# dsh-better-debug

把「卡住闸门」从自觉条款变成代码闸门。

`AGENTS.md` 里的五条闸门与 `stuck-gate` 技能都是**提示词层**的约束——模型得先想起
「我卡住了」，条款才开始生效。可卡住时的典型症状恰恰是**想不起来**：于是它写第 3 个
「再试一次」、吃第 4 遍同一个报错、改完代码不跑任何验证。这个插件不看模型说了什么，
只看它做了什么；一旦行为符合「原地打转」，就在**下一步之前**塞一句话进去。

## 三个信号

| 信号 | 触发条件 | 默认阈值 | 为什么是它 |
| --- | --- | --- | --- |
| **A** 同一文件**连续盲改** | `fs/write-intent` 按绝对路径计数；**一次 verify 到达即清零** | 第 **3** 次 | 单点反复摩擦且中间夹不进新事实，才是最典型的「没建回路就在猜」 |
| **B** 同一报错反复吃 | `tool/result` 错误指纹去重计数，且本 turn 未搜过 | 第 **2** 次 | 同一个错两次说明第一次没读懂；且补了「该搜没搜」 |
| **C** 改完不验证 | 最后一次写入后已过 N 步，这期间既没验证也没搜 | **2** 步 | 「改完就跑下一个」是最常见的漏验证 |

错误指纹做了归一化：`0x1f3a2b9c` → `<hex>`、`C:\Users\...` → `<path>`、`42` → `<n>`，
所以「行号变了但异常类没变」仍算同一个错。

**搜索类工具**（命中即视为获取了外部先验，B 与 C 同时解除）：
`web_search` `research` `advanced_search` `multi_search` `platform_search`
`domain_search` `cache_search` `video_search`

**验证类工具**（A 的连续盲改计数清零、C 解除）：
`ops_bash` `lsp_diagnostics` `verify` `run_tests`。

> 「清零」是有意的：词数 725→664→601→591 这种**每改一次就跑一次测量**的收敛，
> 数字朝目标单调走、每步都有新信息，属于有回路的迭代，不是原地打转。
> 旧版把累计编辑次数当 A 的判据，会在这类任务上误报（`decayEditsOnVerify: false` 可退回旧行为）。

## 不做的事

- **不做「我猜是」措辞检测**：插件看不见模型的内心独白，这条留给 `stuck-gate` 技能自检。
- **不做收尾探针清零**：归 `dsh-turn-cleanup`。
- **不用 `reject`**：那会把整个 turn 变成 no-op。只往 `messages` 尾部追加一条 user 消息。
- **不对子会话生效**：`header.origin === 'subagent'` 或 `delegationDepth > 0` 一律跳过，
  它们的 cwd 可能是别人的工作区，计数也没有可比性。

## D 段例外

`AGENTS.md` 的 D 条：用户显式说「别搜了 / 直接改 / 快速试一下」时闸门不落。
插件用**本 turn 用户原话**实现这条——命中 `/别搜|不要搜|不用搜|先别搜|直接改|快速试|别折腾|先试试/`
就整 turn 静音。只认 `source.kind === 'user'` 的消息，插件自己注入的不算。

## 幂等

每条信号每个 turn 最多一次；且**上一次提醒之后必须出现新事实**（多写一次文件、多吃一个错）
才会再次开口。两个条件缺一不可——否则模型每多跑一步就被念一遍，turn 永远结束不了。

A/B 触发时会顺带把 C 标成已触发：A/B 已经说明了局面，再补一句「改完没验证」只是换个说法。

## 触发前置（v0.1.2）

闸门只管「下一次尝试之前」，不管「交完货之后」。命中信号也先过三道前置：

1. **done-state**：本 turn 出现过 `present`（交付物已挂出）且之后没有新的写入意图 → **不注入**。
   写一行 `suppress … reason=done`。下一次 `fs/write-intent` 会把 done 复位，闸门重新武装。
   关掉：`doneOnPresent: false`。
2. **有进展的收敛**：见上表 A 的清零规则。关掉：`decayEditsOnVerify: false`。
3. **任务类型**：写作 / 词数校准 / 版式收敛没有报错与失败测试，回路是一条能给出数字的
   校验命令（词数、段数、checklist 断言）；注入文案已改成任务中立，收尾退化为数字复核 + 清场。

边界：代码层只能认 `present` 这个动作。**纯文本终稿（没有 `present`）** 只能靠
`stuck-gate` 技能里的 done-state 自检覆盖——两层互补，别指望插件读模型心思。

## 响应协议（提示词层，`stuck-gate` 技能）

闸门触发后，把验证 / 搜索 / 清场 / 上下文压缩**静默一次性跑完**，期间不输出终稿措辞，
全部结束后给**一个**结论。禁止「结论 → 一串工具调用 → 又一句结论」的倒挂。
`[better-debug]` 只是提醒，不需要先用文字回应它。

## 自带技能

插件包内含 `assets/stuck-gate/SKILL.md`，通过 `inject: ["skills"]` 注册成 **bundled 技能**
（`source: "bundled"`，`rank: 600`）——装完就出现在模型可见的技能目录里，不需要另外拷贝文件。

注入的那句提醒末尾写着「完整五条：skill `stuck-gate`」，指的是这一份。

**rank 关系**（数值小的优先）：

| rank | 来源 | 谁说话 |
| --- | --- | --- |
| 100–200 | 项目级 `.dsh/skills`、`.agents/skills` | 项目覆盖 |
| 300 | `custom` | |
| 400 | `~/.dsh/skills`（用户全局） | **用户自己放的会压过本插件** |
| 500 | `~/.agents/skills` | |
| 600 | 本插件 `assets/` | 默认文案 |

所以想改闸门措辞**不必改代码**：在 `~/.dsh/skills/stuck-gate/SKILL.md` 放一份就自动生效。
改插件里的那份则对所有安装者生效（改了 `assets/` 下的文件，`get()` 每次重读，无需重启）。

宿主若没有 `skills` 服务（老版本 DSH），注册会被跳过并记一行日志，**闸门本身照常工作**。

## 增益面板

日志只有一种人爱读，就是写它的人。面板把它变成一眼能看的东西：**设置页 → better-debug**，
一个 iframe 视图，5 秒自刷新，只读，不改插件行为。

三张主卡：

| 卡 | 数据来源 | 能说明什么 |
| --- | --- | --- |
| 闸门触发次数 | 每条 `inject` 行 | 提醒一共说了几次，按 `A/B/C` 与组合标签分组 |
| 覆盖会话 | `inject` 行的 `session=` 去重 | 影响了多少个会话、多少个轮次、注入文本总共多少字符 |
| 注入后模型换动作 | `outcome` 行的 `class=` | **唯一的客观效果指标**：提醒之后那条 `tool/call` 是转去验证/搜索，还是继续改 |

它同时暴露一件事：**没有 `outcome` 行时，「换动作」是空的**。面板不会替你编一个百分比。

### 为面板新增的埋点

注入之后，插件等**第一条**后续 `tool/call`，写一行：

```
outcome session=… turn=39 after=C first=ops_bash class=verify steps=1
```

- `after` 是触发它的那次注入的信号标签；
- `first` 是模型真正做的下一件事，`class` 归为 `verify` / `search` / `edit` / `other`；
- `steps` 是隔了几步才出手（`0` 表示下一步就换）。

只收第一条：晚到的验证不能把早先的原地打转洗白。

`inject` 行同时补了 `chars=`（注入正文的字符数），面板上的「单次注入开销」由它算出来。
老日志没有这个字段，解析器按信号组合回填（`A=254` / `B=268` / `C=256` / `A+B=307` 字符）。

### 面板的三条自我约束

1. **每个数字都是数出来的。** 触发次数、覆盖会话、信号分布逐行来自日志；注入开销来自 `chars=`。
2. **「换动作」只算有 `outcome` 的那几次。** 分母是「已被观察到的注入」，不是全部注入。
3. **不估算「省掉了多少 token」。** 那个数字要先假设「模型本来会失败、会多绕一圈」，
   属于编数。插件的职责是把可观测的事记下来，把判断留给看的人。

### 关掉面板

`config: { panel: false }`。路由不挂，`/better-debug` 返回 404，闸门不受影响。

路由用 `ctx.inject(['webServer'], …)` **动态注入**，没有加进 `export const inject` ——
后者是结构性变更，会让热重载失效，也会让没有 `webServer` 的宿主连闸门都装不上。
宿主缺 `webServer` 时日志写一行 `panel unavailable: …`，其余功能照常。

## 安装

**快装（从 Release tarball，pnpm 会把它当普通包装进 profile）：**

```bash
dsh plugin add https://github.com/Leonlee114514/dsh-better-debug/releases/download/v0.1.2/dsh-better-debug-0.1.2.tgz
```

（这个包**没有**发到 npm registry，所以 `dsh plugin add dsh-better-debug` 会 404；
要么用上面这条 tarball URL，要么手动 link，见下。）

**手动 link（要改代码就用这个）：**

```bash
# 1. 放到一个你长期保留的位置。别放临时目录，也别放 node_modules 里
#    （下面以 ~/dsh-plugins/dsh-better-debug 为例，换成你自己的路径即可）
mkdir -p ~/dsh-plugins
cp -r dsh-better-debug ~/dsh-plugins/

# 2. profile 里加 link 依赖
cd ~/.dsh/profiles/desktop
# package.json → dependencies 加一行（路径相对 .dsh/profiles/desktop）：
#   "dsh-better-debug": "link:../../../dsh-plugins/dsh-better-debug"
# 也可以直接写绝对路径：
#   "dsh-better-debug": "link:D:/code/dsh-better-debug"
# package.json → dsh.profile.bundles 数组末尾加：
#   "dsh-better-debug"

# 3. 让 bundle patch 挂上（如果 bundles 已含它，dsh 会自动 apply 包内的 cordis.patch.yml）
#    或者在自己的 profile cordis.patch.yml 里手写一行：
#      - id: better-debug
#        name: dsh-better-debug
#        inject: [skills]
#        config: { enabled: true }

# 4. 重启 DSH。inject 里多了 skills 属于结构性变更，HMR 未必能生效。
```

面板不需要额外的 inject：它用动态注入挂路由，`export const inject` 一直只声明 `skills`。
想看面板就打开 **设置 → better-debug**，或直接访问 `http://<web-origin>/better-debug`。

## 配置

```yaml
- id: better-debug
  name: dsh-better-debug
  inject: [skills]
  config:
    enabled: true
    repeatEditThreshold: 3      # A：同一文件改几次算打转
    repeatErrorThreshold: 2     # B：同一类报错几次算打转
    noVerifySteps: 2            # C：改完几步没验证算打转
    decayEditsOnVerify: true    # A：一次 verify 到达就清零连续盲改计数（false = 旧行为）
    doneOnPresent: true         # present 后休眠闸门，下一次写入重新唤醒（false = 旧行为）
    logFile: ""                 # 绝对路径；空 = 不落盘（ctx.logger 只进 stdout）
    panel: true                 # 挂 /better-debug 只读面板；false = 不挂路由
```

调紧（更容易触发）→ 数字调小；放松 → 调大。`enabled: false` 时连 listener 都不注册。

## 怎么验证它真的在工作

1. `logFile` 设成一个绝对路径，比如 `~/.dsh/logs/better-debug.log`（Windows 写 `C:/Users/<you>/.dsh/logs/better-debug.log`）。
2. 加载即有一行 `apply pid=… logFile=… A=3 B=2 C=2`——**这一行是唯一能证明「插件到底加载了」的证据**
   （`ctx.logger` 只进 Electron stdout，事后 grep 不到）。没有 `apply` 行就是没挂上。
3. 正常干活，日志出现这样一行即为命中：
   ```
   inject session=… turn=32 step=98 signals=A chars=254 files=1 worstEdits=3 worstStreak=3 worstErrors=0 searched=false
   ```
   `signals` 是命中的信号（`A`/`B`/`C`，多条用 `+`）；`files` 是本 turn 碰过的**不同文件数**、
   `worstEdits` 是累计改了几次，**`worstStreak` 才是 A 真正用的判据**（自上次 verify 以来的
   连续盲改次数）。三者混着看：`files=1 worstEdits=3 worstStreak=1` 说明中间夹过测量，不该响。
   `suppress … reason=done` 表示闸门醒着但处于交付态，故意不出声。
   紧接着还会有 `outcome` 行（见「增益面板 / 为面板新增的埋点」）。
4. 自证指标：注入后**下一个** `tool/call` 的类别有没有变。
   `edit → edit` 说明它被无视了；`edit → lsp_diagnostics / web_search / 读新文件`
   说明提醒有效。持续低于 30% 就该改文案或阈值，而不是加更多信号。
   **这一项现在由插件自己记**（`outcome` 行），不用手工比对；面板把它算成「换动作率」。

## 本地验证

```bash
node --check lib/index.js && node --check lib/panel.js && node --check client.js
node test/sim.mjs      # 19 个用例：闸门行为
node test/panel.mjs    # 19 个用例：日志解析、聚合、注入开销、埋点落盘
npm run verify         # 上面全部
```

`test/sim.mjs` 用假 ctx 复刻 agent-loop 的调用顺序（`emitPlain` / `emitWaterfall` /
`emitSerial`），覆盖 **19 个用例**：A/B/C 各一条正例与反例、幂等、D 段静音、子会话跳过、
阈值可调、`enabled:false`、自带技能注册（含正文可取与已去私有化）、宿主无 `skills` 服务时不抛、
导出形状，外加 4 条 v0.1.2 回归——编辑间有测量不响 / 关掉清零仍响 /
`present` 后不响 / 关掉 done-state 仍响（两条反向用例保证开关可回滚）。
**不依赖 DSH 运行时**，改动后先跑它。

`test/panel.mjs` 覆盖 **19 个用例**：带引号与转义的字段切分、三种行型解析、`worstStreak` 在日志→解析→聚合→面板全链路保留（A 的判据可见）、`suppress` 行可解析且不计入触发（交付态静默可观测）、缺 `chars=` 的
回退、分布与会话去重、阈值取最后一条 `apply`、`estimate` 只剩实测的注入开销、
空日志与坏行不抛，
以及一条端到端——真跑 `apply()` 走完一个 turn，读回日志断言 `inject` 与 `outcome`
两行都写了、且聚合把它算成「换了动作」。同样不依赖 DSH。

## 已知边界

- 「同一文件」按**绝对路径**判定。删了重建同名文件也算同一处——这通常是对的（说明在同一个
  概念上打转），但如果只是反复改生成文件，把 `repeatEditThreshold` 调大或换个检查点。
- `done-state` 认的是 `present` 调用，不是「模型说了一句收尾话」。纯文本终稿靠
  `stuck-gate` 技能的 done-state 自检兜底；若某类任务从不调 `present`，把
  `doneOnPresent: false` 关掉更省心。
- 清零判定只看**工具名**，看不懂 `ops_bash` 里跑的是 `npm test` 还是 `ls`（沿用 C 的既有取舍）。
  宁可把「夹了一次 `ls`」当成一次测量而漏报，也不误伤有回路的收敛。
- `useVerifying` 只看工具名，看不懂 `ops_bash` 里跑的是 `npm test` 还是 `ls`。
  宁可漏判也不误判成「已验证」。
- 只在**主会话**生效。多 agent 场景下每个 subagent 各自打转不会被拦——但它们的产物最终
  汇到 lead，lead 这边的计数仍然有效。
- 面板是**只读的日志视图**，不是监控：它不写任何数据，也不改变闸门判定。`logFile` 为空时
  面板只剩「未配置 logFile」，一切统计为 0。
- 面板的 `changedRate` 分母是「已被观察到的注入」。注入后 turn 直接结束（没有后续
  `tool/call`）不计入，因此样本少时这个百分比波动很大——看量级，别当 KPI。

## License

MIT
