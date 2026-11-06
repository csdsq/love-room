import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = 'C:/Users/c/WorkBuddy/2026-11-03-21-51-06/couple-play/public';
const PORT = 8123;
const CDP_PORT = 9333;
const CHROME = 'C:/Users/c/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(path.normalize(ROOT))) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = (e) => rej(new Error('ws error'));
    });
    this.ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) rej(new Error(JSON.stringify(m.error)));
        else res(m.result);
      }
    };
  }
  send(method, params = {}, sessionId) {
    return new Promise((res, rej) => {
      const i = ++this.id;
      this.pending.set(i, { res, rej });
      this.ws.send(JSON.stringify({ id: i, method, params, sessionId }));
      setTimeout(() => {
        if (this.pending.has(i)) { this.pending.delete(i); rej(new Error('timeout ' + method)); }
      }, 30000);
    });
  }
}

async function main() {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  console.log('static server on', PORT);

  const userDir = path.join(tmpdir(), 'duo-cdp-' + Date.now());
  const chromeLog = path.join(tmpdir(), 'duo-chrome.log');
  const out = fs.openSync(chromeLog, 'w');
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--no-proxy-server', '--disable-features=Translate',
    '--remote-allow-origins=*',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + userDir,
    '--window-size=420,900',
    'about:blank',
  ], { stdio: ['ignore', out, out] });

  const getJson = (p) => new Promise((res, rej) => {
    const req = http.get({ host: '127.0.0.1', port: CDP_PORT, path: p, timeout: 2000 }, (r) => {
      let b = '';
      r.on('data', (d) => b += d);
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    });
    req.on('error', rej);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });

  let ver = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { ver = await getJson('/json/version'); break; } catch {}
  }
  if (!ver) {
    console.error('chrome 日志：\n' + fs.readFileSync(chromeLog, 'utf8').slice(0, 1500));
    throw new Error('chrome devtools 没起来');
  }
  console.log('chrome:', ver['Browser']);

  const cdp = new CDP(ver.webSocketDebuggerUrl);
  await cdp.ready;

  async function openPage(url) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.navigate', { url }, sessionId);
    for (let i = 0; i < 60; i++) {
      await sleep(200);
      try {
        const r = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, sessionId);
        if (r.result.value === 'complete') break;
      } catch {}
    }
    return { sessionId, targetId };
  }

  async function ev(page, expr) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: `(() => { ${expr} })()`,
      returnByValue: true, awaitPromise: true,
    }, page.sessionId);
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }

  const URL_APP = `http://127.0.0.1:${PORT}/`;

  const A = await openPage(URL_APP);
  const B = await openPage(URL_APP);
  console.log('两页已打开');

  for (const p of [A, B]) {
    await ev(p, `localStorage.setItem('duo_lock_until', String(Date.now() + 2592000000)); return 1;`);
  }
  await cdp.send('Page.reload', {}, A.sessionId);
  await cdp.send('Page.reload', {}, B.sessionId);
  await sleep(2500);

  // 过成年门
  for (const [name, p] of [['A', A], ['B', B]]) {
    const r = await ev(p, `
      const g = document.querySelector('#gateEnter');
      if (!g) return 'no gate';
      const vis = g.closest('.screen');
      g.click();
      return 'clicked:' + (vis ? vis.id + '/' + vis.className : '?');
    `);
    console.log(name, 'gate ->', r);
  }
  await sleep(1200);

  // A 开房
  const created = await ev(A, `
    const t = document.querySelector('[data-action="create"]');
    if (!t) return 'no tile';
    t.click();
    return 'ok';
  `);
  console.log('A create ->', created);

  let code = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    code = await ev(A, `const el = document.querySelector('#codeValue'); return el ? el.textContent.trim() : '';`);
    if (/^\d{6}$/.test(code)) break;
  }
  console.log('房间码 =', code);
  if (!/^\d{6}$/.test(code || '')) throw new Error('房主没拿到 6 位码');

  // B 输码进房
  const joined = await ev(B, `
    const t = document.querySelector('[data-action="join"]');
    if (!t) return 'no tile';
    t.click();
    return 'ok';
  `);
  console.log('B join tile ->', joined);
  await sleep(600);
  const filled = await ev(B, `
    const i = document.querySelector('#joinInput');
    const n = document.querySelector('#joinName');
    if (!i) return 'no input';
    i.value = '${code}';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    if (n) { n.value = '测试乙'; n.dispatchEvent(new Event('input', { bubbles: true })); }
    const b = document.querySelector('#joinBtn');
    if (!b) return 'no btn';
    b.click();
    return 'submitted';
  `);
  console.log('B submit ->', filled);

  // 等连接
  let aDiag = '', bDiag = '', aConn = '', bConn = '';
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const snap = await (async () => {
      const a = await ev(A, `
        const d = document.querySelector('#diagBox');
        const t = document.querySelector('#diagToggle');
        if (t && d && d.hidden) t.click();
        return d ? d.textContent : '';
      `);
      const b = await ev(B, `
        const d = document.querySelector('#diagBox');
        const t = document.querySelector('#diagToggle');
        if (t && d && d.hidden) t.click();
        return d ? d.textContent : '';
      `);
      const ac = await ev(A, `const b = document.querySelector('#connDot b'); return b ? b.textContent : '';`);
      const bc = await ev(B, `const b = document.querySelector('#connDot b'); return b ? b.textContent : '';`);
      return { a, b, ac, bc };
    })();
    aDiag = snap.a; bDiag = snap.b; aConn = snap.ac; bConn = snap.bc;
    if (/已同步|已连上|已连接/.test(aConn) && /已同步|已连上|已连接/.test(bConn)) break;
    if (i === 12) console.log('...12s 还没连上，继续等');
  }

  console.log('\n========== A（房主）连接状态：' + aConn + ' ==========');
  console.log(aDiag);
  console.log('\n========== B（客人）连接状态：' + bConn + ' ==========');
  console.log(bDiag);

  // 发一条消息验证数据通道
  const msgTest = await ev(A, `
    return new Promise((res) => {
      try {
        if (!window.P2P || !window.P2P.connected) return res('NOT_CONNECTED');
        window.P2P.send({ t: 'verify', v: 'ping-' + Date.now() });
        res('SENT');
      } catch (e) { res('ERR ' + e.message); }
    });
  `);
  await sleep(1500);
  const got = await ev(B, `
    const items = document.querySelectorAll('.chat-item, .msg, .bubble');
    return 'bubbles=' + items.length + ' hasVerify=' + (document.body.innerText.includes('verify') ? 'y' : 'n');
  `);

  console.log('\n数据通道发送 ->', msgTest);
  console.log('对端 DOM ->', got);

  await cdp.send('Browser.close').catch(() => {});
  chrome.kill();
  server.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  try { server.close(); } catch {}
  process.exit(1);
});
