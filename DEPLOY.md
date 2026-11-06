# 部署说明

`love.hser.ren` 的线上部署**只有一条路径：GitHub Pages**。

## 发布流程

1. 改完 `public/` 下的文件
2. 推送到 `csdsq/love-room` 的 `main` 分支（或 `GITHUB_TOKEN=xxx node tools/deploy.mjs "说明"`）
3. GitHub Actions（`.github/workflows/pages.yml`）自动把 `public/` 发布到 Pages
4. 约 30 秒后刷新 `https://love.hser.ren`

## 域名与证书

- 自定义域名：`love.hser.ren`
- DNS：Cloudflare `CNAME → csdsq.github.io`（DNS only，灰云）
- 证书：GitHub Pages 自动签发和续期
- 强制 HTTPS 已开启

## 关于 `deploy/` 目录

`deploy/` 是早期把站点跑在阿里云 ECS（8.149.139.66）上的方案：nginx + systemd + 阿里云云助手远程执行。
线上从未使用，已停用，**不要再执行**。

里面残留的 `/api/stream`（SSE 长连接）和 `/api/health` 是更早一版「HTTP + SSE 同步」架构的遗留；
当前 `server.js` 只有静态托管、没有任何 API 路由，这些配置即使启用也只会 404。相关残留已清理。

## TURN 中继

极端网络（双方都在对称 NAT / CGNAT 后面）下 P2P 打洞不可能成功，站点会自动降级到自建 coturn：

- 地址：`turn:8.149.139.66:3478`（UDP / TCP）
- 服务：阿里云 ECS `i-bp1cdujt8uyinckfjjtv`，`systemctl status coturn`
- 端口：3478（TCP/UDP）+ 49200-49300（UDP 中继）
- 配额：单用户 3 路、总并发 30 路、单路 2Mbps
- 配置：`/etc/coturn/turnserver.conf`，日志 `/var/log/coturn/turnserver.log`

TURN 只在打洞失败时使用，正常情况仍是点对点直连。
