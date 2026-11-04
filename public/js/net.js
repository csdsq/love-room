/* ------------------------------------------------------------------ */
/*  P2P 传输层                                                          */
/*  两人直连，不经过任何业务服务器 —— 房间码就是点对点地址。            */
/*  静态托管（GitHub Pages / 任何 CDN）也能实时同步。                   */
/* ------------------------------------------------------------------ */
(function () {
  'use strict';

  const ID_PREFIX = 'duo-r-';        // PeerJS 全局命名空间前缀，避免撞号
  const HANDSHAKE_TIMEOUT = 20000;   // 建连超时
  const HB_INTERVAL = 4000;          // 心跳间隔
  const HB_TIMEOUT = 14000;          // 多久没动静算掉线

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
  function host(onReady, preferred, attempt = 0) {
    role = 'host';
    destroyed = false;
    const keep = attempt === 0 && preferred ? String(preferred).replace(/\D/g, '').slice(0, 6) : '';
    code = keep.length === 6 ? keep : randomCode();

    const p = new Peer(ID_PREFIX + code, { debug: 0 });
    peer = p;
    status('正在开房…');

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
  function join(roomCode, onReady) {
    role = 'guest';
    destroyed = false;
    code = String(roomCode || '').replace(/\D/g, '');

    const p = new Peer({ debug: 0 });
    peer = p;
    status('正在连接 Ta 的房间…');

    timeoutId = setTimeout(() => {
      if (!conn || !conn.open) {
        try { p.destroy(); } catch {}
        fail('连接超时，让对方确认房间还开着，或网络是否通畅');
      }
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

  function bind(c, onReady) {
    conn = c;

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
  };
})();
