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
  if (ai && aiCommand(text)) return;
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
  addMsg('Мир очищен. Память ИИ тоже сброшена.', 'ai');
  fetch('/reset', { method: 'POST' });
});

// ---------- движок, модель, ускорение ----------
const engineSel = $('engine'), modelSel = $('model'), fastBox = $('fast'), fastWrap = $('fastWrap');
let ai = null;   // { engine, model, fast, engines: { claude: { models, fast }, codex: {...} } }

function showAi() {
  engineSel.innerHTML = Object.keys(ai.engines).map(e => `<option value="${e}">${e}</option>`).join('');
  engineSel.value = ai.engine;
  modelSel.innerHTML = ai.engines[ai.engine].models.map(m => `<option value="${m}">${m}</option>`).join('');
  modelSel.value = ai.model;
  const canFast = ai.engines[ai.engine].fast;
  fastWrap.classList.toggle('off', !canFast);
  fastBox.checked = canFast && ai.fast;
}

async function loadAi() {
  try { ai = await (await fetch('/model')).json(); showAi(); } catch { return; }
  // Сервер перезапускался и ещё не знает, что уже есть в игре: передаём ему код.
  if (ai.fresh && mods.length) {
    fetch('/context', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mods: mods.map(m => m.code) }) });
    addMsg(`ИИ получил код ${mods.length} сохранённых изменений.`, 'ai');
  }
}

async function setAi(change) {
  const r = await fetch('/model', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...change, mods: mods.map(m => m.code) }),
  });
  const data = await r.json();
  if (!r.ok) { showAi(); return addMsg('Ошибка: ' + data.error, 'err'); }
  ai = data; showAi();
  const speed = ai.engines[ai.engine].fast ? (ai.fast ? ', ⚡ fast' : ', обычная скорость') : '';
  addMsg(`ИИ: ${ai.engine} / ${ai.model} (effort low${speed}).` +
    (data.restarted ? ` Передано изменений: ${mods.length}.` : ' Память сохранена.'), 'ai');
}

// Команды в чате: /model sonnet, /model gpt-6-luna, /engine codex, /fast on|off
function aiCommand(text) {
  let m = text.match(/^\/?(?:model|модель)\s+(\S+)/i);
  if (m) {
    const name = m[1].toLowerCase();
    const engine = Object.keys(ai.engines).find(e => ai.engines[e].models.includes(name));
    if (!engine) {
      const all = Object.entries(ai.engines).map(([e, v]) => `${e}: ${v.models.join(', ')}`).join('; ');
      addMsg(`Нет модели «${name}». Доступны — ${all}`, 'err');
    } else setAi({ engine, model: name });
    return true;
  }
  m = text.match(/^\/?(?:engine|движок)\s+(\S+)/i);
  if (m) { setAi({ engine: m[1].toLowerCase(), model: undefined }); return true; }
  m = text.match(/^\/?(?:fast|ускорение)\s*(on|off|вкл|выкл)?$/i);
  if (m) { setAi({ fast: m[1] ? /on|вкл/i.test(m[1]) : !ai.fast }); return true; }
  return false;
}

engineSel.addEventListener('change', () => { setAi({ engine: engineSel.value }); engineSel.blur(); });
modelSel.addEventListener('change', () => { setAi({ model: modelSel.value }); modelSel.blur(); });
fastBox.addEventListener('change', () => { setAi({ fast: fastBox.checked }); fastBox.blur(); });
loadAi();

// ---------- сейвы ----------
const savesBox = $('saves'), savesList = $('savesList');

async function saveGame() {
  if (!mods.length) return addMsg('Сохранять нечего: изменений пока нет', 'err');
  const name = prompt('Имя сейва:', new Date().toLocaleString('ru-RU').replace(/[^\d ]+/g, '-'));
  if (!name) return;
  const r = await fetch('/saves/' + encodeURIComponent(name), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mods }),
  });
  const data = await r.json();
  if (!r.ok) return addMsg('Не сохранилось: ' + data.error, 'err');
  addMsg(`💾 Сохранено «${data.name}» (${mods.length} изменений)`, 'ai');
  if (!savesBox.hidden) showSaves();
}

async function showSaves() {
  const list = await (await fetch('/saves')).json();
  savesList.innerHTML = '';
  if (!list.length) savesList.textContent = 'Сейвов пока нет. Нажми 💾 сохранить.';
  for (const s of list) {
    const row = document.createElement('div');
    row.className = 'save-row';
    const name = document.createElement('span');
    name.className = 'name'; name.textContent = s.name; name.title = 'Загрузить';
    const info = document.createElement('small');
    info.textContent = `${s.count} изм. · ${new Date(s.time).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}`;
    const dl = document.createElement('button'); dl.textContent = '⬇'; dl.title = 'Скачать код .js';
    const del = document.createElement('button'); del.textContent = '🗑'; del.title = 'Удалить сейв';
    name.onclick = () => loadGame(s.name);
    dl.onclick = () => downloadCode(s.name);
    del.onclick = async () => {
      if (!confirm(`Удалить сейв «${s.name}»?`)) return;
      await fetch('/saves/' + encodeURIComponent(s.name), { method: 'DELETE' });
      showSaves();
    };
    row.append(name, info, dl, del);
    savesList.append(row);
  }
  savesBox.hidden = false;
}

async function loadGame(name) {
  const r = await fetch('/saves/' + encodeURIComponent(name));
  const data = await r.json();
  if (!r.ok) return addMsg('Не загрузилось: ' + data.error, 'err');
  mods = data.mods; save(); rebuild();
  savesBox.hidden = true;
  addMsg(`📂 Загружено «${name}» (${mods.length} изменений). ИИ получил этот код.`, 'ai');
  fetch('/context', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mods: mods.map(m => m.code) }) });
}

async function downloadCode(name) {
  const data = await (await fetch('/saves/' + encodeURIComponent(name))).json();
  const js = data.mods.map((m, i) => `// ===== ${i + 1}. ${m.text}\n${m.code}`).join('\n\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([js], { type: 'text/javascript' }));
  a.download = name + '.js';
  a.click();
  URL.revokeObjectURL(a.href);
}

$('saveBtn').addEventListener('click', saveGame);
$('loadBtn').addEventListener('click', () => savesBox.hidden ? showSaves() : (savesBox.hidden = true));
$('savesClose').addEventListener('click', () => savesBox.hidden = true);

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
  : 'Пустой платформер. Enter — написать, ` или 🎤 — сказать голосом, что добавить в игру. Внизу — выбор ИИ (Claude или Codex), модели и ⚡ ускорения.', 'ai');
