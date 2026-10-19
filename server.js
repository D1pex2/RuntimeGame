// Живой платформер: сервер раздаёт игру и держит один постоянный процесс Claude CLI,
// который превращает фразы игрока в JS-патчи.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 5173;
// Модели, которые работают на этом аккаунте; все запускаются с effort low ради скорости.
const MODELS = ['haiku', 'sonnet', 'opus'];
let model = MODELS.includes(process.env.GAME_MODEL) ? process.env.GAME_MODEL : 'haiku';
const ROOT = __dirname;
// npm-папка часто не в PATH на Windows, поэтому ищем CLI и там.
const npmClaude = path.join(process.env.APPDATA || '', 'npm', 'claude.cmd');
const CLAUDE = process.env.CLAUDE_BIN || (fs.existsSync(npmClaude) ? `"${npmClaude}"` : 'claude');
const PUBLIC = path.join(ROOT, 'public');

// ---------- Claude CLI: один процесс на всю игру, поток JSON в обе стороны ----------
let proc = null;
let buf = '';
let waiting = null;          // { resolve, reject, t0 }
const queue = [];            // очередь запросов, Claude отвечает по одному
let busy = false;

function startClaude() {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', model,
    '--effort', 'low',
    '--tools', '""',
    '--safe-mode',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--system-prompt-file', 'prompt.md',
  ];
  proc = spawn(CLAUDE, args, { cwd: ROOT, shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
  buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  });
  proc.stderr.on('data', d => process.stderr.write('[claude] ' + d));
  proc.on('exit', code => {
    console.log(`[claude] процесс завершился (${code})`);
    proc = null;
    if (waiting) { waiting.reject(new Error('Claude CLI упал, перезапускаю')); waiting = null; }
    busy = false;
    pump();
  });
  console.log(`[claude] запущен, модель ${model}, effort low`);
}

function onLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'result' && waiting) {
    const w = waiting; waiting = null;
    if (msg.is_error) w.reject(new Error(msg.result || 'ошибка Claude'));
    else w.resolve({ text: msg.result || '', ms: Date.now() - w.t0 });
  }
}

function sendToClaude(text) {
  if (!proc) startClaude();
  return new Promise((resolve, reject) => {
    waiting = { resolve, reject, t0: Date.now() };
    proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
  });
}

function ask(text) {
  return new Promise((resolve, reject) => { queue.push({ text, resolve, reject }); pump(); });
}

async function pump() {
  if (busy || !queue.length) return;
  busy = true;
  const job = queue.shift();
  try { job.resolve(await sendToClaude(job.text)); }
  catch (e) { job.reject(e); }
  busy = false;
  pump();
}

function restartClaude(context = []) {
  for (const job of queue.splice(0)) job.reject(new Error('Claude перезапущен'));
  if (proc) { const p = proc; proc = null; p.removeAllListeners('exit'); p.kill(); }
  if (waiting) { waiting.reject(new Error('сброс')); waiting = null; }
  busy = false;
  startClaude();
  warmUp(context);
}

// Прогрев: первый запрос к свежему процессу медленный, делаем его заранее.
// При смене модели заодно передаём ей код, который уже работает в игре.
function warmUp(context = []) {
  const known = context.length
    ? `В игре уже применены и работают эти изменения, по порядку:\n\n${context.map((c, i) => `// --- изменение ${i + 1}\n${c}`).join('\n\n')}\n\nЗапомни их. `
    : '';
  ask(known + 'Это прогрев. Ответь пустым блоком ```js\n// готов\n```').then(
    r => console.log(`[claude] прогрет за ${r.ms} мс`),
    e => console.log('[claude] прогрев не удался:', e.message));
}

function extractCode(text) {
  const m = text.match(/```(?:js|javascript)?\s*\n([\s\S]*?)```/i);
  return (m ? m[1] : text).trim();
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

http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/ask') {
    const { text, error } = JSON.parse(await readBody(req) || '{}');
    const prompt = error
      ? `Твой прошлый код упал с ошибкой: ${error}\nПришли исправленный код (только то, что нужно добавить).`
      : `Игрок: ${text}`;
    console.log('>', prompt.split('\n')[0]);
    try {
      const r = await ask(prompt);
      const code = extractCode(r.text);
      console.log(`< ${r.ms} мс, ${code.length} символов`);
      json(res, 200, { code, ms: r.ms });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/reset') {
    restartClaude();
    json(res, 200, { ok: true });
    return;
  }
  if (req.method === 'GET' && req.url === '/model') {
    json(res, 200, { model, models: MODELS });
    return;
  }
  if (req.method === 'POST' && req.url === '/model') {
    const { model: next, mods = [] } = JSON.parse(await readBody(req) || '{}');
    if (!MODELS.includes(next)) { json(res, 400, { error: 'нет такой модели: ' + next }); return; }
    model = next;
    restartClaude(mods);
    json(res, 200, { model });
    return;
  }
  const file = path.join(PUBLIC, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`Игра: http://localhost:${PORT}`);
  startClaude();
  warmUp();
});

process.on('exit', () => proc && proc.kill());
