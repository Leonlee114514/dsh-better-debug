# 变更记录

本文件记录 **dsh-better-debug** 的每一次已发布变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

> **关于 0.3.5 之前的部分**：本文件从 0.3.6 起才存在，更早的版本由 git 历史回补（20 个 commit / 16 个 tag）。回补时只记录**用户可观察的行为变化**与**根因**，不记录内部重构；每条根因都来自当时 commit message 的实测记录，不是事后追述。

版本节奏提醒：0.3.0 → 0.3.5 在两天内连发 6 个版本，全部是深审挖出的缺陷。0.x 阶段的次版本号可能包含行为改变，升级前请看一眼对应小节。

---

## [未发布] — 0.3.6

主题：**把「只在特定形态下才坏」的四类缺陷补上回归测试**，并第一次让 CI 承担发布。

### 修复

- **指纹正则二次爆炸（性能 P0）**：`EXC_TYPE` 的惰性量词加 `\b` 在单条超长行上逐列回溯，40 KB 的 hex dump 单行要 2.4 s，10 万字符 18.7 s —— 每一次工具输出都付这个代价（`failureSetOf` 在同一个 turn 里被调用多次）。改成左边界 `(?<!\w.)` 加名字长度上限 64，10 万字符降到 2.0 ms，12 例判定与旧正则逐条一致。
- **pytest 进度行同样爆炸**：`PYTEST_PROGRESS` 的 `^\S.*?\s+` 改成 `^\S+\s+`（路径里不会出现空白），4 万空格单行 13.45 s → 0.4 ms。
- **盘符根洗白整盘盲改（逻辑 P0，两侧都修）**：命令里出现任何 C 盘根下的文件（连 `npm test -- C:/a.ts` 都算），`dirOf` 只能剥出 `c:`，而 `c:` 作为前缀能匹配整个 C 盘 —— 一次测量把 4 条 streakEdits 清到 1 条，C 信号在 C 盘上几乎失效。新增 `dirOfMatch()`（末段含 `.` 才按文件算、否则按目录算，误判方向取「少清一层」）+ `BARE_DRIVE` 守卫（settler 里对 `c:` 只做精确匹配）。注意 `BARE_DRIVE` 必须带 `i`：`normDir` 在 win32/darwin 折小写、linux 变体不折，写成 `/^[a-z]:$/` 会让 linux 变体守卫整条失效。
- **`measureKey` 不读 `args.code`（逻辑 P0）**：PTC 的 `run_code` 把命令写在 `code` 里，而 `measureKey` 只读 `command` / `script_path` —— `{code: npm test}` 与 `{code: cargo build}` 撞成同一个 key `run_code|`，O 把两条完全不同的验证回路当成同一条。`code` 按行 trim + 行内空白压缩（不压跨行空白，否则只差分行的两条脚本又撞 key）。
- **A 在无效测量后重复报同一现场**：`s.fired.A = 0` 原本无条件执行，而紧邻注释自述「失败的测量没带来任何新事实，重新武装等于允许同一现场再喊一遍」。改成 `if (cleared > 0 || dirs.size === 0)` —— 只有真的清掉某些路径才算新事实。端到端复现：同文件改 3 次 → 注入 A → 在无关目录跑一次失败测量 → 再注入一模一样的 A。（`decayEditsOnVerify: false` 时 `cleared` 恒 0，A 因此不再重新武装，符合语义。）
- **B 在补丁链上被完全静音**：`repairChain >= 1` 时既跳过 failEpisodes 循环，又在 splice 闸里被压掉，而 P 要 `repairChain >= patchChainThreshold`（默认 3）—— 四轮「失败→改→仍失败」在默认阈值下只剩最后一条 P，把阈值抬到 10 让 P 永不开口时则**一条注入都没有**。现在第 2 轮照常由 B 开口，第 3 轮交给 P。
- **`QUIET_PATTERN` 误静音（触发前置）**：旧版把 `先试试` / `快速试` / `别折腾` / `不用搜` 裸放进来，实测 8 条**描述性**句子全部命中（「我先试试复现一下」「我快速试一下这个假设」「不用搜索我也知道根因，但我会先跑一遍测试确认」「这个文件我直接改过了」），整个 turn 因此静音 —— 恰好违反本函数自己的注释「误静音比漏静音一次更贵」。收窄为：`不用搜(?!索)`、`直接改(?!过)`、`先试试(?:直接改|改)`、`别折腾了`，删掉「动作快慢」类描述词。7 条祈使句仍静音，9 条描述句不再静音。
- **状态先提交、投递后执行**：`injectionsThisTurn += 1` 与 `lastFireMark` 原本写在 `await deliver(...)` **之前**，投递失败时预算被白吃一格，且 `lastFireMark` 让幂等闸把后续同样局面全部静音。改成投递成功后才提交。

### 修复（算法层：失败身份的稳定性）

- **失败身份被易变读数污染（α）**：`failureItemFingerprint` 对去路径去行号后的剩余文本直接取 sha256，而其中常含耗时、端口、时间戳 —— `AssertionError: boom (took 37ms)` 与 `(took 41ms)` 是两个身份。后果同时击穿 F（错误族）、O（振荡）、P（补丁链）三个集合类信号：每轮都是「新失败」，族永远攒不满、翻转永远数不到、补丁链永远从 1 重启。新增 `normalizeVolatile()`，只归一化**可证明是读数**的形态：IPv4[:端口]、`localhost:端口`、带单位的时长（`ns|us|µs|ms|secs|seconds|mins`）、`duration_ms|duration|elapsed|took|pid|port` 后的数字、ISO 时间戳、`0x` 十六进制。裸数字一律不动 —— `case-1` / `case-2` 这类用例编号仍必须是不同身份（测试里有反例守着）。
- **「解析不出」被当成「没有失败」（β）**：`failureSetOf` 在最坏情况下返回空集，而空集同时意味着两件事：「这次确实没失败」与「我认不出这些失败」。P 的 `shrunk` 判据正是「新集合是旧集合的真子集」，于是一条 `[exit code: 1]`（没有任何可解析失败行）会被读成**大幅收敛**，补丁链由此清零。新增 `FAILSET_OPAQUE` 标记 + `hasFailureEvidence()`（退出码非 0，或跳过滤噪行后仍有 `looksLikeFailure` 的行才判定「确实有失败」）：解析不出又有失败证据时返回带标记的空集，P 与 O 见此一律**什么都不动**。
- **`run_code` 把注释和字符串当管辖目录（γ）**：`measureDirs` 过去对 `args.code` 整段做路径扫描，`import x from './src/a.ts'`、文档 URL、`const p = 'node_modules/jest/bin/jest.js'` 都会被算成「这次测量管的目录」，于是真测量 `cleared=0`、C 永远解不了武装。改成只认 `tools.<name>({ ... })` 调用里的字面量参数：`matchBrace()` 配平取参数对象、`codeCallArgs()` 抽 `command|script_path|file_path|path|workdir` 五个键；`workdir` 本身即管辖目录，其余路径键按 `workdir` 落地；`://` 一律跳过。
- **没有退出码时默认成功（δ）**：测量结算过去写 `ok = isError !== true && (exit === void 0 || exit === 0)`，宿主不给退出码（部分通道、被截断的输出）时一条红输出被记成有效测量，C 立刻重新武装。改为 `exit === 0 || (exit === void 0 && !tailLooksFailed(text))`，`tailLooksFailed()` 只看尾部三条有效行（跳过滤噪行、堆栈帧、`[exit code: …]`），`0 failed/failures/errors` 或有 `passed` 且无 fail 词时判成功。**有退出码时一律以退出码为准** —— 真机 388 条无退出码测量里 128 条，其中 pwsh 的 95 条确实是成功，宽口径会把它们全打成失败。

### 变更

- **CI 承担发布**：`.github/workflows/ci.yml` 新增 `v*` tag 触发与 `publish` job —— tag 与 `package.json` 版本不一致直接 `::error::` 失败；发布前在**解包后的 tarball 内**再跑 `test/sim.mjs` / `test/panel.mjs` / `test/client.mjs`（克隆仓库里 `test/` 一定在，所以包内自测是唯一能发现 `files` 白名单漏项的方式）；`npm publish --provenance`（需 `id-token: write`）。
- `judge-health` 的**全 SKIP 不再算健康**：全部判据都 SKIP 时 exit 1（过去走 exit 0，而它被 `test:unit` 用 `&&` 串在最后，等于把「没测」记成「测过了」）。部分 SKIP 仍 exit 0。
- 文档对齐代码：apply 示例 `C=2` → `C=3`（`noVerifyWrites` 默认 3）、用例数 298 → 345、删除「归一化数字」这一过时说法（0.3.3 起保留裸数字；0.3.6 起另行归一化**读数**，见上文 α）。

### 测试

- 298 → **345**（sim），新增 47 条断言，按缺陷类别分：A/C 互斥 2 条、PTC 解除武装 6 条、盘符根守卫 5 条、`measureKey` 读 `code` 4 条、超长单行性能 3 条、A 重新武装 3 条、QUIET 两侧 2 条（各含 7 / 9 个用例）、补丁链 B 开口 2 条、`run_code` 测量口径 4 条、失败身份归一化 7 条（含 3 条反例：用例编号 / 断言字面量 / vitest 述语里的序号必须仍是不同身份）、空集≠未知 6 条、`run_code` 管辖范围 1 组（8 个形态）、无退出码判定 2 条。
- 首次覆盖 PTC（`run_code`）测量路径。
- δ 的两条用例必须跑满「攒 3 次盲改 → 测量 → 再攒 3 次」才有判别力：少任何一段都看不出 C 有没有被重新武装，早期版本因为只造了 2 次编辑而假绿。

---

## 0.3.5 — 2026-11-27

### 变更

- **C 从「数步数」改成「数盲改次数」**：配置键 `noVerifySteps` → `noVerifyWrites`，默认 2 步 → 3 次。旧口径把「读三个文件」也算成盲改，而读文件本来不该被催。
- **路径方言归一**：Git Bash / MSYS 的 `/c/work/...`、WSL 的 `/mnt/c/work/...` 与 `C:/work/...` 现在归一成同一个目录，跨方言的测量能清掉对应的盲改计数。
- **日志轮转**：新增 `logMaxBytes`（默认 2 MiB，范围 64 KiB–64 MiB）与 `logKeep`（默认 2，范围 1–9）。过去日志只增不减，长期使用会无界增长。

### 修复

- **面板鉴权（安全）**：`/better-debug/api` 走 prefix 路由时**没有经过宿主的准入闸**。本机 dsh web 经 `@linxin666/dsh-remote-web-ui` relay 暴露到公网后，`https://<instance>.dsh-market.com/` 返回 401，而同 origin 的 `/better-debug/api` 返回 200 —— 泄漏真实会话 id、工具报错原文与日志绝对路径。新增 `createRequestGate(ctx)`（每次请求才查 `ctx.get(connection)`，注册时缓存会永久拿到 `undefined` 并静默退化成恒放行），判据完全交给宿主的 `connection.requestRejection(req)`；另加 CSP（收到最紧）与 `nosniff`。

### 测试

- 98 → **298**：补齐面板解析、鉴权闸、日志轮转、路径方言四块。

---

## 0.3.4 — 2026-11-25

### 修复

第三轮深审，五处解析缺陷，核心是**「诊断行必须先分类再进集合」**。补丁式加正则会把同一行在不同层判成不同东西：目标层认得（因为正则写在 `errorTargetOf` 里）、身份层不认得（`failureItemFingerprint` 走的是另一条分支），于是「同一个错」被算成「换了个错」。

### 测试

- 89 → **98**（0.3.3 上 89/98）。

---

## 0.3.3 — 2026-11-25

### 修复

第二轮深审，四处缺陷：

- **失败身份把源位置当语义**：`failureItemFingerprint` 原先对整行取指纹并保留全部数字，`src/a.ts(12,9)` 与 `(13,9)` 成两个不同失败 —— 编辑一行就看似换了个错。改成结构化：先定位路径、只在位置紧跟路径时切掉位置（tsc `(12,9)`、go/rust `:12:29`、Python `", line 10, in test_case"`、jest `: line 12`），剩余消息取指纹。**消息里的数字一律保留** —— 0.3.0/0.3.1 的全量数字归一化把这条路走反了（`case-1/2/3` 归一后成同一条）。
- **Python 栈帧顶替异常消息**：`failureSetOf` 只排除 JS 的 `^at\s`，于是 `File "...test_a.py", line 10, in test_case` 进集合、`AssertionError: case-one` 反被「有路径行就只用路径行」丢掉 —— 两个不同断言只要共用栈帧就成了同一条失败。新增 `isFrameLine()` 覆盖 JS / Python / pytest / Rust / 源码片段五形态，栈帧**只贡献目标、不进条目集合**，紧跟栈帧的原始缩进回显行跳过。
- **O 比整集合相等**：改成存最近 4 次失败集合，当前集合与其中任一次有**条目交集**即算复发。原来 `{A}→{A,B}→{A,C}→{A,D}` 十轮零注入；`{A}→{B}` 仍不算，无写入的纯测量变化也不算。
- **通用幂等闸漏掉「同一失败又失败一次」**：闸只比 `writeSeq` / `errorSeq`，而「`npm test` 又失败一次」两者都不动。新增单调 `failSeq`，`lastFireMark` 与提前返回改比三项。

### 测试

- 79 → **89**（0.3.2 上 82/89）。

---

## 0.3.2 — 2026-11-25

### 修复

深审六处状态机缺陷：

- **M 被幂等闸吞掉**：M 上移到通用幂等闸**之前** —— futile 增长期正是「什么都没变」的时候，幂等闸会把 M 挡在门外。
- **失败测量无人接管**：新增 `fresh().failEpisodes`（`isError: false` 的测量失败从不进 `s.errors`，P 的 unchanged 清链后没人接手，同一个失败一字未变能重复八轮零注入）。记账放 `settleMeasure` 不放 `tool/result`；B 的搜索免疫改成计数基线 `searchBaseline`。
- **P 说错事实**：`unchanged` 改成清链而不是暂停（`A→A→B→C` 曾被说成「连续 3 轮」）；`movedSite` 改成比本 turn 见过的所有目标（`A→B→A→B` 曾每轮当换现场清零）。
- **O 被无关 warning 绕过**：改用失败条目集合身份 `failureSetKey`（整段输出指纹会被无关 warning 改写），新增 `failureItemFingerprint`。

### 测试

- 73 → **79**。

---

## 0.3.1 — 2026-11-25

### 修复

**P / O / F 三条判据在健康路径上误报**，加 `errorTargetOf` 只认 V8 一种方言：

- **P 只看写入序号、不看失败是否同一个**：收敛中的 lint 清扫（10→9→8→7）、同一错一字未变、逐个修独立文件，三种健康形状全中招。改比「失败条目集合」（目标|指纹）：严格变小＝收敛、一字未变＝没推动、换文件＝换现场，后两者不计数（宁可漏判）。
- **`errorTargetOf` 只认 V8 栈与带引号绝对路径**：tsc / cargo / pytest / go / mypy 的相对路径全返回空串，四个无关项目被 F 报成「同一目标 4 种报错」。改成「绝对路径 / `./` + 源码扩展名白名单」两段式，`stripLocators` 统一剥 `::测试名`、`(12,9)`、`:12:29`、尾部裸冒号，分隔符同时认 `/` 与 `\`；抽不出目标不建族。
- **O 的静音记在全局 `s.fired.O` 上**：任何新回路首次 ok 都解除，step 12/13 的文案逐字相同。改记在 `series.announced`。
- **F 的搜索免疫比族的 `firstClock`**：一次搜索终生免责。改比 `lastNewClock`。

### 测试

- 65 → **73**（0.3.0 上 66/73）。

---

## 0.3.0 — 2026-11-25

### 新增

**方案层三个信号与元闸门，七信号成型。** A/B/C 只看「动作在重复」，盲区是**每一步都合规、整条路是死的**。

- **F（错误族）**：按 `工具|目标` 聚族，**故意不带指纹** —— 同一文件四种不同报错才说明方向错了。族内不同指纹 ≥ 3 且总数 ≥ 4 才开口。
- **O（振荡，实验性）**：判据是近期失败指纹 FIFO（容量 4）的集合，不是「颜色变了」。挂在 `measureSeries` 每个 key 上而非 turn 级 —— 全局计数会把健康的 TDD（每轮换失败用例）算成来回推。
- **P（补丁链，实验性）**：失败后有新写入才算一轮，连续 3 轮才开口。
- **M（元闸门）**：注入后窗口内既无测量也无搜索 → `futile + 1`，累计 2 次开口。独立路径、不占 `maxInjectsPerTurn`、每 turn 一次、文案独立（不复用普通模板，否则会被读成第四条普通提醒）。

### 设计决定

- **O 不按 ok 重新武装**：振荡里每隔一次就是 ok，按 ok 归零等于每次翻转都重说一遍（实测一个 turn 连发三条 O）。只在 flips 清零时重新武装。
- 未实现规格可选项 `flip` / `chain` 日志行（无面板消费者）。

### 测试

- 46 → **65**（panel 48 → 62）。

---

## 0.2.6 — 2026-11-21

### 修复

- 面板在**亮色模式下仍然是黑的**：主题变量缺失，纯前端问题。

---

## 0.2.5 — 2026-11-14

### 修复

- **测试用固定 sleep 等日志落盘，慢盘上必然红**（CI run 43592444353：`FAIL 埋点：测量结果行写出 ok/exit/cleared（失败也是测量）— no measure line`，38/40）。正确的假设是「不是埋点坏了，是读早了」—— 插件用 `void record(...)` 刻意不 await，「写完了没有」在测试里永远是竞态。改成轮询等待。

---

## 0.2.4 — 2026-11-14

### 修复

- **断言自己沾了本机平台**：0.2.2 的断言把 `CASE_INSENSITIVE` 折叠结果写死，真机 Ubuntu 上 sim 三格全红（44/46）。正确的假设是「断言测的是『Windows 上通过』，不是『路径被正确识别』」。根因是 `test:posix` 只换 `node:path` 不伪造 `process.platform`，posix 轮里 `CASE_INSENSITIVE` 仍为 true，那条分支永不执行 —— 本机全绿、CI 全红。新增 `test/linux/register.mjs` 用 `defineProperty` 覆盖 `process.platform` getter（不碰 path 模块），两轴分开。

---

## 0.2.3 — 2026-11-14

### 修复

- **面板横幅按「这一代」判**：过去红条长期显示「插件当前被关闭」而页面实测 200 —— `aggregate()` 对整份日志累加 `disabled` / `skill-failed` / `panel-failed`，index.html 用全量数判红，11-07 的 4 条历史 `panel register failed` 永久染红。改为 `aggregate` 维护世代计数 `current`（遇 `apply` 或 `disabled` 行重置），横幅只读 `log.current`，历史数写页脚；无 `current` 的老 API 退回全量口径并明说可能误报。
- API 版本 2 → 3。

---

## 0.2.2 — 2026-11-14

### 修复

两个「本机看不到」的误报/漏报（过拟合审计挖出）：

- **ESM 栈的目标塌缩**：真实栈是 `file:///C:/Users/.../a.mjs:12:29`，路径正则先撞 scheme 里的 `e:` → `errorTargetOf` 返回 `"e:///c"`，三个不同文件塌成一个 episode；且路径里每个数字被归一成 `<n>`，`a1.js` 与 `a2.js`、`proj1/` 与 `proj2/` 也塌。新增 `stripFileUrl()` 先剥 URL 头；归一化只剥末尾 `(:\d+)+$`。
- **`measureDirs` 把 `cd <dir>` 当文件取父目录**：`cd /home/u/projB && npm test` 被剥成 `/hom…`，A 漏报。

---

## 0.2.1 — 2026-11-14

### 修复

- **版本范围写在没人读的位置**：`engines.dsh` 原本嵌在 `dsh.engines.dsh` 里，而宿主 `dsh-app-boot` 的 `unmetRequirements()` 读 `fields.engines.dsh`、市场 `dshmarket/lib/verify.js:252` 读 `manifest.engines?.dsh` —— 嵌套写法恒 `undefined`，恒被视为满足，旧宿主既不拦也不提示。实测：顶层 `engines.dsh = ">=9.0.0"` 被拦，嵌套不拦。改为顶层写法（与 `dsh-file-explorer-kit`、`dsh-workspace-kit` 一致）。

### 测试

- 37 → **40**。

---

## 0.2.0 — 2026-11-14

### 变更（语义修正 —— v0.1 的验收面在说谎）

- **A** 从「累计编辑」改成「同一文件连续盲改」：一次测量到达就清零，`decayEditsOnVerify: false` 可回滚。
- **B** 从「全局错误计数」改成「错误 episode」：key = `工具|目标|指纹`，某个 episode 之后搜过才免发，不再因为搜了无关问题就永久闭麦。
- **C** 从「步数闹钟」改成「下一次写入前的闸门」：N 步没测量只上膛不提醒，准备再写时才开口 —— 阅读不该被打断。
- **工具的「发起」不再等于「测量完成」**：`fs/write-intent` / `tool/call` 只记账，`tool/result` 回来才结算并记 exitCode / 类别 / 关联目录。**失败的测试仍算有效测量**。
- `ops_bash` 按命令判，不再一律当验证：`ls` / `cat` 不清零，`npm test` / `pytest` / `lsp_diagnostics` 才清，且只清它实际作用到的目录。
- 每个卡住 episode **提醒一次**（不是每信号每 turn 一次），有效测量后重新武装，配 `maxInjectsPerTurn` 每轮预算。
- `present` **成功返回**才进交付休眠（发起即休眠会让失败的 present 也关闸）。
- 生成物 / 锁文件 / 日志默认排除。

### 修复（可移植性 —— 新用户从市场装完就该能用）

- **`node:path.isAbsolute` 是平台相关的**：Linux/macOS 上所有 `C:/...` 写入被静默丢弃，A/C 完全失效。改用自有 `isAbsPath()` 同时认两种方言，并加 `test:posix` 一轮。
- **默认 `logFile: ""` 不落盘**：装完面板四张卡全 0，像插件没工作。默认改落 `$DSH_HOME/logs/better-debug.log`，支持 `~/`，写不进只 warn 一次并说明代价。
- **静态 `inject: ['skills']` 会让插件永不启动**：宿主缺该服务时 `Fiber._refresh()` 直接不执行 `apply()` —— 无报错、无日志、面板里看着装好了。改成 `inject = []` + `ctx.inject` 动态订阅；client 侧同理（且 client 必须 `inject: ['slots']`，动态 facade 取属性即抛）。
- **面板路由重复抛 `duplicate prefix route`**：热重载时靠 `Symbol.for` 槽位先摘旧路由自愈。
- **`.gitattributes` 强制 LF**（tag 打在 `f1e8b77`）：GitHub Actions Windows runner 的 `core.autocrlf=true` 会 checkout 出 CRLF，而市场 `dshmarket/lib/hot.js` 的 `scanPatch()` 用 `#.*$` 剥注释匹配不到行尾 `\r` → patch 被判「含 config 或表达式行」→ 拒绝热挂载。验证：无 `.gitattributes` 新克隆 CRLF=52；加后 CRLF=0、37/37 passed。这条**不只影响 CI，所有 Windows clone 后 `npm pack` 发出去都会坏**。

### 修复（同批，tag 之后补的三个）

- `test/posix/register.mjs` 具名导入 `registerHooks` 在 node 20 上加载期 SyntaxError，`typeof` 回退分支没有执行机会 → 改 `import * as nodeModule` 再解构。
- 默认日志文件名 `${name}.log` = `dsh-better-debug.log` 与全部文档写的 `better-debug.log` 不一致，测试因 `endsWith` 后缀匹配一直绿 → 新增 `DEFAULT_LOG_NAME`。
- `DSH_HOME` 是相对路径时日志落到进程 cwd → `resolveLogFile` 里对 home 做 `resolve()`。

---

## 0.1.2 — 2026-11-14

### 变更

- A 改为**连续**盲改计数（此前是累计编辑数）。
- 新增**交付态休眠**：`present` 成功后闸门静音，下一次写入唤醒。
- 安装文档脱离 `local-pkgs`（改走市场 / 手动 link）。

---

## 0.1.1 — 2026-11-07

### 新增

- 只读**增益面板**与 outcome 埋点。

### 变更

- 去掉 token 折算 —— 那需要假设「本来会失败」，属编数。面板上每个数字都必须能从日志逐行数出来。

---

## 0.1.0 — 2026-11-07

### 新增

- 初版：把「卡住闸门」代码化，A / B / C 三信号 + 行为证据判定，不调 LLM、不改 agent loop、不解析模型输出。

---

## 更早

- `0.0.0-stage`（npm 上的占位版本，无对应 tag，无功能）。
