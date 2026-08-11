# 进度与下一步

更新于 2026-08-10。

---

## 现状

已部署 → https://lookthru.ffkiyo7.workers.dev

| Phase | 内容 | 状态 |
|---|---|---|
| **P0** | 出口风险验证（阻塞性） | ✅ **通过**（30.9h，三端点 288/288 全 100%） |
| P1 | 基金库 + 搜索 + 详情 + 手动持仓录入 + 官方净值收益 | 🟡 UI 全完成，搜索接了真实接口，持仓/详情走 fixture |
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
| D1 `lookthru` | ✅ 已建表（`0001_probe.sql`），读写验证通过 |
| KV `CACHE` | ✅ 已创建，binding 就绪（**尚未实际使用**） |
| R2 `lookthru-archive` | ✅ 已启用，put→get→delete 往返验证通过（**尚未实际使用**） |
| Cron | ✅ `*/5 * * * *`（P0 用；P1 起换成 architecture.md 的时刻表） |
| GitHub Actions | 🟡 只有契约测试，`pipelines/` 尚未建 |

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

风险已部分兑现：东财行情线从 CF 出口不可用，但基金列表与档案正常，**不需要动用「全迁 GitHub Actions」的终极退路**。详见 [data-sources.md](data-sources.md)。

### 两条不要读过头的口径

1. **成功率与 colo 分布统计的都是最近 24h 滚动窗口，不是全时段。** 当前窗口里只剩 `IAD`（864 次，100%），早先出现过的 `LAX` 已经滚出去了。所以证明的是「单个边缘节点连续可用」，**不等于「出口地域不可控」这条核心风险被排除** —— 那需要观察到足够多的 colo。探针成本可以忽略（每 5 分钟一次），**继续跑着**，它是唯一能发现地域性封禁的东西。

2. 判定采样时长必须用 `firstProbedAt`（全时段最早探测），不是 `since`（滚动窗口起点）。用错的话跑满 24h 后 `hours` 会永远卡在 23.9x，面板一直显示「采样中」—— 这个 bug 已修（`probe.ts`），别改回去。

---

## 下一步

### 0. 数据层落地 —— 先做这个，它是下面三块的前置

**为什么排在估值引擎前面**：估值引擎的验收标准是「交易日 14:55 记录估值，次日与官方净值比对」。没有落库的地方，引擎写完那天一条都验不了，得等数据层建好再等若干个交易日；反过来先建数据层，引擎落地当天估值就自动被记下来，第二天早上直接有误差报表。这一块工作量也小得多。

五件事，可以一次做完：

1. **D1 建表** —— `users` / `positions`（或 `transactions`）/ `positions_cache`。表结构见 [architecture.md](architecture.md) 的「持仓数据模型」。migrations 目录里目前只有 `0001_probe.sql`
2. **Cron 分派** —— `scheduled` 现在只跑探针。按 `wrangler.toml` 里注释的时刻表分派不同任务，**探针继续保留**（见上一节口径 1）
3. **官方净值落库** —— 收盘后 19:30–22:30 拉当日净值。这是估值引擎的验收基准，也是持仓收益的真实来源
4. **KV 缓存层** —— binding 已就绪但一行没用。搜索每次按键都打上游，这是现在就在发生的成本
5. **交易日历 pipeline + 可用性指示** —— 生成交易日历并写入 R2 `calendar/trading_days.json`，每年生成、每月校验；`/api/health` 暴露 `tradingCalendar.available/generatedAt/days`。日历不可用时估值、预热和收盘样本任务必须 fail closed，不能退化成 `2-6` 工作日猜测

做完这块，估值引擎才有「写完就能自证对错」的条件。

### 1. 估值引擎（P2）—— 三块功能里优先级最高

产品的核心差异点，且 UI 和类型都已就位，接上就能看到效果。

**入手点**：新建 `apps/api/src/valuation/`。

已有的原料：
- `packages/shared/src/index.ts` 的 `Valuation` / `ValuationPrecision` 类型，以及 `isQdii()` `isBondOrMoneyFund()` `isPassiveIndexFund()` `isExchangeTradedCode()` 判定函数
- `sources/eastmoney.ts` 的 `parsePingzhongData()`（每日股票仓位历史）、`fetchHoldings()`（重仓股权重 `JZBL` + 行业分类）
- `sources/quotes.ts` 的 `fetchQuotesResilient()`（实时行情 + `delayed` 标记）

公式与精度分档见 [architecture.md](architecture.md#自建估值引擎--精度分级)。

**必须注意**：
- QDII / 债基 / 货基 直接 `NONE`，不要试图估
- `delayed: true` 时精度要降级，且 `basis.note` 要说明
- `basis` 里的 `reportDate` / `staleDays` / `coverageWeight` 是 UI 展示用的，不能空着

**验收**：选 10 只基金（2 ETF、3 指数、5 主动），交易日 14:55 记录估值，次日与官方净值比对。`HIGH` < 0.15%，`MEDIUM` < 0.6%，达不到就调阈值 —— 不要调 UI 去掩盖。

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

（D1 建表 / Cron 分派 / KV 缓存已并入上面的第 0 步。）

- **邀请码与注册流**：表建好之后的那一层。目前没有任何鉴权，`/api/*` 全部裸奔
- **`pipelines/`**：GitHub Actions 侧的 Python 批处理（全量基金列表、净值归档、持仓明细、交易日历）。这里可以用 AKShare

---

## 待验证 / 遗留问题

- **生产环境自称 development** —— `wrangler.toml` 是无条件的 `[vars] ENVIRONMENT = "development"`，线上 `/api/health` 也这么回。今天没有任何代码分支读它，所以不是 bug 是**陷阱**：哪天有人写 `if (env.ENVIRONMENT === 'production')` 去关调试端点或关 `?state=` 预览开关，会静默走错分支。要么加 `[env.production]`，要么干脆删掉这个变量 —— 别留着
- **`/api/*` 无鉴权** —— 站点是公开 URL，任何人都能打 `/api/probe/run` 触发一次探测、或者拿 `/api/quotes` 当免费行情代理。做用户系统时一并收口
- **搜索会返回股票** —— `searchFunds` 只按 `/^\d{6}$/` 过滤代码，而 A 股代码也是 6 位。搜「茅台」可能混进 `600519`，它的 `FundBaseInfo` 为空。后端要按 `FTYPE` 过滤，前端也要对非法基金代码有防御（别让详情页去请求一个不存在的基金档案）
- **交易日才能测的**：`push2delay` 的实际延时有多少（决定它作为兜底源时估值精度降几级）；估值引擎各精度档的实测误差。周末验不了
- **「高」档精度徽章待设计确认** —— 设计稿缺这一档，当前是插值补的，见 [frontend.md](frontend.md#2-精度徽章不可弱化)
- **搜索结果缺涨跌幅** —— 东财 suggest 不返回前收盘价。补的话要对结果再打一次新浪批量接口，等搜索端点加上 KV 缓存后再做，否则每次按键多打一次上游
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
