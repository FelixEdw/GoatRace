(() => {
  const socket = io();
  const params = new URLSearchParams(window.location.search);
  const initialRoom = (params.get('room') || '').trim().toUpperCase();

  // DOM Elements
  const stateSubtitle = document.getElementById('state-subtitle');
  const hudRoom = document.getElementById('hud-room');
  const hudPlayers = document.getElementById('hud-players');
  const hudTimer = document.getElementById('hud-timer');
  const muteBtn = document.getElementById('mute-btn');
  const startBtn = document.getElementById('start-btn');
  const resetBtn = document.getElementById('reset-btn');

  const lobbyView = document.getElementById('lobby-view');
  const countdownView = document.getElementById('countdown-view');
  const podiumView = document.getElementById('podium-view');

  const qrImage = document.getElementById('qr-image');
  const lobbyRoomCode = document.getElementById('lobby-room-code');
  const lobbyJoinUrl = document.getElementById('lobby-join-url');
  const lobbyCounter = document.getElementById('lobby-counter');
  const lobbyStartBtn = document.getElementById('lobby-start-btn');
  const openPlayLink = document.getElementById('open-play-link');
  const tickerItems = document.getElementById('ticker-items');
  const durationBtns = Array.from(document.querySelectorAll('.duration-btn'));

  const countdownNum = document.getElementById('countdown-num');
  const podiumSummary = document.getElementById('podium-summary');
  const podiumStand = document.getElementById('podium-stand');
  const podiumTop10 = document.getElementById('podium-top10');
  const podiumResetBtn = document.getElementById('podium-reset-btn');

  const canvas = document.getElementById('track-canvas');
  const ctx = canvas.getContext('2d');

  // Preload 4x2 Frame-by-Frame CNY Goat Sprite Sheet & Decorative CNY Assets
  const SPRITE_COLS = 4;
  const SPRITE_ROWS = 2;
  const SPRITE_FRAMES = 8;

  function loadImg(src) {
    const img = new Image();
    img.src = src;
    return img;
  }

  const goatSprite = loadImg('/images/goat-sprite.png');
  const finishArchImg = loadImg('/images/cny/finish-arch.png');
  const chargeBannerImg = loadImg('/images/cny/banner-charge.png');
  const coinIngotImg = loadImg('/images/cny/coin-ingot.png');

  // State
  let roomCode = initialRoom || '';
  let gameState = 'LOBBY';
  let durationSec = 35;
  let lastFinalSecBeep = -1;
  let raceStartedAtPerf = 0;

  // Racer interpolation map: id -> visual state
  const racers = new Map();
  const dustParticles = [];

  // =========================================================
  // Web Audio API Synthesized CNY Sound Engine
  // =========================================================
  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.muted = false;
      this.crowdNode = null;
      this.crowdGain = null;
    }

    ensureContext() {
      if (this.muted) return null;
      if (!this.ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return null;
        this.ctx = new AudioCtx();
      }
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      return this.ctx;
    }

    setMuted(muted) {
      this.muted = muted;
      if (muted) {
        this.stopCrowdMurmur();
      }
    }

    playCountdownBeep(remaining) {
      const ac = this.ensureContext();
      if (!ac) return;
      const now = ac.currentTime;
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(remaining <= 1 ? 880 : 523.25, now);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.start(now);
      osc.stop(now + 0.22);
    }

    playStartingFirecracker() {
      const ac = this.ensureContext();
      if (!ac) return;
      const now = ac.currentTime;

      // Festival drum hit
      const drum = ac.createOscillator();
      const drumGain = ac.createGain();
      drum.type = 'sine';
      drum.frequency.setValueAtTime(160, now);
      drum.frequency.exponentialRampToValueAtTime(42, now + 0.28);
      drumGain.gain.setValueAtTime(0.55, now);
      drumGain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      drum.connect(drumGain);
      drumGain.connect(ac.destination);
      drum.start(now);
      drum.stop(now + 0.32);

      // Firecracker crackle bursts
      for (let i = 0; i < 6; i++) {
        const offset = i * 0.055 + Math.random() * 0.02;
        const bufferSize = Math.floor(ac.sampleRate * 0.08);
        const buffer = ac.createBuffer(1, bufferSize, ac.sampleRate);
        const data = buffer.getChannelData(0);
        for (let s = 0; s < bufferSize; s++) {
          data[s] = (Math.random() * 2 - 1) * Math.exp(-s / (ac.sampleRate * 0.014));
        }
        const noise = ac.createBufferSource();
        noise.buffer = buffer;

        const hp = ac.createBiquadFilter();
        hp.type = 'bandpass';
        hp.frequency.value = 1800 + i * 250;

        const gain = ac.createGain();
        gain.gain.setValueAtTime(0.32, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.08);

        noise.connect(hp);
        hp.connect(gain);
        gain.connect(ac.destination);
        noise.start(now + offset);
      }
    }

    startCrowdMurmur() {
      const ac = this.ensureContext();
      if (!ac || this.crowdNode) return;

      const bufferSize = ac.sampleRate * 2;
      const buffer = ac.createBuffer(1, bufferSize, ac.sampleRate);
      const data = buffer.getChannelData(0);
      let lastOut = 0;
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        lastOut = (lastOut + 0.03 * white) / 1.03;
        data[i] = lastOut * 3.2;
      }

      const source = ac.createBufferSource();
      source.buffer = buffer;
      source.loop = true;

      const bandpass = ac.createBiquadFilter();
      bandpass.type = 'bandpass';
      bandpass.frequency.value = 440;
      bandpass.Q.value = 0.7;

      const gain = ac.createGain();
      gain.gain.setValueAtTime(0.06, ac.currentTime);

      source.connect(bandpass);
      bandpass.connect(gain);
      gain.connect(ac.destination);
      source.start();

      this.crowdNode = source;
      this.crowdGain = gain;
    }

    stopCrowdMurmur() {
      if (this.crowdNode) {
        try { this.crowdNode.stop(); } catch (_) {}
        this.crowdNode.disconnect();
        this.crowdNode = null;
        this.crowdGain = null;
      }
    }

    playFinalFiveTone(sec) {
      const ac = this.ensureContext();
      if (!ac) return;
      const now = ac.currentTime;
      // Chinese pentatonic scale ascending in final 5s
      const pentatonic = [1046.5, 880, 783.99, 659.25, 587.33];
      const freq = pentatonic[Math.max(0, Math.min(4, sec - 1))];
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.start(now);
      osc.stop(now + 0.16);
    }

    playFinishGong() {
      const ac = this.ensureContext();
      if (!ac) return;
      const now = ac.currentTime;
      // Rich gong shimmer + celebratory pentatonic chime
      const gongFreqs = [196, 293.66, 392, 587.33, 783.99];
      gongFreqs.forEach((f, idx) => {
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.type = idx === 0 ? 'sawtooth' : 'sine';
        osc.frequency.setValueAtTime(f, now);
        gain.gain.setValueAtTime(0.16 / (idx + 1), now);
        gain.gain.exponentialRampToValueAtTime(0.0008, now + 1.5);
        osc.connect(gain);
        gain.connect(ac.destination);
        osc.start(now);
        osc.stop(now + 1.55);
      });

      const chimeNotes = [523.25, 659.25, 783.99, 1046.5];
      chimeNotes.forEach((f, idx) => {
        const t = now + 0.12 + idx * 0.09;
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(f, t);
        gain.gain.setValueAtTime(0.12, t);
        gain.gain.exponentialRampToValueAtTime(0.0008, t + 0.45);
        osc.connect(gain);
        gain.connect(ac.destination);
        osc.start(t);
        osc.stop(t + 0.5);
      });
    }
  }

  const audio = new AudioEngine();

  muteBtn.addEventListener('click', () => {
    const nextMuted = !audio.muted;
    audio.setMuted(nextMuted);
    muteBtn.textContent = nextMuted ? '静音 OFF' : '音效 ON';
  });

  // =========================================================
  // Room & UI Control Wiring
  // =========================================================
  socket.on('connect', () => {
    socket.emit('host_join', { roomCode: initialRoom || roomCode || undefined });
  });

  durationBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (gameState !== 'LOBBY') return;
      const sec = Number(btn.dataset.sec);
      durationSec = sec;
      updateDurationSelection();
      socket.emit('host_set_duration', { durationSec: sec });
    });
  });

  function updateDurationSelection() {
    durationBtns.forEach((b) => {
      b.classList.toggle('selected', Number(b.dataset.sec) === durationSec);
    });
  }

  function triggerStartRace() {
    audio.ensureContext();
    socket.emit('host_start_race', { durationSec });
  }

  function triggerResetRace() {
    audio.stopCrowdMurmur();
    socket.emit('host_reset_race');
  }

  startBtn.addEventListener('click', triggerStartRace);
  lobbyStartBtn.addEventListener('click', triggerStartRace);
  resetBtn.addEventListener('click', triggerResetRace);
  podiumResetBtn.addEventListener('click', triggerResetRace);

  function updateTicker(names) {
    if (!Array.isArray(names) || names.length === 0) {
      tickerItems.innerHTML = '<span class="ticker-chip">等待玩家加入 • WAITING FOR PLAYERS</span>';
      return;
    }
    const chips = names
      .map((n) => `<span class="ticker-chip">${escapeHtml(n)}</span>`)
      .join('');
    tickerItems.innerHTML = names.length > 5 ? chips + chips : chips;
  }

  function setOverlayVisibility(state) {
    lobbyView.classList.toggle('active', state === 'LOBBY');
    countdownView.classList.toggle('active', state === 'COUNTDOWN');
    podiumView.classList.toggle('active', state === 'PODIUM');

    startBtn.style.display = state === 'LOBBY' ? 'inline-block' : 'none';
    resetBtn.style.display = state !== 'LOBBY' ? 'inline-block' : 'none';

    const labels = {
      LOBBY: '候场 LOBBY',
      COUNTDOWN: '准备 READY',
      RACING: '狂奔中 RACING',
      PHOTO_FINISH: '冲线 FINISH',
      PODIUM: '颁奖 PODIUM',
    };
    stateSubtitle.textContent = labels[state] || state;
  }

  socket.on('room_state', (data) => {
    roomCode = data.roomCode;
    const prevState = gameState;
    gameState = data.state;
    durationSec = data.durationSec || durationSec;
    updateDurationSelection();

    hudRoom.textContent = roomCode;
    lobbyRoomCode.textContent = roomCode;
    hudPlayers.textContent = `${data.playerCount} / ${data.maxPlayers}`;
    lobbyCounter.textContent = `${data.playerCount} / ${data.maxPlayers} READY`;

    if (data.joinUrl) {
      lobbyJoinUrl.textContent = data.joinUrl;
      openPlayLink.href = `/play?room=${encodeURIComponent(roomCode)}`;
    }
    if (data.qrDataUrl) {
      qrImage.src = data.qrDataUrl;
    }
    if (data.recentPlayers) {
      updateTicker(data.recentPlayers);
    }

    setOverlayVisibility(gameState);

    if (gameState === 'LOBBY') {
      racers.clear();
      dustParticles.length = 0;
      lastFinalSecBeep = -1;
      hudTimer.textContent = `${durationSec.toFixed(1)}s`;
      audio.stopCrowdMurmur();
    } else if (gameState === 'COUNTDOWN') {
      countdownNum.textContent = String(data.countdownRemaining ?? 5);
      hudTimer.textContent = `${durationSec.toFixed(1)}s`;
      if (prevState !== 'COUNTDOWN') {
        audio.playCountdownBeep(data.countdownRemaining ?? 5);
      }
    } else if (gameState === 'RACING' && prevState !== 'RACING') {
      lastFinalSecBeep = -1;
      raceStartedAtPerf = performance.now();
      audio.playStartingFirecracker();
      audio.startCrowdMurmur();
    } else if (gameState === 'PHOTO_FINISH' && prevState === 'RACING') {
      audio.playFinishGong();
    } else if (gameState === 'PODIUM') {
      audio.stopCrowdMurmur();
    }
  });

  socket.on('lobby_update', (data) => {
    hudPlayers.textContent = `${data.playerCount} / ${data.maxPlayers}`;
    lobbyCounter.textContent = `${data.playerCount} / ${data.maxPlayers} READY`;
    updateTicker(data.recentPlayers);
  });

  socket.on('countdown_tick', (data) => {
    countdownNum.textContent = String(data.remaining);
    audio.playCountdownBeep(data.remaining);
  });

  // =========================================================
  // Dynamic Finish-Line Scaling & Tick Updates
  // =========================================================
  function computeProjectedTarget(leaderTaps, elapsedMs, durationMs) {
    const elapsedRatio = Math.min(1, Math.max(0.05, elapsedMs / durationMs));
    const t = Math.min(1, Math.max(0, (elapsedRatio - 0.65) / 0.35));
    const smoothT = t * t * (3 - 2 * t);
    const buffer = 1.08 - 0.08 * smoothT;
    return Math.max(40, (leaderTaps / elapsedRatio) * buffer);
  }

  socket.on('race_tick', (data) => {
    const remSec = data.remainingMs / 1000;
    hudTimer.textContent = data.state === 'PHOTO_FINISH'
      ? '终点 FINISH'
      : `${remSec.toFixed(1)}s`;

    if (data.state === 'RACING' && remSec <= 5 && remSec > 0) {
      const ceilSec = Math.ceil(remSec);
      if (ceilSec !== lastFinalSecBeep) {
        lastFinalSecBeep = ceilSec;
        audio.playFinalFiveTone(ceilSec);
      }
    }

    const projectedTarget = computeProjectedTarget(
      data.leaderTaps,
      data.elapsedMs,
      data.durationMs
    );

    const now = performance.now();
    const activeIds = new Set();

    data.top10.forEach((entry, laneIdx) => {
      activeIds.add(entry.id);
      const targetX = Math.min(1.02, entry.taps / projectedTarget);
      const existing = racers.get(entry.id);

      if (!existing) {
        racers.set(entry.id, {
          id: entry.id,
          name: entry.name,
          color: entry.color,
          taps: entry.taps,
          rank: entry.rank,
          x: Math.max(0, targetX - 0.04),
          targetX,
          y: laneIdx,
          fromY: laneIdx,
          toY: laneIdx,
          yAnimStart: now,
          phase: Math.random() * Math.PI * 2,
          lastDustAt: 0,
        });
      } else {
        existing.name = entry.name;
        existing.color = entry.color;
        existing.taps = entry.taps;
        existing.rank = entry.rank;
        existing.targetX = targetX;
        if (existing.toY !== laneIdx) {
          existing.fromY = existing.y;
          existing.toY = laneIdx;
          existing.yAnimStart = now;
        }
      }
    });

    for (const id of racers.keys()) {
      if (!activeIds.has(id)) {
        racers.delete(id);
      }
    }
  });

  socket.on('podium', (data) => {
    audio.stopCrowdMurmur();
    setOverlayVisibility('PODIUM');
    podiumSummary.textContent = `${data.totalPlayers} 人 • ${data.totalTaps.toLocaleString()} 次 • ${data.durationSec}s`;

    const trophies = [
      '/images/cny/trophy-gold.png',
      '/images/cny/trophy-silver.png',
      '/images/cny/angpow-gold.png',
    ];
    const order = data.top3.length >= 3 ? [data.top3[1], data.top3[0], data.top3[2]] : data.top3;
    const placeClasses = data.top3.length >= 3 ? ['place-2', 'place-1', 'place-3'] : ['place-1', 'place-2', 'place-3'];
    const trophyOrder = data.top3.length >= 3 ? [trophies[1], trophies[0], trophies[2]] : trophies;

    podiumStand.innerHTML = order
      .map((entry, i) => `
        <div class="podium-step ${placeClasses[i]}">
          <img class="trophy-img" src="${trophyOrder[i]}" alt="Trophy" />
          <div class="winner-name" style="color: ${entry.color}">${escapeHtml(entry.name)}</div>
          <div class="winner-metrics">${entry.taps} • ${entry.tps}/s</div>
        </div>
      `)
      .join('');

    podiumTop10.innerHTML = data.top10
      .map(
        (entry) => `
        <div class="top10-row">
          <span>#${entry.rank} <span style="color: ${entry.color}">●</span> ${escapeHtml(entry.name)}</span>
          <span>${entry.taps} (${entry.tps}/s)</span>
        </div>
      `
      )
      .join('');
  });

  // =========================================================
  // 60 FPS Canvas Track & Frame-by-Frame Goat Sprite Renderer
  // =========================================================
  function resizeCanvas() {
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  function drawGoatSprite(x, y, laneH, color, rank, name, taps, bounce, isMoving, phase, now) {
    ctx.save();
    ctx.translate(x, y);

    // Shadow on jade turf
    ctx.fillStyle = 'rgba(0, 0, 0, 0.32)';
    ctx.beginPath();
    ctx.ellipse(0, laneH * 0.28, 22, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    // Player color aura / silk ribbon ring underneath goat so each player is distinguishable
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.ellipse(0, laneH * 0.25, 24, 7, 0, 0, Math.PI * 2);
    ctx.stroke();

    if (goatSprite.complete && goatSprite.naturalWidth > 0) {
      const cellW = goatSprite.width / SPRITE_COLS;
      const cellH = goatSprite.height / SPRITE_ROWS;
      const frame = isMoving
        ? Math.floor((now * 0.015 + phase * 2) % SPRITE_FRAMES)
        : 0;
      const col = frame % SPRITE_COLS;
      const row = Math.floor(frame / SPRITE_COLS);

      // Slight crop inset (4px) prevents any edge bleed from neighboring cells
      const sx = col * cellW + 4;
      const sy = row * cellH + 4;
      const sw = cellW - 8;
      const sh = cellH - 8;

      const drawH = Math.min(laneH * 1.18, 76);
      const drawW = drawH * (sw / sh);
      ctx.drawImage(
        goatSprite,
        sx,
        sy,
        sw,
        sh,
        -drawW * 0.52,
        -drawH * 0.56 + bounce * 0.45,
        drawW,
        drawH
      );
    } else {
      // Vector fallback before image finishes loading
      ctx.fillStyle = '#fff8eb';
      ctx.beginPath();
      ctx.ellipse(0, bounce, 18, 11, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Rank badge & Name tag to the left of the goat
    ctx.font = '800 13px system-ui, sans-serif';
    const label = `#${rank} ${name} (${taps})`;
    const textW = ctx.measureText(label).width;
    const tagX = -38 - textW - 14;
    ctx.fillStyle = 'rgba(43, 6, 11, 0.88)';
    ctx.beginPath();
    ctx.roundRect(tagX, -11, textW + 14, 22, 7);
    ctx.fill();

    ctx.strokeStyle = rank === 1 ? '#ffd166' : color;
    ctx.lineWidth = rank === 1 ? 2 : 1.5;
    ctx.stroke();

    ctx.fillStyle = rank === 1 ? '#ffe8a3' : '#fff8eb';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, tagX + 7, 0);

    ctx.restore();
  }

  let lastFrameAt = performance.now();

  function renderFrame(now) {
    const dt = Math.min(0.05, (now - lastFrameAt) / 1000);
    lastFrameAt = now;

    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    const padTop = 26;
    const padBottom = 26;
    const trackLeft = 78;
    const trackRight = w - 72;
    const trackWidth = Math.max(200, trackRight - trackLeft);
    const laneCount = 10;
    const laneH = (h - padTop - padBottom) / laneCount;

    // Crimson & gold decorative top/bottom rails
    ctx.fillStyle = '#5c0a14';
    ctx.fillRect(0, 0, w, padTop);
    ctx.fillRect(0, h - padBottom, w, padBottom);
    ctx.fillStyle = '#ffd166';
    ctx.fillRect(0, padTop - 3, w, 3);
    ctx.fillRect(0, h - padBottom, w, 3);

    // 1. Draw 10 Auspicious Jade Turf Lanes
    for (let i = 0; i < laneCount; i++) {
      const y = padTop + i * laneH;
      ctx.fillStyle = i % 2 === 0 ? '#0d3f2f' : '#124e3b';
      ctx.fillRect(0, y, w, laneH);

      // Golden lane divider
      ctx.strokeStyle = 'rgba(255, 209, 102, 0.2)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();

      // Gold lane number badge on left
      ctx.fillStyle = 'rgba(255, 209, 102, 0.72)';
      ctx.font = '900 14px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), 22, y + laneH / 2);
    }

    // Gold dashed distance markers (25%, 50%, 75%)
    ctx.save();
    ctx.setLineDash([6, 8]);
    ctx.strokeStyle = 'rgba(255, 209, 102, 0.25)';
    ctx.lineWidth = 1.5;
    [0.25, 0.5, 0.75].forEach((pct) => {
      const gx = trackLeft + trackWidth * pct;
      ctx.beginPath();
      ctx.moveTo(gx, padTop);
      ctx.lineTo(gx, h - padBottom);
      ctx.stroke();
    });
    ctx.restore();

    // Festive Crimson & Gold Checkered Finish Line + Golden Cloud Arch
    const sq = 11;
    const rows = Math.ceil((h - padTop - padBottom) / sq);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < 2; c++) {
        ctx.fillStyle = (r + c) % 2 === 0 ? '#ffd166' : '#991b1b';
        ctx.fillRect(trackRight + c * sq, padTop + r * sq, sq, sq);
      }
    }

    if (finishArchImg.complete && finishArchImg.naturalWidth > 0) {
      const archW = 108;
      const archH = archW * (finishArchImg.naturalHeight / finishArchImg.naturalWidth);
      ctx.drawImage(finishArchImg, trackRight - archW * 0.42, padTop - 6, archW, archH);
    }

    // 2. Update & Draw Golden Sparkle / Coin / Dust Particles
    for (let i = dustParticles.length - 1; i >= 0; i--) {
      const p = dustParticles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      if (p.life <= 0) {
        dustParticles.splice(i, 1);
        continue;
      }
      const alpha = Math.max(0, p.life / p.maxLife);
      if (p.coin && coinIngotImg.complete && coinIngotImg.naturalWidth > 0) {
        ctx.save();
        ctx.globalAlpha = alpha * 0.9;
        const cs = p.size * 3.2;
        ctx.drawImage(coinIngotImg, p.x - cs / 2, p.y - cs / 2, cs, cs);
        ctx.restore();
      } else {
        ctx.fillStyle = p.gold
          ? `rgba(255, 209, 102, ${alpha * 0.75})`
          : `rgba(244, 214, 166, ${alpha * 0.5})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 3. Interpolate & Draw Top 10 Goats
    const xLerpFactor = 1 - Math.exp(-10 * dt);
    const yAnimDurationMs = 300;
    const isMoving = gameState === 'RACING' || gameState === 'PHOTO_FINISH';

    for (const racer of racers.values()) {
      racer.x += (racer.targetX - racer.x) * xLerpFactor;

      const yProgress = Math.min(1, (now - racer.yAnimStart) / yAnimDurationMs);
      const yEase = 1 - Math.pow(1 - yProgress, 3);
      racer.y = racer.fromY + (racer.toY - racer.fromY) * yEase;

      const px = trackLeft + racer.x * trackWidth;
      const py = padTop + (racer.y + 0.5) * laneH;
      const bounce = isMoving ? Math.sin(now * 0.022 + racer.phase) * 3 : 0;

      // Trailing lucky gold coins, sparkles & hoof dust behind top-ranking goats
      if (isMoving && racer.rank <= 5 && now - racer.lastDustAt > 55) {
        racer.lastDustAt = now;
        dustParticles.push({
          x: px - 24,
          y: py + laneH * 0.18,
          vx: -50 - Math.random() * 40,
          vy: (Math.random() - 0.5) * 18,
          size: 2 + Math.random() * 3.5,
          life: 0.48,
          maxLife: 0.48,
          gold: racer.rank === 1 || Math.random() < 0.45,
          coin: racer.rank === 1 && Math.random() < 0.25,
        });
      }

      drawGoatSprite(
        px,
        py,
        laneH,
        racer.color,
        racer.rank,
        racer.name,
        racer.taps,
        bounce,
        isMoving,
        racer.phase,
        now
      );
    }

    // 4. "冲啊!" Start Charge Banner Burst for first 2.2s of RACING
    if (gameState === 'RACING' && chargeBannerImg.complete && chargeBannerImg.naturalWidth > 0) {
      const sinceStart = now - raceStartedAtPerf;
      if (sinceStart >= 0 && sinceStart < 2200) {
        const fade = sinceStart > 1600 ? Math.max(0, 1 - (sinceStart - 1600) / 600) : 1;
        const pop = sinceStart < 220 ? 0.65 + (sinceStart / 220) * 0.4 : 1.0;
        const bw = 240 * pop;
        const bh = bw * (chargeBannerImg.naturalHeight / chargeBannerImg.naturalWidth);
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.drawImage(chargeBannerImg, (w - bw) / 2, padTop + 14, bw, bh);
        ctx.restore();
      }
    }

    requestAnimationFrame(renderFrame);
  }

  requestAnimationFrame(renderFrame);

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
