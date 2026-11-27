# dsh-better-debug v0.3.5 代码评审报告

> 评审级别：Staff Engineer / 发布门禁评审
> 评审对象：`C:/Users/Lyonl/Desktop/dsh-better-debug`（commit 694d377 + 未提交工作区改动）
> 评审日期：2026-11-26
> 评审方式：全量逐行阅读（13 个源文件 + 全部测试 + 全部配置文档）+ 6 组可复现探针实测 + 4 份并行子审交叉复验

---

## 0. 评审结论

**评审时的判断：不建议以当前状态发布 0.3.5。**（下文为评审原始记录，未改写。）

一句话判断：**解析层是生产级质量，状态机层有一个地基级缺陷，发布流程是空的。**

> **修复后状态（2026-11-26）**：S1–S7 七条全部关闭，A 级缺陷按 P0/P1 路线图收敛，
> 第 9 章 P0 七条 + P1 十条已全部落地（表格带 ✅）。当前测试基线：
> sim 255/255、panel 90/90、slow 91/91，`lint` 与 `pack-check` 进 CI，tarball 自测通过。
> 分层评分中「发布/文档 = D」一项随 CI 三步与 README 三处失实成对修复而解除；
> 「状态机层 = B-」随身份地基（`failureSetOf` + 四套 runner golden）与三个工厂抽取而改善，
> 但 `apply` 体仍有 756 行（抽出三个工厂后从 987 行降到 756 行），仍是下个迭代的结构债。P2 十八条未动。

> **第二次审查（同日，见第 11 章）**：三路并行子审复评 + 6 组探针，**无 P0**；新查出的 8 条 P1（A–H）
> 全部落盘并带回归测试，另有 4 类候选经实测判定不成立。`npm run verify` 全绿，循环收敛。
> 分层评分随之调整：面板/前端 **C+ → B-**（聚合层流式化、缓存读失败自愈、红条复位、阈值口径统一；
> 仍缺媒体查询 / CSP / AA 对比度，属 P2），发布/文档 **D → C+**（CI 三步 + pack-check 静态必需项 +
> 用例数同步；仍缺 CHANGELOG 与 0.3.5 的实际发布动作）。
> **第三次审查（真机验证期，见第 12 章）**：静态审查漏掉的一条 **P0（安全）** 在真机形态下暴露 ——
> 面板的 prefix 路由没有调宿主的准入闸，经公网 relay 可匿名读到会话 id、报错原文与日志路径
> （同 origin 下 `/` 是 401、`/better-debug/api` 是 200）。已修：新增 `createRequestGate(ctx)`
> 并在 handler 首段生效，服务懒查不缓存；同轮补 CSP 与 `nosniff`、O/P 标记实验性、7 个双盲
> 信号键补测试。面板/前端 **B- → B**（鉴权 + CSP + nosniff 到位；仍缺媒体查询与 AA 对比度）。

分层评分：

| 层 | 评分 | 依据 |
|---|---|---|
| 解析层（lib/index.js:141-1300，纯函数） | **A** | 17 条绿语料、60+ 处集合等式断言、多 runner 交叉验证；注释即设计文档（38.4% 注释密度） |
| 状态机层（apply 内 987 行 → 抽工厂后 756 行） | **B-** → **B** | 设计意图清晰、判定顺序有语义，但 B/O/P 三条判据的身份地基在主流 runner 上实测塌陷 |
| 面板/前端（lib/panel.js + web/） | **C+** → **B-** → **B** | 已修：阈值键名、按 `inj` 关联口径、红条复位、聚合流式化、缓存读失败自愈、**宿主准入闸（P0，第 12 章）**、CSP + `nosniff`；仍缺媒体查询 / AA 对比度（P2） |
| 测试体系（test/ 3535 行 → 4700 行） | **B** | 解析层达生产级；panel 路由已补真实执行测试（第 14 组）与准入闸 8 条（第 14b 组）；7 个双盲信号键已补正反例（组 58–64）；仍缺真实 turn 序列（P2） |
| 发布/文档（README/CI/package.json） | **D** → **C+** | 已修：CI 三步（死代码/发布契约/tarball 自测）、pack-check 静态必需项、README 用例数与 0.3.5 失实；仍缺 CHANGELOG 与实际发布 |

**核心风险不是「代码写得差」，而是「一个自述为可观测、可验证的插件，它自己的验证链路有洞」**：指纹判据在真实 runner 输出上塌陷、面板在首次安装时显示全 0、发布包无法自检、CI 只有语法检查。这些洞恰好都在「用来证明它对」的那条路上。

---

## 1. 项目画像（实测度量）

### 1.1 体量

| 文件 | 行数 | 其中注释行 |
|---|---|---|
| `lib/index.js` | 2437 | 935（38.4%） |
| `lib/panel.js` | 590 | 102（17.3%） |
| `lib/text.js` | 139 | 56（40.3%） |
| `web/index.html` | 590 | 38（6.4%） |
| `client.js` | 71 | 13（18.3%） |
| `test/sim.mjs` | 2646 | — |
| `test/panel.mjs` | 724 | — |
| 其余 shim（5 个） | 165 | — |
| **src 合计** | **3827** | — |
| **test 合计** | **3535** | — |

源码:测试 ≈ 1:0.92。零运行时依赖、零 devDependencies、纯 ESM。

### 1.2 结构热点

- `apply()` 是 **987 行单函数**（`lib/index.js:1451-2437`），内含 7 个闭包（record / mountSkill / fresh / stateFor / turnState / settleMeasure / deliver）+ 4 个事件注册。
- 两个最长 handler 都嵌在 apply 里：`session/event` **242 行**（:1863-2104）、`agent/pre-step` **233 行**（:2205-2437）。**这两块是全仓最复杂、也最不可能被单测的逻辑**（需要一个 987 行作用域 + 假 ctx 才能执行），这是测试覆盖盲区的结构性根因，不是测试作者的疏忽。

### 1.3 测试基线（本次实测，Node v26.13.0 / Windows）

```
npm run check          exit 0   3.7 s   （12 个 node --check，纯语法）
node test/sim.mjs      184/184 passed
node test/panel.mjs     62/62  passed
--import ./test/posix/register.mjs   sim 184/184 + panel 62/62
--import ./test/slow/register.mjs    panel 63/63
```

全绿。**但全绿不代表对** —— 见第 6 节。

### 1.4 真实运行数据（`$DSH_HOME/logs/better-debug.log`，20 天）

- 132,767 字节 / 863 行，首行 2026-11-06、末行 2026-11-26，**单文件累积无轮转**。
- 行类型：inject 197、outcome 191、arm 148、measure 80、apply 78、bundled 72、suppress 57、futile 29、change 6、panel 4、disabled 1。
- **信号分布：C = 142（72%）、B = 34、A = 12、M = 6、A+C = 2、F = 1、O = 0、P = 0。**
- 注入文本平均 223 字符 / 112 tokens，累计 22,121 tokens。
- **效果：197 次注入里只有 6 次在窗口内换来转向（3.0%）。**

这组数字是本报告最重要的一条产品证据：

1. **C 占 72%** —— 真实场景里最常见的是「改完一直没测」，而不是「反复改同一处」（A 只有 12 次）。
2. **O 与 P 在生产 20 天里零触发**，而这两条判据占用了约 120 行实现 + 数十条测试。
3. **3% 的转向率**说明闸门开口后绝大多数情况模型没有改变行为。插件当前的主要产出是「注入文本」，不是「行为改变」。

---

## 2. S 级缺陷（发布前必须解决）

### S1. `errorFingerprint` 只取前 6 行 —— B/O/P 三条判据的身份地基在主流 runner 上塌陷

**位置**：`lib/index.js:615-629`

```js
export function errorFingerprint(text) {
  const head = stripFileUrl(text).split('\n').slice(0, 6).join('\n')   // ← :618
  const normalized = head
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
    .replace(/(?<![\w.])\.{0,2}\/[^\s"']{6,}/g, '<path>')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ').trim().slice(0, 300)
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16)
}
```

**实测**（`.agent-tmp/probe-final-fp3.mjs` / `probe-final-fp4.mjs`，干净夹具）：

| runner | preamble 行数 | 两个完全不同失败的指纹 |
|---|---|---|
| jest | 6 | **相同** `a56294cb75bcb2c6` |
| pytest | 5 | **相同** `1fc1e953752e82eb` |
| vitest | 4 | 不同 `16c394f0…` vs `62fa61a8…` |
| tsc | 3 | 不同 `b9ef9f77…` vs `0dc878a8…` |

阈值精确定位（vitest 形状，pad 0→7）：

```
totalPreamble=2,3,4,5  → same-fp=false
totalPreamble=6,7,8,9  → same-fp=true     ← 只要 preamble 达到 6 行就必然塌陷
```

**为什么是 S 级**：

- B（同一错误重复）、O（旧失败又回来）、P（补丁链）三条判据**全部**以这个指纹做身份。身份一塌，三条同时失效。
- 这是**双向失效**，不只是漏报：
  - **漏报**：jest 输出前 6 行是 `> proj@1.0.0 test` / `> jest` / 空行 / `PASS a` / `PASS b` / `FAIL pay`，真正的失败原因是第 9 行。三个完全不同的失败被算成「同一个错误出现 3 次」——端到端探针（`.agent-tmp/probe-b.mjs`）实测：三次不同失败 → **注入 0 次**。
  - **误报**：同一失败在两次运行之间，只要 warning 行数变动把 preamble 推过/推回 6 行，它的身份就会翻转。「同一个错误」会突然被当成新错误。
- `errorTargetOf` 同时错：jest 夹具两段都取出 target = `"pass test/a.test.js"` —— **把 PASS 行当成了失败目标**。

**修复方向**（按成本排序）：

1. **不要用固定行数窗口。** 先按 `FAIL` / `Error` / `●` / `×` / `FAILED` 标记定位失败区块，再对**区块内容**取指纹。
2. 更好：**统一到 `failureSetOf` 路线**。同一对 jest 夹具上，`failureSetOf` 给出 A size=1、B size=2 且 `failureSetKey` 不相等 —— 它是对的。现状是两条身份路线并存、结论互相矛盾，这是架构级问题。
3. 修 `failureSetOf` 的 PASS 行误判（它在 B 里多出一条假条目 `"pass test/a.test.js|e46e314e0aa9490b"`）。
4. 补 golden value 测试 —— 现在 `test/sim.mjs:953-955` 只做「两次调用相等」的自比对，归一化链整体退化也能全绿。

---

### S2. README 主推的 0.3.5 安装路径不存在

**位置**：`README.md:254-257`、`README.en.md:281`

文档让用户下载 `releases/download/v0.3.5/dsh-better-debug-0.3.5.tgz` 并声明「与 npm 包逐字节相同」。

**实测**：

```
npm view dsh-better-debug versions   → 止于 0.3.4
npm view dsh-better-debug dist-tags   → { latest: '0.3.4' }
releases/tags/v0.3.5                  → 404
```

而整篇 README（:589-613 的深审探针数字、:382-391 的测试计数）全部按 0.3.5 叙述。

**影响**：任何按文档操作的用户会拿到 0.3.4，然后发现自己装的版本与文档描述的修复不一致 —— 而这正好是一个「告诉你事情有没有真的修好」的插件。

**这是发布纪律问题，不是代码问题，但它排在 S 级**：一个以「可验证」为卖点的工具，第一段安装说明就是错的。

---

### S3. 面板阈值键名错配 —— 首次安装时永远显示 A=0 B=0 C=0

**位置**：`lib/panel.js:419-425` 读 `options.thresholds?.A`，而 `lib/panel.js:560` 传入的是整个 `cfg`（键名是 `repeatEditThreshold`）。

**实测**：

```
readAggregate('C:/nonexistent-xyz.log', { thresholds: { repeatEditThreshold:5, repeatErrorThreshold:4, noVerifySteps:7 } })
  → { A: 0, B: 0, C: 0 }  budget=0  window=0

readAggregate('C:/nonexistent-xyz.log', { thresholds: { A:5, B:4, C:7 } })
  → { A: 5, B: 4, C: 7 }
```

**触发条件**：日志里没有 `apply` 行 —— 即**首次安装、日志轮转后、`logFile` 指向新文件**。此时面板确定地显示三条阈值全 0，用户会以为插件没工作（而阈值 0 在语义上意味着「任何一次重复就报警」）。

`budget` / `window` 更糟：`lastApply?.budget ?? 0` 完全没有 cfg 回退。

**修复**：`aggregate()` 里统一用一套键名（建议内部统一用 `A/B/C`，在 `registerPanel` 里做一次映射 `{A: cfg.repeatEditThreshold, B: cfg.repeatErrorThreshold, C: cfg.noVerifySteps}`），`budget`/`window` 从 cfg 兜底。

---

### S4. 面板统计口径错误 —— 转向率可显示 300%，静默数可为负

**位置**：`lib/panel.js:381-388`

```js
const reported = outcomes.length      // 分母：outcome 行
const turned = changes.length         // 分子：change 行
const instrumented = injects.filter(...).length
```

分子分母**不按 `inj=` 关联**，各数各的行。

**实测**：

```
1 条 inject + 3 条不同 inj 的 change  → turned = { observed:1, total:3, rate:3 }   // 300%
2 条 outcome + 0 条 inject            → firstAction = { reported:2, silent:-2 }
```

**影响**：面板上最显眼的两个数字（「转向率」「静默数」）在最普通的场景下就是错的。

**修复**：用 `inj` 做 key 建 Set，分子取 `change` 与分母取 `inject` 的交集；`silent` 用 `Math.max(0, …)` 并明确语义。

---

### S5. 前端 slot 注册无 dispose + `dsh.client.inject` 语义错位

**位置**：`client.js:56`、`client.js:60`、`client.js:63`、`package.json` 的 `dsh.client.inject: ["slots"]`

**问题一：注册不可逆。** `slots.register(...)` 的返回值被丢弃，也没有 `ctx.effect` 包裹：

```js
slots.inject('settings.section', () => slots.register({...}, BetterDebugPanel))   // 返回值丢弃
```

对比官方插件，标准写法是 `ctx.effect(() => slots.register(...))`。**热重载会累积同名 section**，而插件的日志显示 20 天里 `apply` 跑了 78 次 —— 这是个高频路径。

**问题二：静态声明与注释直接矛盾。** `client.js:42-50` 有长注释论证「不声明静态 inject，改成 `ctx.inject` 动态订阅」，`client.js:31` 是 `const inject = []`。但 `package.json` 里 `dsh.client.inject: ["slots"]`。

这两个 `inject` **不是同一个概念**：`package.json` 的 `dsh.client.inject` 是前端**模块图依赖**（宿主 `dsh-client-modules/lib/client.js` 的装载循环 `for (const packageName of row.inject) { const dependency = this.graphRows.get(packageName); if (dependency !== void 0) … }` —— 查不到**静默跳过、零日志**），而 `"slots"` 在模块图里查不到。官方包实测**全部用完整包名**（`dsh-client-ui-approval` 用 6 个完整包名，`dsh-client-ui-attachment` 用 8 个，无例外）。

结果：这一行既是无效声明，又会误导后来的维护者以为 slot 依赖已被静态保证。

**问题三：无 locale、label 是字符串。** `client.js:60` 的 `label: 'better-debug'` 是硬编码字符串；官方写法是 `locale: NS` + `label: () => t('nav')`。README.en.md 面向英文用户，但设置页永远显示中文/小写 id。

---

### S6. 面板路由零执行覆盖，且假 ctx 掩盖了这一点

**位置**：`test/sim.mjs:78-88`

```js
ctx.inject = (deps, cb) => {
  if (deps.includes('webServer') && !hasWebServer) return { dispose(){}, then(){} }   // 什么都不做
  ...
}
```

**实测**：`grep -rn "registerPanel\|WEB_ROOT" test/` → **0 命中**。

`registerPanel`（`lib/panel.js:528-590`，63 行）**从未在测试里执行过一次**。而 `test/panel.mjs:473-521` 那个「panel register failed」用例断言的是**手打的字符串**，不是插件行为。

这意味着：面板的路由挂载、`dispose` 链、`globalThis[PANEL_SLOT]` 去重、`ctx.webServer.prefixes` 手术、404/500 分支，全部没有回归保护。S3/S4 那两个面板缺陷能长期存活，直接原因就在这里。

---

### S7. 对外口径「不读模型的语言内容」与实现矛盾，且中文用户享有特权

**位置**：`README.md:5`、`README.en.md:6`、`package.json:4`（description，会原样进 npm / 市场描述）

三处都说「不读取模型的语言内容 / does not read the model's prose」。

**实现**：`lib/index.js:1879-1894` 读 `user/message` 的 text 块并做 `QUIET_PATTERN.test(text)`。

同一篇 `README.md:173-174` 自己承认做了这件事。**这是自相矛盾，且矛盾的那一半进了 npm 元数据。**

**同时 `QUIET_PATTERN`（`lib/index.js:131`）只认中文**：

```js
export const QUIET_PATTERN = /别搜|不要搜|不用搜|先别搜|直接改|快速试|别折腾|先试试/
```

无 `i` 标志、无词边界、**零英文条目**。一个说 "just do it, skip the search" 的英文用户得到的待遇完全相反（闸门照常开口）。对一个有 `README.en.md` 的双语项目，这是功能缺口而非文案问题。

**修复**：口径改成「只匹配少量静音短语，不存储、不外传」（这是事实）；`QUIET_PATTERN` 补英文条目（`don't search` / `skip the search` / `just do it` / `no need to search`）。

---

## 3. A 级缺陷（下个迭代必修）

### A1. 无日志轮转 + 同步全量读，成本随天数单调上涨

- 写端：`lib/index.js:1458-1473` 每条 `await appendFile`，无限追加。`grep -rn "rotate|renameSync|createWriteStream|statSync" lib/` → **零命中**。
- 读端：`lib/panel.js:515` 每次 HTTP 请求 `readFileSync` 整个文件；`lib/panel.js:554` 每次请求还同步读一次 `index.html`。

**实测**：130 KB / 863 行 → 10 ms（热页缓存；冷启首测 30 ms）。20 天 132 KB，一年约 2.4 MB → 单次面板请求约 180 ms **同步阻塞 webServer 线程**，而且**每 5 秒一次**（`web/index.html:583`）。

**修复**：写端按大小切分（`better-debug.log` → `.1` → `.2`，上限 3 个）；读端只读尾部 N 字节，或维护 offset 游标增量解析。

### A2. 五处死代码 / 死字段 / 死导出

| 位置 | 内容 | 证据 |
|---|---|---|
| `lib/index.js:1997` | `const toolName = call?.name ?? (typeof callId === 'string' ? s.calls.get(callId) : void 0)` | 全文件 `toolName` 仅此一处；右分支返回 Map entry 对象而非 string，与 `call` 完全重复；`:2050` 正确写法是 `const tool = call?.name ?? 'tool'` |
| `lib/index.js:1412` | `export const PTC_ROOT_TOOLS = new Set(['run_code'])` | `grep -rn` 在 lib/ test/ client.js 只命中定义本身 |
| `lib/index.js:1595` / `:1890` | `turnUserText` 初始化 + 赋值 | **只写不读**，零消费 |
| `lib/index.js:1679` | `settleMeasure` 解构出 `fingerprint` | 函数体内（:1679-1861）零引用；调用方 `:2010` 仍白算一次完整 `errorFingerprint` |
| `lib/index.js:1588` | `fired: { A,B,C,F,O,P,M }` 中的 `O` | 只有定义与两处注释提及，零读写（O 的静音已改成 per-series `announced`） |

**这五处共同的根因是「项目没有 lint、没有 typecheck」**（见 A7）。任何 `noUnusedLocals` / `no-unused-vars` 都会当场全抓到。

### A3. `settleMeasure` 对同一份文本解析三次

**位置**：`lib/index.js:1755`、`:1798`、`:1835`

**实测**（`.agent-tmp/probe-triple.mjs`，501 行 vitest 输出 / 98,301 字节）：单次 `failureSetOf` **2.66 ms**，三次 **7.97 ms**。

失败测量是最高频路径（日志里 measure 80 次 / 20 天，且真实项目里 `npm test` 失败输出常有几百 KB）。一条 `const failSet = failureSetOf(text)` 提到函数顶部即可消掉 2/3。

顺带：这份 500 个 FAIL 的合成输出只能抽出 **2 个条目** —— 说明 `failureSetOf` 本来就会把同文件多失败合并，三次重复解析是纯白烧。

### A4. `failSeq` 在「失败但解析不出条目」时不推进 → 幂等闸把整轮失败当没发生

**位置**：`lib/index.js:1812-1818`，`s.failSeq += 1` 在 `if (failSetKey !== '')` 内。

**场景**：vitest 崩溃、输出被截断、只有 exit code 1 而无可识别失败行 → `failureSetOf` 返回空集 → `failSetKey === ''` → `failSeq` 不动。

而幂等闸（`:2265-2272`）判的是 `lastFireMark.failSeq === s.failSeq`。于是：**一轮真的失败了，但因为解析不出条目，闸门认为「什么都没变」，不开口。**

这与插件存在的目的直接冲突 —— 「测了但失败」是最该被看见的状态。

### A5. `fs/write-intent` 整段 `try/catch{}` 静默吞错

**位置**：`lib/index.js:2112-2136`

被 `try/catch{}` 包住的是**整个记账逻辑**（edits / streakEdits / writeSeq / lastAction / `s.done` 重置）。任何一处 throw 都会让这次写入**完全不被记账**，而 A/C 的核心输入正是这些计数 —— 闸门会安静地不响，无日志、无 warn。

对比 `record()` 的 catch 至少有 `warnedLogFailure` 告警一次。这两处的容错策略相反，且没有任何注释解释为什么。

### A6. 面板 JSON 转义解析错误 —— 日志里的 JSON 片段读回来是坏的

**位置**：`lib/panel.js:70-92`

```js
if (escaped) { value += char; escaped = false }   // 只丢掉反斜杠，不做 JSON 语义映射
```

**实测**：写端 `JSON.stringify('line1\nline2\ttab')` 产出 `"line1\nline2\ttab"`；读端 `parseLine` 还原成 **`line1nline2ttab`**（反斜杠被吞，`n`/`t` 变成字面字符）。

而写端 `lib/index.js:2187` 正是 `JSON.stringify(errorSample.slice(0, 80))` —— **读端必然遇到这种输入**。面板上显示的 `sample=` 字段在有转义时就是错的。

### A7. CI 只有语法检查，无 lint / 无 typecheck / 无覆盖率

`.github/workflows/ci.yml` 两步：`npm run check`（12 个 `node --check`，纯语法）、`npm test`。

矩阵本身是对的（3 OS × node[20,22,24]、`fail-fast: false`、注释说明「24 is what the desktop app actually ships」）。但 `node --check` 只能发现括号不匹配。

**证据**：A2 的五处死代码、`lib/index.js:1997` 的类型错误、S3 的键名错配（在 TypeScript 或带 JSDoc + `checkJs` 的配置下是编译错误），三类缺陷全部穿过了 CI。

**修复**（零新依赖可选）：`npx eslint --no-eslintrc --rule '{"no-unused-vars":"error"}' lib/ client.js`；或给 `lib/*.js` 加 `// @ts-check` + `npx tsc --noEmit --allowJs --checkJs`。

### A8. `lsp_diagnostics` 的过时事实在 6 处固化

该工具已于 2026-11-24 从本机 DSH 卸载。落点：

| 位置 | 角色 |
|---|---|
| `lib/index.js:83` | `HARD_MEASURE_TOOLS` 成员 |
| `lib/index.js:601` | `measureKey` 注释 |
| `lib/text.js:36` | **A 动作第一选项**（模型看到的第一条建议） |
| `assets/stuck-gate/SKILL.md:33` | 闸门①「首选回路」 |
| `README.md:79` / `README.en.md:89` | 测量表首行 |
| `test/sim.mjs:720` | 唯一断言 `isMeasurement('lsp_diagnostics',…) === true` |

**六处文案 + 一条测试共同锁定一个不存在的工具名。** 其中 `lib/text.js:36` 和 `SKILL.md:33` 最严重 —— 它们是模型被告知「下一步该干什么」的直接来源。

### A9. 发布包内 7 个 npm scripts 全死

`package.json` 的 `files` 白名单 = lib/ assets/ web/ client.js cordis.patch.yml README.md README.en.md LICENSE，**不含 `test/`**；而 7 条 scripts（check / test:unit / test:posix / test:linux / test:slow / test / verify）**全部引用 test/**。

**实测**：`npm pack` → 115,529 B / **11 entries**（无 test/）→ 装进临时目录 → `node test/sim.mjs` 报 `Cannot find module …\node_modules\dsh-better-debug\test\sim.mjs`，`code: 'MODULE_NOT_FOUND'`。7/7 全死。

对克隆仓库的贡献者无影响（test/ 在），但「装了 tarball 想自检」这条路完全断掉。修法二选一：`files` 加 `test/`（增加 ~90 KB），或把 scripts 从发布包语义里分离（`prepack` 校验 + docs 说明只能从仓库跑）。

### A10. README 引用不存在的证据文件

`README.md:612` / `README.en.md:721` 用「`acceptance-matrix.mjs` 在原生/POSIX/Linux 三种语义下均 `70/70`」作为第八轮深审的证据。

**实测**：`glob **/*acceptance*` → 空；`ls test/` → linux panel.mjs posix sim.mjs slow。全文 grep 只命中 README 自身两处。

一个把「证据可复现」写进方法论的文档，引用了一个不存在的证据文件。

### A11. README 承诺「非法正则记 warn」，代码里没有

`README.md:324` / `README.en.md:354-355`：「三个正则键传入非法正则会回退内置默认并记 warn」。

**实现**：`lib/index.js:141-148 toRegExp` 的 `catch { return fallback }`，无 logger。全文件 `warn` 只有两处：`:1467`（写日志失败）、`:2430`（pre-step 异常）。

用户写坏一个 `measureCommands` 正则，插件静默使用默认值，用户永远不知道自己的配置没生效。

### A12. `record()` 每条日志都重做一次 `mkdir`

**位置**：`lib/index.js:1458-1462`

```js
await mkdir(dirname(cfg.logFile), { recursive: true })
await appendFile(cfg.logFile, ...)
```

`mkdir` 幂等，但仍是一次系统调用。而 `record` 在 tool/call、tool/result、arm、inject、suppress **五条热路径**上，一个活跃 turn 可产生数十次。

**修复**：模块级 `let dirReady = false`（或 `Map<dir, Promise>`）缓存首次结果。

---

## 4. B 级缺陷（应收敛的技术债）

### 面板 / 前端

- **B1 红条永不复位**（`web/index.html`）：`hidden` 共 7 处 —— `:224/:225` 是 CSS、`:273` 初始属性、`:533/:536/:539` 置 `false`、`:565` fail 分支置 `false`、`:585` 是 `document.hidden` 判断。**没有一处设回 `true`**，而 `:583` `setInterval(load, 5000)` 每 5 秒重渲染。一次历史故障会永久顶在「只说现在」的位置上。
- **B2 字符串手术注入语义**（`web/index.html:452-459`）：`bar(...).replace('<span class="num">0</span>', ...)` —— `bar()`（`:373-378`）用 `esc(String(value))` 渲染数字，value=0 时输出恰好匹配。一旦 `bar` 改成加空格/加 class/走 `fmt()`，四条阈值条会**静默显示 0**，无任何报错。给 `bar` 加可选 `display` 参数即可。
- **B3 条形图失真**（`:374`）：`Math.max(2, ...)` 让 0 次也有 2% 条；无 `Math.min(100, ...)`，值 >total 时可画到 300%。与 S4 的 300% 是同一类病。
- **B4 未知信号静默吞**（`lib/panel.js:352`）：`if (bySignal[kind] !== void 0) bySignal[kind] += 1`。`signals=Z` → total=1 但所有桶为 0，`unknownSignals` 未收集。日志格式演进时（新增信号）面板会静默丢数据。
- **B5 `ctx.webServer.prefixes` 被直接改**（`lib/panel.js:537-538`）：伸手删宿主内部 Map 的键。宿主改数据结构即断。
- **B6 无媒体查询**（`@media` 全文零命中）：`.bar` 用 `grid-template-columns: 172px 1fr 64px`（`:223`），8 列表格在窄面板下溢出直接传到宿主布局。
- **B7 对比度不达 AA**：`--fg-faint: #81858c`（`:104`）在 #fff 上 = 3.71:1，低于 AA 4.5:1，而它被用在 `:200/:213/:220/:238/:257/:261` 六处 11–11.5px 小字上。无 `prefers-reduced-motion` 分支。
- **B8 `esc()` 不转单引号**（`:362-366` 只处理 `& < > "`）。当前所有 sink 都不可利用，但没有 CSP，也没有 `nosniff` / `referrer-policy`（响应头只有 `content-type` + `cache-control`）。
- **B9 轮询不停**：`:583` `setInterval(load, 5000)` 无 `document.hidden` 短路，`:584-586` 的 `visibilitychange` 只是额外触发一次。
- **B10 每 5 秒全量 `innerHTML` 重建**：与 A1 叠加，成本随日志增长而上涨。
- **B11 错误分类折叠**：`lib/panel.js:518-520` `catch { exists = false }` 把 EACCES / EISDIR / 路径非法全折成「落盘已关闭」。
- **B12 API 字段浪费**：`log.exists` / `log.bytes` / `arms` / `skills` / `skillPath` / `current.pid` / `thresholds` / `budget` / `window` / `firstAction.byTool` / `futile.bySession` / `applied` / `estimate` 前端零读取。
- **B13 token 估算口径分裂**：面板回退路径用 `estimateTokens('x'.repeat(chars))`，全 ASCII → 0.32 倍。同一注入文本真实 168 tokens、面板 69（差 2.4 倍）。
- **B14 截断行被当完整记录**：写入端 `slice` 后的 chars/tokens 走回退，凭空算出偏低的 token 数。
- **B15 版本号第三个真相源**：`lib/panel.js:561` `?raw=1` 返回写死的 `{id:'dsh-better-debug', version:3}`，与 `package.json` 的 0.3.5、`cordis.patch.yml` 都不同步。
- **B16 `panelSrc` 写死根路径**（`client.js:29` `/better-debug/index.html`）：DSH 若挂子路径即 404。
- **B17 `.bd-fail` 样式定义但零使用**（`client.js:16`）：而 iframe 恰好没有任何失败分支 —— 路由没挂上那天，用户看到 640px 全透明空框。
- **B18 `/better-debug/api` 完全未文档化**：暴露 JSON 接口（`lib/panel.js:558-571`），两份 README 全文 grep 不到 `api`，也没说明 `panel:false` 会连它一起关。

### 状态机

- **B19 `s.fired.A = 0; s.fired.C = 0` 无条件重置**（`lib/index.js:1712-1713`）：任何一次测量（含失败）都解除 A 静音。而相邻的 C 前提取消是**条件式**的（`clear` 后 `measureArmed = false`，`:1704`）。两条相邻的「测量后解除」用了相反规则，无注释解释差异。
- **B20 `series.lastWriteSeq` 无条件覆盖**（`:1779`）：recurring 判据要的是「上次 ok 之后有没有写过」（`:1760` `s.writeSeq > prevSeries.lastWriteSeq`）。两次失败测量之间插入一次无关写操作会把 `lastWriteSeq` 推高 → 下一次失败漏计一次翻转。
- **B21 M 与普通注入的 `inj` 哈希输入形状不同**：M 用 `|M|`（`:2248`），普通用 `|TAG|`（`:2424`，TAG 为信号组合）。M 分支不自增 `injectionsThisTurn`。当前无碰撞，但两条路径的输入形状不一致是维护期负担。
- **B22 `pending` 无上限**（`:1943-1961`）：`stepNow === void 0`（PTC 子事件且 `pendingStep` 也未定）时 `expired` 恒 false → pending 永久驻留，直到 `turn/end` 整对象丢弃。单 turn 内受 `maxInjectsPerTurn` 限制所以风险低。
- **B23 pre-step 的 catch 只 warn 不 record**（`:2428-2433`）：走 DSH logger，**不进 better-debug.log**。而面板/事后验收只读 better-debug.log → **插件自身崩溃在验收面上完全不可见**。863 行日志里 0 条 warn，无法证明「从未崩过」。
- **B24 `skill` 类转向在面板不可见**：真实日志 `first=skill` 出现 **10 次**（模型在提醒后去加载技能，这是 design intent 的成功路径），但 `firstAction.byClass.method = 0`。`classifyTool`（`:531-539`）确实把 `skill` 归到 `method`，说明那 10 次调用**没有产生 outcome 行**（`outcome` 只在有 pending 时记）。**面板统计口径漏掉了最有效的转向。**

### 配置 / 文档

- **B25 `noVerifySteps` 示例措辞不一致**（`cordis.patch.yml:9`）：其他四条明写「loosen from 3 / 默认 6」，这一条只写语义说明，读起来像默认值（真值 2）。
- **B26 `excludePaths` 默认值只概括未枚举**（`README` 两版）：实现是三条正则（`lib/index.js:124-128`）。
- **B27 measure 行示例漏 `turn=`**（`README.md:350`）：实现 `:1922` 是带 `turn=` 的。
- **B28 测量命令清单漏 5 类**：文档写 13 类，实现 16 条（`:98-115`）。漏 `node test/`、`go vet|build`、`cargo check|clippy|build`、`dotnet build`、`python -m pytest|unittest`。
- **B29 CI 命令与 README 字面不符**：README 说 `npm run verify`，`ci.yml:21-22` 是 `npm run check` + `:26-27` `npm test`（语义等价）。
- **B30 深审轮次编号自相矛盾**：`README.md:456` 标题「第五轮」紧跟 `:458` 正文「第三轮」；`:545` 标题「第七轮」紧跟 `:547`「第五轮」；`:589` 又是「第五轮」。英文同型（`en:510/512`、`en:631/633`）。
- **B31 「第四类防线」缺标题**：`README.md:397` 只是段内加粗，而 `:411` 是 `### 第五类防线` → 目录里出现第五却找不到第四。
- **B32 无 CHANGELOG**。
- **B33 `files` 未含 `.gitattributes`**：当前 CRLF 计数为 0 无实际故障，但机制脆弱。建议 `prepack` 硬校验。
- **B34 CI 缺 `permissions` / `timeout-minutes` / `concurrency` / `cache: npm`**。
- **B35 `package.json:4` description 用中文**：降低 npm 检索命中；`keywords` 里 `agent-hygiene` / `pre-step` 无检索价值。
- **B36 `s.fired.O` 与面板 `bySignal` 的 7 键固定表互相对齐** —— 两处共同冗余，看起来「一致」其实都多一个永不使用的键。

---

## 5. 架构评审：三个结构性判断

### 5.1 `apply()` 987 行单函数是测试盲区的根因，不是风格问题

现状：7 个闭包 + 4 个事件注册全部嵌在 `apply` 作用域内。`stateFor` / `turnState` / `settleMeasure` / `deliver` 都需要 `state`、`cfg`、`record`、`ctx` 四个闭包变量。

后果：**任何想单测这两块 233 + 242 行逻辑的人，必须先造一个能跑完 987 行的假 ctx。** 而项目里那个假 ctx（`test/sim.mjs:60-120`）已经被迫做了白盒妥协（S6 的 `ctx.inject` 空实现），于是面板路由至今零覆盖。

**建议**：把纯逻辑从闭包抽成可注入依赖的工厂函数：

```js
// 现在：settleMeasure 读 4 个闭包变量
// 目标：
export function createMeasureSettler({ cfg, record }) {
  return (s, input) => { ... }   // 纯输入输出，可直接单测
}
```

这不会改变任何行为，但能让 S1 / A3 / A4 这类缺陷第一次变得可测。**这是本次评审最有杠杆的一条建议** —— 它一次性解锁 C 级（面板）之外的整片覆盖盲区。

### 5.2 两条身份路线并存且结论冲突

- `errorFingerprint`（`:615-629`）：前 6 行 → sha256 → 16 位。B 用。
- `failureSetOf`（`:1002`）+ `failureSetKey`：按失败条目集合 → 排序 key。O/P 用。

**实测冲突**（同一对 jest 夹具）：前者 same-fp=**true**（错），后者 key **不相等**（对）。

这是典型的「两条路都活着，各自被不同判据依赖，没人做过一致性验证」。修 S1 的正确做法不是修 `errorFingerprint`，而是**让 B 改用 `failureSetOf` 路线**，然后删掉 `errorFingerprint`。此时 A2 的 `fingerprint` 死参数、`:2010` 的白算、`errorTargetOf` 的 PASS 行误判一起消失。

### 5.3 O 与 P：120 行实现 + 数十条测试，生产 20 天零触发

| 信号 | 生产触发次数 | 实现成本 |
|---|---|---|
| C | 142 | ~15 行 |
| B | 34 | ~30 行 |
| A | 12 | ~15 行 |
| M | 6 | ~25 行 |
| F | 1 | ~40 行 |
| **O** | **0** | `measureSeries` + `recentFailSets` 交集 + `announced` 生命周期，~60 行 |
| **P** | **0** | `repairChain` + `seenFailTargets` + `unchanged/shrunk/movedSite` 三判据，~60 行 |

不是说要删掉它们 —— 它们覆盖的是真实存在的失败模式（振荡、补丁链）。但**在当前可观测性下无法证伪**：没有 golden 用例证明它们在真实 runner 输出上会正确触发。

**建议**：把 O/P 标记为 experimental，在 `cordis.patch.yml` 里默认关闭；先用真实语料（可脱敏的 CI 日志）证明它们能正确触发，再默认开启。

---

## 6. 测试体系评审

### 6.1 分层结论

| 层 | 评价 |
|---|---|
| `failureSetOf` 解析 | **生产级**：147 次调用、17 条 `.size === 0` 绿语料、60 处 `failureSetKey` 集合等式 |
| 其余纯函数 | 良好但有洞：`errorFingerprint` 无 golden（只有自比对）、`measureKey` / `failureTargetsOf` / 工具集常量 grep 命中 **0** |
| 状态机 | **基本是空的**：18 个配置键 **10 个零覆盖**；62 个 `runTurn` 全 `turn: 1` |
| 面板路由 | **零执行** |
| 慢盘 / posix / linux shim | 三层各自可静默失效 |

断言总数约 240（sim 176 + panel 64），**`assert.` 零使用**（全用自建 `check(label, pass, detail)`，无 try/catch、无超时）。

### 6.2 五个具体失效机制

1. **配置键零覆盖**（`test/sim.mjs` grep 计数）：`excludePaths` / `repeatErrorThreshold` / `noVerifySteps` / `changedWindow` / `repeatFamilyThreshold` / `familyMinFingerprints` / `oscillationThreshold` / `patchChainThreshold` / `metaAfterFutile` / `doneOnPresent` 全部 **0 命中**。`num()` 的钳制分支与 `toRegExp` 的坏正则回退对任何键都没跑过。

2. **turn 生命周期从未执行**：`grep -oE "turn: *[0-9]+"` → sim.mjs 66 处全 `turn: 1`、panel.mjs 5 处全 `turn: 1`；`turn/start` 仅 2 次、`turn/end` 1 次、`session/disposed` **0 次**。**预算若永不重置，全部测试仍然全绿**（`injectionsThisTurn` 只在 `fresh()` 里归零，而 `fresh()` 只在 turn 变化/首次时调）。

3. **慢盘回归三层自失效**：
   - `test/panel.mjs:409-419` 的守卫**只在替身已生效时才存在**（`slow !== void 0` 才 check）—— 替身消失则 63→62，仍然绿。
   - `test/slow/register.mjs:18-22`：node 20 没有 `module.registerHooks` 时只 `console.log('[跳过]')` 并 **exit 0**。
   - `test/slow/fs.mjs:12`：`Number(process.env.BD_SLOW_MS ?? '400')` 无 clamp —— `NaN` 或 `60000` 都会毁掉这一轮。

4. **posix 轴贡献为零**：`test/posix/path.mjs:22` `export const win32 = posix`（把 win32 别名成 posix，语义相反），且没有 `posix` 具名导出。更关键的是 `lib/index.js:257-261 isAbsPath` 是**纯正则、不 import node:path** —— 所以 `test:posix` 对路径双平台轴**没有任何影响**，它换的是项目自己写的 shim。

5. **linux 轴是假组合**：`test/linux/register.mjs:17-22` 只改 `process.platform`，不换 `node:path`。本机得到 `platform=linux + path=win32` —— 这个组合现实中不存在；唯一有生产意义的 `platform=linux + path=posix` 在本机跑不到。

### 6.3 断言质量问题（择要）

- **存在性冒充行为**：`test/sim.mjs:508` / `:1034` / `:1770-1775` 用 `length > 0` / `>= 1`。
- **自指断言**：`:804` `same === CASE_INSENSITIVE` 恒真。
- **重言式**：`test/panel.mjs:108-112` 的 `charsFor` 漂移用例；`:298-300` `estimateTokens` 用 `en > 0 && en < 10` 区间断言（真值 3）。
- **子串定位行**：`test/panel.mjs:434-435` 用 `'00:00:00'` 时间戳找行。
- **句子存在代替逻辑存在**：`test/panel.mjs:527-548` 对 `web/index.html` 只断言某句话在文件里。
- **超时不失败**：`:365-370` `readLogWhenReady` 超时只 `console.log`。
- **只写不读**：`test/sim.mjs:35` / `:38-41` 的 `noise` 数组只 push 不 assert → `record()` 写失败告警零覆盖。
- **吞异常使断言失效**：`:656-679` `apply` 吞异常，`threw === null` 无法区分「没抛」和「抛了被吞」。
- **环境恢复无 try/finally**：`:761-776` 的 `DSH_HOME` 保存/恢复。
- **分母动态**：删一个用例不会报错（`:2642`、`:720` 用 `checks.length`）。

---

## 7. 文档与发布一致性

**做得好的部分先明确**（这部分是真的对，不要改）：

- 19 个配置键在 `lib/index.js:184-224` **全部真实存在**，键名集合与两份 README 的 yaml 块**逐字一致**。
- **默认值与 clamp 区间两端全部一致，零例不符**。
- 无未使用键、无「代码有键但 README 未列」。
- 中英两版的章节、19 键配置表、命令清单完全同步（`zh:295-322` == `en:329-352`；`zh:384-391` == `en:421-428`）。实质差异仅三处举例。
- 测试计数 184/62/63 与实测一致（`README.md:382-391`）。

**须成对修复的失实**（两版同错，改一处会造成新的不同步）：S2（0.3.5 不存在）、S7（不读模型文本）、A10（acceptance-matrix.mjs）、A11（非法正则记 warn）、B28（命令清单漏 5 类）、B30（轮次编号）、B31（缺第四类防线标题）。

---

## 8. 值得保留的设计（评审中确认的正确决策）

这些是本次评审里我认为**不该动**的部分：

1. **`export const inject = []` 留空**（`lib/index.js:55`）。注释给出硬理由：cordis `Fiber._refresh()` 只要 `inject` 里有一个服务拿不到就把 epoch 置 INACTIVE **且直接不执行 apply，无报错无日志**。所以 `skills` / `webServer` 两个可选服务必须走 `ctx.inject([...], cb)` 动态订阅。**这是外部约束驱动的正确取舍**，是教科书级的「为什么这里不按惯例写」。

2. **`DEFAULT_LOG_NAME = 'better-debug.log'` 而非 `dsh-better-debug.log`**（`:68`）。理由写在注释里：旧测试 `endsWith('better-debug.log')` 对 `dsh-better-debug.log` **也成立** —— 断言绿着，文件却不在文档位置。**这是一个「测试通过但事实错误」的经典案例，作者抓到了并修掉了。**

3. **`apply` 行把 11 个配置值全打出来**（`:1503-1512`）。热重载后读到的到底是默认还是覆盖值，可直接从日志判定。**这是全仓最好的可观测性设计。**

4. **`registerBundledSkill` 的 `provider.get` 容错**（`:1387-1388`）：解析失败/IO 抖动时，只有 `options?.signal?.aborted === true` 才 rethrow，否则静默退回 `cachedBody`。**正确取舍** —— 技能可用性不该因为一次读盘抖动而崩。

5. **`isFrameLine` 的七条判据**（`:890-899`）：JS/TS 栈帧、Python `File "`、Python Traceback 表头、Rust/go `-->`、源码片段 `|`、pytest `path:line: in fn`、纯路径行号。覆盖了主流生态，是同层里少见的「真的跨生态验证过」。

6. **`failureItemFingerprint` 的设计纪律**（`:860-877`）：源位置是定位噪声必须剥，消息里的数字（`case-1` / `TS2322` / `expected 3 to be 4`）是失败语义必须留。**这条注释值一个 PR。**

7. **M 闸门刻意排在通用幂等闸之前**（`:2230-2238` 长注释：M 的输入是 futile，而「提醒后既没写入也没新错误」正是幂等会挡掉的状态）—— **判定顺序被当作设计的一部分写进注释，这在插件代码里非常罕见。**

8. **`test/panel.mjs` 的暗色/亮色对比度方向断言**（`light 1->0.066 / dark 0.083->0.979`）：测的是「深字浅底 vs 浅字深底」的方向而不是具体色值，色值可改而断言不脆。

---

## 9. 修复路线图

> **进度（2026-11-26）**：P0 七条、P1 十条全部落地，均带回归测试与文档同步。
> 测试基线：`node test/sim.mjs` 255/255、`node test/panel.mjs` 90/90、
> `node --import ./test/slow/register.mjs test/panel.mjs` 91/91、`node scripts/lint.mjs`、
> `node scripts/pack-check.mjs` 全绿；CI 已加死代码 / 发布契约 / tarball 自测三步。
> P2 十八条未动。

### P0 —— 发布门禁（本周）

| # | 动作 | 关联 |
|---|---|---|
| 1 | ✅ 让 B 改用 `failureSetOf` 路线，删掉 `errorFingerprint` | S1、A2（fingerprint）、A3 |
| 2 | ✅ 补 golden value 测试：jest / pytest / vitest / tsc 四套真实夹具，断言「不同失败 → 不同身份」+「同一失败 → 同身份」 | S1 |
| 3 | ✅ 修 `failureSetOf` 的 PASS 行误判 | S1 |
| 4 | ✅ 统一面板阈值键名 + `budget`/`window` 从 cfg 兜底 | S3 |
| 5 | ✅ 修统计口径：按 `inj` 关联分子分母 | S4 |
| 6 | ✅ `client.js` 用 `ctx.effect` 包注册；删 `dsh.client.inject:["slots"]` 或改成完整包名；补 `locale` | S5 |
| 7 | ✅ 决定 0.3.5 是发还是回退文档 —— **二选一，不能两头挂着** | S2 |

### P1 —— 结构杠杆（本月）

| # | 动作 | 关联 |
|---|---|---|
| 8 | ✅ 把 `settleMeasure` / `turnState` / `deliver` 抽成 `createXxx({cfg, record})` 工厂，脱离 `apply` 闭包 | 第 5.1 节 |
| 9 | ✅ 接上 lint（`no-unused-vars`）或 `// @ts-check` —— 五处死代码当天消失 | A2、A7 |
| 10 | ✅ 日志轮转 + 读端增量解析 | A1 |
| 11 | ✅ `failSeq` 在「解析不出条目但 exit 非 0」时也推进 | A4 |
| 12 | ✅ `fs/write-intent` 的 catch 改成 warn + 记 `intent-failed` 行 | A5 |
| 13 | ✅ 补 `registerPanel` 的真实执行测试（需要先修 `ctx.inject` 白盒） | S6 |
| 14 | ✅ `QUIET_PATTERN` 补英文；改三处对外口径 | S7 |
| 15 | ✅ `lsp_diagnostics` 六处 + 一条测试一起处理 | A8 |
| 16 | ✅ `files` 加 `test/` 或 `prepack` 校验 | A9 |
| 17 | ✅ README 三处失实（acceptance-matrix / 非法正则 warn / 0.3.5）成对修 | A10、A11 |

### P2 —— 债（下季度）

- 18 个配置键补齐覆盖（尤其是 `num()` 钳制、`toRegExp` 回退）。
- `runTurn` 引入真实 turn 序列（turn 1→2→3），验证预算重置与 `state.delete`。
- 慢盘 / posix / linux 三个 shim 改成「失效即失败」而不是静默跳过。
- 面板前端：`@media`、AA 对比度、`prefers-reduced-motion`、`esc` 补单引号、CSP/nosniff、轮询 hidden 短路、`bar()` 加 `display` 参数。
- O/P 标记 experimental 并默认关闭，用真实语料证明能触发后再开。
- 补 `CHANGELOG`。

---

## 10. 一句话给作者

这个项目的**判断力**明显在平均线以上：`inject = []` 的取舍、`DEFAULT_LOG_NAME` 的陷阱、`failureItemFingerprint` 的「剥位置留数字」纪律、`apply` 行打全配置 —— 这些都是想清楚了才写得出来的东西。

但**它对自己说的话做的事，比它对代码做的事少**：

- 它宣称不读模型文本，代码在读；
- 它宣称非法正则记 warn，代码不记；
- 它宣称 0.3.5 可下载，仓库只到 0.3.4；
- 它宣称面板告诉你阈值，面板在首次安装时告诉你 0；
- 它宣称检测「同一个错误重复」，而它的指纹在 jest 上把三个不同错误当成同一个。

**修 S1 那一条，价值大于修其余全部。** 因为它是唯一一条「插件以为自己在工作，其实没有」的缺陷 —— 而一个 debug 工具最不能犯的错，就是这个。
---

## 11. 第二次审查（2026-11-26，修复后复评）

> 触发：第一次修复完成后按「审查 → 只修 P0/P1 → 再审查」循环复评。
> 方式：三路并行子审（core / panel / docs）全量重读 + 主审逐条复核 + 6 组探针实测。
> **结论：无 P0。** 子审报的 8 条 P1 中 6 条在本轮已修、2 条是子审读改前快照导致的误报；
> 本轮新查出的 8 条 P1（A–H）全部落盘并带回归测试。

### 11.1 本轮修掉的 8 条 P1

| # | 缺陷 | 位置 | 修法 | 验证 |
|---|---|---|---|---|
| A | 面板每次 HTTP 请求全量 `aggregate(records)`，注释却称「每请求 O(新增)」 | `lib/panel.js:588-620` | 抽 `createAggregator()`，`logCache.acc` 常驻，`absorb` 只 `acc.push(record)`，`finish()` 出快照 | 新旧 JSON 全量对拍（1046 条真实日志）唯一差异是 reported 口径，见 11.2 |
| B | `logCache.records` 只增不减，无上限 | `lib/panel.js:546` | 随 A 一起删除 records 数组 | `grep records lib/panel.js` 只剩 parseLog 局部数组 |
| C | `absorb` 两处裸调在 try/catch 外，`openSync` 无保护 → ENOENT 穿成 HTTP 500 | `lib/panel.js:611/613`、`:551` | `readRangeSync` 的 `fd` 提到 try 外、catch 返回 null；`absorb` 返回 boolean，读失败不推进游标 | 第 16 组 6 条（含轮转重置、半字符 tail） |
| D | 前端红条只 `hidden=false`，全文无一处复位 → 一次错误永久显示 | `web/index.html:532-541/563-567` | `render()` 开头 `$('error').hidden = true` + 清空 textContent | 4 处 false / 1 处 true |
| E | 配置钳制只 clamp 不取整，分数 `logKeep` 让轮转失效 | `lib/index.js:212-213` | `num()` 改 `Math.round` 后再 clamp | 探针：`logKeep=2.5` 正常产出 `.1`/`.2` |
| F | `writesSinceMeasure` 注释称是 C 的 arm 依据，全文件无读取点 | `lib/index.js:1994` | 删字段，注释改为描述 `streakEdits` | `grep writesSinceMeasure` 全仓 0 命中 |
| G | 打包契约只校验 `pkg.scripts` 里出现的路径，`dsh.bundle.patch` / `exports['./client']` / `assets/` / `web/` 是覆盖盲区 | `scripts/pack-check.mjs:30-41` | 新增 `REQUIRED` 四项静态清单，逐项判声明存在 + 文件存在 + files 覆盖 | 反证：临时删 files 里的 `cordis.patch.yml` → exit 1 |
| H | README 用例数 213/67/68 与真实 255/90/91 不符 | `README.md:410/411/414/637-638`、`README.en.md:449/450/453/748-750` | 全部同步；历史基线 `184/184` 保留 | — |

### 11.2 aggregate 改写的验证方式（本轮最大改动）

改 `lib/panel.js` 的聚合层等于改面板全部数字，所以用了三重验证，探针跑完即删：

1. **新旧全量对拍**：`git show HEAD:lib/panel.js` 取改前版本放在同目录（相对 import 才能解析），喂同一份真实日志 1046 条记录，比对 JSON。除 `generatedAt` 外**只有 `firstAction` 一处差异**：old reported=207 / new reported=154。
2. **差异归因**：老代码是 `const reported = outcomes.length`，直接数 outcome 行数 —— 同一 `inj` 的重复 outcome 会被重复计，`silent = injects - reported` 因此可能变负。新代码按 `inj=` 关联。实测 injects=214、outcomes=207、outcomeInjs 去重=154、重复 inj=0、outcome 早于 inject 的条数=0 → **154 才是「多少条注入被跟进了」，这是有意修正，不是回归。**
3. **独立 oracle 对拍**：另写一份不共用代码的手算，全项相等 —— reported 154 / silent 60 / turned 9 / observed 155 / rate 0.05806 / lines 1048 / bySignal `{A:17,B:36,C:156,F:1,O:0,P:0,M:8}` / measures `{total:183,ok:170,failed:13,cleared:95}` / futile 41。

### 11.3 复核后判定「不成立」的候选（记录以免下次重查）

- **`record` 是 async 但 16 个调用点全 `void record(...)`（不 await）→ 并发竞争 logBytes/rotateLog**：不成立。实测 awaited 串行写到 `size >= cap` 后同 tick 并发 8 条 → `files=2 a.log:584 a.log.1:584`，`fill=8/8 race=8/8 total=16 tornTail=0 warns=0`。原因是 `rename` 语义自洽：后到的 rotateLog 把已被前者清空的新文件改名，旧数据不丢。cap×keep 三档（64/200/2048 × 2/3）× 50 条并发全部 kept=50 distinct=50。
- **前端读了聚合里不存在的字段**：不成立。正则抽出的 13 个「MISSING」全是误抓（`r.at`/`r.tag` 来自 `recent` 行对象，`r.status` 是 fetch Response，`r.json()` 是方法）。`recent[0]` 实测键与 `web/index.html:497-515` 逐一对应。
- **打包缺文件**：不成立。`npm pack --dry-run` 21 文件 / unpacked 544.1 kB，prepack 钩子正常触发 pack-check。
- **空 catch 静默吞错**：不成立。9 处空 catch 全部是「日志/清理不该让主流程崩」的有意兜底；`lib/` 下 `JSON.parse` 0 命中；TODO/FIXME/XXX/HACK 全仓 0 命中。

### 11.4 收口判定

`npm run verify` 全绿：`[lint] ok` / `[pack-check] ok — 13 个脚本路径 + 4 个静态必需项` / sim **255/255** / panel **90/90** / slow **91/91**（posix、linux 变体同）。
（第 12 章的 P0 修复落地后为 sim **270/270** / panel **100/100** / slow **101/101**。）

**第二次审查后已无 P0/P1。** 剩余全部是第 9 章 P2 清单里的债（18 个配置键覆盖、真实 turn 序列、前端可访问性与 CSP、O/P 标记 experimental、CHANGELOG），按用户口径不动。**循环到此收敛。**

---

## 12. 真机验证新发现的 P0：面板路由绕过宿主鉴权

> 触发：第二轮真机验证时把面板路径放到公网 relay 上打，发现响应码与其它插件不一致。
> 性质：**P0（安全）** —— 不属于第一、二轮静态审查能看到的类别，因为缺陷不在本仓库代码里，
> 而在「本仓库代码没有做别家插件都做的那一件事」这个负空间里。

### 12.1 现象（实测，2026-11-26）

本机 profile 里装了 `@linxin666/dsh-remote-web-ui`，它把 `127.0.0.1:<port>` 反向暴露到
`https://<instance>.dsh-market.com`。同一份公网 origin 下的响应码：

| 路径 | 公网响应 | 说明 |
|---|---|---|
| `/` | **401** | `dsh web authentication required; reopen the URL printed by dsh web.`（`dsh-client-connection/lib/index.js:571-577` 的 `writeUnauthorized`） |
| `/open-in-app/apps` | **403** | 官方插件自己调了准入闸 |
| `/inspector/devtools` | 404 | 该 profile 未装 |
| `/plugins/` | 404 | — |
| **`/better-debug/api`** | **200** | 13,504 字节真实 JSON，含 `session-…` 真实会话 id、`"sample":"Error: … Expected ',', got 'string literal' …"` 报错原文、日志绝对路径 `C:/Users/Lyonl/.dsh/logs/better-debug.log` |
| **`/better-debug/index.html`** | **200** | 面板页整页可取 |

本机 `127.0.0.1:<port>` 上同样复现（`/` 401 而 `/better-debug/api` 200）⇒ **不是 relay 的
缺陷，是 better-debug 自己没做鉴权**。带 `Host: 127.0.0.1:<port>` 打公网 relay 则两者都 403
（宿主的 Host fence 本身是好的，问题只是 better-debug 没去调它）。

### 12.2 机制

宿主的准入闸是 `ctx.get('connection').requestRejection(req)`：

- `dsh-client-connection/lib/index.js:737-740` `requestRejection` → `admit()`。
- `:742-750` `admit`：`!isTrusted(request)` → **403**；`disposed` → 401；
  `browserAuth.isAuthenticated` 过 → peer；`authenticateApi` 查不到 → **401**。
- `:240-250` `isTrustedApiRequest`：Host 必须是 loopback / `trustedHosts` / 绑定地址，
  `sec-fetch-site !== 'cross-site'`，且 Origin 与 Host 同源。

**官方插件每个请求都自己调这一闸**：`dsh-host-open-in-app/lib/index.js:1264-1270` 的
`rejected(req, res)` 被三个路由（`:1271` / `:1283` / `:1324`）首行调用；
`dsh-experimental-inspector/lib/index.js:2479` 同样。而 `lib/panel.js` 的 handler 里
**一次都没有**。`ctx.webServer.register({ kind: 'prefix', … })` 只负责路由分发，不负责鉴权 ——
把 prefix 路由当成「已经挂在宿主里所以自然受保护」是这个 P0 的认知根源。

### 12.3 修法（已落盘）

`lib/panel.js` 新增导出 `createRequestGate(ctx)`，`registerPanel` 内 `const gate = createRequestGate(ctx)`，
handler 首段（任何路由分支之前）：

```js
const rejection = gate(req)
if (rejection !== 0) {
  res.writeHead(rejection, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  res.end(rejection === 403 ? 'forbidden' : 'authentication required')
  return
}
```

三个设计决定及理由：

1. **服务懒查，不缓存**：`lookup` 是 `() => ctx.get('connection')`，每次请求调一次。
   cordis 不保证服务就绪顺序（`@deepseek-ai/cordis/lib/index.js:1350-1356` `_getImpl` 在
   provider fiber 未 active 时返回 `undefined` 且不抛），注册时取一次会永久拿到 `undefined`，
   闸静默退化成恒放行 —— 无信号的失效比不做更危险。
2. **不改 `export const inject = []`**：用 `ctx.get('connection')`（`cordis/lib/index.js:1347-1349`，
   不需要 inject），DSH 自带插件里共 498 处同样用法。若把 `connection` 写进 inject，
   缺少该服务的 profile 会**静默跳过整个 apply**，闸门全部失效。
3. **无 `connection` 服务时恒放行**：headless profile 与单测假 ctx 里 webServer 只监听回环，
   没有浏览器鉴权层可依，强加自造鉴权只会关掉面板而不增加安全性。

拒绝路径刻意不带 CSP：响应体是一行纯文本，没有可执行内容。

### 12.4 验证

- 单测 `test/panel.mjs` 第 14b 组 8 条：无凭证 api 401 `text/plain` + `nosniff`；页面同样 401
  且不含 `<html`；有 cookie 200；宿主判 403 时 body=`forbidden`；无 connection 恒放行；
  服务缺 `requestRejection` 恒放行；**服务晚到**（注册时无、请求时有）`before=0 after=401`。
- 真 HTTP server 探针（非假 res）：真 `createServer` + 真 `fetch`，覆盖 HEAD、404、`?raw=1`、
  cookie 通过后的 200 `application/json` 996 字节 / `text/html` 23,666 字节。
- 全绿：lint ok / pack-check ok / sim **270/270** / panel **100/100** / slow **101/101**。
- **真机复验需重启 DSH**：活进程是改动前启动的，旧 handler 还在内存里，重启前公网仍 200。

### 12.5 教训（写进清单，避免第三次审查再漏）

**「宿主提供的能力」与「宿主替我做的事」是两件事。** 静态审查时看到
`ctx.webServer.register({ kind: 'prefix', … })` 与官方插件同构，很容易判定「与官方一致 ⇒ 安全」；
但官方那几处 `register` 前后都有显式的 `rejected(req, res)` 首行调用，而这类**负空间**
（别人都做、你没做）在逐行读代码时最难被注意到 —— 它不在任何一行的内容里。
唯一的系统性发现方式是**横向对比同一 API 的所有调用点**，以及**把每条路由放到
真实部署形态（这里是有公网 relay 的形态）下打一遍响应码**。

后续如新增任何 prefix / exact 路由，验收清单固定加一条：
`curl -s -o /dev/null -w '%{http_code}' <public-origin><route>` 必须是 401/403。
