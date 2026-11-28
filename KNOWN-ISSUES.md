# 已知问题留档（KNOWN ISSUES）

> 本文件记录 **当前版本里已知但尚未解决** 的问题，按「影响面 × 可观察性」分级。
> 这里每一条都经过实测或逐行核对，并带代码位置；写下来是为了让下一轮审查不再把它们当成新发现重捞一遍。
>
> - 对应版本：0.3.6（`package.json` 未提交工作区）
> - 用例基线：sim 345/345、panel 100/100、client 16/16；`npm run verify` 1452 PASS / 0 FAIL
> - 相关文档：`README.md` 的「适用范围与边界」记录的是**设计上接受的边界**，本文件记录的是**实现上尚未修掉的问题**；`CODE-REVIEW.md` 是历次审查的原始记录，已关闭的条目不在本文件重复。

## 怎么用这份文件

1. **不阻断发布**：P0 已全部关闭，下面的条目都不阻断发版。但每修一条就删掉对应小节 —— 留着过期条目比没有更糟。
2. **不要凭本文件改阈值**：SIG 组的结论是「记账层错」，不是「阈值不对」。调阈值只会把同一个缺陷换个症状。
3. **修复必须带回归测试**：这轮 12 条缺陷里有 9 条属于「只在特定形态下才坏」，读源码读不出来，只能靠用例钉住。

## 分级

| 级别 | 含义 | 是否阻断发布 |
|---|---|---|
| P2 | 真实缺陷，影响正确性或可观察性，但不在主路径上 | 否 |
| P3 | 已知的粗糙实现，方向明确（漏报或钝），代价可接受 | 否 |
| SIG | 信号判据/阈值的价值问题，需先改结构再谈数值 | 否（但影响卖点成立与否） |
| 待验 | 数值调整，前置条件未满足 | 否 |

---

## 总览

| ID | 标题 | 级别 | 位置 |
|---|---|---|---|
| PANEL-1 | 日志尾部按解码后长度回算字节偏移，非法 UTF-8 会吞掉整条 inject | P2 | `lib/panel.js:661-669` |
| PANEL-2 | CSP 含 `script-src 'unsafe-inline'` | P2 | `lib/panel.js:796-804` |
| PANEL-3 | 500 回显 `error.message`，泄漏绝对路径 | P2 | `lib/panel.js:841` |
| PANEL-4 | `?raw=1` 写死 `version: 3` | P3 | `lib/panel.js:830` |
| PANEL-5 | `logCache` 是模块级单例，只缓存一个日志文件 | P3 | `lib/panel.js:625` |
| PANEL-6 | `finish()` 每次都全量排序算中位数 | P3 | `lib/panel.js:292-297` |
| TOOL-1 | `judge-health` 的分母与面板 `instrumented` 不等 | P3 | `scripts/judge-health.mjs:87` |
| TOOL-2 | `lint` 用整词计数冒充可达性 | P3 | `scripts/lint.mjs:49-70` |
| TOOL-3 | `pack-check` 对不存在的路径静默跳过 | P2 | `scripts/pack-check.mjs:36` |
| ENG-1 | `engines.dsh` 只有下界没有上界 | P2 | `package.json:55` |
| ENG-2 | 多会话并发与 `session/disposed` 零覆盖 | P2 | `test/sim.mjs` |
| ENG-3 | 用例数漂移（0.3.6 已改对，但无脚本校验） | P3 | `README.md:403` 等 |
| SIG-1 | `state` 按 turn 重建，O/P/F 永远看不到跨 turn | P2 | `lib/index.js:2192` |
| SIG-2 | `errorTargetOf` 抽不出 target，F 的错误族建不起来 | P2 | `lib/index.js:913` |
| SIG-3 | 一条 FAIL 行被记成两条失败条目，P 的收缩判据失真 | P2 | `lib/index.js:1233` |
| SIG-4 | `run_code` 里手写断言的测量不可见 | P3（刻意） | `lib/index.js:677-683` |
| VAL-1 | C 的注入有 61.9% 落在末班车 | SIG | `lib/index.js:2859` |
| VAL-2 | B 的末班车比例更高（69.0%） | SIG | — |
| VAL-3 | A 覆盖窄，且日志无 `dir=` 无法估误报率 | SIG | `lib/index.js:1758` |
| VAL-4 | 「收工闸」受 pre-step 约束，做不了 | SIG（设计限制） | — |
| TUNE-1 | `oscillationThreshold` 3→2 未验证 | 待验 | `lib/index.js:257` |
| TUNE-2 | `patchChainThreshold` 3→2 未验证 | 待验 | `lib/index.js:259` |
| TUNE-3 | `repeatFamilyThreshold` 4→3 未验证 | 待验 | `lib/index.js:254` |
| IDEA-1 | C-3 跨 turn 升级未实现 | 提案 | — |
| DOC-1 | ~~F 与 M 未标实验性~~（0.3.6 已关闭） | 已关闭 | `README.md:121` |

---

## 一、面板（`lib/panel.js`）

### PANEL-1 日志尾部按解码后长度回算字节偏移，非法 UTF-8 会吞掉整条 inject — P2

`absorb()` 先整段解码，再按字符串长度回算「已消费字节数」：

```js
const text = buffer.toString('utf8')        // lib/panel.js:661
const cut = text.lastIndexOf('\n')          // :662
const head = text.slice(0, cut + 1)         // :668
logCache.tail = buffer.subarray(Buffer.byteLength(head, 'utf8'))  // :669
```

非法 UTF-8 序列在 :661 被替换成 U+FFFD（3 字节），而原字节可能是 1–4 字节。于是
`Buffer.byteLength(head, 'utf8')` 与真实消耗的字节数不等 → 下一次增量的起点漂移，
**后续整条 inject 记录被跳过**。真机探针在人为插入非法字节的日志上复现 2/3 次。

注意 `lib/panel.js:616-619` 的注释自称「tail 存原始字节，切在多字节字符中间时先解码会造出替换字符」——
这个判断本身是对的，但 :661 就是先解码了，注释与实现矛盾，读代码的人会被误导。

**修法**：切分放在字节层，不要 decode 再回算。

```js
const cut = buffer.lastIndexOf(0x0a)          // 找最后一个换行的字节位置
const head = buffer.subarray(0, cut + 1)
logCache.tail = buffer.subarray(cut + 1)
```

**验收**：日志中间插入 `0xC3 0x28`（非法两字节序列），后面跟一条完整 inject 行，断言该行仍被解析出来。

### PANEL-2 CSP 含 `script-src 'unsafe-inline'` — P2

`lib/panel.js:796-804` 的六项里，`script-src 'unsafe-inline'` 让 CSP 对 XSS 基本失效
（`default-src 'none'` + `connect-src 'self'` 仍挡住了数据外带，所以不是可直接利用的洞）。
页面完全内联（`web/index.html` 里没有 `src=` / `href=` / `@import` / `url()`），
所以这行是「内联」的代价，不是疏忽。

**修法**：页面是静态的，用 hash 最省事 —— 构建时对 `<script>` / `<style>` 内容算 sha256，
写进 `script-src 'sha256-…'`，去掉 `unsafe-inline`。代价是每次改前端都要重建 hash，
需要一个生成步骤。

**验收**：CSP 头里没有 `unsafe-inline`，页面功能与样式不变。

### PANEL-3 500 回显 `error.message` — P2

`lib/panel.js:841` 把异常文本原样写回响应体。`readAggregate` 抛出的错误里带
`cfg.logFile` 的绝对路径 —— 面板在有些部署下经 relay 暴露，读 `/better-debug/api`
就能拿到用户名与目录结构。

**修法**：响应只写 `{ ok: false, error: 'internal' }`，细节走 `record()` 进日志。

### PANEL-4 `?raw=1` 写死 `version: 3` — P3

`lib/panel.js:830`：`JSON.stringify({ id: 'dsh-better-debug', version: 3 }, null, 2)`。
这个接口的用途是「确认插件真的挂上了」，写死版本号会让升级后的人无法从响应判断装的是哪一版。

**修法**：`createRequire` 读 `package.json` 的 `version`，或构建时注入常量。

### PANEL-5 `logCache` 是模块级单例 — P3

`lib/panel.js:625` `let logCache = { … }`，`resetCache()` 在 :675 重建它。

三个后果：只缓存一个文件（配置里换了 `logFile` 就整份重读）、同一进程里两个插件实例
互相踩（后注册的把前一个的 tail 当自己的）、测试之间无法隔离。

**修法**：把 cache 移进 `registerPanel` 的闭包（每实例一份），key 用 `file + ino`。

### PANEL-6 `finish()` 每次都全量排序算中位数 — P3

`lib/panel.js:292-297` 的 `median()` 走 `[...values].sort(...)`，:569 的
`medianSteps: median(stepsToTurn)` 每次 `finish()` 都调一次（:606 与 :719 两处入口）。
70 万条注入时实测堆峰 +158.8 MB，耗时线性于 n log n。

**修法**：`stepsToTurn` 的取值范围很小（受 `changedWindow` 限制），换成定长直方图；
或只在真正需要时算一次并缓存（带 size/mtime 失效）。

---

## 二、脚本与工程

### TOOL-1 `judge-health` 的分母与面板 `instrumented` 不等 — P3

`scripts/judge-health.mjs:87` 用 `injects.filter(r => r.signals.includes('C'))`，
分母是「全部 inject 行」；而面板的 `instrumented`（`lib/panel.js:380`、:488-489、:565）
只统计**确实带 inj 关联**的那些。两个分母在缺 `inj` 字段的旧日志上会差出十几个百分点，
同一个日志在面板与体检脚本里给出不同的 C 占比。

**修法**：`judge-health` 统一按 `instrumented` 口径取分母，与面板对齐。

### TOOL-2 `lint` 用整词计数冒充可达性 — P3

`scripts/lint.mjs:49` 只抓顶格声明（:56 跳过缩进行），:54-70 在原始文本里数整词出现次数，
`>1` 就算被引用。文件头 :13-16 自己写明这是**漏报方向**（宁可漏判死代码，不误报）。

方向是对的（误报死代码比漏报更贵），代价是「导出但零调用」的符号查不出来。
**修法**：接 `eslint no-unused-vars`，或加 `// @ts-check` + `tsc --noEmit` —— 一次性把这类问题变成编译错误。

### TOOL-3 `pack-check` 对不存在的路径静默跳过 — P2

`scripts/pack-check.mjs:36`：

```js
if (!existsSync(join(ROOT, clean))) continue
```

于是 `package.json` 的 scripts 里把 `test/sim.mjs` 打错成 `test/smi.mjs`，
发布契约检查照样全绿 —— 而这条检查存在的全部意义就是抓这类错。
:42 起的四条静态必需项是后来补的补丁，覆盖不到这个面。

**修法**：token 含 `/` 且不以 `-` 开头但文件不存在 → 直接报错并非 0 退出。
（当前过滤条件已经足够窄，不会把 `node --test` 之类误判。）

### ENG-1 `engines.dsh` 只有下界没有上界 — P2

`package.json:55` `"dsh": ">=0.2.1-rc.5"`。DSH 还在 0.x，cordis 服务名、`ctx.inject` 语义、
事件字段都改过（本插件自己就因为 `lsp_diagnostics` 的过时事实改过 6 处）。
装上不兼容的宿主不会报错，只会**静默不工作** —— 最难排查的一类故障。

**修法**：加 `<0.4.0`（或当前主测版本的下一个次版本），并在 README 里写明主测版本。

### ENG-2 多会话并发与 `session/disposed` 零覆盖 — P2

实测 `grep`：`test/sim.mjs` 里 `disposed` 0 命中、`sessions.size` 0 命中。
而 `lib/index.js:2607-2612` 的 `state.delete(session)` + `seen.delete(session.id)`
是唯一释放路径，写错就是内存泄漏或「卸载后还在注入」。

**修法**：两条用例 ——

1. 两个 `sessionId` 交替跑 turn，断言各自的 `blindWrites` / `fired` 互不影响；
2. 触发 `session/disposed` 后再来一个 step 事件，断言零注入且 `state.size === 0`。

### ENG-3 用例数文档漂移 — 已关闭（0.3.6）

发现时实测 sim **329**，而 `README.md:403`、`README.en.md:448`、`CHANGELOG.md:30` 与 :34
写的是 325（P0 那轮新增的 4 条用例没同步）。0.3.6 已把这四处一并改成 329。

留在这里是因为**漂移机制还在**：用例数只写在文档里，没有脚本从 `test/*.mjs` 反算校验。
下一轮加用例仍可能再次漂移。若要做，就在 `scripts/pack-check.mjs` 里加一条：
跑三份测试取 `N/M passed`，与 README 里的数字比对，不一致即 fail。

---

## 三、结构性判据缺陷（`lib/index.js`）

这一组是**真正的技术债**，共同点是「判据本身没错，但能看到的数据不够」。

### SIG-1 `state` 按 turn 重建，O/P/F 永远看不到跨 turn — P2

`lib/index.js:2192` 的 `const fresh = (turn) => ({ … })` 每个 turn 重建全部状态，
`turn/end` 时 :2362 直接 `state.delete(session)`。其中：

| 字段 | 位置 | 语义上应该跨越 |
|---|---|---|
| `errorFamilies: new Map()` | :2272 | 整个会话（错误族是慢变量） |
| `measureSeries: new Map()` | :2281 | 整个会话（O 判的是同一条回路反复翻转） |
| `repairChain: 0` | :2283 | 整个会话（补丁链可以横跨几个 turn） |
| `lastFailSet: new Set()` | :2287 | 上一次测量，不是本 turn 的上一次 |

结果：**O / P / F 的语义是跨 turn 的，实现只在一个 turn 内看**。

实测（本机真实日志 `~/.dsh/logs/better-debug.log`，0.3.0 之后 2.8 天）：
A 9 / B 15 / C 48 / F 1 / O 0 / P 0 / M 10。

按会话级重放模拟（同一份 measure 流，把 `flips` 与连续失败段提到 session 级）：

| 判据 | 阈值 | 全量命中 | 0.3.0 后命中 |
|---|---|---|---|
| O | 2（clamp 下限） | 1 | 1 |
| O | 3（当前默认） | 0 | 0 |
| P | 2 | 3 | 1 |
| P | 3（当前默认） | 1 | 0 |

全量数据里最长连续失败段只有 **4**。⇒ **降到 clamp 下限也救不活**，问题在记账层，不在阈值。

**修法（0.4.0 级，60–100 行 + 测试）**：把 `measureSeries` / `repairChain` / `lastFailSet` /
`errorFamilies` 搬到 session 级（`lib/index.js:2172` 附近新建 `sessionState`，
:2362 的 `turn/end` 只清 turn 级字段），并补「跨 turn 累积」的用例。

### SIG-2 `errorTargetOf` 抽不出 target，F 的错误族建不起来 — P2

`lib/index.js:913` 的 `errorTargetOf(text)` 从报错文本里抽路径。收集端
`lib/index.js:2550-2553` 组 `工具|目标|指纹`，:2576 的
`const familyKey = target.length > 0 ? 工具 + '|' + target : ''` —— **抽不出 target 就不进族**。

实测抽不出的两个高频形态：

- `old_string was not found in file` —— 编辑失败但文本里没有路径；
- `npm ERR! code ELIFECYCLE` 这类没有文件位置的构建错误。

于是 F 在真实数据里只触发过 1 次，而且那次是跨错误计数凑出来的，不是真的「同一个目标在漂移」。
**F 实际上一直由 B 在替代**（B 的 key 是 `工具|目标|指纹`，F 是 `工具|目标`）。

**修法（约 30 行）**：:2548 的收集端补兜底 —— `args.path` / `args.file_path` / `args.command`
里第一个像路径的 token。工具调用的参数比报错文本可靠得多。

### SIG-3 一条 FAIL 行被记成两条失败条目，P 的收缩判据失真 — P2

`lib/index.js:1233` 的 `failureSetOf(text)` 从一个输出块里抽失败条目。
jest 风格的输出会同时抽出「`test/sim.mjs`」与「`C:/x/test/sim.mjs:41:7`」两条
（FAIL 行一条、栈帧里的 `at` 行一条）。于是同一份输出在不同次运行里给出不同的集合基数，
P 的 `shrunk` / `unchanged`（`lib/index.js:1917`、:1935）永远判不出来 ——
收缩要求当前集合是上一轮的**真子集**，而集合本身不稳定。

**修法**：`failureSetOf` 里对「同一 file:line 归属」的条目做归并，只保留首个；
或按 `(file, line)` 归一化后再取集合。

### SIG-4 `run_code` 里手写断言的测量不可见 — P3（刻意的取舍）

0.3.6 已让 `run_code` 进得了测量（`lib/index.js:662` 的 `classifyTool`、
:677-683 的 `isMeasurement` 只认 `cfg.measureCommands`），但**故意不认** `measureIntent`：
后者的默认正则（`lib/index.js:137`）含裸 `test|verify|measure|diagnos`，对整段 `code` 测
等于「注释里提到测试就算跑过测试」，会把 C 直接洗白。

代价：`run_code` 里用 `node -e` 手写断言那一类不算测量。方向是「宁可漏认，也不误清」，
与 README 里「测量判据双向不对称」那条边界一致。

---

## 四、信号价值的实测结论

> 口径：**强证据转向** = 注入后的窗口内出现了 `class` 属于 `verify` / `search` / `method`
> 的动作；**末班车** = 注入之后本 turn 没有更多事件（下一次请求就是收工）。
> 早期版本只统计「窗口内已判定」的注入，会系统性高估（末班车全被排除），下面是全样本口径。

### VAL-1 C 的注入有 61.9% 落在末班车 — SIG

| 分组 | 注入数 | 强证据转向 | 开口后仍有测量 | 末班车 |
|---|---|---|---|---|
| 纯 C | 174 | 15（8.6%） | 27（15.5%） | **112（64.4%）** |
| 不含 C | 71 | 10（14.1%） | 16（22.5%） | 44（62.0%） |
| C + 其它 | 7 | 4（57.1%） | 6（85.7%） | 0 |

C turn 的最后一个事件里 142/158 是 inject-C，只有 16 条以 measure-ok 收尾。
这不是「噪音」，而是**劝阻失败**：模型看到提醒后直接收工。所有信号共享同一个盲点 ——
**都在动手时开口，而伤害发生在收工时**。

另一个更大的问题是**该开口却没开口**：183 个「已上膛」的 turn 里 68 个最终零注入，
其中 60 个整 turn 一条注入都没有（另外 8 个被 A/B 的互斥压掉）。
开口组强转向 10.4% / 有测量 17.4%；未开口组 2.9% / 14.7% ——
**C 开口是有效的（3.6 倍），缺陷是漏开口，不是开口太多。**

### VAL-2 B 的末班车比例更高（69.0%）— SIG

42 条注入、强证据转向 14.3%、末班车 69.0%，同现场重复 0。
B 的判据（同一 `工具|目标|指纹` 在连续失败里重复 N 次）本身很少误报，
但它命中的时机比 C 更晚 —— 连续失败到第 2 次时，模型往往已经在这个 turn 的尾声。

建议**先只加一个面板指标**（B 开口后本 turn 是否还有测量），不动行为。

### VAL-3 A 覆盖窄，且日志无 `dir=` 无法估误报率 — SIG

A 是**唯一开口早、留得住动作空间**的信号：注入 25 条、强证据转向 28.0%、
开口后测量 44.0%、末班车仅 32.0%、同现场重复 0。

但它只能看见「同一个文件改 N 次」。`worstEdits < 3` 的场景占了 C 的 170/181；
其中「改了 ≥3 个文件但每个都不到 3 次」有 48 条（26.5%）—— A 完全看不到多文件铺开式盲改。

**想扩可行域（同目录第二档），但日志里没有 `dir=` 字段，无法估计误报率。**
⇒ 先补日志字段（`dir=` 或 `top=`），跑一周拿到误报基线再动。**不拿 A 做实验。**

### VAL-4 「收工闸」受 pre-step 约束，做不了 — SIG（设计限制）

理想修法是「turn 即将结束时、若本 turn 有 `blindWrites` 且零测量，再开口一次」。
插件挂在 `pre-step` 上，**无法预知当前这次请求是不是最后一次** —— 没有「即将结束」的信号。

替代方案只有跨 turn 升级（IDEA-1）。列在这里是为了说明：末班车问题不是没想过，
是**当前架构下没有干净的解法**。

---

## 五、待验证的阈值调整

三条都在 SIG-1 的结论之下 —— **先搬 session 级，再谈数值**。现在调只会把缺陷换个症状。

| ID | 键 | 现值 | 建议 | 位置 |
|---|---|---|---|---|
| TUNE-1 | `oscillationThreshold` | 3 | 2（clamp 下限） | `lib/index.js:257` |
| TUNE-2 | `patchChainThreshold` | 3 | 2 | `lib/index.js:259` |
| TUNE-3 | `repeatFamilyThreshold` | 4 | 3 | `lib/index.js:254` |

模拟已证明：**在 turn 级记账下，把 O/P 压到 clamp 下限仍然命中 0–1 次**（见 SIG-1 的表）。
所以这三条的前置条件是 SIG-1 落地。

---

## 六、未实现的提案

### IDEA-1 C-3 跨 turn 升级 — 提案

上 turn 的 C 之后，如果既没有测量也没有转向，本 turn 第一次写入前补一句。
估算代价约 **+10% 注入量**（202 条 vs 181 条），收益是覆盖 60 个「上膛但沉默」的现场。

**上线顺序**：单独一个 PR，先只看注入量与末班车比例两个指标，不要与其它改动混在一起。

### DOC-1 F 与 M 未标实验性 — 已关闭（0.3.6）

原文：`README.md:121-132` 只把 **O 与 P** 标成了实验性（`README.en.md:132-142` 同），
但实测 F 只触发 1 次（且是凑出来的，见 SIG-2）、M 的建议人群口径也不稳
（`futile >= 2` 的 10 个 turn 基线 30%，全量 92 turn 是 53.7%）。
`web/index.html:451-462` 面板柱标题只标了 O/P。

**0.3.6 已做**：两个 README 的信号表给 F 加 `*实验性*`，小节标题由「O 与 P 是实验性信号」
改为「F / O / P 是实验性信号」并写清 F 的根因（SIG-2）；`web/index.html` 的 F 柱
与 F 阈值行加「· 实验性」；`assets/stuck-gate/SKILL.md` 在「与插件的信号的关系」里
补了三行说明。M 不改标记，改为在「适用范围与边界」里补一句统计基线不稳的告警。

---

## 七、明确决定不修的

写在这里是为了**下一轮审查不再重提**。

| 候选 | 决定 | 理由 |
|---|---|---|
| 砍掉 C | 不做 | 它是唯一覆盖「多文件铺开式盲改」的信号（占 181 条的 93.9%） |
| 上调 C 阈值 3→5 | 不做 | 实测只压掉 3.9%（7/181），代价是覆盖更窄 |
| 为了让 O/P 有数据而调阈值 | 不做 | 模拟已证明无效，见 SIG-1 |
| 改 A 的判据扩覆盖 | 暂不做 | 日志无 `dir=` 字段，无法估误报率（VAL-3） |
| 删掉 F | 不做 | 等 SIG-2 修完再评估；现在删等于把「错误漂移」这一面永久交给 B |

---

## 八、复现方法

上面的数字全部来自本机真实日志 `~/.dsh/logs/better-debug.log`（252 条 inject / 208 KB / 20 天）
与 `test/fixtures/` 下的样本。复现口径：

1. 按 `turn` 分组所有事件，注入行带 `signals=`，测量行带 `class=` 与 `exitCode=`；
2. **分母**用 `instrumented`（确实带 `inj` 关联的注入），不是全部 inject 行 —— 否则旧日志会失真；
3. **转向**只认 `class` 属于 `verify` / `search` / `method` 的动作，窗口宽度 `changedWindow`（默认 6）；
4. **末班车** = 注入之后该 turn 再无事件。

---

*本文件随版本更新。修掉一条就删一条 —— 留着过期条目比没有更糟。*
