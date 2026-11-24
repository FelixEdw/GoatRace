(() => {
  const STORAGE_PLAYER_ID = 'hrl_player_id';
  const STORAGE_NAME = 'hrl_player_name';
  const STORAGE_ROOM = 'hrl_room_code';
  const BATCH_FLUSH_MS = 250;

  const params = new URLSearchParams(window.location.search);
  const urlRoom = (params.get('room') || '').trim().toUpperCase();

  // Elements
  const joinScreen = document.getElementById('join-screen');
  const raceScreen = document.getElementById('race-screen');
  const joinForm = document.getElementById('join-form');
  const roomInput = document.getElementById('room-input');
  const nameInput = document.getElementById('name-input');
  const joinError = document.getElementById('join-error');

  const playerColorDot = document.getElementById('player-color-dot');
  const playerNameLabel = document.getElementById('player-name-label');
  const roomBadge = document.getElementById('room-badge');
  const tapCountEl = document.getElementById('tap-count');
  const standingEl = document.getElementById('standing-value');
  const motivationEl = document.getElementById('motivation-banner');

  const tapPad = document.getElementById('tap-pad');
  const tapArt = document.getElementById('tap-art');
  const tapTitle = document.getElementById('tap-title');
  const tapSub = document.getElementById('tap-sub');
  const podiumList = document.getElementById('podium-list');

  // Generate or load persistent playerId
  let playerId = localStorage.getItem(STORAGE_PLAYER_ID);
  if (!playerId) {
    playerId = (crypto.randomUUID && crypto.randomUUID()) ||
      `p_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(STORAGE_PLAYER_ID, playerId);
  }

  const savedName = localStorage.getItem(STORAGE_NAME) || '';
  const savedRoom = localStorage.getItem(STORAGE_ROOM) || '';
  roomInput.value = urlRoom || savedRoom;
  if (savedName) {
    nameInput.value = savedName;
  }

  const socket = io();

  let joined = false;
  let activeRoomCode = urlRoom || savedRoom;
  let activeName = savedName;
  let gameState = 'LOBBY';
  let serverTaps = 0;
  let localBuffer = 0;
  let clientSeq = 0;
  let unackedBatches = [];
  let pulseTimeout = null;
  let flushInterval = null;

  function showScreen(screen) {
    joinScreen.classList.toggle('active', screen === 'join');
    raceScreen.classList.toggle('active', screen === 'race');
  }

  function updateTapCounterUI() {
    let pendingSent = 0;
    for (let i = 0; i < unackedBatches.length; i++) {
      pendingSent += unackedBatches[i].taps;
    }
    tapCountEl.textContent = String(serverTaps + pendingSent + localBuffer);
  }

  function renderGameState(state, extra = {}) {
    if (state === 'PODIUM') {
      flushPendingTaps();
    }
    gameState = state;
    podiumList.style.display = 'none';
    podiumList.innerHTML = '';

    if (state === 'LOBBY') {
      tapPad.classList.remove('ready-race');
      tapPad.classList.add('disabled');
      tapArt.src = '/images/cny/goat-happy.png';
      tapTitle.textContent = '等待开赛 WAITING';
      tapSub.textContent = '';
      motivationEl.classList.remove('on-screen');
      motivationEl.textContent = '准备就绪 READY';
      standingEl.textContent = extra.totalPlayers ? `— / ${extra.totalPlayers}` : '—';
      serverTaps = 0;
      localBuffer = 0;
      clientSeq = 0;
      unackedBatches = [];
      updateTapCounterUI();
    } else if (state === 'COUNTDOWN') {
      tapPad.classList.remove('ready-race');
      tapPad.classList.add('disabled');
      tapArt.src = '/images/cny/banner-ready.png';
      const rem = extra.countdownRemaining ?? 5;
      tapTitle.textContent = `倒计时 ${rem}`;
      tapSub.textContent = '';
      motivationEl.classList.remove('on-screen');
      motivationEl.textContent = '即将开跑 GET READY';
      serverTaps = 0;
      localBuffer = 0;
      clientSeq = 0;
      unackedBatches = [];
      updateTapCounterUI();
    } else if (state === 'RACING') {
      tapPad.classList.add('ready-race');
      tapPad.classList.remove('disabled');
      tapArt.src = '/images/cny/btn-kuangdian.png';
      tapTitle.textContent = '狂点！TAP!';
      tapSub.textContent = '';
    } else if (state === 'PHOTO_FINISH') {
      flushPendingTaps();
      tapPad.classList.add('ready-race');
      tapPad.classList.remove('disabled');
      tapArt.src = '/images/cny/btn-jisu.png';
      tapTitle.textContent = '冲刺！SPRINT!';
      tapSub.textContent = '';
    } else if (state === 'PODIUM') {
      tapPad.classList.remove('ready-race');
      tapPad.classList.add('disabled');
      tapArt.src = '/images/cny/angpow-gold.png';
      tapTitle.textContent = '比赛结束 FINISH';
      tapSub.textContent = '';
    }
  }

  function flushPendingTaps() {
    if (localBuffer <= 0) return;
    if (gameState !== 'RACING' && gameState !== 'PHOTO_FINISH') {
      localBuffer = 0;
      return;
    }

    const tapsToSend = localBuffer;
    localBuffer = 0;
    clientSeq += 1;
    unackedBatches.push({ seq: clientSeq, taps: tapsToSend });
    socket.emit('tap_batch', { taps: tapsToSend, seq: clientSeq });
    updateTapCounterUI();
  }

  function startFlushLoop() {
    if (flushInterval) return;
    flushInterval = setInterval(flushPendingTaps, BATCH_FLUSH_MS);
  }

  // Low-latency multi-finger pointerdown input
  tapPad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (gameState !== 'RACING' && gameState !== 'PHOTO_FINISH') return;

    localBuffer += 1;
    updateTapCounterUI();

    if (navigator.vibrate) {
      navigator.vibrate(10);
    }

    tapPad.classList.add('pulsing');
    if (pulseTimeout) clearTimeout(pulseTimeout);
    pulseTimeout = setTimeout(() => {
      tapPad.classList.remove('pulsing');
    }, 65);
  });

  // Prevent context menu / drag gestures on mobile
  tapPad.addEventListener('contextmenu', (e) => e.preventDefault());

  function submitJoin(roomCode, name) {
    joinError.textContent = '';
    activeRoomCode = (roomCode || '').trim().toUpperCase();
    activeName = (name || '').trim().slice(0, 12);

    if (!activeName) {
      joinError.textContent = '请输入骑手昵称 • Please enter a rider nickname.';
      return;
    }

    localStorage.setItem(STORAGE_NAME, activeName);
    if (activeRoomCode) {
      localStorage.setItem(STORAGE_ROOM, activeRoomCode);
    }

    socket.emit('player_join', {
      roomCode: activeRoomCode,
      name: activeName,
      playerId,
    });
  }

  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitJoin(roomInput.value, nameInput.value);
  });

  socket.on('connect', () => {
    // Auto-rejoin on reconnect / refresh if previously joined in this session
    if (joined && activeName) {
      socket.emit('player_join', {
        roomCode: activeRoomCode,
        name: activeName,
        playerId,
      });
    }
  });

  socket.on('join_error', (data) => {
    joined = false;
    showScreen('join');
    joinError.textContent = data?.message || '无法加入房间 • Unable to join room.';
  });

  socket.on('player_joined', (data) => {
    joined = true;
    playerId = data.playerId;
    activeRoomCode = data.roomCode;
    activeName = data.name;

    localStorage.setItem(STORAGE_PLAYER_ID, playerId);
    localStorage.setItem(STORAGE_NAME, activeName);
    localStorage.setItem(STORAGE_ROOM, activeRoomCode);

    playerNameLabel.textContent = activeName;
    playerColorDot.style.backgroundColor = data.color || '#f59e0b';
    playerColorDot.style.color = data.color || '#f59e0b';
    roomBadge.textContent = activeRoomCode;

    serverTaps = Number(data.taps) || 0;
    localBuffer = 0;
    unackedBatches = [];
    updateTapCounterUI();

    showScreen('race');
    startFlushLoop();
    renderGameState(data.state, data);
  });

  socket.on('game_state', (data) => {
    renderGameState(data.state, data);
  });

  socket.on('player_rank', (data) => {
    if (!data) return;
    standingEl.textContent = `#${data.rank} / ${data.totalPlayers}`;
    // Reconcile optimistic counter with authoritative server score
    if (typeof data.taps === 'number') {
      const ackSeq = Number(data.lastSeq) || 0;
      if (ackSeq > 0) {
        unackedBatches = unackedBatches.filter((b) => b.seq > ackSeq);
      }
      serverTaps = data.taps;
      updateTapCounterUI();
    }

    if (data.inTop10) {
      motivationEl.classList.add('on-screen');
      motivationEl.textContent = `前十强！TOP 10 (#${data.rank})`;
    } else {
      motivationEl.classList.remove('on-screen');
      const behind = Math.max(1, data.tapsBehindTop10 || 1);
      motivationEl.textContent = `距前十差 ${behind} • ${behind} TO TOP 10`;
    }
  });

  socket.on('player_podium', (data) => {
    renderGameState('PODIUM', data);
    standingEl.textContent = `#${data.rank} / ${data.totalPlayers}`;
    serverTaps = data.taps;
    localBuffer = 0;
    unackedBatches = [];
    updateTapCounterUI();

    const isWinner = data.rank <= 3;
    motivationEl.classList.toggle('on-screen', isWinner);
    motivationEl.textContent = `第 #${data.rank} 名 • ${data.tps}/s`;

    if (data.rank === 1) {
      tapArt.src = '/images/cny/trophy-gold.png';
    } else if (data.rank === 2) {
      tapArt.src = '/images/cny/trophy-silver.png';
    } else if (data.rank === 3) {
      tapArt.src = '/images/cny/angpow-gold.png';
    } else {
      tapArt.src = '/images/cny/goat-happy.png';
    }

    tapTitle.textContent = `第 #${data.rank} 名`;
    tapSub.textContent = `${data.taps} 次 • ${data.tps}/s`;

    if (Array.isArray(data.top3) && data.top3.length > 0) {
      podiumList.innerHTML = data.top3
        .map(
          (entry, idx) => `
          <div class="podium-item">
            <span>#${idx + 1} ${escapeHtml(entry.name)}</span>
            <span>${entry.taps} (${entry.tps}/s)</span>
          </div>
        `
        )
        .join('');
      podiumList.style.display = 'flex';
    }
  });

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }
})();
