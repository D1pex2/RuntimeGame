// Чат, голос и применение кода от Claude прямо в работающую игру.
const $ = id => document.getElementById(id);
const log = $('log'), inputEl = $('input'), statusEl = $('status'), micBtn = $('mic');
const STORE = 'live-platformer-mods';

let mods = [];
try { mods = JSON.parse(localStorage.getItem(STORE)) || []; } catch {}
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(mods)); } catch {} };

let fixBudget = 0;   // сколько авто-исправлений ещё можно попросить подряд
let pending = 0;

function addMsg(text, cls, extra) {
  const d = document.createElement('div');
  d.className = 'msg ' + cls;
  d.textContent = text;
  if (extra) { const s = document.createElement('small'); s.textContent = extra; d.append(s); }
  log.append(d);
  while (log.children.length > 30) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
  return d;
}

function setStatus() {
  statusEl.textContent = (pending ? `думаю… (${pending}) · ` : '') + `изменений: ${mods.length}`;
}

// Выполнить код мода на текущем мире. Возвращает ошибку или null.
function run(mod) {
  game.currentMod = mod.id;
  try { new Function('game', 'ctx', mod.code)(game, game.ctx); return null; }
  catch (e) { return e; }
  finally { game.currentMod = null; }
}

// Мир с нуля + все моды по порядку (нужно для отмены и после перезагрузки страницы).
function rebuild() {
  window.game = createGame();
  game.onError = onRuntimeError;
  for (const m of mods) { const e = run(m); if (e) console.warn('мод', m.id, e); }
  setStatus();
}

let errTimer = null, errText = '';
function onRuntimeError(e, modId, where) {
  errText = `${where}: ${e && e.message || e}`;
  clearTimeout(errTimer);
  errTimer = setTimeout(() => {
    addMsg('⚠ ' + errText, 'err');
    if (fixBudget > 0) { fixBudget--; request({ error: errText }); }
  }, 250);
}

function describe(code) {
  const m = code.match(/^\s*\/\/\s*(.+)/);
  return m ? m[1] : 'готово';
}

async function request(body) {
  pending++; setStatus();
  const wait = addMsg(body.error ? 'чиню ошибку…' : 'думаю…', 'wait');
  const t0 = performance.now();
  try {
    const r = await fetch('/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json();
    wait.remove();
    if (!r.ok) throw new Error(data.error || r.status);
    const mod = { id: Date.now() + Math.random(), code: data.code, text: body.text || '(исправление)' };
    const err = run(mod);
    const secs = ((performance.now() - t0) / 1000).toFixed(1) + ' с';
    if (err) {
      addMsg('⚠ код упал: ' + err.message, 'err', secs);
      if (fixBudget > 0) { fixBudget--; request({ error: err.message }); }
    } else {
      mods.push(mod); save();
      addMsg('✓ ' + describe(data.code), 'ai', secs);
    }
  } catch (e) {
    wait.remove();
    addMsg('Ошибка: ' + e.message, 'err');
  } finally {
    pending--; setStatus();
  }
}

function sendText(text) {
  text = text.trim();
  if (!text) return;
  const cmd = text.match(/^\/?(?:model|модель)\s+(\S+)/i);
  if (cmd) return setModel(cmd[1].toLowerCase());
  addMsg(text, 'me');
  fixBudget = 2;
  request({ text });
}

// ---------- чат ----------
$('chat').addEventListener('submit', e => {
  e.preventDefault();
  sendText(inputEl.value);
  inputEl.value = '';
  inputEl.blur();
});
inputEl.addEventListener('focus', () => { input.typing = true; input.keys.clear(); });
inputEl.addEventListener('blur', () => input.typing = false);
inputEl.addEventListener('keydown', e => { if (e.key === 'Escape') inputEl.blur(); });
addEventListener('keydown', e => {
  if (input.typing) return;
  if (e.key === 'Enter' || e.key === '/') { e.preventDefault(); inputEl.focus(); }
  if (e.code === 'Backquote') { e.preventDefault(); toggleMic(); }
});

$('undo').addEventListener('click', () => {
  if (!mods.length) return;
  const m = mods.pop(); save(); rebuild();
  addMsg('↶ отменено: ' + m.text, 'ai');
});
$('reset').addEventListener('click', async () => {
  if (!confirm('Стереть все изменения и начать заново?')) return;
  mods = []; save(); rebuild(); log.innerHTML = '';
  addMsg('Мир очищен. Память Claude тоже сброшена.', 'ai');
  fetch('/reset', { method: 'POST' });
});

// ---------- модель ----------
const modelSel = $('model');
let models = [];

async function loadModels() {
  try {
    const r = await (await fetch('/model')).json();
    models = r.models;
    modelSel.innerHTML = models.map(m => `<option value="${m}">${m}</option>`).join('');
    modelSel.value = r.model;
  } catch {}
}

async function setModel(name) {
  if (!models.includes(name)) {
    modelSel.value = modelSel.dataset.current || modelSel.value;
    return addMsg(`Нет модели «${name}». Доступны: ${models.join(', ')}`, 'err');
  }
  const r = await fetch('/model', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: name, mods: mods.map(m => m.code) }),
  });
  const data = await r.json();
  if (!r.ok) return addMsg('Ошибка: ' + data.error, 'err');
  modelSel.value = modelSel.dataset.current = data.model;
  addMsg(`Модель: ${data.model} (effort low). Передано ей изменений: ${mods.length}.`, 'ai');
}

modelSel.addEventListener('change', () => { setModel(modelSel.value); modelSel.blur(); });
loadModels().then(() => modelSel.dataset.current = modelSel.value);

// ---------- голос ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, listening = false;
if (!SR) { micBtn.disabled = true; micBtn.title = 'Голос работает в Chrome или Edge'; }

function toggleMic() {
  if (!SR) return addMsg('Голос поддерживается только в Chrome или Edge', 'err');
  if (listening) { listening = false; rec && rec.stop(); return; }
  rec = new SR();
  rec.lang = 'ru-RU'; rec.continuous = true; rec.interimResults = true;
  rec.onresult = ev => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) { inputEl.placeholder = 'Enter — написать, что поменять в игре…'; sendText(r[0].transcript); }
      else interim += r[0].transcript;
    }
    if (interim) inputEl.placeholder = '🎤 ' + interim;
  };
  rec.onerror = ev => { if (ev.error !== 'no-speech') addMsg('Микрофон: ' + ev.error, 'err'); };
  rec.onend = () => { if (listening) rec.start(); else micBtn.classList.remove('on'); };
  listening = true; micBtn.classList.add('on');
  rec.start();
}
micBtn.addEventListener('click', toggleMic);

// ---------- старт ----------
rebuild();
addMsg(mods.length
  ? `Восстановлено изменений: ${mods.length}. Пиши или говори, что добавить.`
  : 'Пустой платформер. Enter — написать, ` или 🎤 — сказать голосом, что добавить в игру. «/model sonnet» — сменить модель.', 'ai');
