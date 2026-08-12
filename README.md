# lookthru

移动端优先的公募基金持仓追踪 PWA。名字取自 **look-through**（持仓穿透）—— 聚合所有持仓基金的重仓股，看到股票级的真实敞口和重复押注。天天基金不做这件事，这是本项目相对现有工具的主要差异点。

另一个差异点：官方盘中估值已全面下线，我们自建估值引擎，并且**明示每个估值的精度等级与误差来源** —— 官方从不告诉你估值有多准。

> ⚠️ 个人自用项目，非公开注册（邀请码制）。所有数据来自公开接口，**不构成任何投资建议**。

已部署 → https://lookthru.ffkiyo7.workers.dev

---

## 文档

| 文档 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | **AI agent 从这里开始**。命令、职责边界、红线清单 |
| [docs/architecture.md](docs/architecture.md) | 架构决策及其理由 |
| [docs/data-sources.md](docs/data-sources.md) | 上游接口实测结论、降级链、每个源的坑 |
| [docs/frontend.md](docs/frontend.md) | 设计系统、令牌、UI 不变量 |
| [docs/roadmap.md](docs/roadmap.md) | 当前进度、下一步、每块入手点 |

---

## 现在做到哪了

**P0（出口风险验证）已通过**，Cron 仍每 5 分钟采样，判定面板在 `/probe`。

整个架构押在一个假设上：Cloudflare Workers 从 CF 全球共享 IP 池出网，能否稳定抓取上游。出口地域不可控，云厂商 IP 被限速/封禁是真实风险。

**这个风险已经部分兑现**：东财行情接口 `push2` 从 CF 出口稳定 502，但基金列表与档案接口正常 —— 不是整体封禁，只有行情这一条线。已改为四级降级链解决，**不需要动用「上游抓取全迁 GitHub Actions」的终极退路**。详见 [data-sources.md](docs/data-sources.md#-行情源必须走降级链)。

邀请码登录、持仓流水、盘中估值、持仓穿透和 Discord 日报/告警已经接通生产数据。持仓与穿透页保留 `?state=empty|loading|stale|failing`，只用于预览各状态，不会替代正常请求。

| 路由 | 页面 | 数据 |
|---|---|---|
| `/` | 持仓总览 | 真实 |
| `/fund/:code` | 基金详情 | 真实 |
| `/search` | 基金搜索 | 真实 |
| `/xray` | 持仓穿透 | 真实 |
| `/settings` | 设置 | 偏好与加密通知绑定均真实 |
| `/probe` | P0 判定面板 | 真实 |

---

## 本地开发

```bash
npm install
cp .wrangler-ids.example .wrangler-ids   # 填入 CF 资源 id，见下

npm run db:migrate:local
npm run build          # 前端必须先构建，Worker 才有 assets 可托管
npm run dev            # → http://localhost:8787
npm run dev:web        # 另开终端，前端热更新 → :5173，/api 代理到 :8787
```

验证：

```bash
npm run typecheck
npm run test
npm run test:live      # 打真实上游端点的契约测试
```

`test:live` 里最关键的是**跨源一致性**测试：拿 pingzhongdata 的最新净值日期与 lsjz、新浪逐一比对。东财的时间戳是「北京时间当日零点」，时区换算写错会让整条净值曲线偏移一天且不报错 —— 这条测试是唯一能抓到它的地方。

---

## 部署

**资源 id 不入库**：`wrangler.toml` 里是 `PLACEHOLDER_<KEY>` 占位符，真实值放在 gitignore 的 `.wrangler-ids`，由 `scripts/gen-wrangler.mjs` 生成 `.wrangler.generated.toml` 供 wrangler 使用。这样 `wrangler.toml` 仍是唯一配置真相源，不会出现 example 文件与实际配置各改各的漂移。

```bash
npx wrangler login

npx wrangler d1 create lookthru            # → database_id
npx wrangler kv namespace create CACHE     # → id
npx wrangler r2 bucket create lookthru-archive

cp .wrangler-ids.example .wrangler-ids     # 填入上面两个 id

npm run db:migrate
npx wrangler secret put NOTIFY_KEY   # 32 字节 base64url AES-GCM 密钥；缺失时部署会失败
npm run deploy
curl -X POST https://<域名>/api/probe/run  # 立刻探一次，不必等 Cron
```

部署后先由管理员把一次性邀请码的 SHA-256 哈希手工写入 D1；用户兑换后会拿到只显示一次的恢复码。Discord 日报与告警各用一个专用频道，在登录后的设置页分别保存和测试，webhook URL 只以 AES-GCM 密文存入 D1。

> **需要 Workers Paid（$5/月）**。免费版每请求仅 10ms CPU，解析 3.1MB 基金列表必然超时。
>
> **R2 需先在 Dashboard 点一次「Enable R2」**，否则 `r2 bucket create` 报 `code: 10042`。

D1 / KV / R2 三个 binding 均已验证可读写（R2 走 put → get → delete 往返）。

---

## 结构

```
wrangler.toml              单 Worker：Static Assets(前端) + API + Cron + bindings
scripts/gen-wrangler.mjs   占位符 → 真实 id
apps/web/                  Vite + React 19 PWA
apps/api/src/sources/      上游数据源 + 降级链
apps/api/src/probe.ts      P0 出口探针
packages/shared/           zod schema + 类型 + 判定函数（前后端共享）
tests/*.live.test.ts       真实端点契约测试
```
