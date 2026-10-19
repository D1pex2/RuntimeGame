// Движок платформера. createGame() собирает чистый мир; моды от Claude навешиваются поверх.
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let audioCtx = null;

const input = { keys: new Set(), justPressed: new Set(), mouse: { x: 0, y: 0, down: false }, typing: false };

function createGame() {
  const g = {
    W: canvas.width, H: canvas.height, ctx, time: 0, dt: 0,
    keys: input.keys, mouse: input.mouse,
    gravity: 1800, friction: 0.8, bg: '#8fd3ff',
    spawn: { x: 0, y: 400 },
    platforms: [], entities: [], state: {},
    hooks: {}, toasts: [], parts: [],
    currentMod: null, onError: null,
  };
  g.camera = { x: 0, y: 0, zoom: 1, follow: null, shake: 0 };
  g.player = {
    x: 0, y: 400, w: 32, h: 48, vx: 0, vy: 0, color: '#ff5a36', speed: 320, jump: 700,
    onGround: false, facing: 1, hp: 100, dead: false, control: true, draw: null,
    maxJumps: 1, jumpsLeft: 1,
  };
  g.camera.follow = g.player;

  g.on = (name, fn) => { (g.hooks[name] ||= []).push({ fn, mod: g.currentMod }); return fn; };
  g.off = (name, fn) => { g.hooks[name] = (g.hooks[name] || []).filter(h => h.fn !== fn); };
  g.emit = (name, ...args) => {
    for (const h of [...(g.hooks[name] || [])]) {
      try { h.fn(...args); }
      catch (e) { g.off(name, h.fn); g.fail(e, h.mod, `хук '${name}'`); }
    }
  };
  g.fail = (e, mod, where) => { console.error(where, e); g.onError && g.onError(e, mod, where); };

  g.pressed = code => input.justPressed.has(code);
  g.addPlatform = p => { const o = { color: '#5b8c3a', ...p }; g.platforms.push(o); return o; };
  g.add = e => { const o = { x: 0, y: 0, w: 32, h: 32, vx: 0, vy: 0, color: '#fc0', mod: g.currentMod, ...e }; g.entities.push(o); return o; };
  g.remove = e => { e._dead = true; };
  g.find = tag => g.entities.filter(e => e.tag === tag && !e._dead);
  g.overlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  g.rand = (a, b) => a + Math.random() * (b - a);
  g.clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  g.say = (text, seconds = 2.5) => g.toasts.push({ text: String(text), t: seconds });
  g.text = (c, str, x, y, o = {}) => {
    c.font = `bold ${o.size || 20}px system-ui, sans-serif`;
    c.textAlign = o.align || 'left'; c.fillStyle = o.color || '#fff';
    c.fillText(str, x, y);
  };
  g.particles = (x, y, o = {}) => {
    const n = o.n || 20;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = (o.speed || 300) * Math.random();
      g.parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: o.life || 0.8, max: o.life || 0.8, color: o.color || '#fff', size: o.size || 4 });
    }
  };
  g.beep = (freq = 440, dur = 0.1, type = 'square', vol = 0.1) => {
    try {
      audioCtx ||= new AudioContext();
      const o = audioCtx.createOscillator(), v = audioCtx.createGain();
      o.type = type; o.frequency.value = freq; v.gain.value = vol;
      v.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
      o.connect(v).connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + dur);
    } catch {}
  };
  g.hurt = (amount = 10) => {
    const p = g.player;
    if (p.dead || p.invuln > 0) return;
    p.hp -= amount; p.invuln = 0.5; g.camera.shake = 8; g.beep(120, 0.15, 'sawtooth');
    if (p.hp <= 0) {
      p.dead = true; p.deadT = 1; g.particles(p.x + p.w / 2, p.y + p.h / 2, { n: 40, color: p.color });
      g.emit('death');
    }
  };
  g.respawn = () => {
    const p = g.player;
    Object.assign(p, { x: g.spawn.x, y: g.spawn.y, vx: 0, vy: 0, hp: 100, dead: false });
    g.emit('respawn');
  };

  // Столкновения прямоугольника o со всеми твёрдыми телами по осям.
  g.solids = self => {
    const list = g.platforms.slice();
    for (const e of g.entities) if (e.solid && e !== self && !e._dead) list.push(e);
    return list;
  };
  g.moveBody = (o, dt) => {
    o.onGround = false;
    const solids = g.solids(o);
    o.x += o.vx * dt;
    for (const s of solids) if (g.overlap(o, s)) {
      if (o.vx > 0) o.x = s.x - o.w; else if (o.vx < 0) o.x = s.x + s.w;
      o.vx = o.bounce ? -o.vx * o.bounce : 0;
    }
    o.y += o.vy * dt;
    for (const s of solids) if (g.overlap(o, s)) {
      if (o.vy > 0) { o.y = s.y - o.h; o.onGround = true; o.ground = s; if (s.vx) o.x += s.vx * dt; }
      else if (o.vy < 0) o.y = s.y + s.h;
      o.vy = o.bounce && Math.abs(o.vy) > 60 ? -o.vy * o.bounce : 0;
    }
  };

  g._updatePlayer = dt => {
    const p = g.player, k = g.keys;
    if (p.dead) { p.deadT -= dt; if (p.deadT <= 0) g.respawn(); return; }
    if (p.invuln > 0) p.invuln -= dt;
    if (p.control) {
      const dir = (k.has('ArrowRight') || k.has('KeyD') ? 1 : 0) - (k.has('ArrowLeft') || k.has('KeyA') ? 1 : 0);
      if (dir) { p.vx = dir * p.speed; p.facing = dir; }
      else if (p.onGround) p.vx *= g.friction; else p.vx *= 0.98;
      if (p.onGround) p.jumpsLeft = p.maxJumps;
      if (p.jumpsLeft > 0 && (g.pressed('Space') || g.pressed('KeyW') || g.pressed('ArrowUp'))) {
        p.jumpsLeft--; p.vy = -p.jump; g.beep(p.onGround ? 520 : 700, 0.08);
        g.emit('jump', p.maxJumps - p.jumpsLeft);
      }
    }
    p.vy += g.gravity * dt;
    g.moveBody(p, dt);
    if (p.y > 3000) { p.hp = 0; p.dead = true; p.deadT = 0.5; g.emit('death'); }
  };
  g.updatePlayer = dt => g._updatePlayer(dt);

  g.drawPlayer = (c, p) => {
    if (p.dead) return;
    if (p.invuln > 0 && Math.floor(g.time * 20) % 2) return;
    if (p.draw) return p.draw(c, p);
    c.fillStyle = p.color; c.fillRect(p.x, p.y, p.w, p.h);
    c.fillStyle = '#fff'; const ex = p.facing > 0 ? p.x + p.w - 12 : p.x + 4;
    c.fillRect(ex, p.y + 10, 8, 8);
    c.fillStyle = '#000'; c.fillRect(ex + (p.facing > 0 ? 4 : 0), p.y + 12, 4, 4);
  };

  g.updateEntities = dt => {
    for (const e of g.entities) {
      if (e._dead) continue;
      try {
        if (e.gravity) { e.vy += g.gravity * dt; g.moveBody(e, dt); }
        else { e.x += e.vx * dt; e.y += e.vy * dt; }
        if (e.update) e.update(e, dt, g);
        if (e.onTouch && !g.player.dead && g.overlap(e, g.player)) e.onTouch(e, g.player, g);
        if (e.life !== undefined && (e.life -= dt) <= 0) e._dead = true;
      } catch (err) { e._dead = true; g.fail(err, e.mod, 'сущность'); }
    }
    g.entities = g.entities.filter(e => !e._dead);
  };

  g.update = dt => {
    g.dt = dt; g.time += dt;
    g.updatePlayer(dt);
    g.updateEntities(dt);
    g.emit('update', dt);
    for (const q of g.parts) { q.vy += g.gravity * 0.5 * dt; q.x += q.vx * dt; q.y += q.vy * dt; q.life -= dt; }
    g.parts = g.parts.filter(q => q.life > 0);
    for (const t of g.toasts) t.t -= dt;
    g.toasts = g.toasts.filter(t => t.t > 0);
    const cam = g.camera, f = cam.follow;
    if (f) {
      const tx = f.x + f.w / 2 - g.W / 2 / cam.zoom, ty = f.y + f.h / 2 - g.H * 0.55 / cam.zoom;
      cam.x += (tx - cam.x) * Math.min(1, dt * 8); cam.y += (ty - cam.y) * Math.min(1, dt * 8);
    }
    cam.shake *= 0.9;
  };

  g.draw = () => {
    const c = ctx, cam = g.camera;
    c.setTransform(1, 0, 0, 1, 0, 0);
    if (typeof g.bg === 'function') { try { g.bg(c); } catch (e) { g.bg = '#8fd3ff'; g.fail(e, null, 'фон'); } }
    else { c.fillStyle = g.bg; c.fillRect(0, 0, g.W, g.H); }
    const sx = (Math.random() - 0.5) * cam.shake, sy = (Math.random() - 0.5) * cam.shake;
    c.setTransform(cam.zoom, 0, 0, cam.zoom, -cam.x * cam.zoom + sx, -cam.y * cam.zoom + sy);
    g.emit('drawBehind', c);
    for (const p of g.platforms) {
      if (p.draw) { try { p.draw(c, p, g); } catch (e) { p.draw = null; g.fail(e, null, 'платформа'); } continue; }
      c.fillStyle = p.color; c.fillRect(p.x, p.y, p.w, p.h);
    }
    for (const e of g.entities) {
      if (e.draw) { try { e.draw(c, e, g); } catch (err) { e.draw = null; g.fail(err, e.mod, 'рисование сущности'); } }
      else { c.fillStyle = e.color; c.fillRect(e.x, e.y, e.w, e.h); }
    }
    try { g.drawPlayer(c, g.player); } catch (e) { g.drawPlayer = g._drawPlayerDefault; g.fail(e, null, 'drawPlayer'); }
    for (const q of g.parts) { c.globalAlpha = q.life / q.max; c.fillStyle = q.color; c.fillRect(q.x - q.size / 2, q.y - q.size / 2, q.size, q.size); }
    c.globalAlpha = 1;
    g.emit('draw', c);
    c.setTransform(1, 0, 0, 1, 0, 0);
    g.emit('ui', c);
    g.toasts.forEach((t, i) => {
      c.globalAlpha = Math.min(1, t.t * 2);
      g.text(c, t.text, g.W / 2, 60 + i * 34, { size: 26, align: 'center', color: '#fff' });
    });
    c.globalAlpha = 1;
    if (g.player.hp < 100 && !g.player.dead) {
      c.fillStyle = '#0008'; c.fillRect(g.W - 220, 16, 204, 18);
      c.fillStyle = '#e33'; c.fillRect(g.W - 218, 18, 200 * Math.max(0, g.player.hp) / 100, 14);
    }
  };
  g._drawPlayerDefault = g.drawPlayer;
  // Если мод сломал главный цикл, возвращаем исходные функции, а не падаем каждый кадр.
  const core = ['update', 'draw', 'updatePlayer', 'drawPlayer', 'updateEntities', 'moveBody', 'solids'];
  g._core = Object.fromEntries(core.map(k => [k, g[k]]));
  g.restoreCore = () => Object.assign(g, g._core);

  // Пустой мир: только пол.
  g.addPlatform({ x: -5000, y: 500, w: 10000, h: 1000 });
  return g;
}

function resize() {
  canvas.width = innerWidth; canvas.height = innerHeight;
  if (window.game) { game.W = canvas.width; game.H = canvas.height; }
}
addEventListener('resize', resize);

addEventListener('keydown', e => {
  if (input.typing) return;
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  if (!input.keys.has(e.code)) { input.justPressed.add(e.code); window.game && game.emit('key', e.code); }
  input.keys.add(e.code);
});
addEventListener('keyup', e => input.keys.delete(e.code));
addEventListener('blur', () => input.keys.clear());
canvas.addEventListener('mousemove', e => { input.mouse.x = e.clientX; input.mouse.y = e.clientY; });
canvas.addEventListener('mousedown', e => {
  input.mouse.down = true;
  const cam = game.camera;
  game.emit('click', cam.x + e.clientX / cam.zoom, cam.y + e.clientY / cam.zoom);
});
addEventListener('mouseup', () => input.mouse.down = false);

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  const cam = game.camera;
  input.mouse.worldX = cam.x + input.mouse.x / cam.zoom;
  input.mouse.worldY = cam.y + input.mouse.y / cam.zoom;
  try { game.update(dt); } catch (e) { game.restoreCore(); game.fail(e, null, 'главный update (функции движка восстановлены)'); }
  try { game.draw(); } catch (e) { game.restoreCore(); game.fail(e, null, 'главный draw (функции движка восстановлены)'); }
  input.justPressed.clear();
  requestAnimationFrame(frame);
}

resize();
window.game = createGame();
requestAnimationFrame(frame);
