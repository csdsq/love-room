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

  /* 重试策略：连不上时不要静默卡住，要么退避重试，要么把原因说清楚 */
  const GUEST_MAX_RETRY = 2;                     // 客人拨号失败最多再试 2 次（共 3 轮）
  const GUEST_RETRY_DELAY = [600, 1500];         // 每一轮重试前等多久（原来 1.2s/3s，太磨叽）
  const HOST_MAX_RETRY = 4;                      // 房主号码被占最多换几次号
  const SIG_RECONNECT_MAX = 5;                   // 信令断线自动重连次数
  const SIG_RECONNECT_DELAY = 1000;              // 重连退避基数：1s / 2s / 4s / 8s / 16s
  const ID_RETRY_MAX = 3;                        // 恢复时原号码还占着，原地再试几次（保住号码）
  const HIDDEN_REFRESH_MIN = 1000;               // 切走超过 1 秒，回到前台就重刷一次信令
  const REFRESH_THROTTLE = 700;                  // 两次主动重刷之间的最小间隔

  /* 「房主切去微信发码、切回来」是真实主路径：Android 会冻结页面，
     WebSocket 可能半死（TCP 还在、但一个包都不再进来）。实测 PeerJS 公共云
     既不主动下发心跳、也不回任何探测帧（HEARTBEAT/PING 全无响应，发错帧还会
     被服务端直接断开），所以本地无法通过「安静多久」判断死活 ——
     只能回到前台时主动把信令重新注册一遍（P2P 数据通道走另一条传输，不受影响）。*/
  const GUEST_LONG_WAIT = 6000;                  // 慢速等待间隔
  const GUEST_LONG_MAX = 6;                      // 慢速最多再等 6 轮（约 38 秒）
  const ANSWER_WAIT = 3500;                      // offer 发出去多久没等到 answer 就重拨

  /* ------------------------------------------------------------------ */
  /*  信令服务器                                                         */
  /*  PeerJS 1.5.4 的构造选项是 host / port / path / secure / key，       */
  /*  不是直接塞一个 wss:// 地址，所以这里要拆开。                        */
  /*  默认走 PeerJS 公共云；想换自建 PeerServer，二选一：                 */
  /*    1) 地址栏加参数：?signal=wss://your.host:443/                    */
  /*    2) localStorage.setItem('duo_signal', 'wss://your.host:443/')     */
  /*  ?signal=default 可以清掉之前存下来的自定义地址，回到公共云。        */
  /* ------------------------------------------------------------------ */
  const SIGNAL_STORE_KEY = 'duo_signal';

  const SIGNAL_DEFAULT = {
    host: '0.peerjs.com',
    port: 443,
    path: '/',
    secure: true,
    key: 'peerjs',
  };

  function parseSignalUrl(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    let u = null;
    try { u = new URL(s); } catch (e) {
      try { u = new URL('wss://' + s); } catch (e2) { return null; }
    }
    if (!u || !u.hostname) return null;

    const secure = u.protocol === 'https:' || u.protocol === 'wss:';
    // PeerServer 的 WebSocket 入口是 <path>peerjs?key=xxx，
    // 所以用户直接粘 wss://host/peerjs 时要把末尾的 peerjs 去掉，还原成挂载路径
    let path = (u.pathname || '/').replace(/\/+$/, '').replace(/\/peerjs$/, '');
    path = (path || '') + '/';

    return {
      host: u.hostname,
      port: Number(u.port || (secure ? 443 : 80)),
      path,
      secure,
      key: u.searchParams.get('key') || SIGNAL_DEFAULT.key,
    };
  }

  function resolveSignal() {
    let raw = '';
    try { raw = new URLSearchParams(location.search).get('signal') || ''; } catch (e) { raw = ''; }

    if (raw) {
      if (raw === 'default' || raw === 'off' || raw === 'cloud') {
        try { localStorage.removeItem(SIGNAL_STORE_KEY); } catch (e) { /* 隐身模式 */ }
        return Object.assign({}, SIGNAL_DEFAULT);
      }
      // 地址栏带过来的地址就记住，下次直接打开也能用
      try { localStorage.setItem(SIGNAL_STORE_KEY, raw); } catch (e) { /* 隐身模式 */ }
    } else {
      try { raw = localStorage.getItem(SIGNAL_STORE_KEY) || ''; } catch (e) { raw = ''; }
    }
    return parseSignalUrl(raw) || Object.assign({}, SIGNAL_DEFAULT);
  }

  const SIGNAL = resolveSignal();

  /* ------------------------------------------------------------------ */
  /*  ICE 配置                                                           */
  /*  PeerJS 默认只带 Google 的 STUN（stun.l.google.com），国内运营商网络 */
  /*  经常拿不到响应，导致手机流量下收集不到公网映射地址 -> 打洞失败。    */
  /*  这里换成一组国内可达的 STUN，海外网络再用 Google / Cloudflare 兜底。*/
  /*  注意：STUN 只影响「候选」能不能拿到，不解决信令层的问题。           */
  /* ------------------------------------------------------------------ */
  const ICE_SERVERS = [
    { urls: ['stun:stun.miwifi.com:3478', 'stun:stun.chat.bilibili.com:3478'] },
    { urls: ['stun:stun.hitv.com:3478', 'stun:stun.cloudflare.com:3478'] },
    { urls: ['stun:stun.l.google.com:19302'] },
  ];

  // 自建 coturn（8.149.139.66，与 hser.ren 同一台 ECS）。
  // 只在两端都打洞失败（对称 NAT / CGNAT）时才会走中继，正常情况下仍是直连。
  // 纯静态站没有下发临时凭据的后端，所以这里用静态凭据；
  // 服务端已限制单用户并发 3 路、总并发 30 路、单路上限 2Mbps。
  const TURN_SERVERS = [
    {
      urls: [
        'turn:8.149.139.66:3478?transport=udp',
        'turn:8.149.139.66:3478?transport=tcp',
      ],
      username: 'lr6clw9a',
      credential: 'kDqJO3Wb02igz0mtAOwUutGxk37y',
    },
  ];

  function peerOptions(extra = {}) {
    return Object.assign({
      debug: 0,
      host: SIGNAL.host,
      port: SIGNAL.port,
      path: SIGNAL.path,
      secure: SIGNAL.secure,
      key: SIGNAL.key,
      config: {
        iceServers: ICE_SERVERS.concat(TURN_SERVERS),
        iceCandidatePoolSize: 4,
        bundlePolicy: 'max-bundle',
      },
    }, extra);
  }

  /* ------------------------------------------------------------------ */
  /*  模块状态                                                           */
  /* ------------------------------------------------------------------ */

  let peer = null;
  let conn = null;
  let role = null;                   // 'host' | 'guest'
  let code = '';
  let destroyed = false;
  let epoch = 0;                     // 会话代次：旧 peer / conn 的回调一律作废
  let timeoutId = null;              // 建连超时
  let answerTimer = null;            // 等 answer 的超时（等不到就早点重拨）
  let retryTimer = null;             // 整轮重试的定时器
  let sigRetryTimer = null;          // 信令重连的定时器
  let sigRetryNow = null;            // 立刻重连信令（由 watchSignal 注入）
  let sigTries = 0;                  // 信令自动重连的轮数（退避用）
  let hbSend = null;
  let hbCheck = null;
  let lastRecv = 0;
  let closed = false;
  let activePc = null;               // 当前 RTCPeerConnection，诊断面板直接读它
  let diagTimers = [];               // 诊断用的定时器，切会话时统一清掉
  let onReadyHost = null;            // 最近一次 host() 的回调，「重新连接」时复用
  let onReadyGuest = null;
  let retryAttempt = 0;              // 客人正在等待的那一轮重试序号
  let sigSchedule = null;            // watchSignal 注入的「排一次信令重连」
  let suppressSigRetry = false;      // 主动重刷信令时，别让 disconnected 再排一次
  let idRetry = 0;                   // 重新占用原号码失败后的原地重试次数
  let hiddenAt = 0;                  // 页面切到后台的时间点
  let lastHiddenMs = 0;              // 上次在后台待了多久
  let lastRefreshAt = 0;             // 上次主动重刷信令的时间
  let warmPeer = null;               // 预热好的信令连接（用户还在输码时就建好）
  let warmAt = 0;                    // 预热开始的时间点
  let warmMs = 0;                    // 预热连接实际建链耗时

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
    diag.lastStatus = text;
    diag.lastStatusAt = Date.now();
    fire('status', text, kind);
  }

  function setPhase(p) {
    diag.phase = p;
  }

  function clearTimer() {
    if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
  }

  function clearAnswerTimer() {
    if (answerTimer) { clearTimeout(answerTimer); answerTimer = null; }
  }

  function clearRetryTimer() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  }

  function clearSigTimer() {
    if (sigRetryTimer) { clearTimeout(sigRetryTimer); sigRetryTimer = null; }
  }

  function clearDiagTimers() {
    diagTimers.forEach((t) => clearInterval(t));
    diagTimers = [];
  }

  function fail(msg) {
    clearTimer();
    clearAnswerTimer();
    clearRetryTimer();
    setPhase('failed');
    status(msg, 'error');
  }

  /* ---------------- 编号 ---------------- */

  function randomCode() {
    // 首位不为 0，避免显示成「086912」这种让人以为是失误的号码
    let s = String(1 + Math.floor(Math.random() * 9));
    for (let i = 0; i < 5; i++) s += Math.floor(Math.random() * 10);
    return s;
  }

  /* ------------------------------------------------------------------ */
  /*  诊断                                                               */
  /*  这里记录的每一条都是「卡在哪一步」的证据：                          */
  /*  信令是否连上 → 有没有创建数据通道 → 本地/远端描述有没有交换        */
  /*  → ICE 才开始 checking。只要 ICE 一直是 new，就说明卡在信令层。      */
  /* ------------------------------------------------------------------ */

  const diag = {
    // 网络通路（原有）
    ice: 'new', host: 0, srflx: 0, relay: 0, pair: '', checked: false,
    // 信令（到 PeerServer 的 WebSocket）
    sigState: 'idle',      // idle | opening | open | closed
    sigMs: 0,              // 从 new Peer() 到 open 的耗时
    warmMs: 0,             // 预热连接本身的建链耗时（不打进用户等待）
    sigStartAt: 0,
    sigReconnect: 0,       // 信令自动重连了几次
    sigRefresh: 0,         // 「回到前台 / 网络恢复」时主动重刷了几次
    sigCheck: '',          // 最近一次存活检查的结论（人话）
    idRetry: 0,            // 重新占用原号码的原地重试次数
    // 页面生命周期
    visibility: 'visible',
    hiddenMs: 0,           // 上次切到后台待了多久
    // peer / socket 原始状态（PeerJS 1.5.4 实测可用）
    peerOpen: false,
    peerDisconnected: false,
    wsState: -1,           // peer.socket._socket.readyState：0/1/2/3，-1 表示没有
    // 协商现场
    local: '-',            // 本地描述：offer / answer / -
    remote: '-',           // 远端描述：- 说明对方应答还没到（或 offer 还没到）
    sig: '-',              // RTCPeerConnection.signalingState
    gather: '-',           // iceGatheringState
    pcState: '-',          // connectionState
    // 数据通道
    connState: 'none',     // none | created | open
    connOpen: false,
    // 重试 / 阶段
    attempt: 0,
    maxAttempt: GUEST_MAX_RETRY + 1,
    phase: 'idle',         // idle|peer-opening|negotiating|waiting|connected|retrying|failed
    target: '',            // 客人要拨的 Peer ID
    // 最后的现场（面板里永远显示，截图就能定位）
    lastStatus: '', lastStatusAt: 0,
    errType: '', errMsg: '', errAt: 0,
  };
  let diagBusy = false;

  function resetDiag() {
    diag.ice = 'new'; diag.host = 0; diag.srflx = 0; diag.relay = 0;
    diag.pair = ''; diag.checked = false;
    diag.sigState = 'idle'; diag.sigMs = 0; diag.sigStartAt = 0; diag.sigReconnect = 0;
    diag.sigRefresh = 0; diag.sigCheck = ''; diag.idRetry = 0;
    diag.local = '-'; diag.remote = '-'; diag.sig = '-'; diag.gather = '-'; diag.pcState = '-';
    diag.connState = 'none'; diag.connOpen = false;
    diag.errType = ''; diag.errMsg = ''; diag.errAt = 0;
    diag.lastStatus = ''; diag.lastStatusAt = 0;
    diagBusy = false;
  }

  // 记录最后一次错误（PeerJS 的 type + message），面板里会一直显示
  function noteError(type, err) {
    diag.errType = type || 'unknown';
    if (err && typeof err === 'object') {
      diag.errMsg = String(err.message || err);
    } else {
      diag.errMsg = String(err == null ? '' : err);
    }
    diag.errAt = Date.now();
  }

  function summary() {
    if (diag.pair === 'relay') return '中继转发';
    if (diag.pair === 'srflx') return '公网直连';
    if (diag.pair === 'prflx') return '公网直连';
    if (diag.pair === 'host') return '局域网直连';
    return '';
  }

  // 连不上时给出能直接照做的说明
  // 关键：先按「卡在哪一层」分类，别一上来就说运营商 NAT —— 没收到应答时
  // ICE 根本没开始，这时候说「打洞失败」是误导。
  function diagHint() {
    // 1) 远端描述还没到 = 信令层没把 offer/answer 送到，跟 NAT 无关
    if (diag.remote === '-') {
      if (diag.errType === 'peer-unavailable') {
        return '配对服务里查不到这个房间号：对方可能已经退出，或者正切在微信里、页面被冻结。让对方回到页面（会自动重新注册），这边会自动继续重试';
      }
      if (diag.errType === 'network' || diag.errType === 'socket-error' || diag.sigState === 'closed') {
        return '和配对服务的连接断了。点「重新连接」，或换回 WiFi 再试';
      }
      if (diag.local === 'offer') {
        return 'offer 已经发出去了，但对方的应答一直没回来 —— 这是配对服务（信令）的问题，不是网络打洞。让对方回到页面、两边都点一次「重新连接」';
      }
      return '配对服务没有把对方的信息送过来（信令没建起来），不是打洞问题。点「重新连接」试一次';
    }

    // 2) 远端描述有了 = 已经在打洞，这时候才谈 NAT
    if (!diag.srflx && !diag.relay) {
      return '打洞没拿到公网地址（两端都在运营商内网）。连同一个 WiFi、或一方开热点给另一方，就能通';
    }
    if (diag.srflx && !diag.relay) {
      return '两边网络没打通（运营商大内网）。换一下网络重试，或一方开热点';
    }
    return '建立连接失败，点「重新连接」或刷新页面';
  }

  // 从 getStats 读候选与实际通路（比监听事件可靠：事件挂上时早期候选已经收集完）
  async function collectStats(pc) {
    if (!pc || !pc.getStats) return;

    // 协商现场：这几个字段才是「卡在哪一步」的关键，先同步读一遍
    diag.ice = pc.iceConnectionState;
    diag.gather = pc.iceGatheringState || '-';
    diag.sig = pc.signalingState || '-';
    diag.pcState = pc.connectionState || '-';
    diag.local = pc.localDescription ? pc.localDescription.type : '-';
    diag.remote = pc.remoteDescription ? pc.remoteDescription.type : '-';
    diag.connOpen = !!(conn && conn.open);

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
      diag.checked = true;
      const txt = summary();
      if (txt && conn && conn.open) status('已连上 · ' + txt);
    } catch (e) { /* 统计失败不影响使用 */ }
  }

  function attachDiag(c, my) {
    let tries = 0;
    const timer = setInterval(() => {
      if (my !== epoch) { clearInterval(timer); return; }
      const pc = c && c.peerConnection;
      if (!pc) {
        if (++tries > 40) clearInterval(timer);
        return;
      }
      clearInterval(timer);
      activePc = pc;

      let gotRemote = !!pc.remoteDescription;

      const onState = () => {
        if (my !== epoch) return;
        diag.ice = pc.iceConnectionState;
        if (diag.ice === 'checking') status('正在打通两端网络…');
        else if (diag.ice === 'failed') {
          noteError('ice-failed', '候选对全部失败，网络没打通');
          if (!diagBusy) { diagBusy = true; collectStats(pc); fail(diagHint()); }
        } else if (diag.ice === 'connected' || diag.ice === 'completed') {
          diagBusy = false;
          collectStats(pc);
        }
      };

      // 远端描述到达 = 信令通了、开始打洞。这一步正是「卡在 new」的分水岭。
      const onSignal = () => {
        if (my !== epoch) return;
        if (!gotRemote && pc.remoteDescription) {
          gotRemote = true;
          clearAnswerTimer();          // 远端描述到了，不用再等重拨
          if (pc.remoteDescription.type === 'answer') status('收到对方的应答，开始打通网络…');
          else status('收到对方的邀请，正在应答…');
        }
        collectStats(pc);
      };

      pc.addEventListener('iceconnectionstatechange', onState);
      pc.addEventListener('connectionstatechange', onState);
      pc.addEventListener('signalingstatechange', onSignal);

      // 候选是陆续收集的，前 20 秒每 1.5 秒补一次统计
      let rounds = 0;
      const poll = setInterval(() => {
        if (my !== epoch) { clearInterval(poll); return; }
        collectStats(pc);
        if (++rounds >= 14) clearInterval(poll);
      }, 1500);
      diagTimers.push(poll);
      collectStats(pc);
    }, 120);
    diagTimers.push(timer);
  }

  /* ------------------------------------------------------------------ */
  /*  会话生命周期                                                       */
  /*  同一时刻只允许一个活着的 peer / conn：                            */
  /*  teardown() 先把旧的销毁并让它的回调全部作废（epoch++），再建新的。  */
  /* ------------------------------------------------------------------ */

  function teardown() {
    epoch++;
    clearTimer();
    clearAnswerTimer();
    clearRetryTimer();
    clearSigTimer();
    clearDiagTimers();
    stopHeartbeat();
    diagBusy = false;
    activePc = null;
    sigRetryNow = null;
    sigSchedule = null;
    sigTries = 0;
    suppressSigRetry = false;
    idRetry = 0;
    closed = false;
    try { conn && conn.close(); } catch (e) { /* 已经断了 */ }
    try { peer && peer.destroy(); } catch (e) { /* 已经销毁 */ }
    conn = null;
    peer = null;
    diag.connState = 'none';
    diag.connOpen = false;
  }

  /* ------------------------------------------------------------------ */
  /*  信令存活检查                                                       */
  /*  实测（peerjs 1.5.4 + 0.peerjs.com）：服务端不会主动下发心跳，也不回    */
  /*  任何探测帧，所以「安静多久」不能当死号判据；发错帧还会被服务端断开。    */
  /*  唯一可靠的做法：回到前台/网络恢复时，主动把信令重新注册一遍。          */
  /* ------------------------------------------------------------------ */

  // 原始 WebSocket（peer.socket 是 PeerJS 的包装层，_socket 才是真的）
  function rawWs() {
    try {
      const s = peer && peer.socket;
      const ws = s && s._socket;
      return ws && typeof ws.readyState === 'number' ? ws : null;
    } catch (e) { return null; }
  }

  function noteSig(text) {
    diag.sigCheck = text;
  }

  /**
   * 主动刷新信令：同一个 Peer ID 重新注册一次。
   * 数据通道走另一条传输，这一步不会影响已经建立的直连。
   * 返回 true 表示发起了刷新。
   */
  function forceSignalRefresh(reason) {
    if (!peer || peer.destroyed || !role) return false;
    if (Date.now() - lastRefreshAt < REFRESH_THROTTLE) return false;

    if (conn && conn.open) {
      noteSig(reason + '：已经直连，不需要动信令');
      return false;
    }

    const ws = rawWs();
    const rs = ws ? ws.readyState : -1;
    if (rs !== 1) {
      noteSig(reason + '：socket readyState=' + rs + '，重新注册');
    } else if (peer.disconnected || !peer.open) {
      noteSig(reason + '：peer 已掉线，重新注册');
    } else {
      // 看起来是好的，但半死连接在本地判断不出来（TCP 还在、包已不通）
      noteSig(reason + '：连接表面正常，仍强制重刷一次（半死连接本地无法判断）');
    }

    lastRefreshAt = Date.now();
    diag.sigRefresh++;
    clearSigTimer();
    suppressSigRetry = true;
    try {
      if (!peer.disconnected) peer.disconnect();   // 先把旧 socket 干净地扔掉
      peer.reconnect();                            // 用同一个 id 重新注册
      return true;
    } catch (e) {
      noteError('signal-refresh-failed', e);
      suppressSigRetry = false;
      if (sigSchedule) sigSchedule();
      return false;
    }
  }

  // 页面回到前台 / 网络恢复
  function onPageShow(reason) {
    if (hiddenAt) {
      lastHiddenMs = Date.now() - hiddenAt;
      hiddenAt = 0;
      diag.hiddenMs = lastHiddenMs;
    }
    if (!peer || peer.destroyed) return;

    // 客人正在慢速等待房间出现：立刻插一轮，不用再等 8 秒
    if (role === 'guest' && diag.phase === 'retrying' && retryTimer) {
      clearRetryTimer();
      noteSig(reason + '：客人这边立刻再拨一次');
      join(code, onReadyGuest, retryAttempt);
      return;
    }

    forceSignalRefresh(reason);
  }

  function installLifecycle() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
      } else {
        onPageShow('回到前台');
      }
    });
    // 从 bfcache / 系统冻结里恢复
    window.addEventListener('pageshow', (e) => { if (e.persisted) onPageShow('页面恢复'); });
    // 部分安卓浏览器切回来只发 focus 不发 visibilitychange
    window.addEventListener('focus', () => { if (hiddenAt) onPageShow('回到前台'); });
    window.addEventListener('online', () => { if (peer && !destroyed) forceSignalRefresh('网络恢复'); });
  }

  installLifecycle();

  /* 信令断线：PeerJS 自己不会重连，必须我们叫它连回去 */
  function watchSignal(p, my, opts) {
    function scheduleReconnect() {
      if (my !== epoch || destroyed) return;
      if (suppressSigRetry) return;          // 正在主动重刷 / 原地重占号码，别插一脚
      if (sigTries >= SIG_RECONNECT_MAX) {
        noteError('signal-closed', '信令断线后重连 ' + SIG_RECONNECT_MAX + ' 次都失败');
        fail('和配对服务的连接断了，重连不上。让对方刷新页面重新开一次房');
        return;
      }
      const wait = SIG_RECONNECT_DELAY * Math.pow(2, sigTries);
      sigTries++;
      diag.sigReconnect++;
      status('配对服务断线，' + Math.round(wait / 1000) + ' 秒后重连（' + sigTries + '/' + SIG_RECONNECT_MAX + '）');
      clearSigTimer();
      sigRetryTimer = setTimeout(() => {
        if (my !== epoch || destroyed) return;
        try {
          // PeerJS 1.5.4：先 disconnect 才允许 reconnect，它会重新注册同一个 id
          p.reconnect();
        } catch (e) {
          noteError('reconnect-failed', e);
          scheduleReconnect();
        }
      }, wait);
    }

    sigSchedule = scheduleReconnect;

    // 暴露给手动「重新连接」
    sigRetryNow = () => {
      if (my !== epoch) return false;
      if (p.destroyed) return false;
      if (p.open && !p.disconnected) return false;
      clearSigTimer();
      if (p.disconnected) {
        p.reconnect();
      } else {
        // 还没 open 过（初始连接就没成），只能整轮重开
        return false;
      }
      return true;
    };

    p.on('open', (id) => {
      if (my !== epoch || destroyed) return;
      const first = diag.sigState !== 'open';
      diag.sigState = 'open';
      // sigMs 只记「首次」建立信令的耗时，重连/重刷不覆盖（否则看历史现场会误判）
      if (first && !diag.sigMs && diag.sigStartAt) diag.sigMs = Date.now() - diag.sigStartAt;
      sigTries = 0;
      idRetry = 0;
      diag.idRetry = 0;
      if (!first) status(opts.reconnectedText || '配对服务回来了');
      if (opts.onOpen) opts.onOpen(first, id);
    });

    p.on('disconnected', () => {
      if (my !== epoch || destroyed) return;
      diag.sigState = 'closed';
      if (opts.autoReconnect) scheduleReconnect();
    });

    p.on('close', () => {
      if (my !== epoch || destroyed) return;
      diag.sigState = 'closed';
    });

    p.on('error', (err) => {
      if (my !== epoch || destroyed) return;
      const type = err && err.type;
      noteError(type || 'peer-error', err);
      if (opts.onError) opts.onError(type, err);
    });
  }

  /* ---------------- 建连 ---------------- */

  // 房主：占用一个固定 id 等待对方敲门
  // preferred：上次用过的房间码（刷新后想复用）；被占用就自动换新的
  function host(onReady, preferred, attempt = 0) {
    teardown();
    destroyWarm();
    role = 'host';
    destroyed = false;
    if (onReady) onReadyHost = onReady;
    const my = epoch;

    if (attempt === 0) resetDiag();
    diag.attempt = attempt + 1;
    diag.maxAttempt = HOST_MAX_RETRY + 1;
    diag.sigState = 'opening';
    diag.sigStartAt = Date.now();
    setPhase('peer-opening');

    const keep = attempt === 0 && preferred ? String(preferred).replace(/\D/g, '').slice(0, 6) : '';
    code = keep.length === 6 ? keep : randomCode();
    diag.target = ID_PREFIX + code;

    const p = new Peer(ID_PREFIX + code, peerOptions());
    peer = p;
    status(attempt === 0 ? '正在开房…' : '这个号码被占了，换一个重试…');

    let settled = false;             // 房间号是否已经在配对服务上注册好

    // 信令服务器连不上时别让用户一直等
    timeoutId = setTimeout(() => {
      if (my !== epoch || settled) return;
      try { p.destroy(); } catch (e) { /* 忽略 */ }
      noteError('timeout', HANDSHAKE_TIMEOUT / 1000 + ' 秒没连上配对服务');
      fail('连不上配对服务，检查一下网络（换了网络再试一次）');
    }, HANDSHAKE_TIMEOUT);

    watchSignal(p, my, {
      autoReconnect: true,
      reconnectedText: '配对服务已重新连上，房间号码不变（让 Ta 再试一次）',
      onOpen(first) {
        const wasSettled = settled;
        settled = true;
        clearTimer();
        setPhase('waiting');
        if (!first && wasSettled) return;    // 重连成功，不重复回调
        status('房间已开，等 Ta 输入匹配码');
        if (onReadyHost) onReadyHost(code);
      },
      onError(type, err) {
        if (type === 'unavailable-id') {
          // 重新占用原号码时被占（上一个 socket 还没被服务端回收）：
          // 先原地再试几次，号码能保住就别换 —— 换了对方得重新输一遍
          if (settled && idRetry < ID_RETRY_MAX) {
            idRetry++;
            diag.idRetry = idRetry;
            suppressSigRetry = true;
            clearSigTimer();
            status('原号码还在配对服务上，' + idRetry + ' 秒后重新占用（' + idRetry + '/' + ID_RETRY_MAX + '）…');
            sigRetryTimer = setTimeout(() => {
              suppressSigRetry = false;
              if (destroyed || role !== 'host' || !peer || peer.destroyed) return;
              try {
                peer.reconnect();
              } catch (e) {
                noteError('id-retry-failed', e);
              }
            }, 1000 * idRetry);
            return;
          }
          if (attempt < HOST_MAX_RETRY) {
            status(settled
              ? '原号码已经被配对服务收回，只能换一个新号码（记得把新号码重新发给 Ta）…'
              : '这个号码被占了，换一个号码…');
            return host(onReadyHost, null, attempt + 1);
          }
          return fail('连续几次号码都被占了，等一会儿点「重新连接」再试');
        }
        if (type === 'browser-incompatible') {
          return fail('这个浏览器不支持点对点连接，换 Chrome / Safari / Edge 试试');
        }
        if (type === 'invalid-id' || type === 'invalid-key') {
          return fail('配对服务不认这个 id / key，检查一下 ?signal= 里配的地址');
        }
        if (type === 'network' || type === 'server-error' || type === 'socket-error') {
          if (!settled) return fail('连不上配对服务，检查一下网络（可能需要关闭代理）');
          return;   // 已经开好房：交给 watchSignal 的断线重连
        }
        if (!settled) return fail('开房失败：' + ((err && err.message) || '未知错误'));
        // 已开房之后中转服务器抖动，不影响已经建立的直连
        console.warn('[p2p] host error', err);
      },
    });

    // 有人敲门
    p.on('connection', (c) => {
      if (my !== epoch || destroyed) return;
      if (conn && conn.open) {
        // 已经有一个人了，礼貌拒掉第三个
        try { c.close(); } catch (e) { /* 忽略 */ }
        return;
      }
      if (conn && conn !== c) {
        // 上一个连接还没 open 就被新的顶掉：先清干净，别让两个连接同时挂着
        try { conn.close(); } catch (e) { /* 忽略 */ }
        conn = null;
      }
      bind(c, null, my);
    });
  }

  /* ------------------------------------------------------------------ */
  /*  信令预热                                                           */
  /*  用户还在输 6 位码的时候，先把到配对服务的 WebSocket 建好。         */
  /*  实测这一步要 0.8~1.4 秒（TLS + 注册），提前做完，点「进入」时就     */
  /*  只剩 offer/answer 和 ICE，能明显缩短「等另一个人进来」的时间。      */
  /* ------------------------------------------------------------------ */

  function warm() {
    if (warmPeer && !warmPeer.destroyed) return;
    if (conn && conn.open) return;
    // 正在房间里（房主等客 / 已经连上）就别再建一条信令
    if (peer && !peer.destroyed && !peer.disconnected) return;

    warmAt = Date.now();
    warmMs = 0;
    let p;
    try {
      p = new Peer(peerOptions());
    } catch (e) {
      warmPeer = null;
      return;
    }
    warmPeer = p;
    p.on('open', () => { warmMs = Date.now() - warmAt; });
    const drop = () => { if (warmPeer === p) warmPeer = null; };
    p.on('close', drop);
    // 注意：join() 可能已经把这个 peer 接管走了。只有它还属于预热池时才自动销毁，
    // 否则会把正在用的连接误杀（peer-unavailable 这类错误要交给 join 自己重试）。
    p.on('disconnected', () => {
      if (warmPeer !== p) return;
      drop();
      try { p.destroy(); } catch (e) { /* 忽略 */ }
    });
    p.on('error', () => {
      if (warmPeer !== p) return;
      drop();
      try { p.destroy(); } catch (e) { /* 忽略 */ }
    });
  }

  function takeWarmPeer() {
    const p = warmPeer;
    warmPeer = null;
    // 放太久（>60s）的连接可能已经半死，别复用，重建更稳
    if (!p || p.destroyed || p.disconnected || Date.now() - warmAt > 60000) {
      try { p && p.destroy(); } catch (e) { /* 忽略 */ }
      return null;
    }
    return p;
  }

  function destroyWarm() {
    const p = warmPeer;
    warmPeer = null;
    if (p) { try { p.destroy(); } catch (e) { /* 忽略 */ } }
  }

  // 客人：敲房主的门
  function join(roomCode, onReady, attempt = 0) {
    teardown();
    role = 'guest';
    destroyed = false;
    if (onReady) onReadyGuest = onReady;
    const my = epoch;

    if (attempt === 0) resetDiag();
    diag.attempt = attempt + 1;
    diag.maxAttempt = GUEST_MAX_RETRY + GUEST_LONG_MAX + 1;
    diag.sigState = 'opening';
    diag.sigStartAt = Date.now();
    setPhase('peer-opening');

    code = String(roomCode || '').replace(/\D/g, '').slice(0, 6);
    diag.target = ID_PREFIX + code;

    const warmed = takeWarmPeer();
    const p = warmed || new Peer(peerOptions());
    peer = p;
    if (warmed) {
      // 复用预热连接：信令建链时间算在预热上，这里不再重复等
      diag.warmMs = warmMs;
      if (p.open) {
        diag.sigState = 'open';
        if (!diag.sigMs) diag.sigMs = 1;   // 预热已建好，点进来就是通的
      }
    }
    status(attempt === 0 ? '正在连接 Ta 的房间…' : '没连上，正在重试（第 ' + (attempt + 1) + ' 次）…');

    timeoutId = setTimeout(() => {
      if (my !== epoch) return;
      if (conn && conn.open) return;
      if (!diag.errType) noteError('timeout', HANDSHAKE_TIMEOUT / 1000 + ' 秒内没连上');
      clearTimer();
      if (attempt < GUEST_MAX_RETRY + GUEST_LONG_MAX) return retryJoin(attempt + 1);
      fail(diagHint());
    }, HANDSHAKE_TIMEOUT);

    let dialed = false;
    function dial(first) {
      if (!first || dialed) return;
      dialed = true;
      setPhase('negotiating');
      status('配对服务已连上，正在拨 Ta 的房间…');
      const c = p.connect(diag.target, { reliable: true });
      if (!c) return fail('无法建立数据通道（浏览器拒绝了连接）');
      bind(c, onReadyGuest, my);

      // offer 发出去之后等 answer：等不到就别干等 25 秒 ——
      // 对方页面可能被冻结（切微信），早一点重拨反而更快连上
      clearAnswerTimer();
      answerTimer = setTimeout(() => {
        if (my !== epoch || destroyed) return;
        const pc = c.peerConnection;
        if (c.open || (pc && pc.remoteDescription)) return;
        noteError('no-answer', 'offer 发出 ' + (ANSWER_WAIT / 1000) + ' 秒没收到应答');
        diag.attempt = attempt + 2;
        if (attempt < GUEST_MAX_RETRY + GUEST_LONG_MAX) return retryJoin(attempt + 1);
        fail(diagHint());
      }, ANSWER_WAIT);
    }

    watchSignal(p, my, {
      // 客人每次整轮重来（重建 peer 才能重新走一遍候选收集），
      // 所以信令断了也直接交给 retryJoin，不做原地重连。
      autoReconnect: false,
      onOpen: dial,
      onError(type, err) {
        if (type === 'peer-unavailable') {
          // 对方可能只是在切微信/重建房间号：先快重试，再慢速等半分钟
          if (attempt < GUEST_MAX_RETRY + GUEST_LONG_MAX) {
            return retryJoin(attempt + 1);
          }
          return fail('找不到这个房间号：对方可能已经退出、或者房间还没开好。让对方重新开一次房，把新的匹配码发你');
        }
        if (type === 'browser-incompatible') {
          return fail('这个浏览器不支持点对点连接，换 Chrome / Safari / Edge 试试');
        }
        if (type === 'invalid-id' || type === 'invalid-key') {
          return fail('配对服务不认这个 id / key，检查一下 ?signal= 里配的地址');
        }
        if (type === 'network' || type === 'server-error' || type === 'socket-error') {
          if (attempt < GUEST_MAX_RETRY + GUEST_LONG_MAX) {
            return retryJoin(attempt + 1);
          }
          return fail('连不上配对服务，检查一下网络（可能需要关闭代理）');
        }
        console.warn('[p2p] guest error', err);
      },
    });

    // 预热连接可能已经 open，watchSignal 的 open 事件不会再触发，这里补一刀
    if (p.open && !p.disconnected) dial(true);
  }

  // 整轮重试：先彻底销毁旧 peer（避免旧回调跑到新一轮里），隔一会儿再来
  // 前两轮快重试；之后转成每 6 秒一次的慢速等待 —— 房主很可能正切在微信里，
  // 一回到页面就会重新注册，下一次重试就能连上。
  function retryJoin(n) {
    const fast = n <= GUEST_MAX_RETRY;
    const wait = fast
      ? (GUEST_RETRY_DELAY[Math.min(n - 1, GUEST_RETRY_DELAY.length - 1)] || 1200)
      : GUEST_LONG_WAIT;
    const total = GUEST_MAX_RETRY + GUEST_LONG_MAX;
    const why = diag.errType ? diag.errType : '超时';

    retryAttempt = n;
    diag.attempt = n + 1;
    diag.maxAttempt = total + 1;
    setPhase('retrying');
    teardown();                   // epoch++，旧 peer / conn 的回调全部作废
    if (fast) {
      status('没连上（' + why + '），' + (wait / 1000).toFixed(1) + ' 秒后重试第 ' + (n + 1) + ' 次（最多 ' + (total + 1) + ' 次）…');
    } else {
      status('还没找到这个房间，继续每 ' + (wait / 1000) + ' 秒试一次（第 ' + (n + 1) + '/' + (total + 1) + ' 次）—— 对方可能还切在微信里，回页面就会自动连上');
    }
    clearRetryTimer();
    retryTimer = setTimeout(() => {
      if (destroyed) return;
      join(code, onReadyGuest, n);
    }, wait);
  }

  /* ---------------- 心跳：对方强杀页面也能被发现 ---------------- */

  function startHeartbeat() {
    stopHeartbeat();
    lastRecv = Date.now();
    closed = false;

    hbSend = setInterval(() => {
      if (conn && conn.open) {
        try { conn.send({ __hb: 1 }); } catch (e) { /* 通道正在关 */ }
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
    diag.connOpen = false;
    setPhase('idle');
    fire('close');
  }

  function bind(c, onReady, my) {
    if (!c || my !== epoch) return;
    if (conn === c) return;            // 同一个连接不重复挂监听（防 attachDiag 挂两次）
    conn = c;
    diag.connState = 'created';
    diag.connOpen = false;
    setPhase('negotiating');
    attachDiag(c, my);

    c.on('open', () => {
      if (my !== epoch || destroyed) return;
      clearTimer();
      clearAnswerTimer();
      diag.connState = 'open';
      diag.connOpen = true;
      setPhase('connected');
      startHeartbeat();
      status('已连上');
      fire('open', peer && peer.id);
      if (onReady) onReady(code);
    });

    c.on('data', (data) => {
      if (my !== epoch || destroyed) return;
      lastRecv = Date.now();
      if (data && typeof data === 'object') {
        if (data.__hb) return;          // 心跳不打扰上层
        fire('message', data);
      }
    });

    c.on('close', () => {
      if (my !== epoch || destroyed) return;
      diag.connOpen = false;
      markClosed();
    });

    c.on('error', (err) => {
      noteError((err && err.type) || 'conn-error', err);
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
    teardown();
    destroyWarm();
    role = null;
    code = '';
    setPhase('idle');
  }

  // 手动「重新连接」：能只重连信令就不换号码（号码变了对方得重新输）
  function reconnect() {
    destroyed = false;

    if (conn && conn.open) { status('已经连上了'); return; }

    if (role === 'host') {
      if (diag.sigState === 'open' && peer && !peer.destroyed) {
        status('房间还开着，让 Ta 用这个号码再试一次');
        return;
      }
      if (sigRetryNow) {
        try { if (sigRetryNow()) return; } catch (e) { /* 落到整轮重开 */ }
      }
      return host(onReadyHost, code, 0);
    }

    if (role === 'guest') {
      if (!code) return fail('还没有要连的房间号，回首页重新输入一次');
      return join(code, onReadyGuest, 0);
    }

    fail('还没有房间可以重连，回首页重新开房');
  }

  window.P2P = {
    host,
    join,
    warm,
    destroyWarm,
    send,
    sendRaw,
    buffered,
    destroy,
    reconnect,
    on(name, fn) { hooks[name] = fn; },
    get connected() { return !!(conn && conn.open); },
    get role() { return role; },
    get code() { return code; },
    get peerId() { return peer && peer.id; },
    // 连接诊断：ICE + 候选 + 信令生命周期 + 协商现场 + 最后一次错误
    get diag() {
      const pc = activePc;
      const ws = rawWs();
      const live = pc ? {
        ice: pc.iceConnectionState || diag.ice,
        gather: pc.iceGatheringState || diag.gather,
        sig: pc.signalingState || diag.sig,
        pcState: pc.connectionState || diag.pcState,
        local: pc.localDescription ? pc.localDescription.type : '-',
        remote: pc.remoteDescription ? pc.remoteDescription.type : '-',
      } : {};
      return Object.assign({
        ice: diag.ice,
        host: diag.host,
        srflx: diag.srflx,
        relay: diag.relay,
        pair: diag.pair,
        text: summary(),
        // 没有 pc 的时候（比如重试间隙）也要有值，别返回 undefined
        local: '-',
        remote: '-',
        sig: '-',
        gather: '-',
        pcState: '-',
        sigState: peer ? diag.sigState : 'idle',
        sigMs: diag.sigMs,
        warmMs: diag.warmMs,
        sigReconnect: diag.sigReconnect,
        sigRefresh: diag.sigRefresh,
        sigCheck: diag.sigCheck,
        idRetry: diag.idRetry,
        connState: diag.connState,
        connOpen: !!(conn && conn.open),
        attempt: diag.attempt,
        maxAttempt: diag.maxAttempt,
        phase: diag.phase,
        target: diag.target,
        lastStatus: diag.lastStatus,
        lastStatusAt: diag.lastStatusAt,
        errType: diag.errType,
        errMsg: diag.errMsg,
        errAt: diag.errAt,
        // 页面与 socket 的原始状态（判断「切后台导致半死」全靠这几个）
        visibility: document.visibilityState || '-',
        hiddenMs: diag.hiddenMs,
        peerOpen: !!(peer && peer.open),
        peerDisconnected: !!(peer && peer.disconnected),
        wsState: ws ? ws.readyState : -1,
        wsBuffered: ws && typeof ws.bufferedAmount === 'number' ? ws.bufferedAmount : 0,
      }, live);
    },
    diagHint,
    // 当前生效的信令服务器
    get signal() {
      return {
        host: SIGNAL.host,
        port: SIGNAL.port,
        path: SIGNAL.path,
        secure: SIGNAL.secure,
        key: SIGNAL.key,
      };
    },
    // 当前实际生效的 ICE 服务器（排查时很有用）
    get iceServers() {
      return ICE_SERVERS.concat(TURN_SERVERS).map((s) => {
        const u = Array.isArray(s.urls) ? s.urls : [s.urls];
        return u.join(' | ');
      });
    },
  };
})();
