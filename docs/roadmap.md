# 进度与下一步

更新于 2026-08-12。

---

## 现状

已部署 → https://lookthru.ffkiyo7.workers.dev

| Phase | 内容 | 状态 |
|---|---|---|
| **P0** | 出口风险验证（阻塞性） | ✅ **通过**（30.9h，三端点 288/288 全 100%） |
| P1 | 基金库 + 搜索 + 详情 + 手动持仓录入 + 官方净值收益 | 🟡 UI 全完成；数据层已部署（D1 + Cron + 净值落库 + KV），持仓/详情仍走 fixture |
| P2 | 自建估值引擎 + 精度分级 + 盘中刷新 | ⚪ 类型与 UI 就位，**引擎未写** |
| P3 | 收益可视化 | 🟡 净值曲线已实现，归因/日收益柱状未做 |
| P4 | Notifier（飞书 → Telegram → Discord） | ⚪ 仅设置页 UI |
| P5 | 持仓穿透 + 客观指标提示 | 🟡 UI 完成，**聚合算法未写** |
| P6 | OCR spike + 落地 | ⚪ |
| P7 | 交易流水 / 分红 / 多用户加固 | ⚪ |

**注意区分「UI 做完了」和「功能做完了」。** 估值引擎、穿透聚合、Notifier 适配器三块都还是空壳，只有类型定义和界面。

空态 / 加载态 / 陈旧态已补齐（`components/states.tsx`），持仓页与穿透页的分支已经写好，**接数据时不要另起炉灶**：两个页面顶部都有标了「数据接入点」的注释块，把那几行换成 `useQuery` 即可，下面的分支不用动。这几屏用 `?state=empty|loading|stale|failing` 直接看，见 [frontend.md](frontend.md#8-空态--加载态--陈旧态是三件事不能互相代替)。

### 基础设施

| 项 | 状态 |
|---|---|
| Workers Paid | ✅ 已订阅，`[limits] cpu_ms = 30000` |
| D1 `lookthru` | ✅ `0001_probe.sql` + `0002_data_layer.sql` 已应用远端；五张数据层表只读核验通过 |
| KV `CACHE` | ✅ 搜索、基金分类、最新净值、交易日历与告警去重均已上线 |
| R2 `lookthru-archive` | 🟡 `calendar/trading_days.json` 已生效（242 天，覆盖至 2026-12-31）；其余归档 pipeline 未建 |
| Cron | ✅ 正式分派 + 配置同步测试 + 未知表达式告警 + 交易日历守卫，已部署 |
| GitHub Actions | 🟡 契约测试 + 交易日历 workflow；**缺 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets，定时刷新跑不起来** |

> **部署口径**：数据层、交易日历、估值引擎均已部署生效（Worker 版本 `712e9806`）。写“已实现”时默认指仓库代码，不等于线上已生效 —— 这两件事必须分开说。再加一层：**线上生效也不等于线上有数据**，估值引擎上线当天 8/10 基金因缺前一交易日净值返回 `NONE`，代码、部署、数据是三件事。

---

## P0：✅ 通过

面板 → https://lookthru.ffkiyo7.workers.dev/probe

| 端点 | 结果 | p50 |
|---|---|---|
| `fundcode_search.js` | 288/288 = 100% | 219ms |
| `pingzhongdata` | 288/288 = 100% | 11ms |
| 批量行情（**整条降级链**） | 288/288 = 100% | 2411ms |

判定标准是三端点成功率均 > 95%、采样 ≥ 24h，实际跑了 30.9h 零失败。**架构成立，可以直接在 Workers 侧做在线抓取。**

`quotes` 那项测的是整条降级链而不是单一主机 —— 单主机成功率对架构判定没有意义，「有没有一条路能拿到行情」才有。它的 p50 比另外两项高一个数量级（2411ms vs 219ms），这是绕开东财主域走分片的代价；估值引擎每分钟刷上百只重仓股时要留意批次并发，别让单次 cron 拖太久。

延时口径也不同：`fundlist` / `pingzhong` 记录限流排队后的单次 HTTP 网络耗时；`quotes` 记录整条降级链端到端耗时，包含源间切换与限流排队。三项各自与自己的历史基线比较，**不要横向比较绝对值**。

风险已部分兑现：东财行情线从 CF 出口不可用，但基金列表与档案正常，**不需要动用「全迁 GitHub Actions」的终极退路**。详见 [data-sources.md](data-sources.md)。

### 两条不要读过头的口径

1. **成功率与 colo 分布统计的都是最近 24h 滚动窗口，不是全时段。** 当前窗口里只剩 `IAD`（864 次，100%），早先出现过的 `LAX` 已经滚出去了。所以证明的是「单个边缘节点连续可用」，**不等于「出口地域不可控」这条核心风险被排除** —— 那需要观察到足够多的 colo。探针成本可以忽略（每 5 分钟一次），**继续跑着**，它是唯一能发现地域性封禁的东西。

2. 判定采样时长必须用 `firstProbedAt`（全时段最早探测），不是 `since`（滚动窗口起点）。用错的话跑满 24h 后 `hours` 会永远卡在 23.9x，面板一直显示「采样中」—— 这个 bug 已修（`probe.ts`），别改回去。

---

## 下一步

### 0. 数据层落地 —— 先做这个，它是下面三块的前置

**为什么排在估值引擎前面**：估值引擎的验收标准是「交易日 14:55 记录估值，次日与官方净值比对」。没有落库的地方，引擎写完那天一条都验不了，得等数据层建好再等若干个交易日；反过来先建数据层，引擎落地当天估值就自动被记下来，第二天早上直接有误差报表。这一块工作量也小得多。

五件事，其中前四项代码已完成，第五项仍阻塞估值引擎：

1. ✅ **D1 建表** —— `users` / `transactions` / `positions_cache` / `latest_official_navs` / `valuation_samples` 已建，远端 migration 已完成
2. ✅ **Cron 分派** —— 正式时刻表与探针并存；代码与 `wrangler.toml` 有同步测试，未知表达式会告警
3. ✅ **官方净值落库** —— 普通基金以新浪批量为主，货币基金单独存万份收益；旧日期不能覆盖新日期，官方值会回填估值样本
4. ✅ **KV 缓存层** —— 搜索、基金分类、最新净值和交易日历均已接入；支持 last-known-good 与 `null` 负缓存
5. 🟡 **交易日历 pipeline + 可用性指示** —— pipeline 与 R2 对象已完成（`pipelines/trading_calendar.py` 解析上交所年度休市通知，全量校验后写 R2；`.github/workflows/trading-calendar.yml` 每月校验、12/25 生成双年）。`/api/health` 暴露 `tradingCalendar`，`/probe` 面板有对应指示灯。**剩两件未闭环**：GitHub secrets 未配置（见下），以及 `coversUntil` 尚未上报（见「日历会在跨年时静默断掉」）

日历对象的格式已经被 `parseTradingCalendar()` 锁死，pipeline 必须照着产出，否则会被当成非法直接丢弃（进而 fail closed）：

```json
{ "generatedAt": "2026-08-11T14:41:34.710Z", "tradingDays": ["2026-01-02", "2026-01-05"] }
```

`tradingDays` 每项必须是 `YYYY-MM-DD`；重复项会去重、顺序会重排，但**非法格式一项都不能有** —— 校验是全量的，一项不合格整份日历作废。

#### 日历会在跨年时静默断掉

当前日历覆盖到 **2026-12-31**（242 天，从 2026-08-12 起还剩 96 个交易日）。`_download_notices()` 里下一年是**可选**的：

```python
years = [start_year]
if start_year + 1 in links:
    years.append(start_year + 1)
```

12/25 那次运行 `--year` 默认是 2026。**如果上交所那时还没发 2027 年的通知，脚本不会报错** —— 它照常生成一份只含 2026 的日历，写进 R2，`generatedAt` 刷成崭新的。于是：workflow 绿、`available: true`、生成时间新鲜，而 1 月 4 日开市后 `isTradingDay` 每天都是 false，估值静默停摆。**所有指示灯全绿，系统是死的。**

两个口子都已补上（2026-08-12）：

- **后端** ✅ `/api/health` 返回 `coversUntil`。线上实测 `"coversUntil":"2026-12-31"`，前端指示灯已自动切到按剩余天数判定
- **pipeline** ✅ `--require-next-year`，workflow 里只有 12 月 25 日那次运行会带上，拿不到下一年公告就在写 R2 **之前** exit 1

不完整的兜底：1 月 2 日的月度运行 `--year` 会变成 2027，拿不到通知会硬失败变红 —— 但那是断崖**之后**，且前提是 secrets 已配好。真正早于断崖的信号是前端指示灯：11 月 16 日（末日前 45 天）转黄。

**普适教训**：可用性指示灯要测「还能覆盖多久」，不要测「多久前更新的」。两者平时相关，恰恰在最危险的场景里反向 —— 定时刷新会一直把「更新时间」刷新，而覆盖窗口在一天天缩短。`apps/web/src/lib/calendar.ts` 的注释和 `tests/calendar-coverage.test.ts` 锁住了这一点。

做完这块，估值引擎才有「写完就能自证对错」的条件。

### 1. 估值引擎（P2）—— 🟡 已落地并部署，验收未开始

`apps/api/src/valuation/{engine,service,universe}.ts` + `sources/danjuan.ts`（业绩基准兜底）。`/api/valuations?codes=` 已上线，接入 09:25 预热、分钟估值、15:05 收盘任务、14:55 采样。生产版本 `712e9806`。

**验收数据要到 2026-08-13 晚上才有第一条。** 今天（08-12）线上 10 只里 8 只是 `NONE`：`latest_official_navs` 表为空，场外基金拿不到前一交易日净值，引擎按设计 fail closed。原因是官方净值同步此前用 `listActiveFundCodes`（真实持仓为空 → 一只都不同步），改成 `listValuationFundCodes` 是随本次部署才生效的，第一次覆盖这 10 只要等今晚 19:30。已验证新浪上游对这 10 只全部返回 08-11 净值，今晚能补上。

时间线：今晚 19:30 落净值 → 08-13 14:55 出第一批带 `HIGH`/`MEDIUM` 的样本 → 08-13 19:30 落当日官方净值后即可算首份误差报表。今天 14:55 会写下 8 条 `est_nav` 为 NULL 的样本，属正常留痕，别当成数据已就绪。

复盘见下方 [P2 复盘](#p2-复盘落地当天发现的七件事)。

**入手点**：`apps/api/src/valuation/`。

已有的原料：
- `packages/shared/src/index.ts` 的 `Valuation` / `ValuationPrecision` 类型，以及 `isQdii()` `isBondOrMoneyFund()` `isPassiveIndexFund()` `isExchangeTradedCode()` 判定函数
- `sources/eastmoney.ts` 的 `parsePingzhongData()`（每日股票仓位历史）、`fetchHoldings()`（重仓股权重 `JZBL` + 行业分类）
- `sources/quotes.ts` 的 `fetchQuotesResilient()`（实时行情 + `delayed` 标记）

公式与精度分档见 [architecture.md](architecture.md#自建估值引擎--精度分级)。

**必须注意**：
- QDII / 债基 / 货基 直接 `NONE`，不要试图估
- `delayed: true` 时精度要降级，且 `basis.note` 要说明
- `basis` 里的 `reportDate` / `staleDays` / `coverageWeight` 是 UI 展示用的，不能空着

**验收**：选 10 只基金（2 ETF、3 指数、5 主动），交易日 14:55 记录估值，次日与官方净值比对。`HIGH` < 0.15%，`MEDIUM` < 0.6%，达不到就调阈值 —— 不要调 UI 去掩盖。验收池固定在 `valuation/universe.ts`，与真实持仓合并，保证空仓期也有对账数据。

#### P2 复盘：落地当天发现的七件事

按该先修的顺序排。前三条互相咬合：一个不产生信号的失败模式 + 一个会让人麻木的信号源。

**1. `valued` 把 `NONE` 也算成成功 —— 全绿的死系统，又一次。**
日志是 `[valuation] VALUATION funds=10 valued=10 sampled=0 failed=0`，而实际 8/10 是空的。`runValuationCycle` 把每个 `estimateValuation` 结果无差别 push 进 `valuations`，`NONE` 也在内。今晚净值同步若失败，明天的日志与今天一字不差，没有任何东西会变红。这正是日历指示灯那一轮总结的同一个形状：**统计口径必须能区分「算出来了」和「算了但没结果」**。改法：分档计数，`NONE` 占比越线就 warn。

**2. KV TTL 60 秒 = 刷新间隔，余量为零。**
`VALUATION_TTL_SECONDS = 60`，而分钟 cron 每 60 秒写一次。线上实测写入稳定落在每分钟第 ~27 秒，也就是任何一次周期变慢或失败，`/api/valuations` 直接返回空对象，而不是返回一分钟前的值。数据里本来就带 `estTime`，前端完全能自己标陈旧 —— 删掉数据反而剥夺了这个能力。**能标注的事不要用删除来解决。**

**3. 15:05 收盘任务目前不产生任何存活超过一分钟的东西。**
`shouldRecordValuationSample` 只在 14:55 为真，所以 `CLOSE_SNAPSHOT` 不落 D1；KV 又是 60 秒 TTL，于是它算完 10 只、打完上游、写完 KV，15:06 全部蒸发。收盘后到次日开盘前 `/api/valuations` 一直是空的。它和第 2 条是同一个根因，一起修：TTL 拉到能撑到次日开盘，收盘任务的产出才有意义。

**4. 单只基金失败 → 整个 invocation 抛 `AggregateError`，交易日 242 次/天。**
一只基金持续坏（搜索查不到、清盘、代码变更）就是每天 242 次红。同时输入缓存一直 miss，每分钟还会为它重跑 4 次上游抓取。这与本项目已确立的告警噪音口径直接冲突：**高频、已知、不可操作的红，会把人训练成无视同一渠道里可操作的红。** 失败应当聚合成每日一次告警，或复用日历那套 `alert:*` 的每日去重。

**5. 验收池的 3 只「指数」全是 ETF 联接，被动分支只测到一半。**
被动路径有两条完全不同的算法：联接基金用业绩基准里的显式权重（`benchmark.weight`），非联接指数基金用 `stockPosition`。000961 / 001051 / 005918 全是联接，后一条路径没有任何验收样本。换掉其中一只为非联接指数基金（如 110020 易方达沪深300ETF联接以外的直接指数基金），或者加第 11 只。

**6. 非联接被动基金把已经解析出来的 `weight` 丢掉了。**
`danjuan.ts` 用「业绩基准正文里唯一出现的境内指数」来定位跟踪指数，注释明说是为了避免「把错误估值标成 HIGH」。但 `symbolToSecid` 只认 `SH`/`SZ`，港股/美股指数根本进不了候选表 —— 所以「沪深300×50% + 恒生指数×50%」这类混合基准，唯一性检查照样通过。联接分支乘了 `weight` 所以能自愈，非联接分支用的是 `stockPosition`(≈95%)，等于把 95% 敞口全押在一个只占一半的指数上，还标 `HIGH`。判据就在手边却没用：**非联接被动应要求 `weight` 存在且 ≥ 90，否则 fail closed。**

**7. 场内 ETF 的 `estNav` 是成交价，`prevNav` 是官方净值，两者不同量纲。**
其余所有分支都满足 `estNav = prevNav × (1 + estChgPct/100)`，只有场内这一支不满足。次日误差报表若直接拿 `est_nav` 比官方净值，对这 2 只 ETF 测的是**折溢价**，不是估值误差 —— 而且会诱使人去调 `EXACT` 档的阈值，正好踩中「不要调 UI 去掩盖」那条。报表要么把 `EXACT` 档单独按成交价口径比，要么在结论里标明这 2 只测的是另一件事。

另有一条工具口径：远端 D1 的 CLI 查询是能用的，要带 `-c .wrangler.generated.toml`（仓库里的 `wrangler.toml` 是占位符版本，直接查会报 7400/7403，不是权限问题）。

### 2. 持仓穿透聚合（P5）

项目名就来自这个功能，天天基金不做。

**入手点**：新建 `apps/api/src/xray/`。

把用户所有持仓基金的前十大重仓股按「基金持仓市值 × 该股占基金净值比」加权汇总，得到股票级真实敞口；同时按 `INDEXNAME` 汇总行业分布，算重叠度。

`fetchHoldings()` 已经返回了 `weight`(JZBL)、`secid`、`industries`，数据是齐的。UI 在 `routes/XRay.tsx`，fixture 结构见 `lib/mock.ts` 的 `MOCK_EXPOSURE` / `MOCK_SECTORS` / `MOCK_XRAY_META`。

**注意**：前十大只覆盖 40–70% 净值，穿透结果必须标注覆盖率，不能让用户以为是全部持仓。

### 3. Notifier（P4）

三个适配器实现同一个接口，飞书优先（大陆可直连、卡片消息最好）。

**入手点**：新建 `apps/api/src/notify/`，接口见 [architecture.md](architecture.md#notifier-抽象)。

**注意**：webhook URL 是密钥，D1 里要加密存储，不能明文。部分基金净值未更新时照发，卡片内标注「N 只未更新」。

---

## 还需要建的东西

（D1 建表 / Cron 分派 / KV 缓存已在第 0 步完成；交易日历 pipeline 仍是前置。）

- **邀请码与注册流**：表建好之后的那一层。目前没有任何鉴权，`/api/*` 全部裸奔
- **`pipelines/` 的其余批处理**：交易日历已完成。还差全量基金列表、净值归档、持仓明细。这里可以用 AKShare

---

## 待验证 / 遗留问题

- **GitHub Actions 缺 Cloudflare 凭据** —— 仓库 Actions secrets 里没有 `CLOUDFLARE_API_TOKEN`（R2 Object Read & Write）和 `CLOUDFLARE_ACCOUNT_ID`。当前 2026 日历能用到年底，但每月刷新和 2027 自动生成都不会执行。**第一次红会在 2026-09-02 出现**
- **估值验收数据链未闭环** —— 今晚 19:30 的官方净值同步是唯一还没跑过的一环，且它失败时**不会有任何红**（见 P2 复盘第 1 条）。08-13 早上先查 `SELECT COUNT(*) FROM latest_official_navs`，不是 10 就说明没同步上，别等到 14:55 采样才发现
- **`/api/*` 无鉴权** —— 站点是公开 URL，任何人都能打 `/api/probe/run` 触发一次探测、拿 `/api/quotes` 当免费行情代理。新增的 `/api/valuations` 单次最多 100 个代码 = 100 次 KV 读，同样裸奔。做用户系统时一并收口
- **交易日才能测的**：`push2delay` 的实际延时有多少（决定它作为兜底源时估值精度降几级）；估值引擎各精度档的实测误差。周末验不了
- **「高」档精度徽章待设计确认** —— 设计稿缺这一档，当前是插值补的，见 [frontend.md](frontend.md#2-精度徽章不可弱化)
- **搜索结果缺涨跌幅** —— 东财 suggest 不返回前收盘价。搜索 KV 缓存已实现，部署后可以评估对结果追加一次新浪批量接口
- **OCR 路线未 spike**（P6）。三条路线横评设计见下

### P6 OCR spike 设计

难点不是「认字」，是**版面结构化** —— OCR 输出是带坐标的散落文本框，要还原「基金名 ↔ 份额 ↔ 成本 ↔ 收益」的行关系，各家 App 布局完全不同，规则写不完。

| 路线 | 方案 | 成本 | 隐私 |
|---|---|---|---|
| A 纯开源 | `@gutenye/ocr-browser`（PaddleOCR ONNX）+ 自写版面聚合 | $0 | 最优（图片不出设备） |
| B VLM 直出 | 截图 → Claude vision → 结构化 JSON | ~$0.005/张 | 图片上传 |
| **C 混合** | 浏览器 OCR 出文本 → 只把文本发给 LLM 结构化 | ~$0.0002/次 | 图片不出设备 |

测试集：支付宝 / 天天基金 / 蛋卷 / 雪球 / 招行 各 5 张。验收：字段级准确率、基金名→代码匹配成功率、单张耗时。

**无论走哪条路，人工复核页强制不可跳过** —— OCR 结果永不直接写库。基金名→代码需对本地基金库做模糊匹配（截图常有名称截断）。
