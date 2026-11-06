/* 验证「切到后台不拆连接，回来静默恢复」
 * 用 CDP 的 Debugger.pause 真实冻结一方页面：JS 全停、网络栈照跑，
 * 等价于安卓切到微信后的状态。这不是 mock。
 *
 * 跑法：node tools/verify-keepalive.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = 'C:/Users/c/WorkBuddy/2026-11-03-21-51-06/couple-play/public';
const PORT = 8124;
const CDP_PORT = 9334;
const CHROME = 'C:/Users/c/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe';
const FREEZE_MS = 55000;          // 超过 HB_AWAY(45s)，用来触发「暂时不在」

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(path.normalize(ROOT))) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
});

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.onopen = () => res(); this.ws.onerror = () => rej(new Error('ws error')); });
    this.ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
      }
    };
  }
  send(method, params = {}, sessionId) {
    return new Promise((res, rej) => {
      const i = ++this.id;
      this.pending.set(i, { res, rej });
      this.ws.send(JSON.stringify({ id: i, method, params, sessionId }));
      setTimeout(() => { if (this.pending.has(i)) { this.pending.delete(i); rej(new Error('timeout ' + method)); } }, 90000);
    });
  }
}

async function main() {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const userDir = path.join(tmpdir(), 'duo-ka-' + Date.now());
  const chromeLog = path.join(tmpdir(), 'duo-ka-chrome.log');
  const out = fs.openSync(chromeLog, 'w');
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--no-proxy-server', '--disable-features=Translate', '--remote-allow-origins=*',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + userDir,
    '--window-size=420,900', 'about:blank',
  ], { stdio: ['ignore', out, out] });

  const getJson = (p) => new Promise((res, rej) => {
    const req = http.get({ host: '127.0.0.1', port: CDP_PORT, path: p, timeout: 2000 }, (r) => {
      let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    });
    req.on('error', rej); req.on('timeout', () => req.destroy(new Error('timeout')));
  });

  let ver = null;
  for (let i = 0; i < 60; i++) { await sleep(500); try { ver = await getJson('/json/version'); break; } catch {} }
  if (!ver) { console.error(fs.readFileSync(chromeLog, 'utf8').slice(0, 1200)); throw new Error('chrome 没起来'); }
  console.log('chrome:', ver['Browser']);

  const cdp = new CDP(ver.webSocketDebuggerUrl);
  await cdp.ready;

  async function openPage(url) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Debugger.enable', {}, sessionId);
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
    const r = await cdp.send('Runtime.evaluate', { expression: `(() => { ${expr} })()`, returnByValue: true, awaitPromise: true }, page.sessionId);
    if (r.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }

  // 采一帧现场
  async function snap(page) {
    return ev(page, `
      const d = window.P2P ? window.P2P.diag : {};
      const b = document.querySelector('#connDot b');
      const h = document.querySelector('#waitHint');
      return {
        connected: !!(window.P2P && window.P2P.connected),
        away: !!(window.P2P && window.P2P.away),
        label: b ? b.textContent : '',
        hint: h ? h.textContent : '',
        phase: d.phase, connOpen: d.connOpen, awayMs: d.awayMs,
        rebuild: d.rebuild, recoverMs: d.recoverMs, err: d.errType || '',
      };
    `);
  }

  async function freeze(page) { await cdp.send('Debugger.pause', {}, page.sessionId); }
  async function thaw(page) { await cdp.send('Debugger.resume', {}, page.sessionId); }

  const APP = `http://127.0.0.1:${PORT}/`;
  const A = await openPage(APP);
  const B = await openPage(APP);

  for (const p of [A, B]) await ev(p, `localStorage.setItem('duo_lock_until', String(Date.now() + 2592000000)); return 1;`);
  await cdp.send('Page.reload', {}, A.sessionId);
  await cdp.send('Page.reload', {}, B.sessionId);
  await sleep(2500);
  for (const p of [A, B]) {
    await ev(p, `const g = document.querySelector('#gateEnter'); if (g) g.click(); return 1;`).catch(() => {});
  }
  await sleep(1200);

  await ev(A, `const t = document.querySelector('[data-action="create"]'); if (t) t.click(); return 1;`);
  let code = '';
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    code = await ev(A, `const el = document.querySelector('#codeValue'); return el ? el.textContent.trim() : '';`);
    if (/^\d{6}$/.test(code)) break;
  }
  console.log('房间码 =', code);
  if (!/^\d{6}$/.test(code)) throw new Error('房主没拿到房间码');

  await ev(B, `const t = document.querySelector('[data-action="join"]'); if (t) t.click(); return 1;`);
  await sleep(600);
  await ev(B, `
    const i = document.querySelector('#joinInput');
    const n = document.querySelector('#joinName');
    i.value = '${code}';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    if (n) { n.value = '乙'; n.dispatchEvent(new Event('input', { bubbles: true })); }
    document.querySelector('#joinBtn').click();
    return 1;
  `);

  let base = null;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const a = await snap(A); const b = await snap(B);
    if (a.connected && b.connected) { base = { a, b }; break; }
  }
  if (!base) throw new Error('两端没连上，后面的场景无意义');
  console.log('\n[基线] 房主', JSON.stringify(base.a));
  console.log('[基线] 客人', JSON.stringify(base.b));

  /* ---------- 场景 1：房主切到后台 55 秒 ---------- */
  console.log('\n===== 场景 1：房主页面冻结 55 秒（等价切到微信） =====');
  const t0 = Date.now();
  await freeze(A);
  await sleep(20000);
  const mid = await snap(B);
  console.log(`客人 @20s：`, JSON.stringify(mid));
  await sleep(FREEZE_MS - 20000);
  const stuck = await snap(B);
  console.log(`客人 @${Math.round((Date.now() - t0) / 1000)}s：`, JSON.stringify(stuck));

  const pass1 = stuck.connected === true && stuck.away === true && !/关掉页面/.test(stuck.hint);
  console.log(`判定：连接保留=${stuck.connected} 标记不在=${stuck.away} 没拆会话=${!/关掉页面/.test(stuck.hint)} -> ${pass1 ? 'PASS' : 'FAIL'}`);

  await thaw(A);
  const tr = Date.now();
  let back = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const s = await snap(B);
    if (s.connected && !s.away) { back = s; break; }
  }
  console.log(`解冻后 ${Date.now() - tr}ms：`, JSON.stringify(back));
  const pass2 = !!back;
  console.log('判定：', pass2 ? 'PASS（回来自动恢复，未点任何按钮）' : 'FAIL');

  /* ---------- 场景 2：客人切后台 55 秒 ---------- */
  console.log('\n===== 场景 2：客人页面冻结 55 秒 =====');
  await freeze(B);
  await sleep(FREEZE_MS);
  const hostSees = await snap(A);
  console.log('房主视角：', JSON.stringify(hostSees));
  const pass3 = hostSees.connected === true && hostSees.away === true;
  console.log('判定：', pass3 ? 'PASS' : 'FAIL');
  await thaw(B);
  let back2 = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const s = await snap(A);
    if (s.connected && !s.away) { back2 = s; break; }
  }
  console.log('房主恢复后视角：', JSON.stringify(back2));
  console.log('判定：', back2 ? 'PASS' : 'FAIL');

  /* ---------- 场景 3：客人刷新页面（模拟被系统回收后重建） ---------- */
  console.log('\n===== 场景 3：客人整页重新加载（模拟页面被系统杀掉） =====');
  await cdp.send('Page.reload', {}, B.sessionId);
  await sleep(3000);
  const afterReload = await ev(B, `
    const t = document.querySelector('#waitHint');
    const screen = document.querySelector('.screen.active');
    return { screen: screen ? screen.id : '?', hint: t ? t.textContent : '', code: document.querySelector('#codeValue') ? document.querySelector('#codeValue').textContent : '', saved: sessionStorage.getItem('duo_session') };
  `);
  console.log('重载后落地：', JSON.stringify(afterReload));
  let rejoin = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const s = await snap(B);
    if (s.connected) { rejoin = s; break; }
  }
  console.log('重载后重连：', JSON.stringify(rejoin));
  const pass4 = !!rejoin && afterReload.screen === 'screen-room';
  console.log('判定：', pass4 ? 'PASS（自动回到房间并接上）' : 'FAIL');

  /* ---------- 场景 4：客人真的关掉页面 ---------- */
  console.log('\n===== 场景 4：客人关闭页面（这才是「真的走了」） =====');
  await cdp.send('Target.closeTarget', { targetId: B.targetId });
  await sleep(30000);
  const mid4 = await snap(A);
  console.log(`房主 @30s（还没到 45s 阈值）：`, JSON.stringify(mid4));
  const noFalseAlarm = !/重连中|关掉页面/.test(mid4.label + mid4.hint);
  await sleep(30000);
  const gone = await snap(A);
  console.log(`房主 @60s：`, JSON.stringify(gone));
  const pass5 = gone.away === true && gone.connected === true && noFalseAlarm;
  console.log('判定：', pass5 ? 'PASS（30 秒不误报，60 秒才降级为「Ta 不在」，会话未被拆）' : 'FAIL');

  console.log('\n===== 汇总 =====');
  const items = [['冻结 55s 不拆连接', pass1], ['解冻自动恢复', pass2], ['客人冻结房主不误判', pass3], ['房主回来自动恢复', !!back2], ['重载自动回房', pass4], ['关页面 30s 不误报', pass5]];
  items.forEach(([n, ok]) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`));
  console.log('通过 ' + items.filter(i => i[1]).length + '/' + items.length);

  await cdp.send('Browser.close').catch(() => {});
  chrome.kill();
  server.close();
  process.exit(items.every(i => i[1]) ? 0 : 2);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  try { server.close(); } catch {}
  process.exit(1);
});
