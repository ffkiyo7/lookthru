# 前端设计系统

移动端优先，暗色，单栏。设计稿出自 Claude Design（5 份 `.dc.html`），令牌是从稿子里提取的。

> **这块由 Claude 负责。** 接数据时可以改 `routes/*.tsx` 里的数据获取与状态处理，但不要改设计令牌、间距、配色语义、或通用组件的 API。需要新的视觉元素时把需求写清楚交回来 —— 临时改一处颜色或间距不会报错，但会让整套视觉逐渐失去一致性，而且没有测试能抓到。

---

## 令牌

全在 `apps/web/src/index.css`，Tailwind v4 的 CSS-first `@theme`，**没有 `tailwind.config.js`**。

分组：容器层级（`root`/`page`/`card`/`inset`/`raised`/`chip`/`sheet`）、文字梯度（`ink` → `ink-faintest` 九级）、涨跌、强调、渠道品牌色、行业调色板、描边。

用 `bg-card`、`text-ink-muted`、`border-line-soft` 这样的语义类，**不要写 `text-[#8b8f98]`**。找不到合适的令牌说明需要新增一个，不是就地硬编码一个。

### 涨跌配色是可翻转的

中国惯例红涨绿跌，与西方相反，且用户可在设置页切换。机制：

```css
:root                          { --updown-up: #ef4444; --updown-down: #22c55e; }
:root[data-updown='green-up']  { --updown-up: #22c55e; --updown-down: #ef4444; }

@theme {
  --color-up: var(--updown-up);
  --color-down: var(--updown-down);
  --color-danger: #ef4444;   /* 固定语义色，不跟着翻转 */
  --color-success: #22c55e;
}
```

`prefs.tsx` 往 `<html>` 上写 `data-updown`，全站配色跟着变，**组件不需要感知这件事**。

所以：

- 涨跌用 `text-up` / `text-down`，或直接用 `<Change>` / `<Money colored>`
- **绝不硬编码红绿**，也不要在文案里写死「红涨绿跌」—— 那句话本身要跟着偏好变（`Portfolio.tsx` 里踩过这个坑）
- 报错、危险操作用 `danger`；成功状态用 `success`。这两个不随涨跌翻转

### 字体

系统字体栈，**不引 Google Fonts**。设计稿用的 Noto Sans SC 在大陆被墙，每次加载都会卡在一个必然失败的请求上再回退。PingFang SC 与 Noto Sans SC 同源（思源黑体），视觉等价，还省掉 ~2MB CJK 下载。

---

## 组件

| 组件 | 位置 | 用途 |
|---|---|---|
| `AppShell` / `TabBar` / `SubPage` | `components/AppShell.tsx` | 布局骨架、底部导航 |
| `Card` `SectionTitle` `GroupLabel` `Stat` | `components/ui.tsx` | 容器与标题 |
| `WarnBar` / `InfoBar` | `components/ui.tsx` | 警示与提示条 |
| `Toggle` / `Segmented` / `IconCircle` | `components/ui.tsx` | 交互控件 |
| `Money` / `Change` | `components/Money.tsx` | 金额与涨跌幅 |
| `EmptyState` / `ErrorState` / `*Skeleton` / `FreshnessLine` | `components/states.tsx` | 空态 / 加载态 / 陈旧态 |
| `PrecisionBadge` / `PrecisionLegend` | `components/PrecisionBadge.tsx` | 估值精度 |
| `NavChart` / `Donut` | `components/charts.tsx` | 净值曲线、行业环形图 |
| `CalendarPanel` | `routes/Probe.tsx`（局部） | 交易日历指示灯。只服务运维面板，不进通用组件 |

交易日历覆盖窗口的判定在 `lib/calendar.ts`（`coverage()`），被 `tests/calendar-coverage.test.ts` 锁住。

格式化函数在 `lib/format.ts`：`formatMoney` `formatPct` `formatNav` `formatShares` `formatYi` `staleDays` `formatClock` `relativeTime` `direction` `dirClass`。

### `Money` / `Change`

金额一律走 `<Money>`，**不要自己 `toFixed`**。原因是隐私模式：`usePrefs().privacy` 打开后统一打码成 `¥****`，一处生效全站一致（方便截图分享）。自己格式化的数字会漏掉打码。

`<Change value={null}>` 渲染 `——` 占位。数据缺失时传 `null`，不要传 `0` —— 「没有数据」和「涨跌 0%」是两件事。

---

## UI 不变量

这几条是产品逻辑，不是审美偏好。改之前先读 [architecture.md](architecture.md)。

### 1. 盘中估算与官方净值必须视觉可分

官方盘中估值已下线，我们展示的估算值是自己算的。用户必须一眼看出哪个是估的、哪个是官方确认的。

| | 估算 | 官方 |
|---|---|---|
| 字重/字形 | 斜体 + 灰 `#aeb2ba` | 正常字重 + 亮 `#eceef1` |
| 标签 | 「估算净值」 | 「官方净值」+「昨日确认」chip |
| 徽章 | 必带精度徽章 | 无 |

实现见 `routes/Portfolio.tsx` 的 `PositionCard`。**不要为了视觉统一把两者拉平。**

### 2. 精度徽章不可弱化

五档：`精确 › 高 › 中 › 低 › 不可估`，透明度递减，`不可估` 用虚线边框。

这是产品的诚实性底线 —— 官方从不告诉你估值有多准，我们告诉。不要因为「徽章太多显得乱」而删掉或弱化它。

> ⚠️ 设计稿只画了 精确/中/低/不可估 四档，缺被动指数基金那档「高」。当前是按 精确(实心) → 高(28%) → 中(13%) 的梯度补的，**待设计确认**。

### 3. 缺失数据要显式说明，不能静默省略

债基/货基/QDII 不提供盘中估算。汇总卡片里必须有「其中 N 只不提供盘中估算，未计入今日收益」这类说明，否则总数会被误读为完整。

同理，持仓数据过期超过 30 天要出 `WarnBar`。

### 4. 汇总数字从持仓推导

设计稿里写死了 ¥128,456.32，但与它自己的持仓明细对不上。已改为 `summarize()` 计算。**永远不要为了让页面好看而写死汇总数字。**

### 5. 延时行情不能当实时展示

`/api/quotes` 返回 `delayed: true` 时，UI 必须标明。当前降级链的最后一层是延时源，会真的走到。

### 6. 安全区必须在容器层处理，不要在页面里各写各的

`index.html` 里是 `viewport-fit=cover` + `apple-mobile-web-app-status-bar-style: black-translucent`，页面会铺满到刘海/灵动岛和 home indicator 底下。这是想要的效果（边到边才像原生 App），代价是**内容必须自己让开安全区**。

三个工具类在 `index.css`：

| 类 | 作用 |
|---|---|
| `safe-top` | `padding-top: env(safe-area-inset-top)` |
| `safe-x` | 左右 `max(1rem, env(safe-area-inset-left/right))`，竖屏下等价 `px-4` |
| `safe-bottom` | 底部，可用 `--tw-safe-extra` 追加额外间距 |

**加在 `AppShell` / `SubPage` 上，一次覆盖所有页面。** 不要在单个页面里处理 —— 新增页面必然漏，而且这个 bug 在桌面浏览器上完全看不出来（`env()` 恒为 0）。

两个坑：

1. **`safe-top` 独占 `padding-top`**，同一个元素上再写 `pt-*` 会冲突。页面自己的上边距放到内层元素（`Probe.tsx` 就是这么套的）
2. **不要在页面根节点重复写 `min-h-dvh`** —— 容器已经是整屏高，嵌套会让页面比视口高出正好一个安全区的量，表现为「怎么拉都还能再拉一点，松手又弹回去」

桌面端验证方法：注入 `.safe-top { padding-top: 59px !important }` 模拟 iPhone 刘海，检查 `scrollHeight - innerHeight` 是否仍为 0。

### 7. 上游故障时显示 last-known-good + 陈旧度，绝不空白

宁可显示「3 分钟前的数据」，也不要显示空白或骨架屏转圈。实现见下一条。

### 8. 空态 / 加载态 / 陈旧态是三件事，不能互相代替

全在 `components/states.tsx`。

| 状态 | 含义 | 用什么 |
|---|---|---|
| 空态 | 请求成功了，结果就是空的 | `EmptyPortfolio` / `EmptyXRay` / 通用 `EmptyState` |
| 加载态 | **一份数据都还没有**（冷启动） | `PortfolioSkeleton` / `XRaySkeleton` |
| 陈旧态 | 有数据但是旧的 | `FreshnessLine` |
| 彻底失败 | 冷启动 + 上游同时挂 | `ErrorState` |

三条硬规则：

1. **有缓存就不要用骨架屏。** 骨架屏只属于冷启动。盘中把已经显示出来的数字换成转圈是负体验 —— 那正是不变量 #7 要禁止的
2. **`FreshnessLine` 的圆点必须用 `success`/`warn` 这类固定语义色，不能用 `up`/`down`。** 后者会跟着用户的涨跌配色偏好翻转，而「数据是不是活的」跟涨跌毫无关系（原来写死的那行就是 `bg-up`，踩过）
3. **失败态必须给重试出口。** `FreshnessLine` 的 `onRetry` 接 TanStack Query 的 `refetch`，不传的话用户只能干等

两种「陈旧」不要混：

| | 含义 | 组件 |
|---|---|---|
| `WarnBar 持仓数据已过期 N 天` | **季报报告期**的年龄，决定估值精度 | `WarnBar` + `staleDays()` |
| `数据停在 15:10（23 分钟前）` | **这份数据几点抓的**，决定今天的数字还能不能信 | `FreshnessLine` + `relativeTime()` |

两者会同时出现在同一张卡片上，含义完全不同。

**骨架屏的几何要照抄真实卡片**，否则数据到达时整页跳版。真实卡片高度随数据浮动（`PositionCard` 实测 213–260px），对不齐是必然的 —— 压到**下限**，让版面只会收紧、不会下坠。骨架块用半透明白而不是固定色，因为它会出现在 page / card / 汇总卡渐变三种底上。

#### 怎么看这几屏

它们在正常使用中几乎看不到（空态只对新用户出现，陈旧态要等上游真挂）。加了查询参数强制切换：

```
/?state=empty      /?state=loading    /?state=stale
/?state=failing    /xray?state=empty  /xray?state=loading
```

见 `lib/preview.ts`。只影响 UI 分支、不碰数据，**生产环境也保留** —— 部署后随时能对着真机核对。改完这几屏请务必用它复查一遍，否则没人会发现改坏了。

### 9. 可用性指示灯要测「还能覆盖多久」，不要测「多久前更新的」

`/probe` 的交易日历指示灯踩过一次这个坑，值得当成通则记住。

日历按年生成、每月刷新。第一版指示灯用「距上次生成超过 60 天」判定异常 —— 看起来合理，实际上守不住真正的失败：**每月刷新会一直把生成时间刷新，而覆盖窗口在一天天缩短**。于是日历只剩最后一天时，这个指标反而最绿。全绿的死系统。

| 指标 | 测的是 | 危险场景下的表现 |
|---|---|---|
| `generatedAt` 距今多久 | 刷新是否还在跑 | 刷新照跑但内容没续上 → **一直绿** |
| `coversUntil` 距今多久 | 数据还能用多久 | 直接归零 → 变红 |

两者平时高度相关，恰恰在最危险的场景里反向。凡是「定时刷新的有效期数据」都有这个性质：证书、日历、缓存的白名单、离线包。**指示灯要盯有效期，不要盯刷新时间。**

配套的两条：

- **「用尽」和「快用尽」是不同严重度。** 快用尽是 `warn`（还有时间处理），已用尽是 `danger`（此刻就是坏的）。合成一个会让人在真正停摆时以为还有余量
- **后端还没上报该字段时要说清楚这是退化判断**，不要假装自己在测正确的东西。见 `lib/calendar.ts` 的 `stale-fallback`

---

## 路由

| 路由 | 页面 | 数据状态 |
|---|---|---|
| `/` | 持仓总览 | fixture |
| `/fund/:code` | 基金详情 | fixture |
| `/search` | 基金搜索 | **真实接口** |
| `/xray` | 持仓穿透 | fixture |
| `/settings` | 设置 | 本地偏好真实，推送绑定 fixture |
| `/probe` | P0 出口探针判定面板 | 真实 |

fixture 在 `lib/mock.ts`，**全部按 `@lookthru/shared` 的真实类型构造**，接后端时只换数据来源、不改组件。

---

## 偏好

`lib/prefs.tsx` 的 `PrefsProvider` / `usePrefs`，持久化到 localStorage（key `lookthru.prefs`）：

| 字段 | 作用 |
|---|---|
| `updown` | 涨跌配色，写到 `<html data-updown>` |
| `privacy` | 隐私模式，`<Money>` 打码 |
| `freq` | 刷新频率，`refreshInterval()` 转成 TanStack Query 的 `refetchInterval` |

---

## PWA

`vite-plugin-pwa`，`generateSW` 模式。

`sw.js` 与 `manifest.webmanifest` 必须以 `no-cache` 下发，否则用户永远卡在旧版本 —— 见 `apps/web/public/_headers`。其余带 hash 的静态资源走默认长缓存。
