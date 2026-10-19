// Живой платформер: сервер раздаёт игру и держит один постоянный процесс ИИ
// (Claude CLI или Codex CLI), который превращает фразы игрока в JS-патчи.
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const PORT = Number(process.argv[2] || process.env.PORT) || 5173;
const HTTPS_PORT = Number(process.argv[3] || process.env.HTTPS_PORT) || PORT + 270;   // 5443 по умолчанию
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const PROMPT_FILE = path.join(ROOT, 'prompt.md');

// npm-папка часто не в PATH на Windows, поэтому ищем CLI и там.
function findBin(name, envVar) {
  if (process.env[envVar]) return process.env[envVar];
  const npm = path.join(process.env.APPDATA || '', 'npm', name + '.cmd');
  return fs.existsSync(npm) ? `"${npm}"` : name;
}

// На Windows proc.kill() убивает только cmd.exe, а сам CLI остаётся жить.
function killTree(p) {
  if (!p || p.exitCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
  else p.kill();
}

function lines(stream, onLine) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  });
}

// ---------- Claude CLI: stream-json в обе стороны, effort low ----------
const claude = {
  name: 'claude',
  bin: findBin('claude', 'CLAUDE_BIN'),
  models: ['haiku', 'sonnet', 'opus'],
  hasFast: false,
  proc: null,
  waiting: null,

  start(model) {
    const args = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--model', model, '--effort', 'low',
      '--tools', '""', '--safe-mode', '--strict-mcp-config', '--no-session-persistence',
      '--system-prompt-file', 'prompt.md',
    ];
    const proc = this.proc = spawn(this.bin, args, { cwd: ROOT, shell: true });
    lines(proc.stdout, line => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === 'result' && this.waiting) {
        const w = this.waiting; this.waiting = null;
        if (msg.is_error) w.reject(new Error(msg.result || 'ошибка Claude'));
        else w.resolve(msg.result || '');
      }
    });
    proc.stderr.on('data', d => process.stderr.write('[claude] ' + d));
    proc.on('exit', code => {
      if (this.proc !== proc) return;
      console.log(`[claude] процесс завершился (${code})`);
      this.proc = null;
      if (this.waiting) { this.waiting.reject(new Error('Claude CLI упал, перезапусти модель')); this.waiting = null; }
    });
    console.log(`[claude] запущен, модель ${model}, effort low`);
  },

  send(text) {
    if (!this.proc) this.start(state.model);
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
      this.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
    });
  },

  stop() {
    const p = this.proc; this.proc = null;
    killTree(p);
    if (this.waiting) { this.waiting.reject(new Error('перезапуск')); this.waiting = null; }
  },
};

// ---------- Codex CLI: app-server (JSON-RPC по stdio), effort low, Fast = service tier priority ----------
const codex = {
  name: 'codex',
  bin: findBin('codex', 'CODEX_BIN'),
  // Заменяется списком из model/list при старте.
  models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
  hasFast: true,
  proc: null,
  ready: null,       // Promise с id треда
  nextId: 1,
  calls: new Map(),
  turn: null,        // { resolve, reject, text, error }

  start(model) {
    const proc = this.proc = spawn(this.bin, ['app-server', '--listen', 'stdio://'], { cwd: ROOT, shell: true });
    this.calls = new Map();
    lines(proc.stdout, line => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.id !== undefined && !m.method) {
        const c = this.calls.get(m.id);
        if (c) { this.calls.delete(m.id); m.error ? c.reject(new Error(m.error.message || JSON.stringify(m.error))) : c.resolve(m.result); }
      } else if (m.method && m.id !== undefined) {
        // Запросы разрешений: инструментов у нас нет, всё отклоняем.
        proc.stdin.write(JSON.stringify({ id: m.id, error: { code: -32601, message: 'not supported' } }) + '\n');
      } else if (m.method) this.onNote(m);
    });
    proc.stderr.on('data', d => { if (!/failed to refresh available models/.test(d)) process.stderr.write('[codex] ' + d); });
    proc.on('exit', code => {
      if (this.proc !== proc) return;
      console.log(`[codex] процесс завершился (${code})`);
      this.proc = null; this.ready = null;
      if (this.turn) { this.turn.reject(new Error('Codex CLI упал, перезапусти модель')); this.turn = null; }
    });
    this.ready = (async () => {
      await this.call('initialize', { clientInfo: { name: 'runtime-game', title: 'Живой платформер', version: '1.0' }, capabilities: null });
      proc.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
      this.call('model/list', {}).then(r => {
        const list = (r && r.data || []).map(x => x.id || x.model).filter(Boolean);
        if (list.length) this.models = list;
      }, () => {});
      const t = await this.call('thread/start', {
        model, serviceTier: state.fast ? 'priority' : 'default',
        sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true,
        baseInstructions: fs.readFileSync(PROMPT_FILE, 'utf8'),
      });
      return t.thread.id;
    })();
    this.ready.catch(e => console.log('[codex] не стартовал:', e.message));
    console.log(`[codex] запущен, модель ${model}, effort low${state.fast ? ', fast' : ''}`);
  },

  call(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.calls.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  },

  onNote(m) {
    const t = this.turn;
    if (!t) return;
    if (m.method === 'item/completed' && m.params.item.type === 'agentMessage') t.text = m.params.item.text;
    if (m.method === 'error') t.error = m.params.error && m.params.error.message || JSON.stringify(m.params);
    if (m.method === 'turn/completed') {
      this.turn = null;
      const turn = m.params.turn;
      if (turn.status === 'completed') t.resolve(t.text);
      else t.reject(new Error(t.error || (turn.error && turn.error.message) || 'Codex: ' + turn.status));
    }
  },

  async send(text) {
    if (!this.proc) this.start(state.model);
    const threadId = await this.ready;
    return new Promise((resolve, reject) => {
      this.turn = { resolve, reject, text: '', error: null };
      // Модель и скорость меняются на ходу, без перезапуска и без потери памяти.
      this.call('turn/start', {
        threadId, input: [{ type: 'text', text, text_elements: [] }],
        model: state.model, effort: 'low', serviceTier: state.fast ? 'priority' : 'default',
      }).catch(e => { this.turn = null; reject(e); });
    });
  },

  stop() {
    const p = this.proc; this.proc = null; this.ready = null;
    killTree(p);
    if (this.turn) { this.turn.reject(new Error('перезапуск')); this.turn = null; }
  },
};

const backends = { claude, codex };
const startEngine = process.env.GAME_ENGINE === 'codex' ? codex : claude;
const state = {
  engine: startEngine.name,
  model: startEngine.models.includes(process.env.GAME_MODEL) ? process.env.GAME_MODEL : startEngine.models[0],
  fast: process.env.GAME_FAST === '1',
};
const active = () => backends[state.engine];

// ---------- очередь: ИИ отвечает по одному ----------
const queue = [];
let busy = false;

function ask(text) {
  return new Promise((resolve, reject) => { queue.push({ text, resolve, reject }); pump(); });
}

async function pump() {
  if (busy || !queue.length) return;
  busy = true;
  const job = queue.shift();
  const t0 = Date.now();
  try { job.resolve({ text: await active().send(job.text), ms: Date.now() - t0 }); }
  catch (e) { job.reject(e); }
  busy = false;
  pump();
}

function restart(context = []) {
  for (const job of queue.splice(0)) job.reject(new Error('ИИ перезапущен'));
  for (const b of Object.values(backends)) b.stop();
  busy = false;
  active().start(state.model);
  warmUp(context);
}

// Прогрев: первый запрос к свежему процессу медленный, делаем его заранее.
// При смене модели заодно передаём ей код, который уже работает в игре.
function warmUp(context = []) {
  const known = context.length
    ? `В игре уже применены и работают эти изменения, по порядку:\n\n${context.map((c, i) => `// --- изменение ${i + 1}\n${c}`).join('\n\n')}\n\nЗапомни их. `
    : '';
  const name = state.engine;
  ask(known + 'Это прогрев. Ответь пустым блоком ```js\n// готов\n```').then(
    r => console.log(`[${name}] прогрет за ${r.ms} мс`),
    e => console.log(`[${name}] прогрев не удался:`, e.message));
}

function extractCode(text) {
  const m = text.match(/```(?:js|javascript)?\s*\n([\s\S]*?)```/i);
  return (m ? m[1] : text).trim();
}

let contextSent = false;   // получил ли текущий процесс ИИ код из браузера

function modelInfo() {
  return {
    ...state, fresh: !contextSent,
    engines: Object.fromEntries(Object.values(backends).map(b => [b.name, { models: b.models, fast: b.hasFast }])),
  };
}

// ---------- сейвы: saves/<имя>.json с кодом всех изменений по порядку ----------
const SAVES = path.join(ROOT, 'saves');

function saveFile(name) {
  const safe = String(name || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 60);
  return safe && !safe.startsWith('.') ? path.join(SAVES, safe + '.json') : null;
}

function listSaves() {
  if (!fs.existsSync(SAVES)) return [];
  return fs.readdirSync(SAVES).filter(f => f.endsWith('.json')).map(f => {
    const full = path.join(SAVES, f);
    let count = 0;
    try { count = JSON.parse(fs.readFileSync(full, 'utf8')).mods.length; } catch {}
    return { name: f.slice(0, -5), count, time: fs.statSync(full).mtimeMs };
  }).sort((a, b) => b.time - a.time);
}

// ---------- HTTP ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function readBody(req) {
  return new Promise(resolve => { let s = ''; req.on('data', d => s += d); req.on('end', () => resolve(s)); });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function handle(req, res) {
  if (req.method === 'POST' && req.url === '/ask') {
    const { text, error, name, voice, alts } = JSON.parse(await readBody(req) || '{}');
    contextSent = true;
    const who = name ? `Игрок «${String(name).slice(0, 30)}»` : 'Игрок';
    // Голос распознаёт браузер и часто ошибается — даём модели варианты и просим понять по смыслу.
    const heard = voice
      ? ` (сказал голосом; распознавание могло исказить слова — пойми по смыслу и созвучию${Array.isArray(alts) && alts.length ? '; другие варианты распознавания: ' + alts.slice(0, 4).map(a => `«${String(a).slice(0, 200)}»`).join(', ') : ''})`
      : '';
    const prompt = error
      ? `Твой прошлый код упал с ошибкой: ${error}\nПришли исправленный код (только то, что нужно добавить).`
      : `${who}${heard}: ${text}`;
    console.log('>', prompt.split('\n')[0]);
    try {
      const r = await ask(prompt);
      const code = extractCode(r.text);
      console.log(`< ${state.engine}/${state.model}${state.fast ? ' fast' : ''}: ${r.ms} мс, ${code.length} символов`);
      json(res, 200, { code, ms: r.ms });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/reset') {
    restart();
    contextSent = true;
    json(res, 200, { ok: true });
    return;
  }
  if (req.method === 'GET' && req.url === '/saves') {
    json(res, 200, listSaves());
    return;
  }
  if (req.url.startsWith('/saves/')) {
    const file = saveFile(decodeURIComponent(req.url.slice(7)));
    if (!file) { json(res, 400, { error: 'плохое имя сейва' }); return; }
    if (req.method === 'POST') {
      const { mods = [] } = JSON.parse(await readBody(req) || '{}');
      fs.mkdirSync(SAVES, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ saved: new Date().toISOString(), engine: state.engine, model: state.model, mods }, null, 2));
      console.log(`[save] ${path.basename(file)}: ${mods.length} изменений`);
      json(res, 200, { ok: true, name: path.basename(file, '.json') });
    } else if (req.method === 'DELETE') {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      json(res, 200, { ok: true });
    } else {
      if (!fs.existsSync(file)) { json(res, 404, { error: 'нет такого сейва' }); return; }
      json(res, 200, JSON.parse(fs.readFileSync(file, 'utf8')));
    }
    return;
  }
  // Новый контекст для ИИ (после загрузки сейва): перезапуск с передачей кода изменений.
  if (req.method === 'POST' && req.url === '/context') {
    const { mods = [] } = JSON.parse(await readBody(req) || '{}');
    restart(mods);
    contextSent = true;
    json(res, 200, { ok: true });
    return;
  }
  if (req.method === 'GET' && req.url === '/model') {
    json(res, 200, modelInfo());
    return;
  }
  if (req.method === 'POST' && req.url === '/model') {
    const body = JSON.parse(await readBody(req) || '{}');
    const engine = body.engine || state.engine;
    const b = backends[engine];
    if (!b) { json(res, 400, { error: 'нет такого движка: ' + engine }); return; }
    const model = body.model || (engine === state.engine ? state.model : b.models[0]);
    if (!b.models.includes(model)) { json(res, 400, { error: `у ${engine} нет модели ${model}. Доступны: ${b.models.join(', ')}` }); return; }
    const fast = b.hasFast && (body.fast ?? state.fast);
    // Codex меняет модель и скорость прямо в треде; Claude и смена движка требуют перезапуска.
    const needRestart = engine !== state.engine || (engine === 'claude' && model !== state.model);
    Object.assign(state, { engine, model, fast });
    if (needRestart) { restart(body.mods || []); contextSent = true; }
    console.log(`[model] ${engine}/${model}${fast ? ' fast' : ''}${needRestart ? ' (перезапуск)' : ''}`);
    json(res, 200, { ...modelInfo(), restarted: needRestart });
    return;
  }
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(PUBLIC, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// ---------- мультиплеер: одна комната, WebSocket без библиотек ----------
// Сервер хранит общий список изменений и пересылает сообщения. Мир считает хост —
// первый подключившийся браузер; остальные получают от него снимки мира.
const room = { clients: new Map(), hostId: null, mods: [], seeded: false, nextId: 1 };

function wsAccept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (req.url !== '/ws' || !key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  const client = { id: room.nextId++, socket, name: 'Игрок', player: null, buf: Buffer.alloc(0), parts: [] };
  socket.on('data', d => { client.buf = Buffer.concat([client.buf, d]); wsParse(client); });
  socket.on('close', () => leave(client));
  socket.on('error', () => socket.destroy());
}

function wsParse(c) {
  for (;;) {
    const b = c.buf;
    if (b.length < 2) return;
    const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    const maskOff = off; if (masked) off += 4;
    if (b.length < off + len) return;
    const data = Buffer.from(b.subarray(off, off + len));
    if (masked) for (let i = 0; i < len; i++) data[i] ^= b[maskOff + (i & 3)];
    c.buf = b.subarray(off + len);
    if (op === 8) { c.socket.end(); return; }
    if (op === 9) { wsSendRaw(c, data, 10); continue; }
    if (op === 1 || op === 2 || op === 0) {
      c.parts.push(data);
      if (fin) { const text = Buffer.concat(c.parts).toString('utf8'); c.parts = []; onWs(c, text); }
    }
  }
}

function wsSendRaw(c, payload, op = 1) {
  if (c.socket.destroyed) return;
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | op, len])
    : len < 65536 ? Buffer.from([0x80 | op, 126, len >> 8, len & 255])
    : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); return h; })();
  c.socket.write(Buffer.concat([head, payload]));
}

const send = (c, msg) => wsSendRaw(c, Buffer.from(typeof msg === 'string' ? msg : JSON.stringify(msg)));
function broadcast(msg, except) {
  const s = JSON.stringify(msg);
  for (const c of room.clients.values()) if (c !== except) send(c, s);
}

function onWs(c, text) {
  let m; try { m = JSON.parse(text); } catch { return; }
  switch (m.t) {
    case 'hello': {
      c.name = String(m.name || 'Игрок').slice(0, 20);
      room.clients.set(c.id, c);
      // Первый игрок после запуска сервера приносит свои изменения из браузера.
      if (!room.seeded) { room.seeded = true; if (Array.isArray(m.mods) && !room.mods.length) room.mods = m.mods; }
      if (!room.hostId || !room.clients.has(room.hostId)) room.hostId = c.id;
      const players = [...room.clients.values()].filter(o => o !== c).map(o => ({ id: o.id, name: o.name, s: o.player }));
      send(c, { t: 'welcome', id: c.id, hostId: room.hostId, mods: room.mods, players });
      broadcast({ t: 'join', id: c.id, name: c.name }, c);
      console.log(`[net] вошёл ${c.name} (#${c.id}), игроков: ${room.clients.size}, хост #${room.hostId}`);
      break;
    }
    case 'player': c.player = m.s; broadcast({ t: 'player', id: c.id, s: m.s }, c); break;
    case 'snap': if (c.id === room.hostId) broadcast(m, c); break;
    case 'patch': { const to = room.clients.get(m.to); if (to && c.id === room.hostId) send(to, { t: 'patch', d: m.d }); break; }
    case 'event': { const h = room.clients.get(room.hostId); if (h && h !== c) send(h, { t: 'event', from: c.id, kind: m.kind, args: m.args, s: m.s }); break; }
    case 'commit': room.mods.push(m.mod); broadcast({ t: 'addMod', mod: m.mod, by: c.name }, c); break;
    case 'setMods': room.mods = m.mods || []; broadcast({ t: 'mods', mods: room.mods, reason: m.reason, by: c.name }, c); break;
    case 'chat': broadcast({ t: 'chat', by: c.name, text: String(m.text).slice(0, 500) }, c); break;
  }
}

function leave(c) {
  if (!room.clients.delete(c.id)) return;
  broadcast({ t: 'leave', id: c.id, name: c.name });
  if (room.hostId === c.id) {
    const next = room.clients.keys().next();
    room.hostId = next.done ? null : next.value;
    if (room.hostId) broadcast({ t: 'host', hostId: room.hostId });
  }
  console.log(`[net] вышел ${c.name}, игроков: ${room.clients.size}${room.hostId ? `, хост #${room.hostId}` : ''}`);
}

// ---------- HTTPS для друзей: без него Chrome не даёт микрофон на чужом адресе ----------
// Адреса в локальной сети; туннели VPN, WSL и Docker друзьям не нужны.
function lanIps() {
  return Object.entries(os.networkInterfaces())
    .filter(([name]) => !/tun|tap|vpn|wsl|vethernet|docker|outline|happ|wireguard|zerotier|tailscale|loopback/i.test(name))
    .flatMap(([, list]) => list)
    .filter(i => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')).map(i => i.address);
}

function loadCert() {
  const dir = path.join(ROOT, 'certs'), key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    const openssl = ['openssl', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe']
      .find(p => { try { execFileSync(p, ['version'], { stdio: 'ignore' }); return true; } catch { return false; } });
    if (!openssl) { console.log('[https] openssl не найден, HTTPS выключен (голос у друзей работать не будет)'); return null; }
    fs.mkdirSync(dir, { recursive: true });
    const san = ['DNS:localhost', 'IP:127.0.0.1', ...lanIps().map(ip => 'IP:' + ip)].join(',');
    execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
      '-days', '825', '-subj', '/CN=RuntimeGame', '-addext', 'subjectAltName=' + san], { stdio: 'ignore' });
    console.log('[https] создан самоподписанный сертификат в certs/');
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

const servers = [http.createServer(handle).listen(PORT)];
try {
  const tls = loadCert();
  if (tls) servers.push(https.createServer(tls, handle).listen(HTTPS_PORT));
} catch (e) { console.log('[https] не запустился:', e.message); }
for (const s of servers) {
  s.on('upgrade', wsAccept);
  s.on('error', e => console.log('[http] ошибка:', e.message));
}

console.log(`Игра: http://localhost:${PORT}`);
for (const ip of lanIps()) {
  console.log(`Для друзей в этой сети: http://${ip}:${PORT}` + (servers[1] ? `   с голосом: https://${ip}:${HTTPS_PORT}` : ''));
}
active().start(state.model);
warmUp();

process.on('SIGINT', () => { Object.values(backends).forEach(b => b.stop()); setTimeout(() => process.exit(0), 300); });
