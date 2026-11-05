/* ------------------------------------------------------------------ */
/*  P2P 传输层                                                          */
/*  两人直连，不经过任何业务服务器 —— 房间码就是点对点地址。            */
/*  静态托管（GitHub Pages / 任何 CDN）也能实时同步。                   */
/* ------------------------------------------------------------------ */
(function () {
  'use strict';

  const ID_PREFIX = 'duo-r-';        // PeerJS 全局命名空间前缀，避免撞号
  const HANDSHAKE_TIMEOUT = 25000;   // 建连超时（手机流量下 ICE 协商更慢）
  const HB_INTERVAL = 4000;          // 心跳间隔
  const HB_TIMEOUT = 14000;          // 多久没动静算掉线

  /* ------------------------------------------------------------------ */
  /*  ICE 配置                                                           */
  /*  PeerJS 默认只带 Google 的 STUN（stun.l.google.com），国内运营商网络 */
  /*  经常拿不到响应，导致手机流量下收集不到公网映射地址 -> 打洞失败，    */
  /*  表现就是「同一个 WiFi 能连，双方都用流量就连不上」。                */
  /*  这里换成一组国内可达的 STUN，海外网络再用 Google / Cloudflare 兜底。*/
  /* ------------------------------------------------------------------ */
  const ICE_SERVERS = [
    { urls: ['stun:stun.miwifi.com:3478', 'stun:stun.chat.bilibili.com:3478'] },
    { urls: ['stun:stun.hitv.com:3478', 'stun:stun.cloudflare.com:3478'] },
    { urls: ['stun:stun.l.google.com:19302'] },
  ];

  // 需要中继时在这里填 TURN（形如 { urls: 'turn:turn.example.com:3478', username, credential }）
  // 两端都在运营商 CGNAT 后面时，只有 TURN 能连通；没有 TURN 就只能靠打洞。
  const TURN_SERVERS = [];

  function peerOptions(extra = {}) {
    return Object.assign({
      debug: 0,
      config: {
        iceServers: ICE_SERVERS.concat(TURN_SERVERS),
        iceCandidatePoolSize: 4,
        bundlePolicy: 'max-bundle',
      },
    }, extra);
  }

  let peer = null;
  let conn = null;
  let role = null;                   // 'host' | 'guest'
  let code = '';
  let destroyed = false;
  let timeoutId = null;
  let hbSend = null;
  let hbCheck = null;
  let lastRecv = 0;
  let closed = false;

  const hooks = {
    open: null,      // (peerId) => {}           通道打开
    close: null,     // () => {}                 对方断开
    message: null,   // (data) => {}             收到消息
    status: null,    // (text, kind) => {}       过程状态，kind: 'info'|'error'
  };

  function fire(name, ...args) {
    try { hooks[name] && hooks[name](...args); } catch (e) { console.error(e); }
  }

  function status(text, kind = 'info') {
    fire('status', text, kind);
  }

  function clearTimer() {
    if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
  }

  function fail(msg) {
    clearTimer();
    status(msg, 'error');
  }

  /* ---------------- 编号 ---------------- */

  function randomCode() {
    // 首位不为 0，避免显示成「086912」这种让人以为是失误的号码
    let s = String(1 + Math.floor(Math.random() * 9));
    for (let i = 0; i < 5; i++) s += Math.floor(Math.random() * 10);
    return s;
  }

  /* ---------------- 建连 ---------------- */

  // 房主：占用一个固定 id 等待对方敲门
  // preferred：上次用过的房间码（刷新后想复用）；被占用就自动换新的
  function resetDiag() {
    diag.ice = 'new'; diag.host = 0; diag.srflx = 0;
    diag.relay = 0; diag.pair = ''; diag.checked = false;
    diagBusy = false;
  }

  function host(onReady, preferred, attempt = 0) {
    role = 'host';
    destroyed = false;
    if (attempt === 0) resetDiag();
    const keep = attempt === 0 && preferred ? String(preferred).replace(/\D/g, '').slice(0, 6) : '';
    code = keep.length === 6 ? keep : randomCode();

    const p = new Peer(ID_PREFIX + code, peerOptions());
    peer = p;
    status('正在开房…');

    // 信令服务器连不上时别让用户一直等
    timeoutId = setTimeout(() => {
      if (!settled) {
        try { p.destroy(); } catch {}
        fail('连不上配对服务，检查一下网络（换了网络再试一次）');
      }
    }, HANDSHAKE_TIMEOUT);

    let settled = false;

    p.on('open', () => {
      if (destroyed) return;
      settled = true;
      clearTimer();
      status('房间已开，等 Ta 输入匹配码');
      onReady(code);
    });

    p.on('error', (err) => {
      if (destroyed) return;
      const type = err && err.type;

      if (type === 'unavailable-id' && attempt < 4) {
        // 这个号码被人占了（或上次没释放干净），换一个重来
        try { p.destroy(); } catch {}
        return host(onReady, null, attempt + 1);
      }
      if (type === 'browser-incompatible') {
        return fail('这个浏览器不支持点对点连接，换 Chrome / Safari / Edge 试试');
      }
      if (type === 'network' || type === 'server-error' || type === 'socket-error') {
        return fail('连不上配对服务，检查一下网络（可能需要关闭代理）');
      }
      if (!settled) {
        return fail('开房失败：' + (err && err.message ? err.message : '未知错误'));
      }
      // 已开房之后中转服务器抖动，不影响已经建立的直连
      console.warn('[p2p] host error', err);
    });

    // 有人敲门
    p.on('connection', (c) => {
      if (destroyed) return;
      if (conn && conn.open) {
        // 已经有一个人了，礼貌拒掉第三个
        try { c.close(); } catch {}
        return;
      }
      bind(c);
    });
  }

  // 客人：敲房主的门
  function join(roomCode, onReady, attempt = 0) {
    role = 'guest';
    destroyed = false;
    resetDiag();
    code = String(roomCode || '').replace(/\D/g, '');

    const p = new Peer(peerOptions());
    peer = p;
    status('正在连接 Ta 的房间…');

    timeoutId = setTimeout(() => {
      if (conn && conn.open) return;
      try { p.destroy(); } catch {}
      if (attempt < 1) {
        // 第一次失败多半是候选没收集全，隔一秒换一套候选再试
        status('没连上，正在重试…');
        setTimeout(() => { if (!destroyed) join(code, onReady, attempt + 1); }, 1200);
        return;
      }
      fail(diagHint());
    }, HANDSHAKE_TIMEOUT);

    p.on('open', () => {
      if (destroyed) return;
      const c = p.connect(ID_PREFIX + code, { reliable: true });
      if (!c) return fail('无法建立连接');
      bind(c, onReady);
    });

    p.on('error', (err) => {
      if (destroyed) return;
      const type = err && err.type;
      if (type === 'peer-unavailable') {
        return fail('这个匹配码没有对应的房间，检查一下数字，或让对方重新开房');
      }
      if (type === 'browser-incompatible') {
        return fail('这个浏览器不支持点对点连接，换 Chrome / Safari / Edge 试试');
      }
      if (type === 'network' || type === 'server-error' || type === 'socket-error') {
        return fail('连不上配对服务，检查一下网络（可能需要关闭代理）');
      }
      console.warn('[p2p] guest error', err);
    });
  }

  /* ---------------- 心跳：对方强杀页面也能被发现 ---------------- */

  function startHeartbeat() {
    stopHeartbeat();
    lastRecv = Date.now();
    closed = false;

    hbSend = setInterval(() => {
      if (conn && conn.open) {
        try { conn.send({ __hb: 1 }); } catch {}
      }
    }, HB_INTERVAL);

    hbCheck = setInterval(() => {
      if (!closed && Date.now() - lastRecv > HB_TIMEOUT) markClosed();
    }, 2000);
  }

  function stopHeartbeat() {
    if (hbSend) { clearInterval(hbSend); hbSend = null; }
    if (hbCheck) { clearInterval(hbCheck); hbCheck = null; }
  }

  function markClosed() {
    if (closed) return;
    closed = true;
    stopHeartbeat();
    conn = null;
    fire('close');
  }

  /* ---------------- 连接诊断 ---------------- */

  // 候选统计：host=局域网地址、srflx=公网映射、relay=中继
  const diag = { ice: 'new', host: 0, srflx: 0, relay: 0, pair: '', checked: false };
  let diagBusy = false;

  function summary() {
    if (diag.pair === 'relay') return '中继转发';
    if (diag.pair === 'srflx') return '公网直连';
    if (diag.pair === 'prflx') return '公网直连';
    if (diag.pair === 'host') return '局域网直连';
    return '';
  }

  // 连不上时给出能直接照做的说明
  function diagHint() {
    if (!diag.srflx && !diag.relay) {
      return '打洞没拿到公网地址（两端都在运营商内网）。连同一个 WiFi、或一方开热点给另一方，就能通';
    }
    if (diag.srflx && !diag.relay) {
      return '两边网络没打通（运营商大内网）。换一下网络重试，或一方开热点';
    }
    return '建立连接失败，刷新页面重试';
  }

  // 从 getStats 读候选与实际通路（比监听事件可靠：事件挂上时早期候选已经收集完）
  async function collectStats(pc) {
    if (!pc || !pc.getStats) return;
    try {
      const stats = await pc.getStats();
      const locals = new Map();
      let host = 0, srflx = 0, relay = 0, pairId = '';
      stats.forEach((r) => {
        if (r.type === 'local-candidate') {
          locals.set(r.id, r.candidateType);
          if (r.candidateType === 'host') host++;
          else if (r.candidateType === 'srflx' || r.candidateType === 'prflx') srflx++;
          else if (r.candidateType === 'relay') relay++;
        }
        if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
      });
      // 候选数量取历史最大值（getStats 会随剪枝变化）
      diag.host = Math.max(diag.host, host);
      diag.srflx = Math.max(diag.srflx, srflx);
      diag.relay = Math.max(diag.relay, relay);

      if (!pairId) {
        stats.forEach((r) => {
          if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) pairId = r.id;
        });
      }
      if (pairId) {
        stats.forEach((r) => {
          if (r.id === pairId && r.localCandidateId) {
            const t = locals.get(r.localCandidateId);
            if (t) diag.pair = t;
          }
        });
      }
      diag.ice = pc.iceConnectionState;
      diag.checked = true;
      const txt = summary();
      if (txt && conn && conn.open) status('已连上 · ' + txt);
    } catch (e) { /* 统计失败不影响使用 */ }
  }

  function attachDiag(c) {
    let tries = 0;
    const timer = setInterval(() => {
      const pc = c && c.peerConnection;
      if (!pc) {
        if (++tries > 30) clearInterval(timer);
        return;
      }
      clearInterval(timer);

      const onState = () => {
        diag.ice = pc.iceConnectionState;
        if (diag.ice === 'checking') status('正在打通两端网络…');
        else if (diag.ice === 'failed') {
          if (!diagBusy) { diagBusy = true; collectStats(pc); fail(diagHint()); }
        } else if (diag.ice === 'connected' || diag.ice === 'completed') {
          diagBusy = false;
          collectStats(pc);
        }
      };
      pc.addEventListener('iceconnectionstatechange', onState);
      pc.addEventListener('connectionstatechange', onState);

      // 候选是陆续收集的，前 20 秒每 1.5 秒补一次统计
      let rounds = 0;
      const poll = setInterval(() => {
        collectStats(pc);
        if (++rounds >= 14 || destroyed) clearInterval(poll);
      }, 1500);
      collectStats(pc);
    }, 120);
  }

  function bind(c, onReady) {
    conn = c;
    attachDiag(c);

    c.on('open', () => {
      if (destroyed) return;
      clearTimer();
      startHeartbeat();
      status('已连上');
      fire('open', peer.id);
      if (onReady) onReady(code);
    });

    c.on('data', (data) => {
      if (destroyed) return;
      lastRecv = Date.now();
      if (data && typeof data === 'object') {
        if (data.__hb) return;          // 心跳不打扰上层
        fire('message', data);
      }
    });

    c.on('close', () => {
      if (destroyed) return;
      markClosed();
    });

    c.on('error', (err) => {
      console.warn('[p2p] conn error', err);
    });
  }

  function send(obj) {
    if (!conn || !conn.open) return false;
    try {
      conn.send(obj);
      return true;
    } catch (e) {
      console.warn('[p2p] send failed', e);
      return false;
    }
  }

  // 大文件（图片/语音/视频）分片后逐片调用，绕开 PeerJS 自己的分块
  function sendRaw(payload) {
    return send(payload);
  }

  // 发送缓冲区积压字节数，用来做背压：积压太多就先等一会儿
  function buffered() {
    const dc = conn && conn.dataChannel;
    return dc && typeof dc.bufferedAmount === 'number' ? dc.bufferedAmount : 0;
  }

  function destroy() {
    destroyed = true;
    clearTimer();
    stopHeartbeat();
    try { conn && conn.close(); } catch {}
    try { peer && peer.destroy(); } catch {}
    conn = null;
    peer = null;
  }

  window.P2P = {
    host,
    join,
    send,
    sendRaw,
    buffered,
    destroy,
    on(name, fn) { hooks[name] = fn; },
    get connected() { return !!(conn && conn.open); },
    get role() { return role; },
    get code() { return code; },
    get peerId() { return peer && peer.id; },
    // 连接诊断：ice 状态 + 各类候选数量 + 实际通路的类型
    get diag() {
      return {
        ice: diag.ice,
        host: diag.host,
        srflx: diag.srflx,
        relay: diag.relay,
        pair: diag.pair,
        text: summary(),
      };
    },
    diagHint,
    // 当前实际生效的 ICE 服务器（排查时很有用）
    get iceServers() {
      return ICE_SERVERS.concat(TURN_SERVERS).map((s) => {
        const u = Array.isArray(s.urls) ? s.urls : [s.urls];
        return u.join(' | ');
      });
    },
  };
})();
