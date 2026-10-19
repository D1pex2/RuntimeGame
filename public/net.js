// Мультиплеер по локальной сети. Сервер хранит общий список изменений и пересылает сообщения.
// Хост (первый вошедший) считает мир и раз в 50 мс рассылает снимок; каждый двигает своего персонажа сам.
const NAME_KEY = 'live-platformer-name';
const COLORS = ['#3a8dff', '#2ecc71', '#b65cff', '#ffb02e', '#ff4fa3', '#20c9c9', '#c0392b'];

const net = {
  ws: null, id: null, hostId: null, online: false,
  remotes: new Map(),
  name: new URLSearchParams(location.search).get('name') || (() => { try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; } })(),

  get role() { return !this.online ? 'solo' : this.id === this.hostId ? 'host' : 'client'; },

  send(msg) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg)); },

  // Подключить свежий мир (после rebuild) к сети.
  attach(g) {
    g.role = this.role;
    g.remotes = this.remotes;
    g.onPatch = (id, d) => this.send({ t: 'patch', to: id, d });
    // Нажатие уходит вместе со свежим состоянием персонажа: куда смотрит, где стоит.
    g.onInput = (kind, args) => this.send({ t: 'event', kind, args, s: playerState(g.player) });
    // У каждого свой цвет, если моды не перекрасили персонажа.
    if (this.online && g.player.color === '#ff5a36' && this.id > 1) g.player.color = COLORS[(this.id - 2) % COLORS.length];
    g.spawn.x += this.online ? ((this.id || 1) - 1) % 5 * 50 : 0;
    g.player.x = g.spawn.x;
  },

  connect() {
    if (!this.name) {
      this.name = (prompt('Как тебя зовут в игре?') || '').trim().slice(0, 20) || 'Игрок ' + Math.floor(Math.random() * 100);
      try { localStorage.setItem(NAME_KEY, this.name); } catch {}
    }
    const ws = this.ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onopen = () => this.send({ t: 'hello', name: this.name, mods });
    ws.onmessage = ev => { try { this.onMessage(JSON.parse(ev.data)); } catch (e) { console.error('net', e); } };
    ws.onclose = () => {
      const was = this.online;
      this.online = false; this.remotes.clear(); game.role = 'solo';
      if (was) addMsg('Связь с сервером потеряна, переподключаюсь…', 'err');
      setTimeout(() => this.connect(), 2000);
      netStatus();
    };
  },

  setPlayer(id, name, s) {
    let r = this.remotes.get(id);
    if (!r) { r = { id, name, x: 0, y: 0, w: 32, h: 48, vx: 0, vy: 0, facing: 1, hp: 100, color: '#888' }; this.remotes.set(id, r); }
    if (name) r.name = name;
    if (!s) return;
    // Пока хост только что поменял этого игрока (урон, отскок), не даём старым данным его перезаписать.
    const locked = r._lock && game.time < r._lock;
    for (const k in s) if (!(locked && ['hp', 'dead', 'deadT', 'invuln', 'vx', 'vy'].includes(k))) r[k] = s[k];
  },

  onMessage(m) {
    switch (m.t) {
      case 'welcome': {
        this.id = m.id; this.hostId = m.hostId; this.online = true;
        this.remotes.clear();
        for (const p of m.players) this.setPlayer(p.id, p.name, p.s);
        const same = JSON.stringify(m.mods.map(x => x.id)) === JSON.stringify(mods.map(x => x.id));
        if (!same) { mods = m.mods; save(); }
        rebuild();
        addMsg(`🌐 Ты в игре как «${this.name}». ${this.role === 'host' ? 'Ты хост: мир считается у тебя.' : 'Хост — другой игрок.'} Игроков: ${this.remotes.size + 1}.`, 'ai');
        break;
      }
      case 'host': {
        const wasHost = this.role === 'host';
        this.hostId = m.hostId;
        if (this.role === 'host' && !wasHost) { rebuild(); addMsg('Хост вышел, теперь мир считается у тебя.', 'ai'); }
        else game.role = this.role;
        break;
      }
      case 'join': this.setPlayer(m.id, m.name); addMsg(`👋 ${m.name} зашёл в игру`, 'ai'); break;
      case 'leave': this.remotes.delete(m.id); addMsg(`${m.name} вышел`, 'ai'); break;
      case 'player': this.setPlayer(m.id, null, m.s); break;
      case 'snap': if (this.role === 'client') game.applySnapshot(m); break;
      case 'patch': Object.assign(game.player, m.d); break;
      case 'event': {
        if (this.role !== 'host') break;
        if (m.s) this.setPlayer(m.from, null, m.s);
        const r = this.remotes.get(m.from);
        if (r) game.withPlayer(r, () => game.emit(m.kind, ...m.args));
        break;
      }
      case 'addMod': {
        const err = run(m.mod);
        if (err) console.warn('мод от', m.by, err);
        mods.push(m.mod); save(); setStatus();
        addMsg(`✓ ${m.by}: ${describe(m.mod.code)}`, 'ai');
        break;
      }
      case 'mods':
        mods = m.mods; save(); rebuild();
        addMsg(`${m.by}: ${{ undo: '↶ отменил последнее изменение', reset: '⟲ очистил мир', load: '📂 загрузил сейв' }[m.reason] || 'обновил мир'}`, 'ai');
        break;
      case 'chat': addMsg(`${m.by}: ${m.text}`, 'other'); break;
    }
    netStatus();
  },
};

// Простые поля персонажа (позиция, скорость, цвет, флаги модов) — это и есть его сетевое состояние.
function playerState(p) {
  const s = {};
  for (const k in p) {
    const v = p[k];
    if (v === null || ['number', 'string', 'boolean'].includes(typeof v)) s[k] = typeof v === 'number' ? Math.round(v * 100) / 100 : v;
  }
  return s;
}

setInterval(() => {
  if (!net.online) return;
  net.send({ t: 'player', s: playerState(game.player) });
  if (net.role === 'host' && net.remotes.size) net.send({ t: 'snap', ...game.snapshot() });
}, 50);

function netStatus() {
  const el = document.getElementById('net');
  if (!el) return;
  el.textContent = !net.online ? '🌐 офлайн' : `🌐 ${net.remotes.size + 1} игр. · ${net.role === 'host' ? 'хост' : 'клиент'}`;
  el.title = [net.name + ' (ты)', ...[...net.remotes.values()].map(r => r.name)].join(', ');
}
