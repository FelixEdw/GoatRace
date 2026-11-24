const { io } = require('socket.io-client');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';
const BOT_COUNT = Number(process.env.BOTS) || 200;
const DURATION_SEC = Number(process.env.DURATION) || 30;
const EXISTING_ROOM = (process.env.ROOM || '').trim().toUpperCase();

async function runStressTest() {
  console.log(`Connecting stress test to ${SERVER_URL} with ${BOT_COUNT} bots...`);

  let roomCode = EXISTING_ROOM;
  let hostSocket = null;
  let raceTickCount = 0;
  let rankUpdatesReceived = 0;
  let podiumResult = null;
  const botSockets = [];
  const botIntervals = [];

  function cleanup() {
    for (const iv of botIntervals) clearInterval(iv);
    for (const s of botSockets) s.disconnect();
    if (hostSocket) hostSocket.disconnect();
  }

  // If no existing room code is supplied, create & drive a room as host
  if (!roomCode) {
    hostSocket = io(SERVER_URL, { transports: ['websocket'] });
    roomCode = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Host room creation timed out')), 10000);
      hostSocket.on('connect', () => {
        hostSocket.emit('host_join', { durationSec: DURATION_SEC });
      });
      hostSocket.on('room_state', (data) => {
        if (data.roomCode) {
          clearTimeout(timeout);
          resolve(data.roomCode);
        }
      });
      hostSocket.on('connect_error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    hostSocket.on('race_tick', () => {
      raceTickCount += 1;
    });

    hostSocket.on('podium', (data) => {
      podiumResult = data;
    });

    console.log(`Created host room ${roomCode} (duration: ${DURATION_SEC}s)`);
  }

  // Connect 200 distinct bot clients
  const joinPromises = [];
  for (let i = 0; i < BOT_COUNT; i++) {
    const botIndex = i + 1;
    const p = new Promise((resolve, reject) => {
      const s = io(SERVER_URL, {
        transports: ['websocket'],
        reconnection: false,
      });
      botSockets.push(s);

      const timer = setTimeout(() => reject(new Error(`Bot ${botIndex} timed out joining`)), 15000);

      s.on('connect', () => {
        s.emit('player_join', {
          roomCode,
          name: `Bot_${String(botIndex).padStart(3, '0')}`,
          playerId: `stress-bot-${botIndex}`,
        });
      });

      s.on('player_joined', () => {
        clearTimeout(timer);
        resolve(s);
      });

      s.on('join_error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Bot ${botIndex} join_error: ${err?.message}`));
      });

      s.on('player_rank', () => {
        rankUpdatesReceived += 1;
      });

      s.on('game_state', (data) => {
        if (data.state === 'RACING') {
          // Randomized 250ms tap batches (2 to 8 taps)
          const iv = setInterval(() => {
            const taps = 2 + Math.floor(Math.random() * 7);
            s.emit('tap_batch', { taps });
          }, 250);
          botIntervals.push(iv);
        } else if (data.state === 'PODIUM') {
          for (const iv of botIntervals) clearInterval(iv);
          botIntervals.length = 0;
        }
      });

      s.on('connect_error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    joinPromises.push(p);
  }

  const joinStart = Date.now();
  await Promise.all(joinPromises);
  console.log(`All ${BOT_COUNT} bots joined room ${roomCode} in ${Date.now() - joinStart}ms`);

  if (hostSocket) {
    console.log('Triggering 5s countdown + race...');
    hostSocket.emit('host_start_race', { durationSec: DURATION_SEC });

    const waitMs = (5 + DURATION_SEC + 6) * 1000;
    const startWait = Date.now();
    while (!podiumResult && Date.now() - startWait < waitMs) {
      await new Promise((r) => setTimeout(r, 250));
    }

    if (!podiumResult) {
      cleanup();
      throw new Error('Timed out waiting for podium result');
    }

    console.log('\n=== 200-Bot Stress Test Summary ===');
    console.log(`Room Code:            ${roomCode}`);
    console.log(`Total Players:        ${podiumResult.totalPlayers}`);
    console.log(`Total Taps Accepted:  ${podiumResult.totalTaps.toLocaleString()}`);
    console.log(`Host race_tick Count: ${raceTickCount} (~${(raceTickCount / DURATION_SEC).toFixed(1)} Hz)`);
    console.log(`Player Rank Packets:  ${rankUpdatesReceived.toLocaleString()}`);
    console.log('Top 3 Winners:');
    podiumResult.top3.forEach((w) => {
      console.log(`  #${w.rank} ${w.name} — ${w.taps} taps (${w.tps} TPS)`);
    });
  } else {
    console.log('Joined existing room as 200 bots. Keep running until race ends (Ctrl+C to stop).');
    await new Promise((r) => setTimeout(r, (DURATION_SEC + 20) * 1000));
  }

  cleanup();
  process.exit(0);
}

runStressTest().catch((err) => {
  console.error('Stress test failed:', err);
  process.exit(1);
});
