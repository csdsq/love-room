/**
 * 发布脚本 —— 用 GitHub API 提交并触发 Pages 重新部署
 *
 * 为什么不用 git push：
 *   有些网络环境下 git 的 HTTPS POST 会被代理掐断（CONNECT tunnel 502），
 *   但 GitHub API 是通的。这个脚本走 API，效果一样。
 *
 * 用法：
 *   GITHUB_TOKEN=ghp_xxx node tools/deploy.mjs "改了点什么"
 *
 * 会自动比对本地文件与远端 Git tree 的 sha，只提交真正变化的部分。
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const TOKEN = process.env.GITHUB_TOKEN;
const OWNER = process.env.GITHUB_OWNER || 'csdsq';
const REPO = process.env.GITHUB_REPO || 'love-room';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!TOKEN) {
  console.error('缺少 GITHUB_TOKEN。用法：GITHUB_TOKEN=ghp_xxx node tools/deploy.mjs "提交说明"');
  process.exit(1);
}

const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const H = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
  'User-Agent': 'love-room-deploy',
};

async function call(method, url, body) {
  const res = await fetch(url, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

const SKIP = new Set(['.git', 'node_modules', 'deploy']);

function walk(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (SKIP.has(e.name)) continue;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

const blobSha = (buf) =>
  crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex');

async function main() {
  const local = new Map();
  for (const rel of walk(ROOT)) local.set(rel, fs.readFileSync(path.join(ROOT, rel)));

  const ref = await call('GET', `${API}/git/ref/heads/main`);
  const commit = await call('GET', `${API}/git/commits/${ref.object.sha}`);
  const tree = await call('GET', `${API}/git/trees/${commit.tree.sha}?recursive=1`);
  const remote = new Map((tree.tree || []).filter(x => x.type === 'blob').map(x => [x.path, x.sha]));

  const added = [], changed = [], removed = [];
  for (const [rel, buf] of local) {
    if (!remote.has(rel)) added.push(rel);
    else if (remote.get(rel) !== blobSha(buf)) changed.push(rel);
  }
  for (const rel of remote.keys()) if (!local.has(rel)) removed.push(rel);

  console.log(`本地 ${local.size} 个文件 | 新增 ${added.length} / 改动 ${changed.length} / 删除 ${removed.length}`);
  if (!added.length && !changed.length && !removed.length) {
    console.log('远端已是最新，无需提交');
    return;
  }

  const entries = [];
  for (const rel of [...added, ...changed]) {
    const blob = await call('POST', `${API}/git/blobs`, {
      content: local.get(rel).toString('base64'),
      encoding: 'base64',
    });
    entries.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha });
    console.log('  ↑', rel);
  }
  for (const rel of removed) {
    entries.push({ path: rel, mode: '100644', type: 'blob', sha: null });
    console.log('  ✕', rel);
  }

  const newTree = await call('POST', `${API}/git/trees`, { base_tree: commit.tree.sha, tree: entries });
  const newCommit = await call('POST', `${API}/git/commits`, {
    message: process.argv[2] || '更新站点',
    tree: newTree.sha,
    parents: [ref.object.sha],
  });
  await call('PATCH', `${API}/git/refs/heads/main`, { sha: newCommit.sha });
  console.log('提交:', newCommit.sha.slice(0, 8));

  const wfs = await call('GET', `${API}/actions/workflows`);
  const wf = wfs.workflows.find(w => w.path.includes('pages.yml'));
  if (wf) {
    const res = await fetch(`${API}/actions/workflows/${wf.id}/dispatches`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ ref: 'main' }),
    });
    console.log('触发部署:', res.status === 204 ? '✓ 约 30 秒后生效' : res.status);
  }
}

main().catch(e => { console.error('发布失败:', e.message); process.exit(1); });
