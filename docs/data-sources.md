# 数据源

全部免费、无需 token。**实测时间 2026-08-07 ~ 08-09。**

> ⚠️ 本机能通不代表 Cloudflare Workers 能通。新增上游源时，务必先在 Worker 里实测从 CF 出口的可达性再写实现 —— 下面 push2 的案例就是这么发现的。

---

## 可用端点

| 数据 | 端点 | 说明 |
|---|---|---|
| 全量基金列表 | `fund.eastmoney.com/js/fundcode_search.js` | 3.1MB，`[代码, 拼音缩写, 名称, 类型, 全拼]`。解析放 GitHub Actions |
| **单基金全量档案** | `fund.eastmoney.com/pingzhongdata/{code}.js` | ~750KB，一次拿全：净值全历史、每日股票仓位、重仓股 secid、费率、经理、同类排名 |
| 持仓明细 + 权重 | `fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition` | JSON，`JZBL` 是占净值比（估值公式的 `w_i`），白送 `INDEXNAME` 行业分类 |
| 历史净值 | `api.fund.eastmoney.com/f10/lsjz` | 需 `Referer: fundf10.eastmoney.com`，含申购赎回状态、分红 |
| 搜索建议 | `fundsuggest.eastmoney.com` | 中文/拼音/代码模糊匹配 |
| 净值批量兜底 | `hq.sinajs.cn/list=f_xxxxxx` | GBK，一次几十只，**晚间官方净值应以它为主源** |
| 基金档案兜底 | `danjuanfunds.com/djapi/fund/{code}` | 干净 JSON |

实现中比原方案更好的三个发现：

1. **持仓权重不必解析 HTML** —— `FundMNInverstPosition` 返回干净 JSON，还白送行业分类，「行业重叠度」的数据源不用另找
2. **`stockCodes` 是 7 位** —— `6005191` = `600519` + 市场位 `1`，末位就是行情接口的 secid 前缀，无需按代码段猜市场归属
3. **新浪支持批量** —— `list=f_000001,f_161725,…` 一次几十只，比 lsjz 逐只快一个数量级

---

## ❌ 官方盘中估值已下线

- `fundgz.1234567.com.cn/js/{code}.js` → **实测全部 404**
- `FundMNFInfo` 的 `GSZ/GSZZL/GZTIME` 字段仍在，但**实测恒为 `null`**（测试时间为北京时间周五 12:59，上午已收盘，本应有值）

符合监管趋势：主动管理型基金盘中估值近年被普遍下架。**所以「实时净值」全部自建**，见 [architecture.md](architecture.md#自建估值引擎--精度分级)。

---

## ⚠️ 行情源必须走降级链

**这是 P0 风险第一次真正兑现。** 从 Cloudflare LAX 出口实测：

| 源 | 结果 | 延迟 |
|---|---|---|
| `push2.eastmoney.com`（主域） | ❌ 502，稳定复现 | — |
| `2/5/99.push2` | ❌ 520 | — |
| `3/19/33/50.push2` | ✅ 200 | 3.6–5.9s |
| `push2delay` | ✅ 200 | 2.0s，**延时行情** |
| `qt.gtimg.cn`（腾讯） | ✅ 200 | 2.8s，实时 |
| `hq.sinajs.cn`（新浪） | ✅ 200 | 2.8s，实时 |
| `query1.finance.yahoo.com` | ✅ 200 | 0.1s，**无批量接口** |

### 归因过程

同一 URL 本机直连 200/101ms。四种请求头组合（裸 / UA / UA+Referer / 最简参数）在**每台主机上表现完全一致** —— 所以不是 WAF 拒绝请求形态，调 UA、加 Referer 这类手段没有意义，是出口 IP + CDN 回源的问题（`error code: 520` 是 Cloudflare 独有状态码，说明这些域前面挂着 CDN）。

关键：`fundcode_search.js` 与 `pingzhongdata` 均正常。**不是东财整体封 CF，只有行情这一条线** —— 因此不需要动用「全迁 GitHub Actions」的终极退路，换源即可。

### 降级链

实现见 `apps/api/src/sources/quotes.ts`：

```
东财分片(3/19/33/50) → 腾讯 → 新浪 → 东财延时
```

- **分片健康度会漂移**，因此按序试而非写死主机。实测已观察到 `3.push2` 失败自动降到 `19.push2`
- 延时源排最后并置 `delayed: true` **一路传到 UI** —— 滞后行情不能当实时展示，估值精度须相应降级
- 腾讯/新浪的 `name` 是 GBK 乱码，统一置空，名称从自有基金库取
- 涨跌幅由现价与昨收算出，不读固定下标（腾讯字段表尾部增删过，按下标读会静默错位）

### 雅虎：评估后不采用

代码存档在 `apps/api/src/sources/yahoo.ts`，**未接入链路**，`quotes.ts` 里留了一行注释掉的接入点。

它的指标其实很好：CF 出口 96–142ms（比境内源快约 25 倍）、数据与东财逐位一致、沪深股票+ETF 全覆盖、名称是干净 UTF-8（补上了腾讯/新浪 GBK 乱码的缺口）。

**但没有可用的批量接口**：v7 quote 需 crumb+cookie 返 401，v6 已 404，只剩 v8 chart 一次一只。估值引擎每分钟要刷上百只重仓股，逐只请求既违反中央化抓取铁律，也必然被限流。境内已有腾讯、新浪两家实时批量源，它那点「境外独立性」不足以抵消这个限制。

留着代码是为了避免以后重复调研同一条路。

---

## 时区：唯一会静默出错的地方

**东财的时间戳是「北京时间当日零点」**（= UTC 前一日 16:00）。换算见 `sources/eastmoney.ts` 的 `msToDate()`：

```ts
new Date(ms + 8 * 3600_000).toISOString().slice(0, 10)
```

写错会让**整条净值曲线偏移一天，且不报任何错**。

`tests/sources.live.test.ts` 里最关键的是**跨源一致性**测试：拿 pingzhongdata 的最新净值日期与 lsjz、新浪三方比对。这是唯一能抓到时区 bug 的地方 —— 不要删。

---

## 编码：GBK 源的处理

新浪、腾讯返回 GBK。Workers 的 `TextDecoder` 不保证支持 `gbk`，因此**按 latin1 读取**：

- 数值与日期字段是 ASCII，不受影响 ✅
- **名称字段是乱码，禁止使用** ❌

`fetchText(url, { decodeAs: 'latin1' })` 已封装这个行为。

---

## 礼貌限流

上游 ToS 是灰区。约束自己：

- ≤ 1 req/s + jitter，`sources/http.ts` 已实现指数退避 + 抖动
- 激进缓存（KV + Cache API）
- 中央化抓取，绝不 per-user 打上游
- 不做数据批量再分发
