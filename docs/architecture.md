# 架构

记录**决策及其理由**。理由比结论重要 —— 前提变了，结论就该重新审。

---

## 为什么是 PWA

大陆应用商店上架金融类 App 需要资质证明，个人开发者走不通。PWA 完全绕过审核，且「发个链接朋友就能用」契合邀请码制。

PWA 与前端框架选型无关（PWA = 普通网页 + manifest + service worker，约 20 行配置）。选 React 19 是因为高保真原型由 Claude Design 产出 React + Tailwind，可直接落地。

**只用「主屏图标 + 离线缓存 + 秒开」，不用 Web Push** —— iOS 的 Web Push 要求用户先「添加到主屏幕」且无后台执行，日报走服务端 Cron + IM webhook 可靠得多。

## 为什么是无服务器

VPS 的维护成本与预算不可接受。经实测确认所有数据源都是裸 HTTP JSON/JS，**不需要 AKShare 作为在线依赖**，因此 TS 单栈 + Cloudflare 成立，月成本约 $5。

AKShare 仍可在 GitHub Actions 侧作为兜底数据源使用（那里能跑 Python）。

## 为什么是单个 Worker 而不是 Pages

Cloudflare Pages 已进入维护状态。Workers Static Assets 的优势：

- 静态资源请求**不计入 Workers 请求计费**
- 前端与 API 同源同 Worker，**无 CORS**
- 一次 `wrangler deploy` 全量发布
- 完整 bindings 支持（Pages Functions 长期落后）
- 带版本管理 / 渐进式发布 / 一键回滚

关键配置：

```toml
[assets]
directory = "./apps/web/dist"
not_found_handling = "single-page-application"   # 前端路由兜底
run_worker_first = ["/api/*"]                    # /api/* 不能被 SPA fallback 吞掉
```

**Workers Paid 是硬需求**：免费版每请求 10ms CPU，解析 3.1MB 基金列表必然超时。已订阅，`[limits] cpu_ms = 30000`。

## 技术选型

| 层 | 选择 |
|---|---|
| 前端 | Vite + React 19 + TS + Tailwind v4 + TanStack Query + `vite-plugin-pwa` |
| 托管 + API | 单个 Cloudflare Worker（Static Assets + Hono） |
| 定时 | Cloudflare Cron Triggers（**替代 VPS 做推送**） |
| 数据库 | D1 (SQLite) |
| 缓存 | KV |
| 对象存储 | R2 |
| 离线批处理 | GitHub Actions（免费 2000 min/月，可跑 Python + AKShare） |

Tailwind 用 v4 的 CSS-first `@theme` 配置，没有 `tailwind.config.js`。

---

## 核心设计

### 自建估值引擎 + 精度分级

**这是本产品最大的差异点。**

官方盘中估值已全面下线（`fundgz.1234567.com.cn` 全部 404，`FundMNFInfo` 的 `GSZ` 恒为 `null`），符合监管趋势。所以「实时净值」必须自建 —— 并且做官方从不做的事：**明示精度与误差来源**。

```
主动权益基金：
  est_chg = Σ(w_i × r_i) + (stock_position − Σw_i) × r_benchmark
    w_i             第 i 只重仓股占基金净值比（季报）
    r_i             该股当日实时涨跌幅
    stock_position  最新股票仓位（Data_fundSharesPositions）
    r_benchmark     同类/行业指数涨跌，补足未披露部分
  est_nav = prev_nav × (1 + est_chg)

被动指数基金：
  est_chg = index_chg × stock_position

场内 ETF/LOF：
  不估算，直接用实时成交价（这就是真实价格）
```

| 等级 | 适用 | 判定 |
|---|---|---|
| `EXACT` 精确 | 场内 ETF/LOF | 实时成交价 |
| `HIGH` 高 | 被动指数基金 | 跟踪指数明确 |
| `MEDIUM` 中 | 主动基金 | Σw_i ≥ 50% 且季报龄 ≤ 45 天 |
| `LOW` 低 | 主动基金 | Σw_i < 50% 或季报龄 > 60 天 |
| `NONE` 不可估 | 债基 / 货基 / **QDII** | 不显示估值 |

**QDII 必须单独识别并禁用估值** —— 投美股的 QDII 在 A 股交易时段标的市场未开盘，盘中估值毫无意义。

UI 上每个估值都带精度徽章 + 「基于 2026Q2 前十大（占 62%），持仓数据已过期 38 天」这类说明。

验收标准：选 10 只基金（2 ETF、3 指数、5 主动），交易日 14:55 记录估值，次日与官方净值比对。`HIGH` 应 < 0.15%，`MEDIUM` 应 < 0.6%，否则调整分级阈值。

### 两个「真相」必须在数据模型里分开

| | 盘中估算 | 官方确认 |
|---|---|---|
| 时点 | 09:30–15:00 | 当日 20:00–23:00 |
| 字段 | `estNav`, `estChgPct`, `precision`, `estTime` | `unitNav`, `accNav`, `chgPct`, `navDate` |
| UI | 灰色/斜体 + 精度徽章 | 正常字重 |

晚间官方净值落地后必须**回填并重算当日收益**。历史曲线只用官方净值，**绝不混入估算值**。

### 持仓数据模型：交易流水为唯一真相源

```sql
transactions(
  id, user_id, fund_code,
  type,          -- SNAPSHOT | BUY | SELL | DIVIDEND | CONVERT
  trade_date, confirm_date,
  shares, amount, price, fee,
  status,        -- PENDING | CONFIRMED
  note
)
positions_cache(user_id, fund_code, shares, cost_total, updated_at)  -- 物化视图
latest_official_navs(...)      -- 最新官方值；单位净值与货币基金万份收益分型存储
valuation_samples(...)         -- 每只基金每天一条 14:55 验收样本，晚间官方值回填
```

- **v1 UI 只暴露「当前持仓快照」**（份额 + 成本），内部写成一条 `type=SNAPSHOT` 的流水
- v2 开放完整流水，自动重算 —— **无需数据迁移**
- 副产品：XIRR / 时间加权收益率天然可算

持仓范围：**场外基金 + 场内 ETF/LOF**。个股不作为可持仓标的，只作为基金穿透成分出现。

### 抓取分工

**中央化抓取铁律**：所有用户共享同一份上游数据，绝不 per-user 请求上游。

| 任务 | 执行位置 | 频率 |
|---|---|---|
| 全量基金列表（3.1MB 解析） | GitHub Actions | 每日 06:00 |
| 净值全历史归档 → R2 | GitHub Actions | 每周 + 按需 |
| 持仓明细解析 | GitHub Actions | 季报窗口 |
| 交易日历生成 | GitHub Actions | 每年 + 每月校验 |
| 实时行情 / 估值计算 | Workers Cron | 交易时段每分钟 |
| 当日官方净值 | Workers Cron | 19:30–22:30 每 30 min |
| IM 日报 | Workers Cron | 21:00 |

这个分工同时也是 CF 出口风险的缓解：重活在 Actions 侧，Workers 只做实时。

### 数据分层

```
D1   用户/邀请码/持仓/交易流水/推送绑定/基金元数据索引/最新净值
KV   quote:{secid}       TTL 60s
     est:{fund_code}     TTL 60s
     navlatest:{code}    TTL 1h
     search:{keyword}    TTL 1h
     fundmeta:{code}     TTL 6h
R2   /meta/fundlist.json                    全量基金列表
     /nav/{fund_code}.json.gz               净值全历史
     /holdings/{code}/{report_date}.json    持仓明细
     /calendar/trading_days.json            交易日历
```

净值历史放 R2 而非 D1：1.2 万基金 × 3000 天 = 3600 万行，超出 D1 的合理范围，也会撞上免费版 10 万写/天。

### Notifier 抽象

```ts
interface Notifier {
  send(binding: NotifyBinding, brief: DailyBrief): Promise<Result>
}
```

交付顺序：飞书（大陆可直连、卡片消息最好）→ Telegram → Discord。

- webhook URL 是密钥，D1 中加密存储
- 21:00 发送；部分基金净值未更新时照发，卡片内标注「N 只基金净值未更新」
- 失败重试：22:00 补发一次

### 「投资建议」改为「客观指标提示」

基金投资顾问在中国是持牌业务。改为纯事实指标，既规避监管风险又更有用：

- **7 日内赎回费 1.5% 惩罚提醒**（纯事实，最实用）
- 持仓集中度 / **行业重叠度**（穿透后计算）
- 最大回撤 / 波动率 / 夏普比率
- 跟踪指数 PE/PB 估值分位
- 定投提醒
- AI 解读（可选，明确标注「AI 生成，不构成投资建议」）

**持仓穿透是杀手锏**：聚合所有持仓基金的前十大重仓股 → 看到股票级真实敞口和重复押注。天天基金不做这件事，而这正好用上了「关联股票」数据。项目名 lookthru 即取自 look-through（持仓穿透）。

---

## Cron 时刻表

北京时间，CF 配置需换算 UTC（北京 = UTC+8）。

| 时间 | 任务 | UTC cron |
|---|---|---|
| 09:25 | 交易日检查 + 预热重仓股 secid | `25 1 * * 2-6` |
| 09:30–11:30 / 13:00–15:00 每 1 min | 拉行情 → 算估值 → 写 KV | `* 1-3,5-7 * * 2-6` |
| 15:05 | 收盘快照 | `5 7 * * 2-6` |
| 19:30–22:30 每 30 min | 拉当日官方净值 | `30 11-14 * * 2-6` + `0 12-14 * * 2-6` |
| 21:00 | IM 日报 | `0 13 * * 2-6` |

Cloudflare 的星期编号是 `1=周日`，因此周一至周五必须写 `2-6`。分钟级表达式只能粗框小时，dispatcher 还会收紧到真实交易分钟；交易日最终以 R2 `calendar/trading_days.json` 为准，日历不可用时估值相关任务 fail closed。`/api/health` 暴露日历可用性。

`wrangler.toml` 同时保留 P0 的 `*/5 * * * *` 探针与上表正式时刻表；测试会比较配置集合与代码中的 `CRONS` 注册表，未知表达式必须告警，不能静默变成空跑。

**实时刷新方式**：客户端每 60s 轮询自己的 Worker（Worker 读 KV 缓存）。不用 Durable Objects / SSE —— 对当前规模是过度设计，且 DO 额外收费。

---

## 风险与退路

| 风险 | 缓解 / 退路 |
|---|---|
| **CF 出口 IP 抓不到上游** | ① 激进缓存压低请求量 ② 中央化抓取 ③ 多源降级链 ④ 终极退路：上游抓取全迁 GitHub Actions，Workers 只读自己的 R2/KV —— **架构不用推倒**。已部分兑现，详见 docs/data-sources.md |
| ⚠️ **终极退路本身未经验证** | 上游按地域派发源站，Actions（Azure）拿到的源站已实测出间歇性传输层失败，而 CF 出口同期 265/265。**启用退路前必须先在 Actions 侧挂连续探针**，否则是从一个未验证出口换到另一个。见 docs/data-sources.md「出口地域决定你能拿到哪个源站」 |
| 上游结构变更 | `DataSource` 接口 + 多源 fallback；契约测试打真实端点，CI 定期跑。传输层抖动会 skip 而非 fail —— 分类规则见 docs/data-sources.md「契约测试为什么会红」 |
| 上游故障导致 UI 空白 | 永远返回 last-known-good + 陈旧度徽章，绝不空白 |
| D1 写入超限 | 净值历史走 R2 |
| 交易日历缺失或 R2 抖动 | 日历结果可负缓存；估值/预热/收盘样本 fail closed，`/api/health` 明示 `tradingCalendar.available=false` |
| 估值误差误导用户 | 精度分级 + 持仓陈旧天数明示 + QDII/债基禁用估值 |
| 合规 | 邀请码制（非公开注册）；「客观指标提示」而非「投资建议」；全站免责声明；数据不批量转售 |
| 上游 ToS 灰区 | 礼貌限流（≤1 req/s + jitter）、激进缓存、不做数据批量再分发 |

---

## 验收方法

**P0（架构是否成立）** —— 三端点成功率均 > 95%，判定面板在 `/probe`。

**收益计算** —— 手工构造含 T+1 待确认、跨分红的用例，与天天基金 App 显示值逐项对账。

**日报** —— 手动触发 Cron，三平台各收一次；构造「部分基金净值未更新」场景验证降级文案。

**PWA** —— iOS Safari + Android Chrome 添加到主屏幕；断网后能看到缓存的持仓；Lighthouse PWA 分项全绿。
