# dsh-better-debug

面向编码场景的卡住检测插件（DeepSeek Harness / Cordis）。插件订阅 agent 的事件流，
以**可复现的行为证据**判断模型是否陷入无效迭代，并在下一次模型请求之前注入一条
结构化观察与恢复建议。它不读取模型的语言内容，不调用 LLM，不修改 agent loop。

## 一个最小示例

下面是一段真实可发生的事件序列：每次修改都有验证，每次失败都不相同，
但模型始终在同一组互相破坏的修改之间往返。

```
改 A → npm test（红：断言 B 失败）
改 B → npm test（绿）
改 A → npm test（红：断言 B 失败）   ← 同一失败在绿过之后复发
改 B → npm test（绿）
改 A → npm test（红：断言 B 失败）   ← 第 2 次翻转
改 B → npm test（绿）
改 A → npm test（红：断言 B 失败）   ← 第 3 次翻转，触发 O
```

在下一步之前，插件向消息序列追加一条用户消息：

```
[better-debug] 观察到的重复动作（只是观察，不是结论）：
- 同一组验证的结果已经在通过和不通过之间翻转了 3 次，每次翻转之间都有修改。
下一步先做其中一件，拿到新事实再继续改：
1) 修改在把问题来回推：先固定一个当前为红的用例，只做让它变绿的最小改动，其余改动先撤下；如果两次修改互相破坏，说明它们共享一个错误假设，先写出这个假设再动。
恢复条件：拿到一条新的测量结果或一条外部事实后，继续动手即可。
完整五条：skill `stuck-gate`。
```

同时落一行可 grep 的日志，供事后审计与面板统计：

```
inject session=… turn=1 step=19 signals=O inj=e7db4417 chars=235 tokens=204 files=2 worstEdits=5 worstStreak=0 worstErrors=0 searched=false measured=yes:ops_bash:fail
```

## 问题与方法

「卡住时应当停下来建立反馈回路」这类约束通常写在系统提示或技能文件里，属于
**自觉条款**：模型必须先意识到自己卡住，条款才会生效。而卡住的行为特征恰恰包括
这种自我监测的失效——模型会持续写下第 N 次「再试一次」。

本插件把其中**能够由事件证明**的部分从提示词层移到代码层，遵循三条原则：

1. **只看行为，不看语言**。全部判据是事件计数、路径匹配与字符串归一化，
   不解析 assistant 文本，不做语义或 LLM 判定。每个判定都可用同一段事件序列复现。
2. **只陈述观察，不下诊断**。注入文本以「只是观察，不是结论」开头，
   给出可数的事实（几次、几种、几轮）与至多两条恢复动作，并附恢复条件。
3. **证据成本不对称，宁可漏报**。正常迭代被误打断的代价高于少提醒一次，
   因此每个信号都配有明确的反例（见下文与测试用例）。

## 信号模型

七条信号分三层。战术层检测**动作重复**；方案层检测**动作变化但方向不变**；
元层检测**干预本身失效**。

| 层 | 信号 | 行为证据 | 默认触发条件 |
| --- | --- | --- | --- |
| 战术 | **A** 连续盲改 | 同一绝对路径的 `fs/write-intent` 计数，测量结果返回后按目录清零 | 连续 **3** 次 |
| 战术 | **B** 重复报错 | 同一 `工具\|目标\|错误指纹` 组成的 episode 计数，**含 `isError:false` 的测量失败**；免疫按「搜索时该 episode 的计数」记基线，之后重新攒够才报 | 第 **2** 次 |
| 战术 | **C** 改后未验证又写入 | 写入后 N 步无测量则上膛（arm），**下一次写入**才触发 | **2** 步 |
| 方案 | **F** 错误族 | 同一 `工具\|目标` 上不同指纹的数量与总次数；**该族最近换出新错之后**搜索过才免疫（一次搜索不终生免责） | **3** 种指纹且共 **4** 次 |
| 方案 | **O** 验证振荡 | 同一测量回路中，**绿过的失败条目复发**（近期存最近 4 次失败集合，当前集合与其中任一次有**条目交集**即算复发；只看失败条目，不含 warning 等日志噪声），且两次结果之间有写入；静音按回路记 | 第 **3** 次翻转 |
| 方案 | **P** 补丁链 | 连续「测量失败 → 写入 → 测量仍失败」且**失败面没有收缩**（集合变小＝在收敛；一字未变＝没推动；换到别的文件＝换现场）；成功测量清零 | 连续 **3** 轮 |
| 元 | **M** 干预失效 | 注入后窗口内无测量/搜索，pending 作废计入 `futile` | 连续 **2** 次无效注入 |

所有信号共享同一个基础概念——**测量（measurement）**，而非「调用了某个工具」。

### 测量的两态判定

测量意图在 `tool/call` 时按参数判定，测量结果在 `tool/result` 返回后才记账。
因此 `edit → ls → edit → edit` 不会被中间的 `ls` 洗白；在无关目录运行测试
也不会清除目标文件的盲改计数。

| 类别 | 工具 | 判据 |
| --- | --- | --- |
| 硬测量 | `lsp_diagnostics` `verify` `run_tests` `run_test` | 恒为测量 |
| 软测量 | `ops_bash` `bash` `shell` `pwsh` | 命令命中 `measureCommands`，或描述命中 `measureIntent` 且命令不是 `ls/dir/cat/type/head/tail` |
| 搜索 | `web_search` `research` `advanced_search` `multi_search` `platform_search` `domain_search` `cache_search` `video_search` | 视为取得外部先验 |
| 方法论 | `skill` | 计为有效转向 |
| 编辑 | `edit` `write` `ops_write` `str_replace` `apply_patch` `notebook_edit` | 计入写入序号 |

**失败的测试仍是有效测量**：它提供了新事实。`[exit code: 1]` 同样清零盲改计数，
仅在日志与面板中记为 `ok=false`。

内置测量命令清单覆盖 `npm/pnpm/yarn/bun` 的 `test|verify|check|lint|typecheck|build`、
`node --test`、`pytest`、`vitest`、`jest`、`mocha`、`go test`、`cargo test`、
`dotnet test`、`tsc`、`eslint`、`ruff check`、`mypy`、`git diff --stat`，可用
`measureCommands` 覆盖。生成物与锁文件由 `excludePaths` 排除，不计入盲改。

### 错误指纹、episode 与错误族

- **目标**：报错正文中第一个路径，仅剥去末尾行号列号（`a.mjs:12:29` → `a.mjs`），
  路径内其他数字保留（`a1.js` 与 `a2.js` 是不同目标）；`file://` 前缀先剥离。
- **指纹（B / F 用）**：首 6 行、前 300 字符，归一化十六进制数、路径与数字后取
  sha256 前 16 位。因此「行号变化但异常类不变」仍属同一 episode。这里**故意**把数字归一
  —— B 要的是「同一个操作用同一句话反复报错」，`expected 2` / `expected 3` 属于同一句。
- **失败条目的身份（P / O 用）**：另有一套，只把「路径 + 紧跟其后的位置」切掉，**消息里的
  数字原样保留**。两套必须分开：B 判「重复」看的是措辞有没有变，P 判「补丁链」看的是
  失败面有没有换成别的问题 —— 把 `case-1`/`case-2` 归一，P 会把两个不同断言算成同一个
  错误；行号不剥，P/O 又会把同一处的一次编辑算成换了新问题。
- **B 的 key** 为 `工具|目标|指纹`，**F 的 key** 为 `工具|目标`（不含指纹）。
  F 统计的正是指纹的**多样性**：`fingerprints.size ≥ 3 ∧ count ≥ 4`。
  若 key 带指纹，每种新报错都会各自开 episode，F 即退化为更迟钝的 B。

### O：为什么判据是「绿过的失败复发」

振荡的朴素定义（结果在 ok/fail 间翻转）会把健康 TDD 误判为卡住：每轮的红都是
尚未实现的新用例，颜色变化本身是进展。因此 O 要求失败**曾经出现过、其后变绿、
如今复发**，且两次结果之间存在写入（纯测量重跑的 flaky 翻转不计）。

仅比对「上一次失败的指纹」仍会漏掉最常见的交替振荡——改 A 踩 B、改 B 踩 A，
指纹按 A/B/A/B 轮换，每次失败都被误判为新失败。故判据使用**近期失败指纹集合**
（FIFO，容量 `RECENT_FAIL_LIMIT = 4`）：新指纹只入队、不清零翻转计数。

三种典型形态下的行为：

| 形态 | 判定 |
| --- | --- |
| 交替振荡（A/B 互踩） | A、B 均在集合内，自第三次失败起连续计数，达阈值触发 |
| 健康 TDD（每轮新失败） | 新指纹不在集合内，永不计数 |
| 纯测量 flaky（无写入） | 不满足写入条件，不计 |

O 的重新武装与「回路稳定」绑定：同一回路**连续两次成功**（翻转计数清零）后才允许
再次触发。若按单次成功重新武装，振荡中每隔一步就会重复提醒同一局面。

### M：元闸门

每条注入登记一个 pending。窗口（`changedWindow`，默认 6 步）内未出现测量或搜索，
pending 作废并记 `futile += 1`；任何有效转向或成功测量将其清零。
`futile` 达到 `metaAfterFutile`（默认 2）即触发 M。

M 与其它信号在机制上有四点不同：

- **优先级最高**，先于其余六条判定；
- **不占** `maxInjectsPerTurn` 普通预算——最需要 M 的局面恰恰是预算已耗尽的局面；
- **每 turn 至多一次**，且触发它的那一 step 不夹带其它信号；
- **独立文案模板**：要求模型先写出已试方案清单、共享假设与一个机制上不同的方案
  （或明确需要用户补充的现场产物），再发起修改类工具调用。

## 干预的优先级与互斥

同一 step 内信号不叠加陈述同一件事：

- **P 与 F** 同时命中时只发 P（补丁链比错误族更接近方案层），F 记为已发；
- **F/P 命中时压掉 B**（「这个错重复了」是弱化版观察），B 记为已发；
- **A/B 命中时**，C 记为已发，不再补一句「改完没验证」；
- **M** 始终单独成条。

## 幂等与重新武装

- 同一局面不重复提醒：上次注入后写入序号与错误序号均未变化则沉默；
- 各信号按「什么算局面变了」分别重新武装：

| 信号 | 重新武装条件 |
| --- | --- |
| A | 一次测量结果返回（仅清相关目录） |
| B | 该 episode 之后发生搜索（之后重新攒够阈值才再报，不是终生免责） |
| C | 一次测量结果返回（解除上膛） |
| F | 搜索（仅对搜索之前出现的指纹免疫），或一次成功测量 |
| O | 同一条回路连续两次成功（只重新武装这条回路，不影响别的回路） |
| P | 一次成功测量，或失败面开始收缩，或一字未变（清零而不是暂停） |
| M | 每 turn 一次；有效转向清 `futile` |

- 普通信号共享每 turn 预算 `maxInjectsPerTurn`（默认 3）。

## 触发前置与例外

1. **交付态**：`present` 成功返回后闸门休眠，下一次写入唤醒；`present` 失败不休眠。
   休眠时写 `suppress … reason=done` 以便区分「醒着但沉默」与「未挂载」。`doneOnPresent: false` 关闭。
2. **用户显式指令**：本 turn 用户原话命中
   `/别搜|不要搜|不用搜|先别搜|直接改|快速试|别折腾|先试试/` 时整 turn 静音。
   只认 `source.kind === 'user'` 的消息，插件自身注入不计。
3. **子会话不生效**：`origin === 'subagent'` 或 `delegationDepth > 0` 一律跳过。
4. **不使用 `reject`**：拦截只表现为向 `messages` 尾部追加一条用户消息，
   不会把 turn 变成 no-op。

## 注入文案

普通信号采用固定骨架（观察 → 至多两条动作 → 恢复条件 → 技能指引），M 使用独立模板。
全部文案的唯一来源是 `lib/text.js`，运行时注入与面板的老日志回填共用同一函数，
因此字符/token 统计不会与真实文案漂移。

M 的完整模板：

```
[better-debug] 元观察：这个 turn 里已经连续 2 次提醒没有换来转向。
这不是「再试一次」能解决的问题了。下一步之前先写三段话（总共不超过 12 行）：
1) 你已经试过的方案清单，以及它们共享的那个假设；
2) 一个机制上不同的方案——换数据结构、换库、换责任层、或先造最小复现再重写，四选一，说明它为什么绕开了之前所有的墙；
3) 如果写不出第 2 条，说明缺的是现场而不是尝试：列出你需要用户补充的一份具体产物（日志 / 最小复现 / 环境信息）。
写完之前不要发起任何修改类工具调用。
```

## 适用范围与已知边界

**本插件面向编码场景设计与校准。** F 依赖报错文本中的路径与指纹，O/P 依赖可重复
运行的验证命令，M 依赖「存在可建立的反馈回路」。写作、设计、数据分析等任务中
「验证」不是一条命令，这些信号不可靠。插件**不做任务类型识别**；边界由配置划定
（`metaGate: false` 关闭 M，调高 F/O/P 阈值等效于关闭）。

其余边界：

- 「同一文件」按绝对路径判定，删除后重建同名文件仍计为同一处；
- 测量判据是启发式正则，误判方向不对称：非测量当测量导致漏报，测量当非测量导致误报；
- 交付态只认成功返回的 `present` 调用，纯文本终稿由 `stuck-gate` 技能的自检兜底；
  从不调用 `present` 的任务可设 `doneOnPresent: false`；
- 全部状态活在 **turn 内**，`turn/start` 重置，不做跨 turn 持久化；
- 不判定 no-op 写入：`fs/write-intent` 不含内容，插件层拿不到 diff；
- P 的「失败面」是按**失败条目集合**（`目标|身份`）数出来的，收缩要求当前集合是上一轮的
  真子集。身份由「切掉路径与紧跟的位置之后的消息」决定，所以行号/列号漂移不算新失败，
  而消息里的 `case-1` / `case-2`、错误码、期望值是语义。仍有两类分不开：同一文件里
  「10 个错减到 6 个」与「前 6 个错一字未变」如果条目完全重叠，都算收缩；`expected 2
  got 1` 与 `got 1.5` 是两个不同身份（数字保留），不会被合并；
- P 宁可漏判：换到**别的文件**报错一律算进展（分头修不同文件不该被说成打转）。
  代价是「在 A 里改、把错推到 B」这种真补丁链也说不出话；
- F 需要能抽出路径。抽不出目标（纯文本报错、只有 `[exit code: 1]`）时只留 B 的记账、
  不进错误族 —— 宁可不说，也不要把不同项目的错算成同一个目标；
- B 现在同时数两种重复：`isError:true` 的工具错误，以及 `isError:false` 的**测量失败**
  （`npm test` 返回非零）。后者原先从不进错误记账，于是「同一个失败一字未变地重复八轮」
  在 0.3.1 上一条提醒都没有；补上之后这类局面由 B 接管，P 仍然不说话；
- 重复 episode 只在**连续失败**时累加：`失败 → 绿 → 同一个失败` 是振荡（O 管），
  不该被说成「同一个错重复 N 次」—— 两者同时开口会撞车；
- O 的「同一个失败」按失败**条目交集**判，不看整段输出、也不要求整集合相同：同一断言
  失败、每次多一行 `Warning: renderer notice-N`，仍是同一个失败；老失败身边又添一条新的
  （`{A} → {A,B} → {A,C}`）也算 A 在复发 —— 要求整集合相等时这类形状十轮都不说话。
  反过来，只改了**无关日志格式**的两次不同失败不会被合并，`{A} → {B}` 也不算复发；
- **失败身份**分两半：源位置（`:12:29`、`(12,9)`、`line 12`）是定位噪声，编辑一行就会
  整体漂移，同一处的同一个错误不该因此变成「新错误」；消息里的数字（`case-1`/`case-2`、
  `TS2322`、`expected 3 to be 4`）是失败语义，全量归一化会把它们塌成同一条；
- **栈帧不是失败本体**：JS 的 `at …`、Python 的 `File "…", line 10, in test_case`、
  pytest 的 `tests/a.py:10: in test_case` 只贡献目标，不进条目集合；紧跟栈帧的缩进行是
  traceback 的**源码回显**（`    assert case == expected`），同样不进 —— 否则两个不同
  断言会因这一行逐字相同而被判成「同一个错」；
- **一行输出先分类再进集合**：`error` 才算失败；`warning`（ESLint 的
  `src/a.js:1:1  warning  'x' is defined…`）、聚合行（`✖ 10 problems`）、日志噪声一律
  不进。判据只看行首那个严重级别列，不看正文 —— `AssertionError: warning total mismatch`
  这种正话里的「warning」仍要算失败，否则是从误报换成漏报；
- **目标的边界由「路径长什么样」决定，不由「第一个空格」决定**：`a.ts` 这种根目录裸
  文件名、`C:/work/My Project/src/a.ts` 这种带空格的绝对路径都要整段认出；但路径后面
  紧跟的错误消息（`C:/work/a.ts: error: cannot open`）不得被吃进目标；
- 收尾探针清零归 `dsh-turn-cleanup`，不在本插件职责内。

## 安装

npm registry：

```bash
dsh plugin add dsh-better-debug
```

Release tarball（与 npm 包逐字节相同）：

```bash
dsh plugin add https://github.com/Leonlee114514/dsh-better-debug/releases/download/v0.3.4/dsh-better-debug-0.3.4.tgz
```

手动 link（用于本地修改）：

```bash
# 1. 放到长期保留的位置（不要用临时目录或 node_modules）
mkdir -p ~/dsh-plugins
cp -r dsh-better-debug ~/dsh-plugins/

# 2. 在 profile（如 ~/.dsh/profiles/desktop）中：
#    package.json → dependencies 加：
#      "dsh-better-debug": "link:../../../dsh-plugins/dsh-better-debug"
#    package.json → dsh.profile.bundles 数组末尾加：
#      "dsh-better-debug"

# 3. 如需手写 patch，在自己的 profile cordis.patch.yml 中加：
#      - id: better-debug
#        name: dsh-better-debug
#    不要加 inject: [skills]；包内 patch 故意不含 config，原因见下。

# 4. 重启 DSH。
```

> 不要同时使用两种挂法。包内 `cordis.patch.yml` 已含 `- id: better-debug`，
> 重复 id 会被 cordis 拒绝；不同 id 指向同一包则插件挂载两次，提醒与日志翻倍。

### 两个刻意为之的打包决定

**不使用静态 inject。** cordis 在任一声明服务缺失时将 epoch 置为 INACTIVE 并跳过
`apply()`——无报错、无日志，插件看似已装载实则未运行。因此 `export const inject = []`，
可选服务（`skills` / `webServer`）一律通过 `ctx.inject([...], cb)` 动态订阅：
服务存在则启用对应功能，缺失仅损失可选功能，闸门照常工作。

**bundle patch 不含 config。** 市场热挂载只重放纯 insert 行，patch 中出现 `config:`
即被标记为 blocker，用户点「启用」不会有任何反应。默认值全部在
`normalizeConfig()` 中，需要覆盖时写在**自己 profile** 的 patch 里。

## 配置

在**自己 profile** 的 `cordis.patch.yml` 中对同一 id 添加 `config:` 块：

```yaml
- id: better-debug
  name: dsh-better-debug
  config:
    enabled: true
    repeatEditThreshold: 3        # A：同一文件连续改几次算盲改
    repeatErrorThreshold: 2       # B：同一 episode 错几次算打转
    noVerifySteps: 2              # C：改完几步没测量才上膛
    maxInjectsPerTurn: 3          # 单轮普通提醒预算（M 不受限）
    changedWindow: 6              # 注入后的转向观察窗口（步）
    repeatFamilyThreshold: 4      # F：错误族累计次数（3–20）
    familyMinFingerprints: 3      # F：族内不同指纹数（2–10）
    oscillationThreshold: 3       # O：第几次翻转触发（2–10）
    patchChainThreshold: 3        # P：连续几轮失败—写入（2–10）
    metaAfterFutile: 2            # M：连续几次无效注入（1–5）
    metaGate: true                # M 总开关
    decayEditsOnVerify: true      # 测量后清零盲改计数
    doneOnPresent: true           # present 成功后休眠
    measureCommands: ""           # 覆盖测量命令正则；空 = 内置清单
    measureIntent: ""             # 覆盖测量意图正则
    excludePaths: ""              # 覆盖盲改排除路径正则
    logFile: "~/.dsh/logs/better-debug.log"
    panel: true                   # 只读面板路由
```

数值越界会被夹到边界值；三个正则键传入非法正则会回退内置默认并记 warn；
`enabled: false` 时不注册任何 listener。

`logFile` 的四种取值：

| 写法 | 行为 |
| --- | --- |
| 不写 | `$DSH_HOME/logs/better-debug.log`（未设 `DSH_HOME` 时为 `~/.dsh/logs/better-debug.log`） |
| `"~/my.log"` | 展开家目录 |
| 绝对路径 | 原样使用 |
| `""` 或 `false` | 显式关闭落盘（面板将无数据） |

## 日志与观测面板

日志是唯一的验收面：`ctx.logger` 只进宿主进程 stdout，事后无法检索，因此所有关键
事件都有落盘行型。加载成功必有一行：

```
apply pid=… logFile=… A=3 B=2 C=2 budget=3 window=6 panel=true F=4/3 O=3 P=3 M=2/1
```

**没有 `apply` 行即未挂载。** 其余行型：

```
inject   session=… turn=… step=… signals=A inj=78ed6bc3 chars=… tokens=… files=… worstEdits=… worstStreak=… worstErrors=… searched=… measured=…
outcome  session=… inj=… after=A first=ops_bash class=verify steps=1 before=write
measure  session=… tool=ops_bash ok=false exit=1 cleared=1
change   session=… inj=… after=A tool=ops_bash class=verify steps=1
futile   session=… inj=… after=A count=1 window=6
arm      session=… turn=… gap=2
suppress session=… reason=done
```

判读要点：`worstStreak` 才是 A 的判据（自上次测量以来的连续盲改），`worstEdits`
只是 turn 内累计；`outcome` 仅记录第一条后续动作，**是否真正建立回路要看 `measure`
行**；`change` 行的 `steps=` 给出转向延迟；M 的 inject 行额外带 `futile=N`。

面板位于 **设置 → better-debug**（或 `http://<web-origin>/better-debug`），只读、
5 秒自刷新，展示触发分布、覆盖会话、提示后首个动作、测量回路、窗口内转向率与
中位步数、方案层阈值与 futile 累计。两项措辞纪律需要说明：

- 「提示后首个动作」是**描述性统计**，不证明提醒促成了改变；「换动作率」这类
  因果暗示的指标名已弃用。
- 早于埋点的旧日志没有分母，转向率显示为「这段日志早于 v0.2 埋点」而非 0%；
  老日志缺少方案层字段时显示 `—`，不编造默认值。面板不估算「节省的 token」，
  要证明增益需要对照组或历史回放，两者均不在其职责内。

`panel: false` 可关闭路由，不影响闸门。

## 自带技能

`assets/stuck-gate/SKILL.md` 注册为 bundled 技能（rank 600），注入文本末尾的
「完整五条」即指此文件。它负责提示词层的五步法（建回路、搜索、最小化、可证伪假设、
换层），与插件相互独立：插件负责「想不起来的那一刻」，技能负责「想起来后做什么」。

用户可在 `~/.dsh/skills/stuck-gate/SKILL.md`（rank 400）放同名文件覆盖默认文案，
数值小者优先，无需修改代码。宿主无 `skills` 服务时注册跳过并记日志，闸门不受影响。

## 本地验证

```bash
node test/sim.mjs           # 102 个用例：闸门语义与可移植性
node test/panel.mjs         # 62 个用例：日志解析、聚合、世代判定、配色、埋点
npm run test:posix          # 以 POSIX 路径语义重跑上述两套
npm run test:linux          # 以 Linux 平台语义（区分大小写）重跑
npm run test:slow           # 落盘延迟 400ms，验证「等条件」而非「等时长」（63 条）
npm run verify              # 全部（含语法检查）
```

测试以假 ctx 复刻 agent-loop 的调用顺序，**不依赖 DSH 运行时**。每条信号均有正例
与反例：测量两态、episode 归属、C 的两段式、重新武装、交付态、F 的族判定与 B 抑制、
O 的交替振荡/健康 TDD/flaky、P 的链计数与重跑排除、M 的触发/独立性/开关。

第四类防线是**判据本身的过拟合**——前三类靠真机 CI 才暴露，这一类连 CI 都抓不到，
因为坏的是判据、不是环境：

- **P 的三种健康形状**：收敛中的清扫（10→9→8→7）、同一个错一字未变、逐个修独立文件
  （换现场）。0.3.0 只看「失败→写入→仍失败」，三种全误报；
- **errorTargetOf 的方言矩阵**：tsc（括号行号）、cargo、pytest、go、mypy、webpack、
  C# 反斜杠路径、Windows 反斜杠相对路径，共 13 种写法；外加 `7/8 and/or TCP/IP`
  这类噪声不得被认成路径；
- **O 的静音粒度**：另一条回路首次变绿不得解除这条回路的静音；
- **F 的免疫范围**：搜索之后同一目标堆出**全新**指纹仍须响（一次搜索不终生免责）。

这一组反例在 0.3.0 上全部为红（`66/73`），改完为绿（`73/73`）—— 用例先证明旧代码
是错的，才轮得到它证明新代码是对的。

### 第五类防线：断言自己写错规格

0.3.1 的十二轮深审又找出一类更隐蔽的问题——**用例本身把规格写错了**。最直接的例子是
`同一个错三连（一字未变）`这条反例：0.3.1 断言「总注入必须为 0」，于是 P 一旦按规格
退出，整类局面就变成所有信号都不说话，实测连续八轮 0 注入。正确规格是「P 不说话，
但必须有人接管」。

现在的测试分成两类，各自只断言自己该管的事：

- **信号语义**：只断言目标信号在不在（`!has(injected, '修出了下一个失败')`），允许
  别的信号接管；
- **端到端覆盖**：断言典型卡住形态**不能全沉默**，且同一局面**不能连发**（新增
  `B 搜索基线` 四条，单条都能被错的实现满足，四条一起才锁住语义）。

对应六处状态机修复（0.3.1 → 0.3.2）：M 移到通用幂等闸之前（否则「提醒后既没写入也没
新错误」恰好是它最该说话的时刻）、失败测量单独记重复 episode（`isError:false` 的测量
失败从不进 `s.errors`）、B 的搜索免疫改为计数基线（原来 `firstClock` 一次搜索终生免责）、
P 的 `unchanged` 清链而不是暂停、`movedSite` 改比整个 turn 见过的目标（原来只比上一轮，
`A→B→A→B` 每轮都被当成换现场）、O 改用失败条目集合身份（整段输出指纹会被无关 warning
改写）。

0.3.2 之后又有第四轮深审，一次揪出**四个新缺陷**，其中两个是上表中判据自身造出来的：

- **失败身份把源位置当语义**（缺陷 1）：对「路径 + 位置 + 消息」整行取指纹并保留全部
  数字，于是 `src/a.ts(12,9)` 与 `src/a.ts(13,9)` 成了不同失败。真要命的是反方向——
  0.3.0/0.3.1 把数字全归一成 `<n>`，`case-1` 与 `case-2` 又塌成同一条。现在的解析器把
  「路径 + 紧跟的位置」切掉后再取指纹，消息里的数字原样保留；
- **Python 栈帧被当成失败本体**（缺陷 2）：只认 JS 的 `^at\s`，于是
  `File "…", line 10, in test_case` 进了集合，而 `AssertionError: case-one` 被
  「有路径行就只用路径行」的收缩逻辑丢掉 —— 两个不同断言只要共用栈帧就成了同一条
  失败（误报「重复报错」），健康 TDD 反过来被判成振荡。修法有两半：栈帧只贡献目标、
  不进条目；并且「有路径行」时异常消息也**必须**并进去，不能整批丢掉。补上之后又露出
  第三个面：紧跟栈帧的源码回显行（`    assert case == expected`）逐字相同，会成为两条
  不同失败的公共条目 —— 用「紧跟栈帧 + 原始行有缩进」把它认出来排除；
- **O 比较整集合相等而不是条目交集**（缺陷 3）：真实局面上极少有「失败集合一模一样地
  回来」，更常见的是老失败身边又添一条新的，整集合哈希每次都不同 → 十轮零注入；
- **失败测量不推进幂等状态**（缺陷 4）：通用闸只比 `writeSeq` / `errorSeq`，而
  「`npm test` 又失败一次」两者都不动，于是「失败 → 提醒 → 再失败到阈值」里第二次提醒
  被当成「什么都没发生」挡掉。新增单调 `failSeq`，三项任一变化都算局面变了。

对应新增五个用例组（`50`–`53`）：位置漂移不得改变身份、`case-1`/`case-2` 不得合并、
Python 不同断言共用栈帧不得合并、异常消息必须留在集合里、源码回显不得成为公共条目、
`{A}→{A,B}→{A,C}` 仍要认出 A 复发、搜索后重新达阈值必须能说第二次。基线对照：
这套用例在 0.3.2 上红 6 条（`82/89`），改完 `89/89`。

### 第五轮：从「加正则」改成「先给诊断行分类」

0.3.3 之后第三轮深审又把解析层拆开看了一遍，发现前两轮一直在给**具体形态补正则**，
而缺的是分类：一行输出到底是 `error`、`warning`、`frame`、`source`、`aggregate`
还是 `log`。补丁式加正则的结果是「目标层认得、身份层不认得」——用例 46 验了
`errorTargetOf` 认 webpack 的位置，却没验 `failureSetOf` 的身份在行号漂移后仍然相同。
五个缺陷全部出自这个缺口：

- **根目录裸文件名不识别**（缺陷 1）：路径规则要求「目录 + 文件名」，
  `a.ts(12,9)` 抽不出目标，位置也就没得剥 —— 行号一漂就成了新失败。
- **绝对路径遇空格被截断**（缺陷 2）：`[^\s"';()]+` 吃到第一个空格即停，
  `C:/work/My Project/src/a.ts` 的目标是 `c:/work/my`，剩下的半截留在消息里。
- **webpack 的空格分隔位置范围未剥离**（缺陷 3）：位置写成
  `./src/index.js 5:0-20`（空格 + 行:列-列），不是括号也不是冒号开头。
- **含路径的行直接进集合**（缺陷 4）：`src/a.js:1:1  warning  'first' is defined…`
  也成了失败条目 —— 同一个 error 一字不变、只有无关 warning 的变量名在变，集合每轮
  不同：B 认不出来，P 反而把 warning 的变化说成「修出了下一个错误」。
- **pytest 的 `> assert …` 源码回显成为公共条目**（缺陷 5）：两个不同断言共享这一行，
  于是 O 的条目交集判据把健康 TDD 读成「旧失败回来了」。

修法不是再加五条正则，而是**先分类再决定要不要进集合**：栈帧只提供目标、`E` 行是诊断
本体、`>`/`<` 与块内缩进行是回显、`warning` 列与聚合行不进集合。这几条都配了反例 ——
尤其「正文里出现 `warning` 这个词的真错误仍要进集合」，避免从误报换成漏报。

对应新增第 `54` 组用例（13 条：裸文件名、带空格路径、webpack 位置、ESLint warning 正反
两面、pytest 回显与 `E` 行）。基线对照：这组在 0.3.3 上红 9 条（`93/102`），改完
`102/102`；三轮深审探针（`deep-review-probes` / `-v032-` / `-v033-`）逐项符合预期。

三轮附加测试对应三类「本机通过、真机失败」的回归防线：

- **路径方言**：`node:path` 的 `isAbsolute` 平台相关，曾导致 POSIX 宿主上写入被静默
  丢弃。`test:posix` 用 resolve hook 替换为 `node:path/posix` 后原样重跑。
- **大小写敏感**：`test:linux` 覆盖 `process.platform`，断言以 `samePath`/`sameDirs`
  按平台比较，避免把本机折叠语义写进期望值。
- **落盘时序**：插件刻意 `void record(...)` 不 await，`test:slow` 将 `appendFile`
  拖慢 400ms，任何固定 sleep 的读日志写法都会稳定失败；读取一律等条件。

CI 在 ubuntu / windows / macos × node 20 / 22 / 24 上运行 `npm run verify`。

## 设计依据与相关工作

插件不实现任何规划算法，其概念划分与以下文献一致，判据均为可复现的事件启发式：

- **计划修复与重规划**：Nebel & Koehler（IJCAI 1995）证明复用旧计划在最坏情况下
  不优于重新规划；Fox 等（ICAPS 2006）提出 plan stability 并实证比较两种策略。
  本插件的 P（补丁链）对应「修复次数累积后应转向重建」的维护规则，arXiv:2611.19663
  将其形式化为 patch debt 与 commitment hysteresis；M 对应「同类修订工具失效后
  应切换修订层级」。
- **元认知监控**：自我监测在压力下失效是引入外部监控的动机；插件充当 harness 层的
  外部元认知——检测不依赖模型自觉，干预也先于下一步动作而非事后复盘。

## License

MIT
