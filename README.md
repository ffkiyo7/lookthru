# lookthru

移动端优先的公募基金持仓追踪 PWA。名字取自 **look-through**（持仓穿透）—— 聚合所有持仓基金的重仓股，看到股票级的真实敞口和重复押注，这是本项目相对现有工具的主要差异点。

> ⚠️ 个人自用项目，非公开注册（邀请码制）。所有数据来自公开接口，**不构成任何投资建议**。

**当前进度**
- P0（出口风险验证）—— 代码就绪，待部署采集 24h 数据。判定面板在 `/probe`
- 前端 5 个页面已按 Claude Design 稿实现，数据走 fixture（`apps/web/src/lib/mock.ts`），搜索已接真实东财接口

| 路由 | 页面 |
|---|---|
| `/` | 持仓总览 |
| `/fund/:code` | 基金详情 |
| `/search` | 基金搜索（真实接口） |
| `/xray` | 持仓穿透 |
| `/settings` | 设置 |
| `/probe` | P0 出口探针判定面板 |

---

## 这个阶段在验证什么

整个架构押在一个未验证的假设上：**Cloudflare Workers 从 CF 全球共享 IP 池出网，能否稳定抓取东方财富**。出口地域不可控，云厂商 IP 被限速/封禁是真实风险。

- **通过**（三端点成功率均 > 95%）→ 在线抓取留在 Workers，进入 P1
- **不通过** → 启用退路：上游抓取全部迁到 GitHub Actions，Workers 只读自己的 R2/KV。**架构不用推倒**

判定面板就是部署后的首页。

---

## 部署（需要你执行，我没有你的 Cloudflare 凭据）

```bash
# 1. 登录（会打开浏览器）
npx wrangler login

# 2. 创建三个资源
npx wrangler d1 create lookthru
npx wrangler kv namespace create CACHE
npx wrangler r2 bucket create lookthru-archive
```

前两条会各输出一个 id。把它们填进 `wrangler.toml`，替换这两个占位符：

```toml
database_id = "PLACEHOLDER_RUN_wrangler_d1_create_lookthru"   # ← d1 create 输出的 database_id
id = "PLACEHOLDER_RUN_wrangler_kv_namespace_create_CACHE" # ← kv create 输出的 id
```

```bash
# 3. 建表 + 部署
npx wrangler d1 migrations apply lookthru --remote
npm run deploy

# 4. 立刻触发一次探测（不必等 Cron）
curl -X POST https://<你的域名>/api/probe/run
```

然后打开首页看判定面板。Cron 每 5 分钟自动探测一次，满 24h 后面板给出结论。

> ⚠️ **需要 Workers Paid（$5/月）**。免费版每请求只有 10ms CPU，解析 3.1MB 的基金列表必然超时。

---

## 本地开发

```bash
npm install
npx wrangler d1 migrations apply lookthru --local
npm run build          # 前端必须先构建，Worker 才有 assets 可托管
npx wrangler dev       # → http://localhost:8787

npm run dev:web        # 另开一个终端，前端热更新 → :5173，/api 代理到 :8787
```

---

## 验证

```bash
npm run typecheck
npm run test:live      # 打真实上游端点的契约测试
```

`test:live` 里最关键的是**跨源一致性**测试：拿 pingzhongdata 的最新净值日期与 lsjz、新浪逐一比对。东财的时间戳是「北京时间当日零点」，时区换算写错会整体偏移一天 —— 这条测试是唯一能抓到它的地方。

---

## 已确认的数据源

| 数据 | 端点 | 说明 |
|---|---|---|
| 全量基金列表 | `fund.eastmoney.com/js/fundcode_search.js` | 3.1MB，解析放 GitHub Actions |
| 单基金全量档案 | `fund.eastmoney.com/pingzhongdata/{code}.js` | 净值全历史 + 每日股票仓位 + 重仓股 secid + 费率 + 经理 |
| 持仓明细 + 权重 | `fundmobapi.eastmoney.com/.../FundMNInverstPosition` | JSON，`JZBL` 是占净值比，白送行业分类 |
| 历史净值 | `api.fund.eastmoney.com/f10/lsjz` | 需 Referer |
| 批量实时行情 | `push2.eastmoney.com/api/qt/ulist.np/get` | 股票/ETF/指数通用 |
| 搜索建议 | `fundsuggest.eastmoney.com` | 中文/拼音/代码 |
| 净值批量兜底 | `hq.sinajs.cn/list=f_xxxxxx` | GBK，按 latin1 读，只取数值字段 |

### ❌ 官方盘中估值已下线

`fundgz.1234567.com.cn/js/{code}.js` 实测全部 404，`FundMNFInfo` 的 `GSZ/GSZZL` 恒为 `null`。

所以「实时净值」全部自建：用每日股票仓位 + 季报前十大权重 + 实时行情反推，并**向用户明示精度等级与误差来源**（`EXACT`/`HIGH`/`MEDIUM`/`LOW`/`NONE`）。QDII 与债基/货基直接禁用估值。详见方案 3.1。

---

## 目录

```
wrangler.toml             单 Worker：Static Assets(前端) + API + Cron + bindings
apps/web/                 Vite + React 19 PWA
apps/api/src/sources/     DataSource 实现，多源 fallback
apps/api/src/probe.ts     P0 探针
packages/shared/          zod schema + 类型（前后端共享）
tests/*.live.test.ts      真实端点契约测试
```
