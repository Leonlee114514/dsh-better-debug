# dsh-better-debug

面向编码 Agent 的**卡住检测**插件（DeepSeek Harness / Cordis）。

它订阅 agent 的事件流，用可复现的行为证据判断模型是否陷入无效迭代，并在下一次模型请求之前，
向消息序列追加一条结构化的观察与恢复建议。

- **不调 LLM** —— 全部判据是事件计数、路径匹配与字符串归一化，同一段事件序列必然得到同一结论。
- **不改 agent loop** —— 只往 `messages` 末尾追加一条用户消息，不 `reject`，不拦截工具调用。
- **不解析模型输出** —— 唯一被读取的用户输入是用户消息，且只用于匹配「别搜 / 直接改」这类静音短语；
  不存储、不落盘、不外传，日志里只有一个布尔量。

一句话：把「卡住要停下来建回路」这条自觉条款，从提示词层移到代码层。

插件要检测的不是「模型不会写代码」，而是几种有名字的认知失效：**over-commitment / blind commitment**（对失效方法的持续承诺）、**Einstellung effect**（成功经验形成的定势）、以及缺一次 **intention reconsideration**（意图重考虑）的时机。这三个概念的文献来源与对应信号见[设计依据](#设计依据与相关工作)。

## 它解决什么问题

「卡住时应当先建立反馈回路」通常写在系统提示或技能文件里，属于**自觉条款**：模型必须先意识到
自己卡住，条款才会生效。而卡住的行为特征恰恰包括这种自我监测的失效 —— 模型会持续写下第 N 次
「再试一次」。

插件接手其中**能由事件证明**的部分，遵循三条原则：

1. **只看行为，不看语言**。判据只有事件计数、路径匹配与字符串归一化，每个结论都能用同一段事件
   序列复现。
2. **只陈述观察，不下诊断**。注入文本以「只是观察，不是结论」开头，给出可数的事实（几次、几种、
   几轮）与至多两条恢复动作，并附恢复条件。
3. **证据成本不对称，宁可漏报**。误打断正常迭代的代价高于少提醒一次，因此每条信号都配有明确的
   反例。

## 一个最小示例

每次修改都有验证，每次失败都不相同，但模型始终在同一组互相破坏的修改之间往返：

```
改 A → npm test（红：断言 B 失败）
改 B → npm test（绿）
改 A → npm test（红：断言 B 失败）   ← 同一失败在绿过之后复发
改 B → npm test（绿）
改 A → npm test（红：断言 B 失败）   ← 第 2 次翻转
改 B → npm test（绿）
改 A → npm test（红：断言 B 失败）   ← 第 3 次翻转，触发 O
```

下一步之前，插件追加一条消息：

```
[better-debug] 观察到的重复动作（只是观察，不是结论）：
- 同一组验证的结果已经在通过和不通过之间翻转了 3 次，每次翻转之间都有修改。
下一步先做其中一件，拿到新事实再继续改：
1) 修改在把问题来回推：先固定一个当前为红的用例，只做让它变绿的最小改动，其余改动先撤下；如果两次修改互相破坏，说明它们共享一个错误假设，先写出这个假设再动。
恢复条件：拿到一条新的测量结果或一条外部事实后，继续动手即可。
完整五条：skill `stuck-gate`。
```

同时落一行可 grep 的日志：

```
inject session=… turn=1 step=19 signals=O inj=e7db4417 chars=235 tokens=204 files=2 worstEdits=5 worstStreak=0 worstErrors=0 searched=false measured=yes:ops_bash:fail
```

## 信号模型

七条信号分三层：战术层检测**动作重复**，方案层检测**动作变化但方向不变**，元层检测**干预本身失效**。

| 层 | 信号 | 行为证据 | 默认触发 |
| --- | --- | --- | --- |
| 战术 | **A** 连续盲改 | 同一绝对路径的 `fs/write-intent` 计数，测量返回后按目录清零 | 连续 3 次 |
| 战术 | **B** 重复报错 | 同一 `工具\|目标\|错误指纹` 的 episode 计数，含 `isError:false` 的测量失败；搜索按当时计数记基线 | 第 2 次 |
| 战术 | **C** 改后未验证又写入 | 自上次测量以来的盲改次数（跨文件、与步号无关），够 N 处则上膛，**再写一处**才触发 | 3 处 |
| 方案 | **F** 错误族 · *实验性* | 同一 `工具\|目标` 上不同指纹的数量与总次数；换出新错之后搜索过才免疫 | 3 种指纹且共 4 次 |
| 方案 | **O** 验证振荡 · *实验性* | 同一回路中**绿过的失败条目复发**，且两次结果之间有写入 | 第 3 次翻转 |
| 方案 | **P** 补丁链 · *实验性* | 连续「测量失败 → 写入 → 仍失败」且**失败面没有收缩** | 连续 3 轮 |
| 元 | **M** 干预失效 | 注入后窗口内无测量 / 搜索，pending 作废计 `futile` | 连续 2 次无效注入 |

所有信号的共同基础是**测量（measurement）**，而不是「调用了某个工具」。

### 测量的两态

测量意图在 `tool/call` 时按参数判定，结果在 `tool/result` 返回后才记账。因此 `edit → ls → edit → edit`
不会被中间的 `ls` 洗白；在无关目录跑测试也不会清掉目标文件的盲改计数。

| 类别 | 工具 | 判据 |
| --- | --- | --- |
| 硬测量 | `verify` `run_tests` `run_test`（装了 `dsh-lsp-actions` 时含 `lsp_diagnostics`） | 恒为测量 |
| 软测量 | `ops_bash` `bash` `shell` `pwsh` | 命令命中 `measureCommands`，或描述命中 `measureIntent` 且命令不是 `ls/dir/cat/type/head/tail` |
| PTC 根调用 | `run_code` | `code` 里出现 `measureCommands` 白名单命令才算测量；不看 `measureIntent`（裸 `test` 对整段代码测等于「注释里提到测试就算测过了」）。子调用逐个按自己的工具名判 |
| 搜索 | `web_search` `research` `advanced_search` `multi_search` `platform_search` `domain_search` `cache_search` `video_search` | 视为取得外部先验 |
| 方法论 | `skill` | 计为有效转向 |
| 编辑 | `edit` `write` `ops_write` `str_replace` `apply_patch` `notebook_edit` | 计入写入序号 |

**失败的测试仍是有效测量**：它提供了新事实。`[exit code: 1]` 同样清零盲改计数，只在日志与面板里
记 `ok=false`。

内置测量命令覆盖 `npm/pnpm/yarn/bun` 的 `test|verify|check|lint|typecheck|build`、`node --test`、
`pytest`、`vitest`、`jest`、`mocha`、`go test`、`cargo test`、`dotnet test`、`tsc`、`eslint`、
`ruff check`、`mypy`、`git diff --stat`，可用 `measureCommands` 覆盖。生成物与锁文件由
`excludePaths` 排除。

`measureIntent` 只对**软测量工具的描述**生效（模型自称在验证），不参与 `run_code` 的判定：
那个正则含裸 `test` / `measure` / `diagnos`，拿去测整段脚本文本会把「注释里写了测试」也算成
跑过测试，等于把 C 的盲改计数洗白。在 `run_code` 里演算、写断言而不调工具的测量，插件看不见 ——
这是刻意的取舍，宁可漏认，也不误清。

### 两套「身份」

同一段报错要回答两个不同的问题，因此有两套归一化：

| 用途 | 归一化 | 回答的问题 |
| --- | --- | --- |
| 指纹（B / F） | 首 6 行、前 300 字符，归一化十六进制串与路径后取 sha256 前 16 位（数字原样保留） | 同一个操作是不是在用同一句话反复报错 |
| 失败条目（P / O） | 只切掉「路径 + 紧跟其后的行列号」，消息里的数字原样保留 | 失败面是不是换成了别的问题 |

两套必须分开：把 `case-1` / `case-2` 归一，P 会把两个不同断言算成同一个错误；行号不剥，P / O 又会
把同一处的一次编辑算成新问题。

B 的 key 是 `工具|目标|指纹`，F 的 key 是 `工具|目标` —— F 统计的正是指纹的**多样性**。若 F 也带
指纹，每种新报错都会各自开 episode，它就退化成更迟钝的 B。

### F / O / P 是实验性信号

A / B / C / M 都在真实会话里被反复验证过会命中；**F（错误族）、O（验证振荡）、P（补丁链）标为
实验性**，各自的原因不同：

- **O / P**：在本机早期 1113 行真实日志里两者各触发 **0** 次（同期 A 17、B 36、C 159、F 1、M 8）。
  它们的判据依赖「失败集合」的形状，在真实工程里最容易被两种健康行为骗到：按红绿红绿的正常 TDD
  节奏被读成振荡，逐个修互相独立的文件被读成补丁链。
- **F**：收紧正则后仍几乎不触发（0.3.0 之后 2.8 天只有 1 次），且那一次是跨错误计数凑出来的 ——
  根因是 `errorTargetOf` 对 `old_string was not found`、`npm ERR! code ELIFECYCLE` 这类文本抽不出
  目标，族根本建不起来。这一面实际一直由 B 代为覆盖（B 的 key 多一位指纹）。

默认阈值保留（`oscillationThreshold: 3` / `patchChainThreshold: 3` / `repeatFamilyThreshold: 4`），
不默认关闭 —— 关掉等于让这几条判据永远拿不到真实样本，永远无法证伪。

- 但把它们当实验性看待：命中时按「值得看一眼」处理，而不是「照做」。A / B / C 的提醒通常是「这一步
  确实在重复」；O / P 的提醒可能是「你的节奏恰好长得像」，F 的提醒可能只是两条无关报错被归到了
  同一个空目标上。
- 想彻底关掉：`oscillationThreshold: 10` + `patchChainThreshold: 10`（两者上限都是 10）、
  `repeatFamilyThreshold: 20`（上限 20）。

### M：元闸门

每条注入登记一个 pending。窗口（`changedWindow`，默认 6 步）内未出现测量或搜索，pending 作废并
`futile += 1`；任何有效转向或成功测量将其清零。`futile` 达到 `metaAfterFutile`（默认 2）即触发 M。

M 与其余六条在机制上不同：

- **优先级最高**，先于其它信号判定；
- **不占** `maxInjectsPerTurn` 预算 —— 最需要 M 的局面恰恰是预算已耗尽的局面；
- **每 turn 至多一次**，触发它的那一步不夹带其它信号；
- **独立文案**：要求模型先写出已试方案清单、共享假设与一个机制上不同的方案（或明确需要用户补充的
  现场产物），再发起修改类工具调用。

## 干预的优先级与互斥

同一 step 内不叠加陈述同一件事：

- **P 与 F** 同时命中只发 P（补丁链比错误族更接近方案层），F 记为已发；
- **F / P 命中时压掉 B**（「这个错重复了」是弱化版观察），B 记为已发；P **没到**
  `patchChainThreshold` 时不算命中，B 照常开口，不让补丁链在攒够证据前先把话说死；
- **A / B 命中时** C 记为已发，不再补一句「改完没验证」；
- **M** 始终单独成条。

## 幂等与重新武装

同一局面不重复提醒：上次注入后写入序号与错误序号均未变化则沉默。各信号按「什么算局面变了」
分别重新武装：

| 信号 | 重新武装条件 |
| --- | --- |
| A | 一次测量**清掉了相关目录里的盲改**（或测量本身不带目录）才重新武装；在管不到的目录跑测量不算新事实 |
| B | 该 episode 之后发生搜索（之后重新攒够阈值才再报，不是终生免责） |
| C | 一次测量结果返回即解除上膛并清零盲改计数（不论成败）；但只有**成功**的测量才重新武装，失败的测量没带来新事实，现场还在。解除不要求「这次测量清掉了具体文件」：`run_code` 里的写入看不出路径，任何测量都是当时唯一可得的事实，所以带目录的测量同样解除；只有「这个目录里的写入」被清掉才算数的是 A |
| F | 搜索（仅对搜索前出现的指纹免疫），或一次成功测量 |
| O | 同一回路连续两次成功（只重新武装这条回路） |
| P | 一次成功测量，或失败面开始收缩，或一字未变 |
| M | 每 turn 一次；有效转向清 `futile` |

普通信号共享每 turn 预算 `maxInjectsPerTurn`（默认 3）。

## 触发前置与例外

1. **交付态**：`present` 成功返回后闸门休眠，下一次写入唤醒；`present` 失败不休眠。休眠时写
   `suppress … reason=done`，以便区分「醒着但沉默」与「未挂载」。`doneOnPresent: false` 关闭。
2. **用户显式指令**：本 turn 用户原话命中下面这条正则时整 turn 静音。只有 `source.kind === 'user'`
   的消息会被匹配，插件自身注入不计。

   ```js
   /别搜|不要搜|不用搜(?!索)|先别搜|直接改(?!过)|别折腾了|先试试(?:直接改|改)|
    don'?t\s+(?:search|bother\s+searching)|no\s+need\s+to\s+search|
    skip\s+(?:the\s+)?search(?:ing)?|stop\s+searching|
    just\s+(?:do\s+it|edit|fix\s+it|make\s+the\s+change|change\s+it)/i
   ```

   中英双语。每条都要求落在祈使位置：「我先搜一下再改」「我快速试一下这个假设」「不用搜索我也知道
   根因」「这个文件我直接改过了」这类描述性用法**不会**静音 —— 误静音会让整个 turn 失去保护，比
   漏静音一次更贵。`test/sim.mjs` 组 71 用 7 条祈使 + 9 条描述性句子把这条边界钉住。
3. **子会话不生效**：`origin === 'subagent'` 或 `delegationDepth > 0` 一律跳过。
4. **不使用 `reject`**：拦截只表现为追加一条用户消息，不会把 turn 变成 no-op。

## 注入文案

普通信号采用固定骨架（观察 → 至多两条动作 → 恢复条件 → 技能指引），M 使用独立模板。文案的唯一
来源是 `lib/text.js`，运行时注入与面板回填共用同一函数，因此字符 / token 统计不会与真实文案漂移。

M 的完整模板：

```
[better-debug] 元观察：这个 turn 里已经连续 2 次提醒没有换来转向。
这不是「再试一次」能解决的问题了。下一步之前先写三段话（总共不超过 12 行）：
1) 你已经试过的方案清单，以及它们共享的那个假设；
2) 一个机制上不同的方案——换数据结构、换库、换责任层、或先造最小复现再重写，四选一，说明它为什么绕开了之前所有的墙；
3) 如果写不出第 2 条，说明缺的是现场而不是尝试：列出你需要用户补充的一份具体产物（日志 / 最小复现 / 环境信息）。
写完之前不要发起任何修改类工具调用。
```

## 适用范围与边界

**面向编码场景设计与校准。** F 依赖报错文本里的路径与指纹，O / P 依赖可重复运行的验证命令，M 依赖
「存在可建立的反馈回路」。写作、设计、数据分析等任务里「验证」不是一条命令，这些信号不可靠。插件
**不做任务类型识别**，边界由配置划定（`metaGate: false` 关 M，调高 F / O / P 阈值等效于关闭）。

- 「同一文件」按绝对路径判定，删除后重建同名文件仍算同一处；
- 测量判据是启发式正则，误判方向不对称：非测量当测量导致漏报，测量当非测量导致误报；
- 交付态只认成功返回的 `present`，纯文本终稿由 `stuck-gate` 技能的自检兜底；
- 全部状态活在 turn 内，`turn/start` 重置，不做跨 turn 持久化；
- 不判定 no-op 写入：`fs/write-intent` 不含内容，插件层拿不到 diff；
- P 的「失败面」按失败条目集合数出来，收缩要求当前集合是上一轮的真子集。换到**别的文件**一律算
  进展（分头修不同文件不该被说成打转），代价是「在 A 里改、把错推到 B」这种真补丁链也说不出话；
- F 需要能抽出路径。抽不出目标（纯文本报错、只有 `[exit code: 1]`）时只留 B 的记账，不进错误族；
- M 的判据是「连续 2 次注入无转向」，统计基线在小样本下不稳：本机全量 92 个注入 turn 的 futile 率
  是 53.7%，但只看「futile 已达 2 次」的 10 个 turn 只有 30% —— 前者被大量首次注入稀释。看面板时
  别把全局 futile 率当 M 的命中率；
- 重复 episode 只在**连续失败**时累加：`失败 → 绿 → 同一个失败` 是振荡（O 管），不该被说成「同一个
  错重复 N 次」。

## 安装

### 桌面版（DeepSeek Harness 应用）

`desktop` profile 由 Electron 应用独占管理，命令行 `dsh plugin --profile desktop …` 会被直接拒绝
（`error: profile "desktop" is managed exclusively by the Electron application`）。在应用内走
「设置 → 内置插件 → 发现」搜索 `dsh-better-debug` 安装，装完重启应用生效。

### 其他 profile（web / headless / 自建）

`dsh plugin` 把剩余参数原样转发给该 profile 目录里的 pnpm，`--profile` 是必填项：

```bash
# npm registry
dsh plugin --profile web add dsh-better-debug

# 指定版本
dsh plugin --profile web add dsh-better-debug@0.3.6
```

本地 tarball（内容与 npm 包同源，由 `files` 白名单决定；相对路径按**当前工作目录**解析）：

```bash
# 在仓库根执行，产物落在 ./dsh-better-debug-<version>.tgz
npm pack
dsh plugin --profile web add ./dsh-better-debug-*.tgz
```

装完由 `dsh-plugin-manager` 自动把包名追加进该 profile 的 `dsh.profile.bundles`，不需要手改；
包内 `dsh.bundle` 缺失时会退化成普通依赖并给出警告。重启 DSH 生效。

### 手动 link（用于本地修改）

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

> 不要同时使用两种挂法。包内 `cordis.patch.yml` 已含 `- id: better-debug`，重复 id 会被 cordis 拒绝；
> 不同 id 指向同一包则插件挂载两次，提醒与日志翻倍。

### 两个刻意为之的打包决定

**两半的 inject 写法不同，不要互相照抄。**

宿主侧（`lib/index.js`）：`export const inject = []`。cordis 在任一声明服务缺失时会把 epoch 置为
INACTIVE 并跳过 `apply()` —— 无报错、无日志，插件看似已装载实则未运行。因此可选服务（`skills` /
`webServer`）走 `ctx.inject([...], cb)` 动态订阅：服务存在则启用对应功能，缺失只损失可选功能，
闸门照常工作。

客户端侧（`client.js`）：必须 `export const inject = ["slots"]`。浏览器里的插件拿到的是
`dsh-cordis-client-runner` 造的 dynamic facade，它的 get trap 只放行 cordis 的几个动词和**本插件
inject 数组里声明过的服务**；`inject` 自己不在白名单里，取值即抛
`dynamic ctx does not expose "inject"`。旧版写 `typeof ctx?.inject === 'function'` 做防御是无效的 ——
取属性本身就抛，`typeof` 拦不住，于是 `apply()` 在注册座位之前就炸，面板静默消失、日志里一行痕迹都没有。
声明式 inject 在客户端反而安全：服务缺席时 cordis 把 fiber 挂到 waitingFor，不会跳过 `apply()`。

**bundle patch 不含 config。** 市场热挂载只重放纯 insert 行，patch 里出现 `config:` 即被标记为
blocker，用户点「启用」不会有任何反应。默认值全部在 `normalizeConfig()` 中，需要覆盖时写在自己
profile 的 patch 里。

## 配置

在自己 profile 的 `cordis.patch.yml` 中对同一 id 添加 `config:` 块：

```yaml
- id: better-debug
  name: dsh-better-debug
  config:
    enabled: true
    repeatEditThreshold: 3        # A：同一文件连续改几次算盲改（2–20）
    repeatErrorThreshold: 2       # B：同一 episode 错几次算打转（2–20）
    noVerifyWrites: 3             # C：盲改几处还没测量才上膛（1–20）
    maxInjectsPerTurn: 3          # 单轮普通提醒预算（1–10，M 不受限）
    changedWindow: 6              # 注入后的转向观察窗口（1–30 步）
    repeatFamilyThreshold: 4      # F：错误族累计次数（3–20）
    familyMinFingerprints: 3      # F：族内不同指纹数（2–10）
    oscillationThreshold: 3       # O：第几次翻转触发（2–10）· 实验性
    patchChainThreshold: 3        # P：连续几轮失败—写入（2–10）· 实验性
    metaAfterFutile: 2            # M：连续几次无效注入（1–5）
    metaGate: true                # M 总开关
    decayEditsOnVerify: true      # 测量后解除 C 的上膛并清零盲改计数（C:/、/c/、/mnt/c/ 视为同一目录）
    doneOnPresent: true           # present 成功后休眠
    measureCommands: ""           # 覆盖测量命令正则；空 = 内置清单
    measureIntent: ""             # 覆盖测量意图正则
    excludePaths: ""              # 覆盖盲改排除路径正则
    logFile: "~/.dsh/logs/better-debug.log"
    logMaxBytes: 2097152          # 单文件上限（64 KiB–64 MiB），到量轮转
    logKeep: 2                    # 保留几份历史（1–9）
    panel: true                   # 只读面板路由
```

数值越界会被取整后夹到边界值；三个正则键传入非法正则会回退内置默认并记 warn；`enabled: false` 时
不注册任何 listener。

`logFile` 的四种取值：

| 写法 | 行为 |
| --- | --- |
| 不写 | `$DSH_HOME/logs/better-debug.log`（未设 `DSH_HOME` 时为 `~/.dsh/logs/better-debug.log`） |
| `"~/my.log"` | 展开家目录 |
| 绝对路径 | 原样使用 |
| `""` 或 `false` | 显式关闭落盘（面板将无数据） |

写端到 `logMaxBytes` 就把当前文件挪成 `better-debug.log.1`，更老的依次后移，超过 `logKeep` 份的最老
一份直接丢弃。读端不每次请求重读全文：它记住 `ino` / `size` / `mtime`，只解析新追加的完整行；文件
变小、被换掉或 `mtime` 回退时整体重来。`api` 里的 `bytes` 始终是文件总字节数。

## 日志与面板

日志是唯一的验收面：`ctx.logger` 只进宿主进程 stdout，事后无法检索，因此所有关键事件都有落盘行型。
加载成功必有一行：

```
apply pid=… logFile=… A=3 B=2 C=3 budget=3 window=6 panel=true F=4/3 O=3 P=3 M=2/1 logMax=2097152 logKeep=2
```

**没有 `apply` 行即未挂载。** 其余行型：

```
inject   session=… turn=… step=… signals=A inj=78ed6bc3 chars=… tokens=… blind=… files=… worstEdits=… worstStreak=… worstErrors=… searched=… measured=…
outcome  session=… inj=… after=A first=ops_bash class=verify steps=1 before=write
measure  session=… tool=ops_bash ok=false exit=1 cleared=1
change   session=… inj=… after=A tool=ops_bash class=verify steps=1
futile   session=… inj=… after=A count=1 window=6
arm      session=… turn=… writes=3
suppress session=… reason=done
```

判读要点：`worstStreak` 才是 A 的判据（自上次测量以来的连续盲改），`worstEdits` 只是 turn 内累计；
`outcome` 仅记录第一条后续动作，**是否真正建立回路要看 `measure` 行**；`change` 行的 `steps=` 给出
转向延迟；M 的 inject 行额外带 `futile=N`。

面板位于 **设置 → better-debug**（或 `http://<web-origin>/better-debug`），只读、5 秒自刷新，展示触发
分布、覆盖会话、提示后首个动作、测量回路、窗口内转向率与中位步数、方案层阈值与 futile 累计。
`panel: false` 可关闭路由，不影响闸门。

**路由复用宿主的准入闸**：每个请求先过 `ctx.get('connection').requestRejection(req)`，与官方插件同一条
判据 —— Host 必须是回环 / 绑定地址（否则 403），且必须持有浏览器会话 cookie 或 API 凭据（否则 401）。
面板 JSON 里有会话 id、报错原文样本与日志绝对路径，宿主经公网 relay 转发时，这层闸是唯一的边界。
服务在**每次请求时**查而非注册时缓存（cordis 的服务就绪顺序不保证）；宿主没有 `connection` 服务时
（headless profile）退化为恒放行。

两项措辞纪律：

- 「提示后首个动作」是**描述性统计**，不证明提醒促成了改变；因果暗示的指标名已弃用。
- 早于埋点的旧日志没有分母，转向率显示为「这段日志早于 v0.2 埋点」而非 0%；老日志缺少方案层字段时
  显示 `—`，不编造默认值。面板不估算「节省的 token」—— 要证明增益需要对照组或历史回放，两者均不在
  其职责内。

## 自带技能

`assets/stuck-gate/SKILL.md` 注册为 bundled 技能（rank 600），注入文本末尾的「完整五条」即指此文件。
它负责提示词层的五步法（建回路、搜索、最小化、可证伪假设、换层），与插件相互独立：插件负责
「想不起来的那一刻」，技能负责「想起来后做什么」。

用户可在 `~/.dsh/skills/stuck-gate/SKILL.md`（rank 400）放同名文件覆盖默认文案，数值小者优先，无需
修改代码。宿主无 `skills` 服务时注册跳过并记日志，闸门不受影响。

## 本地验证

```bash
node test/sim.mjs           # 345 个用例：闸门语义、四套 runner 语料、可移植性
node test/panel.mjs         # 100 个用例：日志解析、聚合、世代判定、埋点、准入闸
node test/client.mjs        # 16 个用例：客户端 facade 契约（inject 声明、座位注册）
node scripts/judge-health.mjs test/fixtures/better-debug.sample.log   # 判据体检（样本日志应全 PASS）
npm run test:posix          # 以 POSIX 路径语义重跑 sim + panel
npm run test:linux          # 以 Linux 平台语义（区分大小写）重跑
npm run test:slow           # 落盘延迟 400ms，验证「等条件」而非「等时长」（101 条）
npm run verify              # 全部（含语法检查、死代码、发布契约）
npm run judge-health        # 拿真实日志算四个数：0 健康 / 1 越界或无数据 / 2 读不到日志
```

`npm run judge-health` 是给自己用的：它把「C 是不是又在替别的信号开口」变成四个可断言的数
（C 占比 ≤35%、arm 清掉率 ≥60%、C 命中率 ≥25%、C futile 率 ≤30%）。arm 清掉率把每条 `arm` 行与
同 session 的下一条 `measure` 配对，问那次测量到底有没有把写入清掉；没有后续测量的 `arm` 不进分母。
默认读 `$DSH_HOME/logs/better-debug.log`，换机器或换模型后先跑一遍看基线，再决定阈值要不要动。
加 `--since-apply` 只判当前这份代码写出来的行 —— 旧行是旧判据轴产生的，会把每个比例都带偏。

退出码三态：`0` 至少一个判据真的判过且没有越界；`1` 有判据越界，**或者四个判据全部因样本不足跳过**；
`2` 日志读不到（路径写错、文件还没生成）。全 SKIP 与「四个数都在阈值内」不该给同一个码 ——
`test:unit` 用 `&&` 串着它，全 SKIP 也 exit 0 等于把「没测」记成「测过了」。
只有部分判据跳过、其余判过的仍在阈值内的，仍然 exit 0。

`test/client.mjs` 把浏览器侧那条最难复现的约束钉在仓库里：客户端插件拿到的是
`dsh-cordis-client-runner` 造的 dynamic facade，不是 cordis Context。测试用一个会抛错的
`inject` 属性复刻那个 get trap，只要有人把 `ctx.inject([...], cb)` 的动态订阅写回 `client.js`，
或者把 `inject` 改回空数组，它立刻变红 —— 不需要装 DSH，也不会随宿主版本漂移。

测试以假 ctx 复刻 agent-loop 的调用顺序，**不依赖 DSH 运行时**。每条信号都有正例与反例：测量两态、
episode 归属、C 的两段式、重新武装、交付态、F 的族判定与 B 抑制、O 的交替振荡 / 健康 TDD / flaky、
P 的链计数与重跑排除、M 的触发 / 独立性 / 开关，以及七条信号各自配置键的正反例。

CI 在 Ubuntu / Windows / macOS × Node 20 / 22 / 24 上跑语法检查、死代码扫描、发布契约校验与全量
测试，最后把 `npm pack` 的产物解包再自测一遍 —— 装进用户的路径与在仓库里跑测试是两件事。

## 设计依据与相关工作

插件不实现规划或推理算法，所有判据都是事件流上的可复现启发式。但它要检测的失效模式有明确的理论来源 —— 下面按「概念 → 文献 → 对应信号」列，说明每个信号为什么值得看。

### over-commitment / blind commitment

意图一旦形成就带有承诺。Cohen & Levesque（*Artificial Intelligence* 42, 1990）把意图形式化为「带承诺的选择」：承诺是意图能驱动行动的原因，也是它难以撤回的原因。承诺在环境变化后不再被证据支持、却继续按原计划推进，就是 over-commitment；当它表现为「不问证据、只按惯性推进」时是 blind commitment。

工程上的形态是三种：反复改同一个位置却从不跑验证（A）、同一个错误反复撞（B）、改完不测就往下走（C）。这三条都不需要理解模型在想什么 —— 只看工具调用序列里「写入」与「验证」的相对位置。

Tewari（arXiv:2611.19663, 2026）把「该修、该重来、还是该放弃」做成阈值理论：最优策略取决于有效破坏深度，浅则修、深则重规划、连新计划都不值就放弃，没有任何单一策略占优。这解释了插件为什么从不预设「应该修还是应该重来」——它只负责把证据摆到模型面前。

### Einstellung effect

Luchins（*Psychological Monographs* 54(6), 1942）的水罐实验：先解过一串同构题的被试，遇到有更简解的新题时仍套用旧解法。这不是能力不足，是成功经验形成的定势 —— 熟练反而更容易犯。

失效形态有两种：把上次奏效的做法原样搬到形状不同的新问题上（F，错误族 —— 指纹去重后看不同错误是否有共同结构）；同一组验证在通过和失败之间来回翻转（O，振荡）。

判据刻意看「形状」而不是「次数」：F 按指纹去重后看不同指纹的共同结构，O 看同一组验证条目在两次测量间的交集。因为 Einstellung 的特征是「换了题还在用旧解」，不是「错了很多次」。

### intention reconsideration

意图要稳定到足以指导行动，又要在环境变化时被重新考虑，这两件事互相拉扯。Cariani（*Philosophical Studies* 182, 2024）把这套张力整理成结构化说明：什么时候该重考虑、重考虑什么、由谁触发。

插件的立场是：重考虑不该由模型自己触发 —— 它正是被承诺绑住的那一方。所以干预点固定在 `agent/pre-step`，即下一步动作之前，把「要不要继续」从默认继续改成一个显式选择。M（元闸门）处理更极端的情形：已经提醒过、模型还是照旧 —— 这时问题不在具体动作，在提醒本身不够，于是升级到「质疑方法」而不是「改下一行」。

### 计划修复与重规划

Nebel & Koehler（*Artificial Intelligence* 76, 1995）证明保守的计划复用在最坏情况下并不比从头规划更省，复用本身也可能更难；Fox 等（ICAPS 2006）提出 plan stability 并实证比较两种策略。P（补丁链，实验性）对应「修复次数累积后应转向重建」的维护规则，arXiv:2611.19663 把它形式化为 patch debt 与 commitment hysteresis。

### 元认知监控

Flavell（*American Psychologist* 34, 1979）把认知监控定义为对自身认知过程的觉察与调节。自我监测在压力下失效正是引入外部监控的动机；插件充当 harness 层的外部元认知 —— 检测不依赖模型自觉，干预也先于下一步动作而非事后复盘。

### 这些文献在代码里的位置

文献提供的是失效模式的分类，不是阈值的推导。21 个配置键里的每一个数值都来自事件流的可观测统计，没有一个是「按文献算出来的」。文献只回答一个问题：为什么要看这几件事。

## 已知问题

[KNOWN-ISSUES.md](./KNOWN-ISSUES.md) 是**未解决问题**的留档：面板的六条 P2、脚本与工程的三条、
结构性判据缺陷（O / P / F 为什么几乎不触发）、信号价值的实测结论，以及明确决定不修的五条。

三份文档的分工：「适用范围与边界」（本节上面）写的是**设计上接受的边界**，KNOWN-ISSUES 写的是
**实现上尚未修掉的问题**，CHANGELOG 写的是**已经修掉的问题**。

## 变更记录

[CHANGELOG.md](./CHANGELOG.md) 按版本记录行为变化与根因（0.3.6 起开始维护，更早的版本由 git 历史回补）。
0.x 阶段的次版本号可能包含行为改变，升级前请看一眼对应小节。

## License

MIT
