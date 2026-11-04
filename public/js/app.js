/* =========================================================
   双人房 · 前端逻辑
   - 单人模式：纯本地
   - 双人模式：HTTP + SSE 实时同步（转盘角度 / 结果卡 / 倒计时 / 安全词）
   ========================================================= */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const PALETTES = {
    sweet: ['#ff9ab8', '#e0678f'],
    flirt: ['#ff7ba0', '#cc4d75'],
    tease: ['#df557a', '#a63257'],
    play:  ['#b8456b', '#782845'],
  };

  const state = {
    mode: null,            // solo | host | guest
    code: null,
    uid: null,
    role: null,
    name: '我',
    partnerName: null,
    members: [],
    theme: 'sweet',
    level: 1,
    points: 0,
    history: [],
    turns: 0,
    spinning: false,
    connected: false,
    es: null,
    custom: loadCustom(),
    lastCardKey: null,
    lastWheelIdx: null,
    timerId: null,
    paused: false,
    turnName: null,
    navStack: [],
  };

  /* ------------------------------------------------------------------ */
  /* 工具                                                                */
  /* ------------------------------------------------------------------ */
  const isDuo = () => state.mode === 'host' || state.mode === 'guest';

  function toast(msg, ms = 2000) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.remove('show'), ms);
  }

  function vibrate(p = 12) {
    if (navigator.vibrate) navigator.vibrate(p);
  }

  function loadCustom() {
    try {
      return JSON.parse(localStorage.getItem('duo_custom') || '{}');
    } catch { return {}; }
  }
  function saveCustom() {
    try { localStorage.setItem('duo_custom', JSON.stringify(state.custom)); } catch {}
  }

  function customPool(type, level) {
    return (state.custom[`${type}-${level}`] || []);
  }

  /* ------------------------------------------------------------------ */
  /* 网络层 —— 两个人直接点对点连（WebRTC）                              */
  /* 没有任何业务服务器，房间码就是对方的地址，静态托管也能同步。        */
  /* ------------------------------------------------------------------ */
  const newUid = () => Math.random().toString(36).slice(2, 10);

  function sendRaw(msg) {
    return window.P2P ? P2P.send(msg) : false;
  }

  function emit(event) {
    if (!isDuo() || !state.connected) return;
    sendRaw({ ...event, from: state.uid, fromName: state.name });
  }

  function activeView() {
    const id = document.querySelector('.screen.active')?.id || '';
    return id.replace('screen-', '') || 'room';
  }

  function roomSnapshot() {
    return {
      theme: state.theme,
      level: state.level,
      points: state.points,
      history: state.history,
      turnName: state.turnName,
      paused: state.paused,
      view: activeView(),
    };
  }

  // 把 P2P 的四个事件接到 UI 上
  function wireP2P() {
    P2P.on('status', (text, kind) => {
      const hint = $('#waitHint');
      if (kind === 'error') {
        toast(text, 4200);
        if (hint) hint.textContent = text;
        setConn(false);
      } else if (hint && !state.connected) {
        hint.textContent = text;
      }
    });

    P2P.on('open', () => {
      setConn(true);
      if (state.role === 'guest') {
        // 报上名号，等房主把进度发过来
        sendRaw({ type: 'hello', uid: state.uid, name: state.name });
      }
    });

    P2P.on('message', (msg) => handleEvent(msg));

    P2P.on('close', () => {
      setConn(false);
      const other = state.members.find(m => m.uid !== state.uid);
      if (other) other.online = false;
      state.partnerName = null;
      renderMembers();
      renderTurn();
      const start = $('#startPlay');
      if (start) start.disabled = true;
      const hint = $('#waitHint');
      if (hint) hint.textContent = 'Ta 掉线了，刷新页面重新连一次';
      toast('Ta 掉线了，等 Ta 回来');
    });
  }

  function setConn(on) {
    state.connected = on;
    ['#connDot', '#connDot2'].forEach(sel => {
      const el = $(sel);
      if (!el) return;
      el.classList.toggle('on', on);
      const b = el.querySelector('b');
      if (b) b.textContent = on ? (isDuo() ? '已同步' : '单人') : '重连中';
    });
  }

  function handleEvent(msg) {
    if (!msg || typeof msg !== 'object') return;

    /* 有人敲门：房主登记来客，并把当前进度打包发过去 */
    if (msg.type === 'hello') {
      if (state.role !== 'host') return;
      const uid = msg.uid || 'g' + Math.random().toString(36).slice(2, 8);
      const name = String(msg.name || 'Ta').slice(0, 8);
      if (!state.members.some(m => m.uid === uid)) {
        state.members.push({ uid, name, role: 'guest', online: true });
      }
      state.partnerName = name;
      renderMembers();
      renderTurn();
      sendRaw({ type: 'snapshot', snapshot: { members: state.members, state: roomSnapshot() } });
      $('#startPlay').disabled = false;
      $('#waitHint').textContent = `${name} 已就位，可以开始了`;
      toast(`${name} 进来了 💗`);
      vibrate(24);
      return;
    }

    /* 刚进屋：接住房主发来的现场 */
    if (msg.type === 'snapshot') {
      const snap = msg.snapshot || {};
      state.members = snap.members || state.members;
      const other = state.members.find(m => m.uid !== state.uid);
      if (other) state.partnerName = other.name;
      renderMembers();
      renderTurn();
      if (snap.state) {
        restoreState(snap.state);
        renderPoints();
        buildThemePills();
        buildLevelPills();
        applyTheme(state.theme, false);
        applyLevel(state.level, false);
        renderHistory();
        const v = snap.state.view;
        if (['wheel', 'truth'].includes(v)) {
          go(v);
          if (v === 'wheel') drawWheel();
        }
      }
      $('#startPlay').disabled = false;
      $('#waitHint').textContent = `${state.partnerName || 'Ta'} 已就位，可以开始了`;
      toast('已接上 Ta 的进度');
      return;
    }

    if (msg.from && msg.from === state.uid) return;

    switch (msg.type) {
      case 'name':
        if (msg.name && msg.from !== state.uid) {
          const me = state.members.find(m => m.uid === msg.from);
          if (me) me.name = msg.name;
          state.partnerName = msg.name;
          renderMembers();
          renderTurn();
        }
        break;
      case 'nav':
        if (msg.view) go(msg.view);
        break;
      case 'theme':
        applyTheme(msg.theme, false);
        break;
      case 'level':
        applyLevel(msg.level, false);
        break;
      case 'points':
        state.points = msg.points || 0;
        renderPoints();
        break;
      case 'spin': {
        applyTheme(msg.theme, false);
        toast(`${msg.fromName} 转了一下转盘`);
        spinWheel({ index: msg.index, spins: msg.spins, remote: true });
        break;
      }
      case 'card':
        applyLevel(msg.level, false);
        showCard(msg.cardType, msg.cardText, { remote: true, by: msg.fromName });
        break;
      case 'timer':
        startTimer(msg.seconds, true);
        break;
      case 'safeword':
        state.paused = true;
        $('#stopWho').textContent = `${msg.fromName} 喊了「${msg.word || '红灯'}」`;
        $('#stopOverlay').hidden = false;
        vibrate([40, 60, 40]);
        break;
      case 'resume':
        state.paused = false;
        $('#stopOverlay').hidden = true;
        toast('继续 · 记得随时可以再喊停');
        break;
      case 'history':
        state.history = msg.history || [];
        renderHistory();
        break;
      case 'poke':
        toast(`${msg.fromName} 戳了你一下 👉`);
        vibrate(30);
        break;
      case 'turn':
        state.turnName = msg.name;
        renderTurn();
        break;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 导航                                                                */
  /*  navStack 记录来路，「←」永远回到上一页，不会突然跳回首页。         */
  /* ------------------------------------------------------------------ */
  const screenEl = (id) => document.getElementById(`screen-${id}`);
  const TAB_SCREENS = ['wheel', 'truth', 'safety'];   // 同一层的兄弟页

  function go(id, opts = {}) {
    const el = screenEl(id);
    if (!el) return;

    const cur = state.navStack[state.navStack.length - 1];
    $$('.screen').forEach(s => s.classList.remove('active'));
    el.classList.add('active');
    el.scrollTop = 0;

    if (!opts.silent && cur !== id) {
      const at = state.navStack.lastIndexOf(id);
      if (at >= 0) {
        // 这一页在来路上出现过：把栈截回去，避免出现「返回要按两次」
        state.navStack.length = at + 1;
      } else if (TAB_SCREENS.includes(id) && TAB_SCREENS.includes(cur)) {
        // 转盘 / 真心话 / 规则 互为兄弟，横向切换时替换栈顶
        state.navStack[state.navStack.length - 1] = id;
      } else {
        state.navStack.push(id);
      }
      if (state.navStack.length > 12) state.navStack = state.navStack.slice(-12);
    }

    const showTab = TAB_SCREENS.includes(id);
    $('#tabbar').hidden = !showTab;
    el.classList.toggle('has-tab', showTab);
    $$('#tabbar button').forEach(b => b.classList.toggle('active', b.dataset.nav === id));

    if (showTab) setConn(state.connected);
    if (id === 'wheel' || id === 'truth') renderTurn();

    document.title = id === 'wheel' ? '转盘 · 双人房'
      : id === 'truth' ? '真心话 · 双人房'
      : '双人房';
  }

  function goRemote(id) {
    go(id);
    if (isDuo()) emit({ type: 'nav', view: id });
  }

  function back() {
    const cur = state.navStack[state.navStack.length - 1];
    if (state.navStack.length > 1) state.navStack.pop();
    const prev = state.navStack[state.navStack.length - 1] || 'home';

    // 从房间退回首页 = 主动散场，把点对点连接也关掉，别留一个空房间挂着
    if (cur === 'room' && prev === 'home') leaveRoom();
    go(prev, { silent: true });
  }

  function leaveRoom() {
    if (window.P2P) { try { P2P.destroy(); } catch {} }
    state.mode = null;
    state.role = null;
    state.code = null;
    state.connected = false;
    state.members = [];
    state.partnerName = null;
    state.turnName = null;
    setConn(false);
  }

  /* ------------------------------------------------------------------ */
  /* 房间                                                                */
  /* ------------------------------------------------------------------ */
  function renderMembers() {
    const box = $('#members');
    const self = { name: state.name || '我', role: state.role || 'solo' };
    const other = state.members.find(m => m.uid !== state.uid);

    const slot = (m, isSelf) => {
      if (!m) return `<div class="member empty"><div class="avatar">?</div><span>等 Ta 进来…</span></div>`;
      const label = isSelf ? `${m.name}（你）` : m.name;
      return `<div class="member filled"><div class="avatar">${escapeHtml((m.name || '?').slice(0, 1))}</div><span>${escapeHtml(label)}</span></div>`;
    };

    if (!isDuo()) {
      box.innerHTML = `
        <div class="member filled"><div class="avatar">${escapeHtml((self.name || '我').slice(0, 1))}</div><span>${escapeHtml(self.name)}（单人）</span></div>`;
      return;
    }
    box.innerHTML = slot({ name: state.name, uid: state.uid }, true) + slot(other, false);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function createRoom() {
    const name = localStorage.getItem('duo_name') || '我';
    state.mode = 'host';
    state.role = 'host';
    state.name = name;
    state.uid = newUid();
    state.turnName = name;
    state.code = null;
    state.members = [{ uid: state.uid, name, role: 'host', online: true }];

    setupRoomScreen('host');
    go('room');
    const hint = $('#waitHint');
    if (hint) hint.textContent = '正在开房…';

    P2P.host((code) => {
      state.code = code;
      const el = $('#codeValue');
      if (el) el.textContent = code;
      if (navigator.clipboard) navigator.clipboard.writeText(code).catch(() => {});
      toast('房间开好了，匹配码已复制');
      if (hint) hint.textContent = '等 Ta 进来，两个人一起开始';
    });
    // 每次开房都用新的随机码，不再复用上一次的号码
    try { localStorage.removeItem('duo_code'); } catch {}
  }

  function joinRoom() {
    const code = $('#joinInput').value.replace(/\D/g, '');
    const name = ($('#joinName').value.trim() || 'Ta').slice(0, 8);
    const err = $('#joinErr');
    err.textContent = '';
    if (code.length !== 6) {
      err.textContent = '匹配码是 6 位数字';
      return;
    }

    state.mode = 'guest';
    state.role = 'guest';
    state.code = code;
    state.uid = newUid();
    state.name = name;
    state.members = [{ uid: state.uid, name, role: 'guest', online: true }];
    localStorage.setItem('duo_name', name);

    setupRoomScreen('guest');
    go('room');
    const hint = $('#waitHint');
    if (hint) hint.textContent = '正在连接 Ta 的房间…';

    P2P.join(code, () => {
      toast('连上了，等 Ta 把进度发过来');
    });
  }

  function setupRoomScreen(kind) {
    $('#roomTitle').textContent = kind === 'host' ? '你的双人房' : '双人房';
    $('#codeCard').hidden = false;
    $('#codeValue').textContent = state.code || '------';
    $('#codeLabel').textContent = kind === 'host' ? '把这串数字发给 Ta' : '你们在同一个房间里';
    $('#codeTip').textContent = kind === 'host'
      ? 'Ta 在首页选「我有匹配码」，输入即可进入同一个房间'
      : 'Ta 点「开始今晚」或你点，两边会同时进入玩法';
    $('#joinBox').hidden = true;
    $('#roomActions').hidden = false;
    $('#hostName').value = kind === 'host' ? state.name : '';
    $('#hostName').hidden = kind === 'guest';
    $('#copyCode').hidden = kind === 'guest';
    $('#regenCode').hidden = kind === 'guest';

    const steps = $('#roomSteps');
    if (steps) {
      steps.innerHTML = kind === 'host'
        ? `<p class="steps-title">接下来</p><ol>
            <li><b>1</b><span>把上面这 6 位数字发给 Ta（微信、短信都行）</span></li>
            <li><b>2</b><span>Ta 在首页点「我有匹配码」，输进去就进到同一个房间</span></li>
            <li><b>3</b><span>谁转的转盘、谁抽的卡，两边屏幕会同时显示</span></li>
          </ol>`
        : `<p class="steps-title">你们已经连上了</p><ol>
            <li><b>1</b><span>任一方点「开始今晚」，两边会同时进入玩法页</span></li>
            <li><b>2</b><span>转盘、抽卡、倒计时、积分都是双向同步的</span></li>
            <li><b>3</b><span>页面底部有「安全词」，任何时候按下去，两个人一起停</span></li>
          </ol>`;
    }

    renderMembers();
    const others = state.members.filter(m => m.uid !== state.uid).length;
    $('#startPlay').disabled = others === 0;
    $('#waitHint').textContent = others === 0 ? '等 Ta 进来，两个人一起开始' : `${state.partnerName || 'Ta'} 已就位，可以开始了`;
  }

  function restoreState(s) {
    if (s.theme) { state.theme = s.theme; }
    if (s.level) state.level = s.level;
    state.points = s.points || 0;
    state.history = s.history || [];
    if (s.turnName) state.turnName = s.turnName;
  }

  /* ------------------------------------------------------------------ */
  /* 转盘                                                                */
  /* ------------------------------------------------------------------ */
  function buildThemePills() {
    const box = $('#themePills');
    box.innerHTML = CONTENT.themeOrder.map(id => {
      const t = CONTENT.themes[id];
      return `<button class="pill${id === state.theme ? ' active' : ''}" data-theme="${id}">
        <b>${t.badge}</b>${t.name}
      </button>`;
    }).join('');
  }

  function applyTheme(id, sync = true) {
    if (!CONTENT.themes[id]) return;
    state.theme = id;
    buildThemePills();
    $('#themeSub').textContent = CONTENT.themes[id].sub;
    drawWheel();
    if (sync) emit({ type: 'theme', theme: id });
  }

  function drawWheel() {
    const canvas = $('#wheel');
    if (!canvas) return;
    const size = canvas.clientWidth || 320;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    const theme = CONTENT.themes[state.theme];
    const segs = theme.segments;
    const n = segs.length;
    const segAngle = (Math.PI * 2) / n;
    const cx = size / 2, cy = size / 2, R = size / 2 - 4;
    const pal = PALETTES[state.theme] || PALETTES.sweet;

    for (let i = 0; i < n; i++) {
      const a0 = -Math.PI / 2 + i * segAngle;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, a0, a0 + segAngle);
      ctx.closePath();
      ctx.fillStyle = i % 2 === 0 ? pal[0] : pal[1];
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(16,6,16,0.55)';
      ctx.stroke();

      // 文字：左半边翻转让字正过来
      const label = segs[i].label;
      const mid = a0 + segAngle / 2;
      const flip = Math.cos(mid) < 0;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(flip ? mid + Math.PI : mid);
      ctx.textAlign = flip ? 'left' : 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      const fs = label.length > 5 ? size * 0.038 : size * 0.043;
      ctx.font = `600 ${fs}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = 4;
      ctx.fillText(label, flip ? -(R - 18) : (R - 18), 0);
      ctx.restore();
    }

    // 外圈描边
    ctx.beginPath();
    ctx.arc(cx, cy, R - 1, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255, 214, 226, 0.55)';
    ctx.stroke();

    // 内圈
    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.135, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(16,6,16,0.9)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255, 214, 226, 0.4)';
    ctx.stroke();
  }

  function spinWheel({ index, spins, remote = false } = {}) {
    if (state.spinning) return null;
    const theme = CONTENT.themes[state.theme];
    const n = theme.segments.length;
    const idx = typeof index === 'number' ? index : Math.floor(Math.random() * n);
    const turns = typeof spins === 'number' ? spins : 5 + Math.floor(Math.random() * 3);
    const segDeg = 360 / n;
    const base = (360 - (idx * segDeg + segDeg / 2)) % 360;

    state.turns += turns;
    const target = base + 360 * state.turns;

    state.spinning = true;
    const canvas = $('#wheel');
    canvas.style.transform = `rotate(${target}deg)`;
    $('#spinBtn').disabled = true;
    if (!remote) vibrate(18);

    setTimeout(() => {
      state.spinning = false;
      $('#spinBtn').disabled = false;
      state.lastWheelIdx = idx;
      renderWheelResult(idx);
      if (!remote) {
        vibrate([16, 40, 16]);
        emit({ type: 'spin', theme: state.theme, index: idx, spins: turns });
      }
    }, 4650);

    return { idx, turns };
  }

  function renderWheelResult(idx) {
    const theme = CONTENT.themes[state.theme];
    const s = theme.segments[idx];
    const box = $('#wheelResult');
    box.innerHTML = `
      <div class="result-card">
        <span class="result-tag">${theme.badge} ${theme.name} · 转盘</span>
        <h2 class="result-title">${escapeHtml(s.label)}</h2>
        <p class="result-desc">${escapeHtml(s.desc)}</p>
        <div class="result-meta">
          ${s.dur ? `<span>建议 <b>${s.dur}s</b></span>` : ''}
          <span>亲密度 <b>+${s.points || 1}</b></span>
        </div>
        <div class="result-btns">
          ${s.dur ? `<button class="btn btn-soft" data-act="timer" data-sec="${s.dur}">开始计时</button>` : ''}
          <button class="btn btn-primary" data-act="done" data-label="${escapeHtml(theme.name + '·' + s.label)}" data-points="${s.points || 1}">我们完成了</button>
        </div>
      </div>`;
    if (s.dur) setTimeout(() => {}, 0);
  }

  /* ------------------------------------------------------------------ */
  /* 真心话 / 大冒险                                                     */
  /* ------------------------------------------------------------------ */
  function buildLevelPills() {
    const box = $('#levelPills');
    box.innerHTML = [1, 2, 3, 4].map(lv => {
      const l = CONTENT.levels[lv];
      return `<button class="pill${lv === state.level ? ' active' : ''}" data-level="${lv}">
        <b>${l.badge}</b>${l.name}
      </button>`;
    }).join('');
  }

  function applyLevel(lv, sync = true) {
    state.level = Number(lv);
    buildLevelPills();
    const pool = CONTENT.cards.dare[state.level] || [];
    $('#dareCount').textContent = `${pool.length} 张`;
    $('#truthCount').textContent = `${(CONTENT.cards.truth[state.level] || []).length} 张`;
    if (sync) emit({ type: 'level', level: state.level });
  }

  function pickCard(type) {
    const base = (CONTENT.cards[type] && CONTENT.cards[type][state.level]) || [];
    const extra = customPool(type, state.level);
    const pool = [...base, ...extra];
    if (!pool.length) return null;
    let text = pool[Math.floor(Math.random() * pool.length)];
    let guard = 0;
    while (text === state.lastCardKey && pool.length > 1 && guard++ < 8) {
      text = pool[Math.floor(Math.random() * pool.length)];
    }
    state.lastCardKey = text;
    showCard(type, text, {});
    emit({ type: 'card', cardType: type, level: state.level, cardText: text });
    return text;
  }

  function showCard(type, text, opts = {}) {
    const isTruth = type === 'truth';
    const lv = CONTENT.levels[state.level];
    const box = $('#truthResult');
    box.innerHTML = `
      <div class="result-card">
        <span class="result-tag">${isTruth ? '🗝️ 真心话' : '🔥 大冒险'} · ${lv.badge} ${lv.name}</span>
        <p class="result-desc" style="font-size:17px;line-height:1.85;color:#fff;font-weight:550;margin-bottom:18px">${escapeHtml(text)}</p>
        <div class="result-btns">
          ${isTruth ? `<button class="btn btn-soft" data-act="timer" data-sec="60">思考 60s</button>`
                    : `<button class="btn btn-soft" data-act="timer" data-sec="90">计时 90s</button>`}
          <button class="btn btn-primary" data-act="done" data-label="${escapeHtml((isTruth ? '真心话·' : '大冒险·') + lv.name)}" data-points="2">完成了</button>
        </div>
        <div class="result-btns" style="margin-top:10px">
          <button class="btn btn-ghost" data-act="again" data-type="${type}">换一张</button>
        </div>
      </div>`;
    vibrate(12);
  }

  /* ------------------------------------------------------------------ */
  /* 计时器                                                              */
  /* ------------------------------------------------------------------ */
  function startTimer(seconds, remote = false, hostSel) {
    clearInterval(state.timerId);
    let left = Number(seconds) || 60;
    const activeId = document.querySelector('.screen.active')?.id || '';
    const panel = $(hostSel || (activeId === 'screen-truth' ? '#truthResult' : '#wheelResult'));
    let el = panel.querySelector('.timer');
    if (!el) {
      el = document.createElement('div');
      el.className = 'timer';
      panel.querySelector('.result-card')?.prepend(el);
    }
    if (!el) return;
    el.textContent = `${left}`;
    el.classList.remove('warn');
    if (!remote) emit({ type: 'timer', seconds: left });
    state.timerId = setInterval(() => {
      left -= 1;
      el.textContent = `${Math.max(left, 0)}`;
      if (left <= 10) el.classList.add('warn');
      if (left <= 0) {
        clearInterval(state.timerId);
        el.textContent = '时间到';
        vibrate([30, 50, 30]);
      }
    }, 1000);
  }

  /* ------------------------------------------------------------------ */
  /* 积分 / 历史                                                         */
  /* ------------------------------------------------------------------ */
  function renderPoints() {
    ['#pointsPill', '#pointsPill2'].forEach(sel => {
      const el = $(sel);
      if (el) el.innerHTML = `💗 <b>${state.points}</b>`;
    });
  }

  function addPoints(n, label) {
    state.points += n;
    renderPoints();
    emit({ type: 'points', points: state.points });
    if (label) {
      state.history.unshift({ label, at: Date.now(), by: state.name });
      state.history = state.history.slice(0, 30);
      renderHistory();
      emit({ type: 'history', history: state.history });
      renderTurn();
    }
  }

  function renderHistory() {
    const ul = $('#historyList');
    if (!ul) return;
    if (!state.history.length) {
      ul.innerHTML = '<li class="empty">还没有记录</li>';
      return;
    }
    ul.innerHTML = state.history.map(h => `
      <li><span class="dot">●</span>${escapeHtml(h.label)}<em style="font-style:normal;color:#7d6470;margin-left:auto">${new Date(h.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</em></li>
    `).join('');
  }

  /* ------------------------------------------------------------------ */
  /* 回合                                                                */
  /* ------------------------------------------------------------------ */
  function renderTurn() {
    ['#turnBar', '#turnBar2'].forEach(sel => {
      const bar = $(sel);
      if (!bar) return;
      if (!isDuo()) {
        bar.innerHTML = `<span>今晚已完成 <b>${state.history.length}</b> 项</span><span style="font-size:11px">💗 ${state.points}</span>`;
        return;
      }
      const who = state.turnName || state.name || '我';
      const isMe = who === state.name;
      bar.innerHTML = `<span>本轮轮到 <b>${escapeHtml(who)}</b>${isMe ? '（你）' : ''}</span>
        <button class="turn-swap" data-act="swap">换 Ta</button>`;
    });
  }

  function swapTurn() {
    if (!isDuo()) return;
    const partner = state.partnerName || 'Ta';
    state.turnName = (state.turnName === partner) ? (state.name || '我') : partner;
    renderTurn();
    emit({ type: 'turn', name: state.turnName });
  }

  /* ------------------------------------------------------------------ */
  /* 安全词                                                              */
  /* ------------------------------------------------------------------ */
  function callSafeword(word = '红灯') {
    state.paused = true;
    $('#stopWho').textContent = '你喊了安全词';
    $('#stopOverlay').hidden = false;
    vibrate([60, 80, 60]);
    emit({ type: 'safeword', word, paused: true });
  }

  function resume() {
    state.paused = false;
    $('#stopOverlay').hidden = true;
    emit({ type: 'resume' });
    toast('继续 · 随时可以再喊停');
  }

  /* ------------------------------------------------------------------ */
  /* 初始化                                                              */
  /* ------------------------------------------------------------------ */
  function init() {
    // 门禁
    $('#gateEnter').addEventListener('click', () => {
      $('#gate').classList.add('hidden');
      go('home');
    });
    $('#gateLeave').addEventListener('click', () => {
      $('#gate').innerHTML = `<div class="gate-inner"><div class="stop-icon" style="font-size:40px">🌙</div>
        <h2 style="letter-spacing:.1em">那就下次</h2>
        <p style="color:#b193a2;font-size:13px;line-height:1.8;margin-top:10px">这扇门一直开着。</p></div>`;
    });

    // 首页三个入口
    document.addEventListener('click', (e) => {
      const tile = e.target.closest('[data-action]');
      if (tile) {
        const a = tile.dataset.action;
        if (a === 'create') createRoom();
        if (a === 'join') {
          go('room');
          $('#roomTitle').textContent = '输入匹配码';
          $('#codeCard').hidden = true;
          $('#roomActions').hidden = true;
          $('#joinBox').hidden = false;
          $('#joinErr').textContent = '';
          setTimeout(() => $('#joinInput').focus(), 260);
        }
        if (a === 'solo') {
          state.mode = 'solo';
          state.name = localStorage.getItem('duo_name') || '我';
          go('mode');
          setConn(false);
          $('#connDot2').querySelector('b').textContent = '单人';
        }
      }

      // 返回 / 页面跳转
      const nav = e.target.closest('[data-nav]');
      if (nav) {
        const t = nav.dataset.nav;
        if (t === 'back') back();
        else if (t === 'home') {
          if (activeView() === 'room') leaveRoom();
          go('home');
        }
        else if (t === 'room') {
          if (!isDuo()) return go('mode');
          go('room');
        } else go(t);
      }

      // 模式卡
      const mode = e.target.closest('[data-mode]');
      if (mode) {
        const m = mode.dataset.mode;
        go(m);  // wheel 或 truth
        if (isDuo()) emit({ type: 'nav', view: m });
        if (m === 'wheel') { drawWheel(); applyTheme(state.theme, false); }
        if (m === 'truth') { applyLevel(state.level, false); }
      }

      // 主题
      const th = e.target.closest('[data-theme]');
      if (th) applyTheme(th.dataset.theme);

      // 档位
      const lv = e.target.closest('[data-level]');
      if (lv) applyLevel(lv.dataset.level);

      // 抽卡
      const pick = e.target.closest('[data-pick]');
      if (pick) pickCard(pick.dataset.pick);

      // 结果卡按钮
      const act = e.target.closest('[data-act]');
      if (act) {
        const a = act.dataset.act;
        if (a === 'timer') startTimer(Number(act.dataset.sec) || 60);
        if (a === 'swap') swapTurn();
        if (a === 'done') {
          addPoints(Number(act.dataset.points) || 1, act.dataset.label || '完成一项');
          toast('记下了 💗' + (isDuo() ? ' 换 Ta' : ''));
          act.disabled = true;
          act.textContent = '已完成 ✓';
          if (isDuo()) setTimeout(() => swapTurn(), 600);
        }
        if (a === 'again') pickCard(act.dataset.type);
      }
    });

    // 转盘
    $('#spinBtn').addEventListener('click', () => {
      if (state.spinning) return;
      spinWheel({});
    });

    // 房间动作
    $('#copyCode').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(state.code || '');
        toast('匹配码已复制，发给 Ta 吧');
      } catch {
        const ta = document.createElement('textarea');
        ta.value = state.code || '';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
        toast('匹配码已复制');
      }
    });

    // 换一个房间码（只在对方还没进来时可用）
    $('#regenCode').addEventListener('click', () => {
      if (state.role !== 'host') return;
      if (state.connected) return toast('Ta 已经进来了，现在换号会把 Ta 踢掉');
      try { P2P.destroy(); } catch {}
      state.code = null;
      createRoom();
      toast('换了一个新号码');
    });

    $('#joinBtn').addEventListener('click', joinRoom);
    $('#joinInput').addEventListener('input', (e) => {
      e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
      if (e.target.value.length === 6) $('#joinName').focus?.();
    });

    $('#startPlay').addEventListener('click', () => {
      if (isDuo()) emit({ type: 'nav', view: 'mode' });
      go('mode');
      setConn(state.connected);
    });

    $('#hostName').addEventListener('change', (e) => {
      const name = (e.target.value.trim() || '我').slice(0, 8);
      const me = state.members.find(m => m.uid === state.uid);
      const oldName = me ? me.name : null;
      state.name = name;
      localStorage.setItem('duo_name', name);
      if (me) me.name = name;
      if (state.turnName === oldName) state.turnName = name;
      renderMembers();
      renderTurn();
      if (isDuo()) emit({ type: 'name', name });
    });

    // 安全词
    $('#sosBtn').addEventListener('click', () => callSafeword('红灯'));
    $('#safewordChip').addEventListener('click', () => go('safety'));
    $('#resumeBtn').addEventListener('click', resume);
    $('#stopExit').addEventListener('click', () => {
      state.paused = false;
      $('#stopOverlay').hidden = true;
      emit({ type: 'resume' });
      go('mode');
    });

    // 自定义卡片
    $('#addCardBtn').addEventListener('click', () => { $('#cardSheet').hidden = false; });
    $('#sheetCancel').addEventListener('click', () => { $('#cardSheet').hidden = true; });
    $('#sheetSave').addEventListener('click', () => {
      const type = $('#newCardType').value;
      const level = $('#newCardLevel').value;
      const text = $('#newCardText').value.trim();
      if (!text) return toast('写点什么再保存');
      const key = `${type}-${level}`;
      state.custom[key] = state.custom[key] || [];
      state.custom[key].push(text);
      saveCustom();
      $('#newCardText').value = '';
      $('#cardSheet').hidden = true;
      applyLevel(level, false);
      toast('加进你们的卡池了');
    });

    // 规则页
    $('#safetyList').innerHTML = CONTENT.safety.map(s =>
      `<div class="safety-item"><strong>${s.t}</strong><p>${s.d}</p></div>`).join('');

    // 窗口尺寸变化重绘转盘
    let rt;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(() => {
        if (screenEl('wheel').classList.contains('active')) drawWheel();
      }, 200);
    });

    renderPoints();
    buildThemePills();
    buildLevelPills();
    applyTheme(state.theme, false);
    applyLevel(state.level, false);
    renderHistory();
    renderTurn();

    const quotes = [
      '“先说好：谁先笑，谁先摘一件配饰。”',
      '“今晚不问对错，只问敢不敢。”',
      '“转盘转到什么就是什么 —— 除非你喊停。”',
      '“可以害羞，但不许撒谎。”',
      '“把手机放下，把灯调暗一点。”',
    ];
    const qt = $('#quoteText');
    if (qt) qt.textContent = quotes[Math.floor(Math.random() * quotes.length)];

    wireP2P();
  }

  window.addEventListener('beforeunload', () => {
    if (isDuo() && window.P2P) P2P.destroy();
  });

  // 等字体/布局就绪后首次绘制
  window.addEventListener('load', () => {
    init();
    setTimeout(() => drawWheel(), 120);
  });
})();
