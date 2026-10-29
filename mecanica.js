(() => {
  // ---------- Configuración ----------
  const TILE = 40;
  const DIFFICULTIES = {
    facil:   { coins: 6,  monsterSpeed: 80 },
    normal:  { coins: 12, monsterSpeed: 100 },
    dificil: { coins: 20, monsterSpeed: 118 },
  };
  const PLAYER_SPEED = 135;
  const LIGHT_RADIUS = 150;
  const VISION_TIME = 4;      // segundos que dura la visión
  const MASK_COOLDOWN = 12;   // segundos antes de reusar la misma máscara

  // Mapa: # pared, . piso, P inicio jugador, T inicio monstruo, E salida, M máscara (en pared)
  const MAP = [
    "########M############",
    "#...#.......#......E#",
    "#...#.......#..T....#",
    "#...............#...#",
    "#...#.......#...#...#",
    "#####.#####.#...#...#",
    "#...........#.......#",
    "#...#...............#",
    "#...#.......#...#...#",
    "#####.#####.#...#...#",
    "#...........M.......#",
    "#...#.......#...#...#",
    "#...#.......#...#...#",
    "#P..................#",
    "#####################",
  ];
  // Máscaras extra en paredes exteriores/interiores
  const EXTRA_MASKS = [[0, 3], [0, 10], [20, 7], [12, 10]];

  const H = MAP.length;
  const W = 21;
  const grid = MAP.map(r => r.padEnd(W, "#").slice(0, W).split(""));
  EXTRA_MASKS.forEach(([x, y]) => { if (grid[y]) grid[y][x] = "M"; });

  let start, monsterStart, exitTile;
  const masks = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = grid[y][x];
    if (c === "P") { start = { x, y }; grid[y][x] = "."; }
    if (c === "T") { monsterStart = { x, y }; grid[y][x] = "."; }
    if (c === "E") { exitTile = { x, y }; grid[y][x] = "."; }
    if (c === "M") masks.push({ x, y, cool: 0 });
  }

  // ---------- Elementos de la página ----------
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const overlay = document.getElementById("overlay");
  const ovTitle = document.getElementById("ovTitle");
  const ovText = document.getElementById("ovText");
  const coinsEl = document.getElementById("coins");
  const maskEl = document.getElementById("mask");

  // Sprites opcionales: pon imágenes en la carpeta assets/ y se usarán solas
  const playerImg = new Image(); playerImg.src = "assets/jugador.png";
  const monsterImg = new Image(); monsterImg.src = "assets/monstruo.png";
  const hasImg = (img) => img.complete && img.naturalWidth > 0;

  // ---------- Estado ----------
  let state = "menu";
  let diff, player, monster, coins, collected, vision, keys = {}, joy = { x: 0, y: 0 }, time = 0;

  const isWall = (tx, ty) =>
    tx < 0 || ty < 0 || tx >= W || ty >= H || grid[ty][tx] === "#" || grid[ty][tx] === "M";

  function blocked(px, py, r) {
    return [[-r, -r], [r, -r], [-r, r], [r, r]].some(([ox, oy]) =>
      isWall(Math.floor((px + ox) / TILE), Math.floor((py + oy) / TILE)));
  }

  const center = (t) => ({ x: t.x * TILE + TILE / 2, y: t.y * TILE + TILE / 2 });

  function startGame(key) {
    diff = DIFFICULTIES[key];
    const s = center(start), m = center(monsterStart);
    player = { x: s.x, y: s.y, r: 12 };
    monster = { x: m.x, y: m.y, target: null, delay: 3 };
    vision = 0;
    collected = 0;
    masks.forEach(k => (k.cool = 0));

    // Monedas en casillas libres, lejos del inicio y de la salida
    const free = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (isWall(x, y)) continue;
      const farStart = Math.hypot(x - start.x, y - start.y) > 3;
      const farExit = Math.hypot(x - exitTile.x, y - exitTile.y) > 1.5;
      if (farStart && farExit) free.push({ x, y });
    }
    for (let i = free.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [free[i], free[j]] = [free[j], free[i]];
    }
    coins = free.slice(0, diff.coins);

    overlay.classList.add("hidden");
    state = "play";
    updateHud();
  }

  function endGame(win) {
    state = win ? "win" : "lose";
    ovTitle.textContent = win ? "¡Escapaste con el botín!" : "Te atrapó";
    ovText.textContent = win
      ? "Juntaste todas las monedas y saliste de la mansión. Elige una dificultad para jugar otra vez."
      : "El monstruo te alcanzó en la oscuridad. Elige una dificultad para intentarlo de nuevo.";
    overlay.classList.remove("hidden");
    beep(win ? 660 : 120, 0.4);
  }

  // ---------- Camino del monstruo (BFS) ----------
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  function nextStep(from, to) {
    if (from.x === to.x && from.y === to.y) return to;
    const key = (x, y) => y * W + x;
    const prev = new Map([[key(from.x, from.y), null]]);
    const queue = [from];
    while (queue.length) {
      const c = queue.shift();
      if (c.x === to.x && c.y === to.y) break;
      for (const [dx, dy] of DIRS) {
        const nx = c.x + dx, ny = c.y + dy;
        if (isWall(nx, ny) || prev.has(key(nx, ny))) continue;
        prev.set(key(nx, ny), c);
        queue.push({ x: nx, y: ny });
      }
    }
    if (!prev.has(key(to.x, to.y))) return from;
    let c = to, p = prev.get(key(c.x, c.y));
    while (p && !(p.x === from.x && p.y === from.y)) { c = p; p = prev.get(key(c.x, c.y)); }
    return c;
  }

  // ---------- Actualización ----------
  function update(dt) {
    time += dt;

    // Movimiento del jugador
    let kx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0) + joy.x;
    let ky = (keys.down ? 1 : 0) - (keys.up ? 1 : 0) + joy.y;
    const len = Math.hypot(kx, ky);
    if (len > 1) { kx /= len; ky /= len; }
    const dx = kx * PLAYER_SPEED * dt, dy = ky * PLAYER_SPEED * dt;
    if (!blocked(player.x + dx, player.y, player.r)) player.x += dx;
    if (!blocked(player.x, player.y + dy, player.r)) player.y += dy;

    // Monedas
    for (let i = coins.length - 1; i >= 0; i--) {
      const c = center(coins[i]);
      if (Math.hypot(player.x - c.x, player.y - c.y) < 20) {
        coins.splice(i, 1);
        collected++;
        beep(880, 0.08);
        updateHud();
      }
    }

    // Máscaras
    vision = Math.max(0, vision - dt);
    masks.forEach(k => {
      k.cool = Math.max(0, k.cool - dt);
      const c = center(k);
      if (k.cool === 0 && vision === 0 && Math.hypot(player.x - c.x, player.y - c.y) < TILE * 1.3) {
        vision = VISION_TIME;
        k.cool = MASK_COOLDOWN;
        beep(300, 0.25);
      }
    });
    updateHud();

    // Monstruo
    if (monster.delay > 0) monster.delay -= dt;
    else {
      const mt = { x: Math.floor(monster.x / TILE), y: Math.floor(monster.y / TILE) };
      const pt = { x: Math.floor(player.x / TILE), y: Math.floor(player.y / TILE) };
      if (!monster.target || Math.hypot(monster.x - monster.target.x, monster.y - monster.target.y) < 2) {
        monster.target = center(nextStep(mt, pt));
      }
      const tx = monster.target.x - monster.x, ty = monster.target.y - monster.y;
      const d = Math.hypot(tx, ty) || 1;
      const step = Math.min(d, diff.monsterSpeed * dt);
      monster.x += (tx / d) * step;
      monster.y += (ty / d) * step;
    }

    // ¿Te atrapó?
    if (Math.hypot(player.x - monster.x, player.y - monster.y) < 24) return endGame(false);

    // ¿Escapaste?
    const e = center(exitTile);
    if (collected === diff.coins && Math.hypot(player.x - e.x, player.y - e.y) < 22) endGame(true);
  }

  function updateHud() {
    if (!diff) return;
    coinsEl.textContent = `Monedas ${collected}/${diff.coins}`;
    maskEl.textContent = vision > 0 ? "Viendo por sus ojos…" : "Busca una máscara en la pared";
    maskEl.classList.toggle("ready", vision > 0);
  }

  // ---------- Dibujo ----------
  function drawMap() {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const px = x * TILE, py = y * TILE;
      if (isWall(x, y)) {
        ctx.fillStyle = "#3b2f52"; ctx.fillRect(px, py, TILE, TILE);
        ctx.fillStyle = "#2c2240"; ctx.fillRect(px, py + TILE - 6, TILE, 6);
      } else {
        ctx.fillStyle = (x + y) % 2 ? "#1b1426" : "#201830";
        ctx.fillRect(px, py, TILE, TILE);
      }
    }
    // Salida
    const open = collected === diff.coins;
    const e = center(exitTile);
    ctx.fillStyle = open ? "#2fbf6b" : "#5a2a2a";
    ctx.fillRect(e.x - 16, e.y - 18, 32, 36);
    ctx.fillStyle = "rgba(0,0,0,.35)";
    ctx.fillRect(e.x - 12, e.y - 14, 24, 28);
    ctx.fillStyle = open ? "#d9ffe8" : "#9a6a6a";
    ctx.beginPath(); ctx.arc(e.x + 7, e.y + 2, 2.5, 0, 7); ctx.fill();
  }

  function drawMasks() {
    masks.forEach(k => {
      const c = center(k);
      ctx.globalAlpha = k.cool > 0 ? 0.35 : 1;
      ctx.fillStyle = "#e8e2d0";
      ctx.beginPath(); ctx.ellipse(c.x, c.y, 11, 14, 0, 0, 7); ctx.fill();
      ctx.fillStyle = "#111";
      ctx.beginPath(); ctx.arc(c.x - 4, c.y - 3, 2.8, 0, 7); ctx.arc(c.x + 4, c.y - 3, 2.8, 0, 7); ctx.fill();
      ctx.fillRect(c.x - 4, c.y + 5, 8, 2);
      ctx.globalAlpha = 1;
    });
  }

  function drawCoins() {
    coins.forEach(t => {
      const c = center(t);
      const bob = Math.sin(time * 4 + t.x) * 2;
      ctx.fillStyle = "#f2c744";
      ctx.beginPath(); ctx.arc(c.x, c.y + bob, 7, 0, 7); ctx.fill();
      ctx.fillStyle = "#b8901f";
      ctx.beginPath(); ctx.arc(c.x, c.y + bob, 3.5, 0, 7); ctx.fill();
    });
  }

  function drawPlayer() {
    if (hasImg(playerImg)) {
      ctx.drawImage(playerImg, player.x - 20, player.y - 20, 40, 40);
      return;
    }
    ctx.fillStyle = "#3fae5a";
    ctx.beginPath(); ctx.arc(player.x, player.y, 13, 0, 7); ctx.fill();
    ctx.fillStyle = "#1d7a38";
    ctx.beginPath(); ctx.arc(player.x, player.y - 5, 11, Math.PI, 0); ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(player.x - 4, player.y + 1, 2.5, 0, 7); ctx.arc(player.x + 4, player.y + 1, 2.5, 0, 7); ctx.fill();
  }

  function drawMonster(glow) {
    const { x, y } = monster;
    if (glow) { ctx.shadowColor = "#4fe08a"; ctx.shadowBlur = 24; }
    if (hasImg(monsterImg)) {
      ctx.drawImage(monsterImg, x - 22, y - 22, 44, 44);
    } else {
      ctx.fillStyle = "#6b4426";
      ctx.beginPath(); ctx.arc(x - 12, y - 13, 6, 0, 7); ctx.arc(x + 12, y - 13, 6, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, 18, 0, 7); ctx.fill();
      ctx.fillStyle = "#a57a4f";
      ctx.beginPath(); ctx.ellipse(x, y + 6, 8, 6, 0, 0, 7); ctx.fill();
      ctx.fillStyle = "#ff3b3b";
      ctx.beginPath(); ctx.arc(x - 6, y - 4, 3, 0, 7); ctx.arc(x + 6, y - 4, 3, 0, 7); ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!diff) { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, canvas.width, canvas.height); return; }

    drawMap(); drawMasks(); drawCoins();
    const monsterInLight = Math.hypot(player.x - monster.x, player.y - monster.y) < LIGHT_RADIUS - 20;
    if (monsterInLight) drawMonster(false);
    drawPlayer();

    // Oscuridad con linterna
    const g = ctx.createRadialGradient(player.x, player.y, 30, player.x, player.y, LIGHT_RADIUS);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.96)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Visión a través de los ojos del monstruo
    if (vision > 0) {
      const blink = vision < 1 && Math.floor(vision * 8) % 2 === 0;
      ctx.fillStyle = blink ? "rgba(79,224,138,0.04)" : "rgba(79,224,138,0.12)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      drawMonster(true);
    }
  }

  // ---------- Sonido simple ----------
  let audio;
  function beep(freq, dur) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = freq; o.type = "square";
      g.gain.value = 0.04;
      o.connect(g); g.connect(audio.destination);
      o.start(); o.stop(audio.currentTime + dur);
    } catch (_) { /* sin audio, no pasa nada */ }
  }

  // ---------- Controles ----------
  const KEYMAP = {
    ArrowLeft: "left", a: "left", A: "left",
    ArrowRight: "right", d: "right", D: "right",
    ArrowUp: "up", w: "up", W: "up",
    ArrowDown: "down", s: "down", S: "down",
  };
  addEventListener("keydown", e => { if (KEYMAP[e.key]) { keys[KEYMAP[e.key]] = true; e.preventDefault(); } });
  addEventListener("keyup", e => { if (KEYMAP[e.key]) keys[KEYMAP[e.key]] = false; });

  const stick = document.getElementById("stick");
  const knob = document.getElementById("knob");
  let pointerId = null;
  function setJoy(e) {
    const r = stick.getBoundingClientRect();
    const max = r.width / 2;
    let dx = e.clientX - (r.left + max), dy = e.clientY - (r.top + max);
    const d = Math.hypot(dx, dy) || 1;
    const k = Math.min(d, max) / d;
    dx *= k; dy *= k;
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    joy.x = dx / max; joy.y = dy / max;
  }
  stick.addEventListener("pointerdown", e => { pointerId = e.pointerId; stick.setPointerCapture(pointerId); setJoy(e); });
  stick.addEventListener("pointermove", e => { if (e.pointerId === pointerId) setJoy(e); });
  const releaseStick = e => {
    if (e.pointerId !== pointerId) return;
    pointerId = null; joy.x = joy.y = 0; knob.style.transform = "";
  };
  stick.addEventListener("pointerup", releaseStick);
  stick.addEventListener("pointercancel", releaseStick);

  document.getElementById("playBtn").addEventListener("click", () => {
    document.getElementById("cover").classList.add("hidden");
  });

  document.querySelectorAll("#levels button").forEach(b =>
    b.addEventListener("click", () => startGame(b.dataset.d)));

  // ---------- Bucle principal ----------
  let last = performance.now();
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (state === "play") update(dt);
    draw();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();