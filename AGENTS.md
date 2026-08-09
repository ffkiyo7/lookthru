# AGENTS.md

面向 AI agent 的仓库指南。人类读者看 [README.md](README.md)。

**lookthru** 是移动端优先的公募基金持仓追踪 PWA，单个 Cloudflare Worker 同时托管前端与 API。

先读这三份，再动手：

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 架构决策**及其理由**。改动前先确认没有推翻某条决策的前提 |
| [docs/data-sources.md](docs/data-sources.md) | 上游接口实测结论、降级链、每个源的坑 |
| [docs/roadmap.md](docs/roadmap.md) | 当前进度、下一步该做什么、每块的入手点 |

前端视觉相关另见 [docs/frontend.md](docs/frontend.md)。

---

## 命令

```bash
npm install              # npm workspaces（无 pnpm）

npm run typecheck        # 三个 project 全查，提交前必跑
npm run test             # 单元测试
npm run test:live        # 契约测试，打真实上游端点（会发网络请求）

npm run dev              # Worker + 前端产物 → :8787
npm run dev:web          # 另开终端，前端热更新 → :5173，/api 代理到 :8787
npm run build            # 只构建前端

npm run db:migrate:local # D1 迁移（本地）
npm run db:migrate       # D1 迁移（远端）
npm run deploy           # 构建前端 + 发布 Worker
```

`npm run dev` 前必须先 `npm run build`，否则 Worker 没有 assets 可托管。

**资源 id 不入库**：`wrangler.toml` 里是 `PLACEHOLDER_<KEY>`，真实值在 gitignore 的 `.wrangler-ids`，由 `scripts/gen-wrangler.mjs` 生成 `.wrangler.generated.toml` 供 wrangler 使用。所有 npm 脚本已接好，直接用即可。新增资源时同步更新 `.wrangler-ids.example`。

---

## 结构

```
wrangler.toml              单 Worker：Static Assets(前端) + API + Cron + bindings
scripts/gen-wrangler.mjs   占位符 → 真实 id
apps/
  web/                     Vite + React 19 PWA
    src/index.css          设计令牌（改动影响全站）
    src/components/        通用组件
    src/routes/            5 个页面 + /probe
    src/lib/               api / format / prefs / mock
  api/                     Worker 入口（Hono）
    src/index.ts           /api/* 走 Hono，其余 fallthrough 到 ASSETS
    src/sources/           上游数据源 + 降级链
    src/probe.ts           P0 出口探针
    migrations/            D1
packages/shared/           zod schema + 类型 + 判定函数（前后端共享）
tests/                     契约测试
```

---

## 职责边界

这个仓库由多个 agent 协作，分工如下。

**Codex 负责**：后端与数据层实现 —— `apps/api/**`、`packages/shared/**`、`pipelines/**`、`.github/workflows/**`、D1 migrations。也包括把真实数据接进前端路由（替换 `lib/mock.ts` 的 fixture）。

**Claude 负责**：code review、文档维护、以及**全部前端设计与 UI/UX** —— `apps/web/src/index.css`（设计令牌）、`apps/web/src/components/**` 的视觉与交互、页面布局与信息层级、`docs/**`。

**交接规则**：接数据时可以改 `routes/*.tsx` 里的数据获取与状态处理，但**不要改设计令牌、间距、配色语义、或通用组件的 API**。需要新的视觉元素（新徽章、新图表类型、新的空态/错误态）时，写清楚需要什么、数据长什么样，交回给 Claude 设计，不要临时拼一个。

理由：设计稿出自 Claude Design，令牌是从稿子里提取的。临时改一处颜色或间距不会报错，但会让整套视觉逐渐失去一致性，而且没有测试能抓到。

---

## 红线

以下每一条，改坏了都不会报错，但会产生**静默错误的数据**或**误导用户的展示**。动到相关代码时务必确认。

### 数据正确性

1. **东财时间戳是「北京时间当日零点」**（UTC 前一日 16:00）。换算见 `apps/api/src/sources/eastmoney.ts` 的 `msToDate()`。写错会让整条净值曲线偏移一天且不报错。`tests/sources.live.test.ts` 的跨源一致性测试是唯一防线 —— 不要删它。

2. **腾讯/新浪返回的名称是 GBK 乱码**。这两个源按 latin1 解码（Workers 的 TextDecoder 不保证支持 gbk），数值字段是 ASCII 不受影响，但 `name` 必须置空，名称从自有基金库取。见 `sources/tencent.ts`、`sources/sina.ts`。

3. **货币基金的 `DWJZ` 是「万份收益」不是净值**。展示时标签必须区分，否则数量级差 4 个数量级。见 `routes/Search.tsx` 的 `isMoneyFund` 分支。

4. **涨跌幅由现价与昨收算出，不要读固定下标**。腾讯的字段表很长且尾部增删过，按下标读涨跌幅会随上游变更静默错位。

5. **`delayed` 标记必须一路传到 UI**。`push2delay` 是延时行情，当实时展示是误导。链路见 `sources/quotes.ts`，API 出口见 `/api/quotes`。

### 产品诚实性

6. **盘中估算与官方净值必须视觉可分**。估算用斜体 + 灰 + 精度徽章，官方净值用正常字重。这是本产品相对天天基金的核心差异，也是诚实性底线。见 `routes/Portfolio.tsx` 的 `PositionCard`。

7. **QDII / 债基 / 货基禁用估值**（`precision = NONE`）。投美股的 QDII 在 A 股时段标的市场没开盘，盘中估值毫无意义。判定函数在 `packages/shared/src/index.ts`。

8. **汇总数字必须从持仓推导，不能写死**。且当有基金不提供估算时，要显式说明「N 只不计入今日收益」，否则总数会被误读为完整。

9. **「投资建议」一律改为「客观指标提示」**。基金投顾在中国是持牌业务。只给事实指标（赎回费、集中度、回撤、估值分位），AI 解读必须标注「不构成投资建议」。

### 架构约束

10. **绝不 per-user 请求上游**。所有用户共享同一份上游数据，100 个用户持有同一只基金 = 1 次上游请求。

11. **净值历史走 R2，不走 D1**。1.2 万基金 × 3000 天 = 3600 万行，D1 装不下也不该装。

12. **不引入任何境外 CDN 资源**（Google Fonts、unpkg、jsdelivr…）。大陆被墙，每次加载都会卡在一个必然失败的请求上再回退。字体用系统栈。

13. **`sw.js` 与 `manifest.webmanifest` 必须 `no-cache`**，否则用户永远卡在旧版本。见 `apps/web/public/_headers`。

14. **T+1 确认**：场外基金 15:00 前买入按当日净值确认，之后按次日。`status = PENDING` 状态必须存在，不能假设买入即确认。

---

## 约定

- 注释写**为什么**，不写做了什么。代码本身说明做了什么
- 上游相关的坑必须就地注释，并写明「写错会怎样」—— 这类 bug 都是静默的
- 提交信息用中文，说明动机与取舍，不只列改了什么
- 新增上游源时：先在 Worker 里实测从 CF 出口的可达性再写实现（本机能通不代表 CF 能通，见 docs/data-sources.md 的 push2 案例）
