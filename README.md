# lookthru

移动端优先的公募基金持仓追踪 PWA。名字取自 **look-through**（持仓穿透）—— 聚合所有持仓基金的重仓股，看到股票级的真实敞口和重复押注，这是本项目相对现有工具的主要差异点。

> ⚠️ 个人自用项目，非公开注册（邀请码制）。所有数据来自公开接口，**不构成任何投资建议**。

**当前进度**
- 已部署 → https://lookthru.ffkiyo7.workers.dev
- P0（出口风险验证）—— 正在采集 24h 数据，Cron 每 5 分钟一次。判定面板在 `/probe`
- 前端 5 个页面已按 Claude Design 稿实现，数据走 fixture（`apps/web/src/lib/mock.ts`），搜索与行情已接真实接口

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

## 部署

**资源 id 不入库。** `wrangler.toml` 里是 `PLACEHOLDER_<KEY>` 占位符，真实值放在 gitignore 的 `.wrangler-ids`，由 `scripts/gen-wrangler.mjs` 替换后生成 `.wrangler.generated.toml` 供 wrangler 使用。好处是 `wrangler.toml` 仍是唯一配置真相源，不会出现 example 文件与实际配置各改各的漂移。

```bash
npx wrangler login

# 创建资源
npx wrangler d1 create lookthru          # → database_id
npx wrangler kv namespace create CACHE   # → id

cp .wrangler-ids.example .wrangler-ids   # 把上面两个 id 填进去

npm run db:migrate                       # 建表（远端）
npm run deploy                           # 构建前端 + 发布 Worker
curl -X POST https://<域名>/api/probe/run # 立刻探一次，不必等 Cron
```

Cron 每 5 分钟自动探测，满 24h 后 `/probe` 面板给出结论。

R2 需要先在 Dashboard 点一次「Enable R2」，否则 `wrangler r2 bucket create` 报 `code: 10042`：

```bash
npx wrangler r2 bucket create lookthru-archive
```

> **需要 Workers Paid（$5/月）**，已订阅。免费版每请求仅 10ms CPU，且订阅前 `[limits] cpu_ms` 不可用。

D1 / KV / R2 三个 binding 均已验证可读写（R2 走 put → get → delete 往返）。

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
| 批量实时行情 | `{3,19,33,50}.push2.eastmoney.com` → 腾讯 → 新浪 → `push2delay` | 降级链，见下 |
| 搜索建议 | `fundsuggest.eastmoney.com` | 中文/拼音/代码 |
| 净值批量兜底 | `hq.sinajs.cn/list=f_xxxxxx` | GBK，按 latin1 读，只取数值字段 |

### ⚠️ 行情源必须走降级链（P0 实测结论）

从 Cloudflare LAX 出口实测，**东财 push2 主域不可用**：

| 源 | 结果 | 延迟 |
|---|---|---|
| `push2.eastmoney.com` | ❌ 502（稳定复现） | — |
| `2/5/99.push2` | ❌ 520 | — |
| `3/19/33/50.push2` | ✅ 200 | 3.6–5.9s |
| `push2delay` | ✅ 200 | 2.0s，**延时行情** |
| `qt.gtimg.cn`（腾讯） | ✅ 200 | 2.8s，实时 |
| `hq.sinajs.cn`（新浪） | ✅ 200 | 2.8s，实时 |
| `query1.finance.yahoo.com` | ✅ 200 | **0.1s**，但无批量接口 |

同一 URL 本机直连 200/101ms，且四种请求头组合（裸 / UA / UA+Referer / 最简参数）在每台主机上表现完全一致 —— **不是 WAF 拒请求形态，是出口 IP + CDN 回源问题，调 UA 没用**。

`fundcode_search.js` 与 `pingzhongdata` 均正常，所以不是东财整体封 CF。

实现见 `apps/api/src/sources/quotes.ts`，降级顺序：

```
东财分片(3/19/33/50) → 腾讯 → 新浪 → 东财延时
```

- 分片健康度会漂移，因此**按序试而非写死主机**。实测已出现过 `3.push2` 失败自动降到 `19.push2` 的情况
- 延时源排最后并置 `delayed: true` 向上传递 —— **滞后行情不能当实时展示**，估值精度须相应降级
- 腾讯/新浪的名称是 GBK 乱码，统一置空，名称从自有基金库取

**雅虎已评估但不采用**（`sources/yahoo.ts` 保留代码存档，未接入链路）。它从 CF 出口只要 96–142ms、数据与东财逐位一致、名称是干净 UTF-8，但**没有可用的批量接口**：v7 需 crumb+cookie 返 401，v6 已 404，只剩 v8 chart 一次一只。估值引擎每分钟刷上百只重仓股，逐只请求违反「中央化抓取」铁律且必然被限流；而境内已有腾讯、新浪两家实时批量源，它那点「境外独立性」不足以抵消这个限制。要启用把 `quotes.ts` 里那行取消注释即可。

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
