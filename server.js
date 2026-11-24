const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

//Game hardcode setting
const PORT = Number(process.env.PORT) || 3000;
const MAX_PLAYERS = 200;
const COUNTDOWN_SECONDS = 5;
const DEFAULT_RACE_DURATION_SEC = 35;
const MIN_RACE_DURATION_SEC = 30;
const MAX_RACE_DURATION_SEC = 45;
const PHOTO_FINISH_MS = 3000;

// Anti-cheat 
const MIN_BATCH_INTERVAL_MS = 200;
const MAX_TAPS_PER_BATCH = 20;
const HOST_TICK_MS = 50; // 20Hz
const PLAYER_RANK_TICK_MS = 200; // 5Hz

const STATES = {
  LOBBY: 'LOBBY',
  COUNTDOWN: 'COUNTDOWN',
  RACING: 'RACING',
  PHOTO_FINISH: 'PHOTO_FINISH',
  PODIUM: 'PODIUM',
};

const HORSE_COLORS = [
  '#FF5A5F', '#FFB400', '#00A699', '#3B82F6', '#A855F7',
  '#EC4899', '#10B981', '#F97316', '#06B6D4', '#EAB308',
  '#EF4444', '#8B5CF6', '#14B8A6', '#F43F5E', '#6366F1',
];

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 10000,
  perMessageDeflate: false, // Lower CPU overhead for 200 concurrent clients
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  if (req.query.room) {
    return res.redirect(`/play?room=${encodeURIComponent(req.query.room)}`);
  }
  return res.redirect('/host');
});

app.get('/host', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

app.get('/play', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'play.html'));
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, uptimeSec: Math.round(process.uptime()) });
});

/** @type {Map<string, Room>} */
const rooms = new Map();

function getLocalLanIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

function buildJoinUrl(hostHeader, roomCode) {
  if (process.env.PUBLIC_URL) {
    const base = process.env.PUBLIC_URL.replace(/\/+$/, '');
    return `${base}/play?room=${roomCode}`;
  }
  const lanIp = getLocalLanIp();
  let host = hostHeader || `${lanIp}:${PORT}`;
  if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) {
    const portPart = host.includes(':') ? `:${host.split(':')[1]}` : '';
    host = `${lanIp}${portPart}`;
  }
  const protocol = host.includes('localhost') || /^\d+\.\d+\.\d+\.\d+/.test(host) ? 'http' : 'https';
  return `${protocol}://${host}/play?room=${roomCode}`;
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

function pickHorseColor(playerId) {
  let hash = 0;
  for (let i = 0; i < playerId.length; i++) {
    hash = (hash * 31 + playerId.charCodeAt(i)) >>> 0;
  }
  return HORSE_COLORS[hash % HORSE_COLORS.length];
}

function clampDuration(sec) {
  const parsed = Number(sec);
  if (!Number.isFinite(parsed)) return DEFAULT_RACE_DURATION_SEC;
  return Math.max(MIN_RACE_DURATION_SEC, Math.min(MAX_RACE_DURATION_SEC, Math.round(parsed)));
}

function createRoom(roomCode, hostHeader) {
  const joinUrl = buildJoinUrl(hostHeader, roomCode);
  const room = {
    code: roomCode,
    state: STATES.LOBBY,
    durationSec: DEFAULT_RACE_DURATION_SEC,
    hostSockets: new Set(),
    players: new Map(), // playerId -> player object
    socketToPlayer: new Map(), // socketId -> playerId
    joinSeq: 0,
    recentNames: [],
    countdownRemaining: COUNTDOWN_SECONDS,
    raceStartAt: 0,
    raceEndAt: 0,
    joinUrl,
    qrDataUrl: '',
    countdownTimer: null,
    raceTimeout: null,
    photoFinishTimeout: null,
    hostTickInterval: null,
    rankTickInterval: null,
    lastSorted: [],
  };

  QRCode.toDataURL(joinUrl, {
    width: 320,
    margin: 2,
    color: { dark: '#0F172A', light: '#FFFFFF' },
  })
    .then((url) => {
      room.qrDataUrl = url;
      emitHostRoomState(room);
    })
    .catch((err) => {
      console.error('QR generation failed:', err);
    });

  rooms.set(roomCode, room);
  return room;
}

function clearRoomTimers(room) {
  if (room.countdownTimer) {
    clearInterval(room.countdownTimer);
    room.countdownTimer = null;
  }
  if (room.raceTimeout) {
    clearTimeout(room.raceTimeout);
    room.raceTimeout = null;
  }
  if (room.photoFinishTimeout) {
    clearTimeout(room.photoFinishTimeout);
    room.photoFinishTimeout = null;
  }
  if (room.hostTickInterval) {
    clearInterval(room.hostTickInterval);
    room.hostTickInterval = null;
  }
  if (room.rankTickInterval) {
    clearInterval(room.rankTickInterval);
    room.rankTickInterval = null;
  }
}

function hostGroup(roomCode) {
  return `host:${roomCode}`;
}

function playersGroup(roomCode) {
  return `players:${roomCode}`;
}

function emitHostRoomState(room) {
  io.to(hostGroup(room.code)).emit('room_state', {
    roomCode: room.code,
    state: room.state,
    playerCount: room.players.size,
    maxPlayers: MAX_PLAYERS,
    durationSec: room.durationSec,
    countdownRemaining: room.countdownRemaining,
    joinUrl: room.joinUrl,
    qrDataUrl: room.qrDataUrl,
    recentPlayers: room.recentNames,
  });
}

function emitLobbyUpdate(room) {
  io.to(hostGroup(room.code)).emit('lobby_update', {
    playerCount: room.players.size,
    maxPlayers: MAX_PLAYERS,
    recentPlayers: room.recentNames,
  });
}

function computeSortedPlayers(room) {
  const list = Array.from(room.players.values());
  list.sort((a, b) => {
    if (b.taps !== a.taps) return b.taps - a.taps;
    if (a.lastAcceptedTapAt !== b.lastAcceptedTapAt) {
      return a.lastAcceptedTapAt - b.lastAcceptedTapAt;
    }
    return a.joinOrder - b.joinOrder;
  });
  room.lastSorted = list;
  return list;
}

function emitRaceTick(room) {
  const sorted = computeSortedPlayers(room);
  const now = Date.now();
  const durationMs = room.durationSec * 1000;
  const elapsedMs = Math.min(durationMs, Math.max(0, now - room.raceStartAt));
  const remainingMs = Math.max(0, durationMs - elapsedMs);
  const top10 = sorted.slice(0, 10).map((p, idx) => ({
    id: p.id,
    name: p.name,
    taps: p.taps,
    rank: idx + 1,
    color: p.color,
  }));

  io.to(hostGroup(room.code)).emit('race_tick', {
    state: room.state,
    elapsedMs,
    durationMs,
    remainingMs,
    leaderTaps: top10[0] ? top10[0].taps : 0,
    playerCount: room.players.size,
    top10,
  });
}

function emitPlayerRanks(room) {
  const sorted = room.lastSorted.length ? room.lastSorted : computeSortedPlayers(room);
  const totalPlayers = sorted.length;
  const tenthPlayer = sorted[9] || null;
  const tenthTaps = tenthPlayer ? tenthPlayer.taps : 0;

  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    if (!p.socketId || !p.connected) continue;
    const rank = i + 1;
    const inTop10 = rank <= 10;
    const tapsBehindTop10 = inTop10 ? 0 : Math.max(1, tenthTaps - p.taps + 1);

    io.to(p.socketId).emit('player_rank', {
      rank,
      totalPlayers,
      taps: p.taps,
      lastSeq: p.lastSeq || 0,
      inTop10,
      tapsBehindTop10,
    });
  }
}

function resetPlayerRaceStats(player) {
  player.taps = 0;
  player.lastBatchAt = 0;
  player.lastAcceptedTapAt = 0;
  player.lastSeq = 0;
  player.tapTokens = MAX_TAPS_PER_BATCH * 2;
  player.packetTokens = 6;
  player.lastRefillAt = 0;
}

function startCountdown(room) {
  if (room.state !== STATES.LOBBY) return;
  clearRoomTimers(room);

  room.state = STATES.COUNTDOWN;
  room.countdownRemaining = COUNTDOWN_SECONDS;

  // Reset tap scores at start of new race
  for (const p of room.players.values()) {
    resetPlayerRaceStats(p);
  }

  emitHostRoomState(room);
  io.to(playersGroup(room.code)).emit('game_state', {
    state: STATES.COUNTDOWN,
    countdownRemaining: room.countdownRemaining,
    durationSec: room.durationSec,
  });
  io.to(hostGroup(room.code)).emit('countdown_tick', {
    remaining: room.countdownRemaining,
  });

  room.countdownTimer = setInterval(() => {
    room.countdownRemaining -= 1;
    if (room.countdownRemaining > 0) {
      io.to(hostGroup(room.code)).emit('countdown_tick', {
        remaining: room.countdownRemaining,
      });
      io.to(playersGroup(room.code)).emit('game_state', {
        state: STATES.COUNTDOWN,
        countdownRemaining: room.countdownRemaining,
      });
    } else {
      clearInterval(room.countdownTimer);
      room.countdownTimer = null;
      startRacing(room);
    }
  }, 1000);
}

function startRacing(room) {
  room.state = STATES.RACING;
  room.raceStartAt = Date.now();
  const durationMs = room.durationSec * 1000;
  room.raceEndAt = room.raceStartAt + durationMs;

  emitHostRoomState(room);
  io.to(playersGroup(room.code)).emit('game_state', {
    state: STATES.RACING,
    durationSec: room.durationSec,
  });

  emitRaceTick(room);
  room.hostTickInterval = setInterval(() => emitRaceTick(room), HOST_TICK_MS);
  room.rankTickInterval = setInterval(() => emitPlayerRanks(room), PLAYER_RANK_TICK_MS);

  room.raceTimeout = setTimeout(() => {
    enterPhotoFinish(room);
  }, durationMs);
}

function enterPhotoFinish(room) {
  if (room.state !== STATES.RACING) return;
  room.state = STATES.PHOTO_FINISH;

  emitHostRoomState(room);
  io.to(playersGroup(room.code)).emit('game_state', {
    state: STATES.PHOTO_FINISH,
  });

  room.photoFinishTimeout = setTimeout(() => {
    finalizePodium(room);
  }, PHOTO_FINISH_MS);
}

function finalizePodium(room) {
  clearRoomTimers(room);
  room.state = STATES.PODIUM;

  const sorted = computeSortedPlayers(room);
  const totalPlayers = sorted.length;
  let totalTaps = 0;
  for (const p of sorted) {
    totalTaps += p.taps;
  }

  const formatEntry = (p, idx) => ({
    id: p.id,
    name: p.name,
    taps: p.taps,
    tps: Number((p.taps / room.durationSec).toFixed(2)),
    rank: idx + 1,
    color: p.color,
  });

  const top10 = sorted.slice(0, 10).map(formatEntry);
  const top3 = top10.slice(0, 3);

  emitHostRoomState(room);
  io.to(hostGroup(room.code)).emit('podium', {
    durationSec: room.durationSec,
    totalPlayers,
    totalTaps,
    top3,
    top10,
  });

  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    if (!p.socketId || !p.connected) continue;
    io.to(p.socketId).emit('player_podium', {
      rank: i + 1,
      totalPlayers,
      taps: p.taps,
      tps: Number((p.taps / room.durationSec).toFixed(2)),
      top3,
    });
  }
}

function resetToLobby(room) {
  clearRoomTimers(room);
  room.state = STATES.LOBBY;
  room.countdownRemaining = COUNTDOWN_SECONDS;
  room.lastSorted = [];
  for (const p of room.players.values()) {
    resetPlayerRaceStats(p);
  }

  emitHostRoomState(room);
  io.to(playersGroup(room.code)).emit('game_state', {
    state: STATES.LOBBY,
    taps: 0,
  });
}

io.on('connection', (socket) => {
  socket.on('host_join', (payload = {}) => {
    const requestedCode = typeof payload.roomCode === 'string'
      ? payload.roomCode.trim().toUpperCase()
      : '';
    let room = requestedCode ? rooms.get(requestedCode) : null;
    if (!room) {
      const code = requestedCode && /^[A-Z0-9]{4}$/.test(requestedCode)
        ? requestedCode
        : generateRoomCode();
      room = createRoom(code, socket.handshake.headers.host);
    }

    if (payload.durationSec !== undefined && room.state === STATES.LOBBY) {
      room.durationSec = clampDuration(payload.durationSec);
    }

    socket.data.role = 'host';
    socket.data.roomCode = room.code;
    room.hostSockets.add(socket.id);
    socket.join(hostGroup(room.code));

    emitHostRoomState(room);
    if (room.state === STATES.RACING || room.state === STATES.PHOTO_FINISH) {
      emitRaceTick(room);
    }
  });

  socket.on('host_set_duration', (payload = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== 'host' || room.state !== STATES.LOBBY) return;
    room.durationSec = clampDuration(payload.durationSec);
    emitHostRoomState(room);
  });

  socket.on('host_start_race', (payload = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== 'host') return;
    if (payload.durationSec !== undefined && room.state === STATES.LOBBY) {
      room.durationSec = clampDuration(payload.durationSec);
    }
    startCountdown(room);
  });

  socket.on('host_reset_race', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== 'host') return;
    resetToLobby(room);
  });

  socket.on('player_join', (payload = {}) => {
    let code = typeof payload.roomCode === 'string'
      ? payload.roomCode.trim().toUpperCase()
      : '';

    let room = code ? rooms.get(code) : null;
    if (!room && !code && rooms.size === 1) {
      room = rooms.values().next().value;
      code = room.code;
    }

    if (!room) {
      socket.emit('join_error', {
        message: code
          ? `房间 "${code}" 不存在 • Room "${code}" not found.`
          : '暂无进行中的房间 • No active race room found.',
      });
      return;
    }

    const rawName = typeof payload.name === 'string' ? payload.name.trim() : '';
    const cleanName = (rawName || 'Racer').slice(0, 12);
    const incomingId = typeof payload.playerId === 'string' && payload.playerId.trim()
      ? payload.playerId.trim().slice(0, 64)
      : '';

    let player = incomingId ? room.players.get(incomingId) : null;

    if (!player) {
      if (room.players.size >= MAX_PLAYERS) {
        socket.emit('join_error', {
          message: `羊群已满 (${MAX_PLAYERS}/${MAX_PLAYERS}) • Stable is full.`,
        });
        return;
      }

      const playerId = incomingId || crypto.randomUUID();
      room.joinSeq += 1;
      player = {
        id: playerId,
        name: cleanName,
        taps: 0,
        color: pickHorseColor(playerId),
        joinOrder: room.joinSeq,
        socketId: socket.id,
        connected: true,
        lastBatchAt: 0,
        lastAcceptedTapAt: 0,
        lastSeq: 0,
        tapTokens: MAX_TAPS_PER_BATCH * 2,
        packetTokens: 6,
        lastRefillAt: 0,
      };
      room.players.set(playerId, player);
      room.recentNames.unshift(cleanName);
      if (room.recentNames.length > 25) {
        room.recentNames.length = 25;
      }
    } else {
      // Session restoration on reconnect/refresh
      if (player.socketId && player.socketId !== socket.id) {
        room.socketToPlayer.delete(player.socketId);
      }
      player.socketId = socket.id;
      player.connected = true;
      if (rawName && room.state === STATES.LOBBY) {
        player.name = cleanName;
      }
    }

    room.socketToPlayer.set(socket.id, player.id);
    socket.data.role = 'player';
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    socket.join(playersGroup(room.code));

    socket.emit('player_joined', {
      roomCode: room.code,
      playerId: player.id,
      name: player.name,
      color: player.color,
      taps: player.taps,
      state: room.state,
      countdownRemaining: room.countdownRemaining,
      durationSec: room.durationSec,
      totalPlayers: room.players.size,
    });

    emitLobbyUpdate(room);
  });

  socket.on('tap_batch', (payload = {}) => {
    if (socket.data.role !== 'player') return;
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (room.state !== STATES.RACING && room.state !== STATES.PHOTO_FINISH) return;

    const player = room.players.get(socket.data.playerId);
    if (!player) return;

    const rawTaps = Number(payload.taps);
    if (!Number.isFinite(rawTaps) || rawTaps <= 0) return;

    const now = Date.now();
    const dt = player.lastRefillAt ? Math.max(0, now - player.lastRefillAt) : 0;
    player.lastRefillAt = now;

    // Token-bucket anti-cheat: tolerates Wi-Fi/4G packet jitter while capping sustained flood/tap rates
    const maxPacketBurst = 6;
    const maxTapBurst = MAX_TAPS_PER_BATCH * 2;
    player.packetTokens = Math.min(maxPacketBurst, (player.packetTokens ?? maxPacketBurst) + dt / MIN_BATCH_INTERVAL_MS);
    player.tapTokens = Math.min(maxTapBurst, (player.tapTokens ?? maxTapBurst) + (dt * MAX_TAPS_PER_BATCH) / 250);

    if (player.packetTokens < 1) {
      return;
    }
    player.packetTokens -= 1;
    player.lastBatchAt = now;

    if (Number.isFinite(Number(payload.seq))) {
      player.lastSeq = Math.max(player.lastSeq || 0, Math.floor(Number(payload.seq)));
    }

    const clampedBatch = Math.min(MAX_TAPS_PER_BATCH, Math.floor(rawTaps));
    const accepted = Math.min(clampedBatch, Math.floor(player.tapTokens));
    if (accepted > 0) {
      player.tapTokens -= accepted;
      player.taps += accepted;
      player.lastAcceptedTapAt = now;
    }
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;

    if (socket.data.role === 'host') {
      room.hostSockets.delete(socket.id);
      return;
    }

    if (socket.data.role === 'player') {
      const playerId = room.socketToPlayer.get(socket.id);
      room.socketToPlayer.delete(socket.id);
      const player = playerId ? room.players.get(playerId) : null;
      if (player && player.socketId === socket.id) {
        // Keep player record and score in room for session recovery
        player.connected = false;
        player.socketId = null;
      }
    }
  });
});

server.listen(PORT, () => {
  const lanIp = getLocalLanIp();
  console.log(`Horse Race Live server listening on http://localhost:${PORT}`);
  console.log(`Host Screen:     http://localhost:${PORT}/host`);
  console.log(`Mobile LAN URL:  http://${lanIp}:${PORT}/play`);
});
