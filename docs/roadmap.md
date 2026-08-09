# 进度与下一步

更新于 2026-08-09。

---

## 现状

已部署 → https://lookthru.ffkiyo7.workers.dev

| Phase | 内容 | 状态 |
|---|---|---|
| **P0** | 出口风险验证（阻塞性） | 🟡 **正在采集 24h 数据** |
| P1 | 基金库 + 搜索 + 详情 + 手动持仓录入 + 官方净值收益 | 🟡 UI 全完成，搜索接了真实接口，持仓/详情走 fixture |
| P2 | 自建估值引擎 + 精度分级 + 盘中刷新 | ⚪ 类型与 UI 就位，**引擎未写** |
| P3 | 收益可视化 | 🟡 净值曲线已实现，归因/日收益柱状未做 |
| P4 | Notifier（飞书 → Telegram → Discord） | ⚪ 仅设置页 UI |
| P5 | 持仓穿透 + 客观指标提示 | 🟡 UI 完成，**聚合算法未写** |
| P6 | OCR spike + 落地 | ⚪ |
| P7 | 交易流水 / 分红 / 多用户加固 | ⚪ |

**注意区分「UI 做完了」和「功能做完了」。** 估值引擎、穿透聚合、Notifier 适配器三块都还是空壳，只有类型定义和界面。

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

## P0：等结论

Cron 每 5 分钟探一次三个端点，满 24h 后看 `/probe` 面板。判定标准：三者成功率均 > 95%。

目前三项全绿。但 **`quotes` 那项测的是整条降级链**，不是单一主机 —— 因为单主机成功率对架构判定没有意义，「有没有一条路能拿到行情」才有。`detail` 字段记录了命中的源与降级层数，24h 后看这个字段能判断东财是彻底不可用还是分片抖动。

风险已部分兑现：东财行情线从 CF 出口不可用，但基金列表与档案正常，**不需要动用「全迁 GitHub Actions」的终极退路**。详见 [data-sources.md](data-sources.md)。

---

## 下一步的三块，按建议顺序

### 1. 估值引擎（P2）—— 优先级最高

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

- **用户系统**：邀请码、持仓录入。D1 里目前只有 `probe_results` 一张表，`transactions` / `positions_cache` / `users` 都还没建。表结构见 [architecture.md](architecture.md) 的「持仓数据模型」一节
- **`pipelines/`**：GitHub Actions 侧的 Python 批处理（全量基金列表、净值归档、持仓明细、交易日历）。这里可以用 AKShare
- **KV 缓存层**：binding 已就绪但一行没用。搜索接口每次按键都打上游，加上缓存后才能考虑给搜索结果补涨跌幅
- **Cron 分派**：目前 `scheduled` 只跑探针。P1 起要按时刻表分派不同任务

---

## 待验证 / 遗留问题

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
