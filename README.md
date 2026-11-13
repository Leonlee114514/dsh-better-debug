# dsh-better-debug

把「卡住闸门」从自觉条款变成代码闸门。

`AGENTS.md` 里的五条闸门与 `stuck-gate` 技能都是**提示词层**的约束——模型得先想起
「我卡住了」，条款才开始生效。可卡住时的典型症状恰恰是**想不起来**：于是它写第 3 个
「再试一次」、吃第 4 遍同一个报错、改完代码不跑任何验证。这个插件不看模型说了什么，
只看它做了什么；一旦行为符合「原地打转」，就在**下一步之前**塞一句话进去。

## 三个信号（v0.2 语义）

| 信号 | 触发条件 | 默认阈值 | 为什么是它 |
| --- | --- | --- | --- |
| **A** 同一文件**连续盲改** | `fs/write-intent` 按绝对路径计数；**一次真测量返回结果后**才清零该目录下的计数 | 第 **3** 次 | 单点反复摩擦且中间夹不进新事实，才是「没建回路就在猜」 |
| **B** 同一**操作**反复吃错 | `tool/result` 按 `工具\|目标\|错误指纹` 组成 episode 计数；该 episode 之后搜过才免疫 | 第 **2** 次 | 同一个错两次说明第一次没读懂；按 episode 判，不会被别处的搜索免单 |
| **C** 改完**又动手**却没回路 | 写入后过 N 步没测量 → 只**上膛**（`arm` 行），**下一次写入之前**才提醒 | **2** 步 | 改完就跑下一处是最常见的漏验证；但阅读阶段不该被打断 |

三条的判据都建立在「**测量**」这个概念上，而不是「调用了某个工具」。

### 什么算一次测量

「工具被调用」≠「测量完成」。这是 v0.1 最大的漏洞：`edit → ls → edit → edit` 里那个
`ls` 会把盲改计数洗白，于是真打转反而不响。

v0.2 拆成两态：**测量意图**（`tool/call` 时按参数判）与**测量结果**（`tool/result` 回来后
才记账）。只有结果回来才清零，并且只清与该命令目录相关的文件——在 `C:/other` 跑一遍
`npm test` 不该洗掉 `C:/work/src/target.js` 的盲改计数。

| 类别 | 工具 | 判据 |
| --- | --- | --- |
| 硬测量 | `lsp_diagnostics` `verify` `run_tests` `run_test` | 恒为测量 |
| 软测量 | `ops_bash` `bash` `shell` `pwsh` | 命令命中 `measureCommands`，或描述命中 `measureIntent` 且命令不是 `ls/dir/cat/type/head/tail` |
| 搜索 | `web_search` `research` `advanced_search` `multi_search` `platform_search` `domain_search` `cache_search` `video_search` | 命中即视为取得外部先验 |
| 方法论 | `skill` | 加载方法论算有效转向，单独计数，不混进 `other` |
| 编辑 | `edit` `write` `ops_write` `str_replace` `apply_patch` `notebook_edit` | |

**失败的测试仍然是有效测量**：它给出了「错在哪一行」这个新事实。`[exit code: 1]` 一样清零、
一样算回路，面板里只把 `ok` 记成 `false`。

`DEFAULT_MEASURE_COMMANDS` 认：`npm/pnpm/yarn/bun` + `test|verify|check|lint|typecheck|build`、
`node --test`、`pytest`、`vitest`、`jest`、`mocha`、`go test`、`cargo test`、`dotnet test`、
`tsc`、`eslint`、`ruff check`、`mypy`、`git diff --stat`。任务类型不是代码时用
`measureCommands` 换成自己的正则（词数统计、段数检查都行）。

**生成物不计入盲改**：`node_modules`、`dist`、`build`、`out`、`coverage`、`.git`、`.next`、
`.cache`、各类 lock 文件、`*.log` / `*.map` / `*.min.js` 由 `excludePaths` 排掉。

### 错误 episode（B 的 key）

```
工具名 | 目标 | 错误指纹
```

- **目标**是报错正文里第一个像路径的东西（`C:/work/a.js`），行号归一成 `<n>`；
- **指纹**是归一化后取首 6 行 / 前 300 字符的 sha256 前 16 位，`0x1f3a2b9c`→`<hex>`、
  路径→`<path>`、`42`→`<n>`。

所以「行号变了但异常类没变」仍算同一个 episode，而**两个不同文件各错一次 ENOENT 不算**。

## 不做的事

- **不做「我猜是」措辞检测**：插件看不见模型的内心独白，这条留给 `stuck-gate` 技能自检。
- **不做 no-op 写入判定**：`fs/write-intent` 拿到的只有 freshness token（`FsVersion` 或
  `createIfAbsent`），不含内容，插件层拿不到 diff。
- **不做收尾探针清零**：归 `dsh-turn-cleanup`。
- **不用 `reject`**：那会把整个 turn 变成 no-op。只往 `messages` 尾部追加一条 user 消息。
- **不对子会话生效**：`header.origin === 'subagent'` 或 `delegationDepth > 0` 一律跳过，
  它们的 cwd 可能是别人的工作区，计数也没有可比性。

## D 段例外

`AGENTS.md` 的 D 条：用户显式说「别搜了 / 直接改 / 快速试一下」时闸门不落。
插件用**本 turn 用户原话**实现这条——命中 `/别搜|不要搜|不用搜|先别搜|直接改|快速试|别折腾|先试试/`
就整 turn 静音。只认 `source.kind === 'user'` 的消息，插件自己注入的不算。

## 幂等与重新武装

不是「每类信号每 turn 一次」——那会让长 turn 的第二阶段永远没人管。v0.2 是**每个卡住
episode 一次**：

- 同一局面不重复（`lastFireMark` 的写序号与错序号都没变就再不开口）；
- **有效测量之后重新武装**：`fired.A/C` 归零，同一 turn 里新的盲改可以再被提醒一次；
- **每 turn 总预算** `maxInjectsPerTurn`（默认 3），防止变成连击。

A/B 触发时会顺带把 C 标成已触发：A/B 已经说明了局面，再补一句「改完没验证」只是换个说法。

## 触发前置

闸门只管「下一次尝试之前」，不管「交完货之后」。命中信号也先过三道前置：

1. **done-state**：本 turn 出现过 **`present` 且结果成功**（`isError !== true`）→ **不注入**。
   写一行 `suppress … reason=done`。**`present` 失败不休眠**——交付物没挂出去，闸门得继续醒着。
   下一次 `fs/write-intent` 会把 done 复位。关掉：`doneOnPresent: false`。
2. **有回路的收敛**：见上面「什么算一次测量」。关掉：`decayEditsOnVerify: false`。
3. **任务类型**：写作 / 词数校准 / 版式收敛没有报错与失败测试，回路是一条能给出数字的
   校验命令；注入文案已改成任务中立。

边界：代码层只能认 `present` 这个动作。**纯文本终稿（没有 `present`）** 只能靠
`stuck-gate` 技能里的 done-state 自检覆盖——两层互补，别指望插件读模型心思。

## 注入文案

```
[better-debug] 观察到的重复动作（只是观察，不是结论）：
- 同一个文件连续改了 3 次，中间没有任何测量。
下一步（挑一条就够）：
1) 建一条几秒能跑完、能给出数字或事实的回路（失败测试 / 复现命令 / 一条断言 / lsp_diagnostics）；建不出来就停下要现场产物。
恢复条件：拿到一条新的测量结果或一条外部事实后，继续动手即可。
完整五条：skill `stuck-gate`。
```

三条纪律：

1. **只陈述观察，不替模型下诊断**。原来那句「检测到你在原地打转」是在替它定性，现在改成
   「观察到的重复动作（只是观察，不是结论）」。
2. **最多给两条动作**。多给等于没给。
3. **一定给恢复条件**。「怎么才能继续」比「你错了」有用。

文案的唯一来源是 `lib/text.js`，`index.js`（注入）与 `panel.js`（老日志回填字符数）共用它，
所以面板的字符估算不会与真实文案漂移。

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

## 观测面板

日志只有一种人爱读，就是写它的人。面板把它变成一眼能看的东西：**设置页 → better-debug**，
一个 iframe 视图，5 秒自刷新，只读，不改插件行为。

四张主卡：

| 卡 | 数据来源 | 能说明什么 |
| --- | --- | --- |
| 闸门触发次数 | 每条 `inject` 行 | 提醒一共说了几次，按 `A/B/C` 与组合标签分组 |
| 覆盖会话 | `inject` 行的 `session=` 去重 | 影响了多少个会话、多少个轮次、注入文本共多少字符 / token |
| **提示后首个动作** | `outcome` 行的 `class=` | 提醒之后第一条 `tool/call` 是什么类别。**描述性的，不证明因果** |
| **测量回路（硬证据）** | `measure` 行 | 真正的测量发生了多少次、成功几次、失败几次、清掉了哪些盲改计数 |

外加三个分布：信号分布、提示后首个动作六类、**窗口内是否真的转去取得新事实**
（`change` 行，含中位步数）。

### 指标措辞纪律

这是 v0.1 面板最容易误导的地方，v0.2 明确拆开：

- 「换动作率」这个名字**删掉了**。它算的是「提示后第一个工具属 verify/search 的比例」，
  既不能证明提示促成了改变，更不能证明它帮你发现了缺陷——模型本来也可能这正是它下一步。
  现在叫 **「提示后首个动作」**，字段名 `firstAction`。
- 想知道「窗口内有没有转去取得新事实」，看 `turned`（只从 `change` 行算，有真中位步数）。
  真正的 `medianSteps` 在这里才有样本——v0.1 那个恒为 `null`，因为 outcome 在下一步就写、
  步差永远是 0。
- **老日志不会被算成「0% 转向」**。v0.1 的 `inject` 行没有 `inj=`，也就不可能有 `change` /
  `measure` 行；这时「转向 0 次」是**没测**，不是「测了没有」。`turned.observed` 是分母，
  只数埋点上线后的注入，`rate` 在 `observed = 0` 时是 `null`，面板显示「这段日志早于
  v0.2 埋点」。真实日志里 55 次注入全是老格式，`observed = 0` —— 面板现在会这么说，
  而不是拿 49 条 outcome 当分母报一个 0%。
- 「这些数字不证明什么」直接印在页脚：要证明增益，需要对照组或历史回放，面板两个都不做。
- **不估算「省掉了多少 token」**。插件的职责是把可观测的事记下来，把判断留给看的人。

### 为面板新增的埋点

每次注入分到一个 `inj=`（8 位哈希），后续几行都带着它，于是同一次提醒的全生命周期可串起来：

```
inject  session=… turn=39 step=88 signals=A inj=78ed6bc3 chars=309 tokens=271 files=1 worstEdits=3 worstStreak=3 worstErrors=0 searched=false measured=no
arm     session=… turn=39 gap=2
outcome session=… turn=39 inj=78ed6bc3 after=A first=ops_bash class=verify steps=1 before=write
measure session=… turn=39 tool=ops_bash ok=false exit=1 cleared=1
change  session=… turn=39 inj=78ed6bc3 after=A tool=ops_bash class=verify steps=1
suppress session=… turn=39 reason=done
```

- `outcome` 只收**第一条**后续 `tool/call`：晚到的验证不能把早先的原地打转洗白。
  `before=` 是提醒前的上一条动作（写入也计入，所以常见值是 `write`）。
- `change` 只在注入后的 `changedWindow`（默认 6）步内写，窗口外自动丢弃。
- `measure` 每次测量结果都写，带 `ok` / `exit` / `cleared`（清掉了几个文件的计数）。
- 老日志没有 `chars=` 时，解析器用 `lib/text.js` 的 `charsFor(signals)` **真算一遍文案长度**，
  v0.1 那张硬编码常量表（`A=254` 等，与真实文案差约 50 字符）已删除。

### 关掉面板

`config: { panel: false }`。路由不挂，`/better-debug` 返回 404，闸门不受影响。

路由用 `ctx.inject(['webServer'], …)` **动态注入**，没有加进 `export const inject` ——
后者是结构性变更，会让热重载失效，也会让没有 `webServer` 的宿主连闸门都装不上。
宿主缺 `webServer` 时日志写一行 `panel unavailable: …`，挂载抛错写 `panel register failed: …`，
面板会把它显示出来。

## 安装

**快装（从 Release tarball，pnpm 会把它当普通包装进 profile）：**

```bash
dsh plugin add https://github.com/Leonlee114514/dsh-better-debug/releases/download/v0.2.0/dsh-better-debug-0.2.0.tgz
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
#    注意：**不要加 `inject: [skills]`**，见下面「为什么不用静态 inject」。
#    包内那行也**故意不带 config**，见「为什么 bundle patch 里没有 config」。

# 4. 重启 DSH。
```

> **别同时用两种挂法。** 包内 `cordis.patch.yml` 已有一行 `- id: better-debug`；如果你又在
> profile 里手写同 id 一行，cordis 会 reject 重复 id。两行 id **不同**但指向同一包名更糟：
> 插件被挂两次，每句提醒注入两遍、每行日志写两份。

### 为什么不用静态 inject

`export const inject` 是空的，`cordis.patch.yml` 里也不写 `inject:` —— 这都是刻意的。

cordis 的 `Fiber._refresh()` 只要声明的服务里**有一个拿不到**，就把 epoch 置成 `INACTIVE`
并直接不执行 `apply()`：没有报错、没有日志、面板里看起来装好了，实际一行代码都没跑。
而 loader 还会把 YAML entry 的 `inject:` 合并进依赖集
（`cordis-plugin-loader`：`Inject.resolve(entry.options.inject, fiber.inject)`），
所以光改代码不够，配置里的那行同样会把插件卡死。

`skills` 由 `@deepseek-ai/dsh-skill` 提供。裁剪过的 profile、别的发行版、或者只是没启用
那个包时，它就不在——而闸门根本不需要它。两个可选服务（`skills` / `webServer`）一律走
`ctx.inject(['skills'], cb)` 动态订阅：服务在就挂上，不在就少一个可选功能。

面板同理：`client.js` 在 `slots` 不在时自己跳过注册，不影响闸门。
想看面板就打开 **设置 → better-debug**，或直接访问 `http://<web-origin>/better-debug`。

### 为什么 bundle patch 里没有 config

包内的 `cordis.patch.yml` 只有两行 `id` + `name`，一个配置键都不写。原因是
DshMarket 的热挂载只重放**纯 insert 行**：

```js
// dshmarket/lib/hot.js
export function parseSimplePatch(patchText) {
  const scan = scanPatch(patchText)
  return scan.blocker === null ? scan.rows : null   // 一遇到别的键就 null
}
```

`scanPatch()` 撞上 `config:` 就停下并把整份 patch 标成 `blocker: 'config'`，
市场于是给用户看「bundle patch 里有 config 块,热挂载只重放纯 insert 行;重启后由
bundle 层按原样加载」。也就是说：**写了 config，用户点「启用」不会有任何反应，
必须重启 DSH**——新用户最容易在这一步以为插件坏了。

每个默认值本来就已经在 `lib/index.js` 的 `normalizeConfig()` 里，那份 config 块
只买到"自我文档"这一个好处，代价却是新手看不到任何反馈。所以默认值留在代码里，
需要在 profile 里覆盖时再写 config——profile 那一行不参与包的热挂载，写什么都行。

## 配置

全部默认值写在 `lib/index.js` 的 `normalizeConfig()` 里，装上就能跑。要改就在
**自己 profile 的** `cordis.patch.yml` 里写同一 id（`- id: better-debug`）并加
`config:` 块覆盖——不要改包内那份（下次升级会被覆盖，而且带 config 会让市场无法热挂载）：

```yaml
- id: better-debug
  name: dsh-better-debug
  config:
    enabled: true
    repeatEditThreshold: 3        # A：同一文件连续改几次算盲改
    repeatErrorThreshold: 2       # B：同一 episode 错几次算打转
    noVerifySteps: 2              # C：改完几步没测量才「上膛」
    maxInjectsPerTurn: 3          # 单轮最多提醒几次
    changedWindow: 6              # 注入后多少步内算「转向」窗口
    decayEditsOnVerify: true      # 测量后清零连续盲改计数（false = 旧行为）
    doneOnPresent: true           # present 成功后休眠，下一次写入重新武装（false = 旧行为）
    measureCommands: ""           # 覆盖「什么命令算测量」的正则；空 = 内置清单
    measureIntent: ""             # 覆盖「描述里出现什么算测量意图」的正则
    excludePaths: ""              # 覆盖「哪些路径不算盲改」的正则
    logFile: "~/.dsh/logs/better-debug.log"  # 支持 ~ 展开；不写就默认这个位置
    panel: true                   # 挂 /better-debug 只读面板；false = 不挂路由
```

调紧（更容易触发）→ 数字调小；放松 → 调大。`enabled: false` 时连 listener 都不注册。
三个正则键传坏正则会**回退到内置默认**并记一行 warn，不会把插件弄死。

`logFile` 的四种写法：

| 写法 | 落到哪 |
| --- | --- |
| 不写这个键 | `$DSH_HOME/logs/better-debug.log`（没设 `DSH_HOME` 就是 `~/.dsh/logs/better-debug.log`） |
| `"~/my.log"` | 展开成家目录下的 `my.log`（`~` 和 `~/x`、`~\x` 都认） |
| `"C:/x.log"` / `"/var/log/x.log"` | 原样使用 |
| `""` 或 `false` | **显式关闭落盘**。`ctx.logger` 只进 Electron stdout，事后 grep 不到，面板也就没有数据 |

默认不落盘曾经是 v0.1 的行为，代价是新用户装完打开面板看到四张空卡，
以为插件没工作。现在开箱就有数据。

## 怎么验证它真的在工作

1. 装好重启后，日志默认就在 `$DSH_HOME/logs/better-debug.log`，不需要配置。
   想换位置就设 `logFile`。
2. 加载即有一行 `apply pid=… logFile=… A=3 B=2 C=2 budget=3 window=6 panel=true`——
   **这一行是唯一能证明「插件到底加载了」的证据**（`ctx.logger` 只进 Electron stdout，
   事后 grep 不到）。没有 `apply` 行就是没挂上。
3. 正常干活，日志出现这样一行即为命中：
   ```
   inject session=… turn=32 step=98 signals=A inj=78ed6bc3 chars=309 tokens=271 files=1 worstEdits=3 worstStreak=3 worstErrors=0 searched=false measured=no
   ```
   `signals` 是命中的信号（`A`/`B`/`C`，多条用 `+`）；`files` 是本 turn 碰过的**不同文件数**、
   `worstEdits` 是累计改了几次，**`worstStreak` 才是 A 真正用的判据**（自上次测量以来的
   连续盲改次数）。三者混着看：`files=1 worstEdits=3 worstStreak=1` 说明中间夹过测量，不该响。
   `suppress … reason=done` 表示闸门醒着但处于交付态，故意不出声。
   `arm … gap=2` 表示 C 只上了膛、还没开口（它在等你下一次写入）。
4. 自证指标**不要**看「下一动作是不是 verify」。要看两件事：
   - `measure` 行有没有出现（这是硬证据：真的测了）；
   - `change` 行的 `steps=`（隔了几步才转去取得新事实）。
   如果只有 `outcome` 没有 `measure`，说明模型只是换了个工具，没真的建立回路。

## 本地验证

```bash
node --check lib/index.js && node --check lib/panel.js && node --check lib/text.js && node --check client.js
node test/sim.mjs           # 37 个用例：闸门语义 + 可移植性
node test/panel.mjs         # 32 个用例：日志解析、聚合、埋点落盘
npm run test:posix          # 把上面两套用 POSIX 路径语义再跑一遍
npm run verify              # 上面全部（含语法检查）
```

`test/sim.mjs` 用假 ctx 复刻 agent-loop 的调用顺序（`emitPlain` / `emitWaterfall`），
覆盖 **37 个用例**。

语义层（每条都有正例 + 反例）：

- **测量意图 / 结果两态**：`edit → ls → edit → edit` 仍触发；只 call 不 result 不清零；
  失败的测试不算盲改；无关目录的测量不清目标文件的计数。
- **B 的 episode**：同目标同指纹才累计；两个不同文件各错一次 ENOENT 不触发；
  episode 之后搜过才免疫（先搜过别的问题不免疫）。
- **C 的两段式**：改完只在读东西不打断；上膛后又动手才开口。
- **重新武装**：A 提醒 → 有效测量恢复 → 新阶段再盲改允许第二次；受每 turn 预算约束。
- **交付态**：`present` 成功后不注入；**`present` 失败不休眠**。
- 措辞只陈述观察、锁文件不计入、D 段静音、子会话跳过、阈值可调、
  `decayEditsOnVerify: false` 反例可回滚、`enabled: false`、自带技能注册与正文去私有化、
  宿主无 `skills` 服务不抛、导出形状，以及 13 项分类/判据/指纹单测。

**不依赖 DSH 运行时**，改动后先跑它。

### 为什么有 `test:posix` 这一轮

`test/sim.mjs` 里的路径全是 `C:/work/...` 这种 Windows 方言。它在一台 Linux 机器上照样
能跑，但跑的是**另一套语义**——这正是 v0.2 之前的一个真事故：

`node:path` 的 `isAbsolute` 是平台相关的，`isAbsolute('C:/work/a.js')` 在 Linux/macOS 上
返回 `false`。入口闸用它筛写入路径，于是那些机器上**所有写入被静默丢弃**，A / C 两个信号
完全不工作，而 Windows 开发机上一片绿。修法是不再问操作系统「这个根像不像我」，只问
「它是不是从根开始的」（`isAbsPath`）。

`test/posix` 用 `node --import` 的 resolve hook 把 `node:path` 换成 `node:path/posix`，
然后**把两套用例原样再跑一遍**——这样 Windows 开发机也能复现 Linux 的路径语义。CI 在
ubuntu / windows / macos × node 20 / 22 上跑 `npm run verify`，所以这条不会退回去。

同一类问题的另外三处，都在 v0.2 修掉了：

| 症状 | 根因 | 现在 |
| --- | --- | --- |
| Linux/macOS 上闸门完全不响 | `isAbsolute` 平台相关 | `isAbsPath` 两种方言都认 |
| 装完面板四张卡全 0 | 默认 `logFile: ""` 不落盘 | 默认落 `$DSH_HOME/logs/better-debug.log` |
| 插件静默不加载，无报错无日志 | 静态 `inject: ['skills']` 缺服务时 `apply()` 整个不执行 | `inject = []`，走 `ctx.inject` 动态订阅 |
| 市场点「启用」没反应 | bundle patch 带 `config:` 块 | patch 只留 `id` + `name` |

**大小写折叠按平台判**（`CASE_INSENSITIVE`）：只在 `win32` / `darwin` 上折叠。折叠错了的
后果不对称——该折叠却不折叠是漏报，不该折叠却折叠是**误报**（狼来了），后者才是这道闸门
最不能犯的错。macOS 上装了区分大小写的 APFS 会少报一点，仍然是安全方向。

`test/panel.mjs` 覆盖 **32 个用例**：带引号与转义的字段切分、六种行型解析（`inject` / `outcome` /
`change` / `measure` / `arm` / `panel-failed`）、`charsFor` 与真实文案长度零漂移（6 组信号组合）、
`worstStreak` 在日志→解析→聚合→面板全链路保留、`suppress` 与 `arm` 行可解析且不计入触发、
聚合出的 `firstAction` / `turned` / `measures`、**断言 v0.1 的旧字段名
`changed` / `changedRate` / `outcomes` 不得复活**、阈值取最后一条 `apply`、空日志与坏行不抛，
以及端到端——真跑 `apply()` 走完一个 turn，读回日志断言 `inject` 带 `inj=`、
`outcome` 带 `before=write`、`measure ok=false exit=1`、`change` 行都写了且被聚合。

## 已知边界

- 「同一文件」按**绝对路径**判定。删了重建同名文件也算同一处——这通常是对的（说明在同一个
  概念上打转），但如果只是反复改生成文件，用 `excludePaths` 排掉或把 `repeatEditThreshold` 调大。
- **测量判据是启发式的**：`ops_bash` 跑的是不是真测量，靠 `measureCommands` / `measureIntent`
  两个正则猜。猜错的代价现在是不对称的——把非测量当测量会漏报，把测量当非测量会误报。
  默认清单偏向「宁可误报也不漏报」，因为你看到提醒后自己判断的成本很低。
- `done-state` 认的是**成功返回的** `present` 调用，不是「模型说了一句收尾话」。纯文本终稿靠
  `stuck-gate` 技能的 done-state 自检兜底；若某类任务从不调 `present`，
  把 `doneOnPresent: false` 关掉更省心。
- 只在**主会话**生效。多 agent 场景下每个 subagent 各自打转不会被拦——但它们的产物最终
  汇到 lead，lead 这边的计数仍然有效。
- 面板是**只读的日志视图**，不是监控：它不写任何数据，也不改变闸门判定。只有显式写
  `logFile: ""` 关掉落盘时，面板才会只剩「没有数据」，一切统计为 0。
- `firstAction` 的分母是「已被观察到的注入」。注入后 turn 直接结束（没有后续 `tool/call`）
  不计入，样本少时波动很大——看量级，别当 KPI。

## License

MIT
