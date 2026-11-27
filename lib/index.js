import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { registerPanel } from './panel.js'
import { messageText, metaMessageText, estimateTokens } from './text.js'

/**
 * dsh-better-debug — 卡住闸门的代码版。
 *
 * 背景：方法论（Mnemon `d713a6e6`）与 `stuck-gate` 技能都是**自觉条款**——
 * 模型得先想起来自己卡住了，条款才会生效。可「想不起来」正是卡住时的症状本身。
 * 这个插件把其中**能被事件证明**的部分升级成代码闸门：不看模型说了什么，
 * 只看它做了什么。
 *
 * 三个信号（用户 2026-11-06 定稿：只做 1+2+4，收尾清零归 dsh-turn-cleanup）：
 *   A 同一文件重复盲改 —— `fs/write-intent` 按路径计数「自上次测量以来」，第 N 次（默认 3）
 *   B 同一错误 episode —— 工具 + 目标 + 归一化指纹三者相同，第 N 次（默认 2）
 *   C 改完不测量又动手 —— 过 N 步没测量只进入 armed，**下一次写入之后**才说
 *
 * v0.2 的四处语义修正（依据 2026-11-14 评审）：
 *   1. 「工具被调用」≠「测量完成」：`ops_bash` 先按命令/描述判是不是测量，
 *      且只在**结果返回后**才清零盲改计数 —— `edit → ls → edit → edit` 不再被洗白。
 *   2. 测量是**意图 + 结果**两段：`exitCode != 0` 的失败测试仍然是有效测量（它给了新事实）。
 *   3. C 不再按步数闹钟打断阅读：arm 之后要等**真的又写了一次**才开口。
 *   4. B 按 episode 计数（工具 + 目标 + 指纹），一次无关搜索不再永久关掉全部 B 提醒。
 *
 * 不做的事：
 *   - 不做「我猜是」措辞检测（插件看不见模型内心独白，留给 skill 自检）
 *   - 不做收尾探针清零（归 dsh-turn-cleanup）
 *   - 不用 `{kind:'reject'}`（那会把整个 turn 变成 no-op），只往 messages 尾部追加一条
 *   - 不对子会话生效（`origin === 'subagent'` 或 `delegationDepth > 0` 直接跳过）
 *   - 不做 no-op 写入判定：`fs/write-intent` 的 intent 只有 freshness token
 *     （`createIfAbsent` / `replaceIfVersion`），不带内容，拿不到 diff。
 *
 * D 段例外（AGENTS.md）：读出本 turn 最后一条用户原话，命中「别搜/直接改/快速试/
 * 不用搜」就整 turn 静音 —— 用户显式要求硬来的时候不做任何事。
 *
 * 幂等：同一局面不重复念；拿到有效测量后重新武装，再犯可以再说一次，
 * 但每 turn 有总预算（默认 3 次）。
 */

export const name = 'dsh-better-debug'
// 一个都不声明 —— 这是刻意的。
//
// cordis 的 `Fiber._refresh()` 只要 `inject` 里有一个服务拿不到，就把 epoch 置成
// INACTIVE 并**直接不执行 apply**：没有报错、没有日志、插件在面板里看起来"装上了"，
// 实际一行代码都没跑。`skills` 由 `@deepseek-ai/dsh-skill` 提供，用户裁剪过的
// profile、别的发行版、或只是没启用那个包时，它就不在 —— 而闸门本身根本不需要它。
//
// 所以两个可选服务（skills / webServer）都改用 `ctx.inject([...], cb)` 动态订阅：
// 服务在就挂上，不在就只是少一个可选功能，闸门照常工作。
export const inject = []

/** 自带技能的名字。注入文本里写的就是它，改这里要同步改 assets 与 text.js。 */
const BUNDLED_SKILL_NAME = 'stuck-gate'
const BUNDLED_SKILL_RANK = 600 // = BUNDLED_SKILL_RANK，与 dsh-skill-office 一致
const ASSET_ROOT = fileURLToPath(new URL('../assets/', import.meta.url))

/**
 * 默认日志文件名。**不能**用 `${name}.log`（那是 `dsh-better-debug.log`）：
 * 文档、面板、老用户手配的路径都写 `better-debug.log`，两处不一致时
 * 用户按文档去翻目录会扑空，而且旧测试的 `endsWith('better-debug.log')`
 * 对 `dsh-better-debug.log` 也成立 —— 断言绿着，文件却不在文档说的位置。
 */
const DEFAULT_LOG_NAME = 'better-debug.log'

/** 全局调用一次就能拿到外部先验的那些工具。 */
export const SEARCH_TOOLS = new Set([
  'web_search',
  'research',
  'advanced_search',
  'multi_search',
  'platform_search',
  'domain_search',
  'cache_search',
  'video_search'
])

/**
 * 语义上「一定在测量」的工具，不需要再看参数。
 *
 * `lsp_diagnostics` 是**宿主可选**的：它由 dsh-lsp-actions 提供，不是每个装了这个插件的人
 * 都有（本机 2026-11-24 已卸载）。留在集合里没有代价 —— 集合只回答「这个名字出现时算不算测量」，
 * 工具根本不存在时这条判定永远不会被问到；而哪天宿主真装了它，分类天然就是对的。
 * 需要小心的是**文案**：别把可选工具写成模型的首选回路（见 lib/text.js 的 A 动作）。
 */
export const HARD_MEASURE_TOOLS = new Set(['lsp_diagnostics', 'verify', 'run_tests', 'run_test'])

/** 要按参数再判一次的工具（`ops_bash` 既能跑测试也能 `ls`）。 */
export const SOFT_MEASURE_TOOLS = new Set(['ops_bash', 'bash', 'shell', 'pwsh'])

/** 会改动仓库那类工具。 */
export const EDIT_TOOLS = new Set(['edit', 'write', 'ops_write', 'str_replace', 'apply_patch', 'notebook_edit'])

/**
 * 只读工具：读文件、列目录、按模式找文件。
 *
 * 为什么要单独列出来：M 的输入是「注入之后有没有转向」，而读文件**是**在收集信息、
 * 不是带病继续改。把读算成没转向，会让 M 的文案（「写完之前不要发起任何修改类工具调用」）
 * 与它实际抓到的东西不符 —— 实测注入后连调 9 次 ops_read_files，M 照样亮。
 */
export const READ_TOOLS = new Set(['read', 'ops_read_files', 'ops_inspect_local_file', 'glob', 'grep'])

/**
 * 默认「这条命令算测量」的判据。
 *
 * 误判的两个方向都真实存在：把 `ls` 当验证会**漏报**盲改（v0.1.2 的问题）；
 * 把 `npm test` 当验证则可能**误报**「你在打通关」——所以判据要窄，
 * 且宁可漏判（不说）也不要错判（乱说）。用户可用 `measureCommands` 覆盖。
 */
const DEFAULT_MEASURE_COMMANDS = [
  '(npm|pnpm|yarn|bun)\\s+(run\\s+)?(test|verify|check|lint|typecheck|build)',
  'node\\s+--test',
  'node\\s+test[/\\\\]',
  'pytest',
  'vitest',
  'jest',
  'mocha',
  'go\\s+(test|vet|build)',
  'cargo\\s+(test|check|clippy|build)',
  'dotnet\\s+(test|build)',
  'tsc(\\s|$)',
  'eslint',
  'ruff\\s+check',
  'mypy',
  'python\\s+-m\\s+(pytest|unittest)',
  'git\\s+diff\\s+--stat'
].join('|')

/**
 * 命令本身看不出来时，退一步看模型的 `description`（ops_bash 必填）。
 * 这是「自称在测量」，弱于命令，但比把 `ls` 当验证强。
 */
const DEFAULT_MEASURE_INTENT = '验证|测试|复现|统计|测量|诊断|跑一遍|看看结果|verify|test|repro|measure|diagnos'

/** 不该计入「盲改」的路径：生成物、锁文件、日志、构建产物。 */
const DEFAULT_EXCLUDE_PATHS = [
  '(^|[/\\\\])(node_modules|dist|build|out|coverage|\\.git|\\.next|\\.cache)[/\\\\]',
  '(^|[/\\\\])(package-lock\\.json|pnpm-lock\\.yaml|yarn\\.lock|bun\\.lockb)$',
  '\\.(log|lock|map|min\\.js)$'
].join('|')

/**
 * D 段例外：用户显式要求别折腾。
 *
 * 中英双语：仓库有 README.en.md，英文用户说 “just do it, skip the search” 时必须得到
 * 和中文用户一样的待遇。原来只有中文条目，同一句话换个语言就静音失效 —— 而静音失败
 * 的方向是「多提醒」，用户明确说了别折腾却继续被提醒，是最刺人的那种误报。
 *
 * 匹配纪律：宁窄勿宽。下面每条都要求祈使语气（直接改 / 别搜 / just do it / skip the
 * search），不匹配描述性用法（“我先搜一下再改” / “I searched before editing”）。
 * 误静音会让整个 turn 失去保护，比漏静音一次更贵。
 */
const QUIET_PATTERN =
  /别搜|不要搜|不用搜|先别搜|直接改|快速试|别折腾|先试试|don'?t\s+(?:search|bother\s+searching)|no\s+need\s+to\s+search|skip\s+(?:the\s+)?search(?:ing)?|stop\s+searching|just\s+(?:do\s+it|edit|fix\s+it|make\s+the\s+change|change\s+it)|quick\s+try/i

/**
 * O 记住多少个「绿过的失败指纹」。
 *
 * 太小会把交替振荡（A/B 两个断言互相踩）挤出窗口，太大则让很久以前的
 * 一次失败也被当成「回来了」。4 够覆盖 A/B/C 三个断言互相踩的常见形态。
 */
const RECENT_FAIL_LIMIT = 4

function toRegExp(source, fallback, onInvalid) {
  if (typeof source !== 'string' || source.trim().length === 0) return fallback
  try {
    return new RegExp(source, 'i')
  } catch (error) {
    // README 承诺「传入非法正则回退内置默认并记 warn」，但 catch 只 return 过。
    // 静默回退是最坏的一种：用户以为自己把 measureCommands 收窄了，实际还在用全量默认，
    // 于是「怎么还在误判」永远查不出来。这里必须把原串和错误一起吐出去。
    if (typeof onInvalid === 'function') {
      try {
        onInvalid(`invalid regex ${JSON.stringify(source)}: ${error?.message ?? error}`)
      } catch {}
    }
    return fallback
  }
}

/** `~` / `~/x` → 家目录。用户手写配置时最爱用的写法，Windows 上也认。 */
function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * 日志落到哪个文件。
 *
 * v0.2.0 之前默认是空字符串 = 完全不落盘。后果对新用户很致命：
 * 装完、重启、打开面板，**四张卡全是 0**，看起来像「插件根本没工作」——
 * 而想看到数据必须自己配一个绝对路径，绝大多数人不会配。
 * 默认必须开箱就有数据。
 *
 *   undefined / 没写     → $DSH_HOME/logs/better-debug.log（与 dsh-turn-cleanup 一致）
 *   "" 或 false（显式）  → 不落盘，留一个干净的退出闸（测试也用它）
 *   "~/x.log"           → 展开家目录
 *   "C:/x.log"          → 原样
 */
export function resolveLogFile(raw) {
  if (raw.logFile === false) return ''
  if (typeof raw.logFile === 'string') {
    const trimmed = raw.logFile.trim()
    if (trimmed.length === 0) return ''
    return expandHome(trimmed)
  }
  // 目录要绝对：DSH_HOME 允许被写成相对路径（用户手写配置时很常见），
  // 而日志路径若跟着相对，就会解析到**进程当下的 cwd**——插件跑在 DSH 主机进程里，
  // 那个 cwd 由用户从哪儿启动决定，事后没人猜得到日志写去了哪。
  const home = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
  return join(home, 'logs', DEFAULT_LOG_NAME)
}

function normalizeConfig(config, onInvalidRegex) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  // 一律取整再钳制：这些键全是「第几次 / 几份 / 几个」的计数语义，小数没有意义，
  // 而轮转循环按 `index === 1` 认主文件 —— logKeep=2.5 时序列是 2.5 / 1.5 / 0.5，
  // 判等永不成立，主文件一次都不会被 rename 走，轮转静默失效（实测：单文件涨到
  // 180 KB 仍然 0 个轮转副本）。先 round 再 clamp，保证钳制后仍是整数。
  const num = (value, fallback, min, max) =>
    Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback
  return {
    enabled: raw.enabled !== false,
    repeatEditThreshold: num(raw.repeatEditThreshold, 3, 2, 20),
    repeatErrorThreshold: num(raw.repeatErrorThreshold, 2, 2, 20),
    // C 的判据是「盲改次数」，不是「过了几步」（0.3.5 换轴）。
    // 旧键 noVerifySteps 仍然读入（老配置不能静默失效），但默认值从 2 步变成 3 次写入 ——
    // 两者不可换算，所以改名而不是沿用旧名。apply 里对旧键单独记一行 warn。
    noVerifyWrites: num(raw.noVerifyWrites ?? raw.noVerifySteps, 3, 1, 20),
    // 一次测量（结果返回）就清零连续盲改计数：有测量回路的收敛不算卡住。
    decayEditsOnVerify: raw.decayEditsOnVerify !== false,
    // present 成功之后休眠闸门，下一次写入重新唤醒：修掉交付后误触发。
    doneOnPresent: raw.doneOnPresent !== false,
    // 每 turn 最多说几次：拿到测量后允许重新武装，但不能变成连击。
    maxInjectsPerTurn: num(raw.maxInjectsPerTurn, 3, 1, 10),
    // 注入后盯多少步，看模型有没有真的转去验证/搜索（面板的 steps 就靠它）。
    changedWindow: num(raw.changedWindow, 6, 1, 30),
    // ── v0.3 方案层四面的阈值。全部按编码调试校准（见 README「适用范围」）。
    // F：同一 (工具|目标) 上换着花样报错。两种数同时成立才算——只看总次数会把
    // 「同一个错反复撞墙」（那是 B）误判成「错误在漂移」。
    repeatFamilyThreshold: num(raw.repeatFamilyThreshold, 4, 3, 20),
    familyMinFingerprints: num(raw.familyMinFingerprints, 3, 2, 10),
    // O：同一组验证在 ok/fail 之间来回翻。翻转必须夹着写入，否则是 flaky 观察。
    oscillationThreshold: num(raw.oscillationThreshold, 3, 2, 10),
    // P：连续「验证失败 → 修改 → 验证仍失败」的轮数（patch debt）。
    patchChainThreshold: num(raw.patchChainThreshold, 3, 2, 10),
    // M：连续多少次注入之后没有任何转向，才允许说「提醒已经失效」。
    metaAfterFutile: num(raw.metaAfterFutile, 2, 1, 5),
    // M 的总开关。false 时只关 M，F/O/P 与 A/B/C 照常——M 是最重的一条，
    // 有人会嫌它打断节奏，所以给它一个独立闸。
    metaGate: raw.metaGate !== false,
    // 判「这条命令是不是测量」。给字符串覆盖，给了坏正则就回退默认。
    measureCommands: toRegExp(raw.measureCommands, new RegExp(DEFAULT_MEASURE_COMMANDS, 'i'), onInvalidRegex),
    measureIntent: toRegExp(raw.measureIntent, new RegExp(DEFAULT_MEASURE_INTENT, 'i'), onInvalidRegex),
    // 不计入盲改的路径（生成物 / 锁文件 / 日志）。
    excludePaths: toRegExp(raw.excludePaths, new RegExp(DEFAULT_EXCLUDE_PATHS, 'i'), onInvalidRegex),
    // ── 日志体积上限（P1-10 / A1）。单文件无上限追加，一年 2.4 MB，
    // 面板每 5 秒同步全量读一次 → 单请求 180 ms 阻塞 webServer 线程。
    // 默认 2 MiB 在真实使用里约等于两三个月；钳制下限 64 KiB 是为了让测试
    // 能在几行日志内就触发轮转，上限 64 MiB 是「别把用户盘写爆」的粗护栏。
    logMaxBytes: num(raw.logMaxBytes, 2 * 1024 * 1024, 64 * 1024, 64 * 1024 * 1024),
    // 保留几份历史（.1/.2/…）。9 份 × 2 MiB = 18 MiB 上限，够查一周的回溯。
    logKeep: num(raw.logKeep, 2, 1, 9),
    logFile: resolveLogFile(raw),
    // 面板是纯只读视图；关掉它不影响闸门。
    panel: raw.panel !== false
  }
}

/** 与 dsh-workspace-changes / dsh-turn-cleanup 同一套判定：子会话不管。 */
function eligible(session) {
  const header = session === null || session === void 0 ? void 0 : session.header
  if (header === null || header === void 0) return false
  const { origin, delegationDepth } = header
  if (origin === 'subagent' || (delegationDepth ?? 0) > 0) return false
  return true
}

/** target 对象 → 绝对路径（不依赖 fs 服务，避免额外 inject）。 */
function targetPath(target) {
  if (typeof target === 'string') return target
  if (target === null || target === void 0) return void 0
  const key = target.targetKey
  return typeof key === 'string' && key.length > 0 ? key : void 0
}

/**
 * 是否是绝对路径 —— **两种方言都认**。
 *
 * `node:path` 的 `isAbsolute` 是平台相关的：在 Linux/macOS 上
 * `isAbsolute('C:/work/a.js')` 是 **false**，在 Windows 上
 * `isAbsolute('/home/u/a.js')` 是 true。这个插件后面所有的判据
 * （`errorFingerprint` / `errorTargetOf` / `measureDirs`）都同时认 `C:/` 与 `/`
 * 两种写法，唯独入口这道闸用平台函数，就会出现「判据说它见过这个路径、
 * 但计数从来没加上」的自相矛盾。
 *
 * 真实会踩到的三种情况：远程/SSH 会话把 Windows 路径带进 POSIX 宿主、
 * 配置里写死了另一种方言、以及 CI 在三个 OS 上跑同一套用例。
 * 所以这里只问「它是不是从根开始的」，不问「根长得像不像本机的」。
 */
export function isAbsPath(path) {
  if (typeof path !== 'string' || path.length === 0) return false
  // `/x`、`\\server\share`、`C:/x`、`C:\x`、`//server/share`
  return /^(?:[A-Za-z]:[\\/]|[\\/])/.test(path)
}

/**
 * 比较路径前要不要折叠大小写。
 *
 * Windows 与 macOS 的默认文件系统不区分大小写，`C:/Work/a.js` 与 `c:/work/a.js`
 * 是同一个文件；Linux 区分，它们是两个不同文件。折叠错了的后果**不对称**：
 *   · 在不区分的系统上不折叠 → 同一个文件被当成两个，A 少报一次（漏）；
 *   · 在区分的系统上折叠     → 两个不同文件被当成一个，B 误报（狼来了）。
 * 后者正是这道闸门最不能犯的错，所以按平台判，而不是无条件 `toLowerCase()`。
 * macOS 有人会装区分大小写的 APFS，那种机器上这里会少报 —— 仍然是安全方向。
 */
export const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin'

/** 需要拿路径做相等/前缀比较时统一走这里，别直接 `toLowerCase()`。 */
function foldCase(text) {
  return CASE_INSENSITIVE ? text.toLowerCase() : text
}

/**
 * 剥掉 `file://` URL 头，把它变回普通路径。
 *
 * node 在 Windows 上抛异常时栈里写的是 `file:///C:/Users/.../a.mjs:12:29`，
 * 在 POSIX 上是 `file:///home/u/.../a.mjs:12:29`。不剥的话，路径正则先撞上
 * scheme 里的 `e:`，`file:///C:/a.mjs` 会被认成目标 `"e:///c"` —— 所有 Windows 栈
 * 就此塌成同一个 episode，B 信号对任何三次不同文件的报错都会误报。
 */
function stripFileUrl(text) {
  return String(text ?? '')
    .replace(/file:\/\/\/(?=[A-Za-z]:[\\/])/gi, '')
    .replace(/file:\/\/(?=\/)/gi, '')
}

/** 规整成一个可比对的目录：posix 分隔符、去尾斜杠、按平台折叠大小写。 */
// 源码扩展名白名单。识别「裸相对路径」必须靠扩展名：编译器喷的是 `src/a.ts(12,9)`、
// `tests/test_a.py::test_foo`、`src/main.rs:12:9`，而 `7/8`、`and/or`、`TCP/IP`、`12/25`
// 这类文本里到处都是斜杠，只看「像不像路径」必然误判。
const SOURCE_EXTENSIONS = [
  'ts', 'tsx', 'mts', 'cts', 'js', 'mjs', 'cjs', 'jsx',
  'go', 'rs', 'py', 'pyi', 'cs', 'fs', 'vb', 'java', 'kt', 'kts', 'scala', 'groovy', 'clj',
  'swift', 'm', 'mm', 'rb', 'php', 'pl', 'lua', 'dart', 'ex', 'exs', 'erl', 'hs', 'ml',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hxx',
  'vue', 'svelte', 'astro', 'sql', 'sh', 'bash', 'zsh', 'ps1', 'bat',
]
// 路径原子：一个路径段里允许出现的字符。
//
// 0.3.4 用的是「ASCII 单词字符」类（字母、数字、下划线、点、@、加号、减号），于是
// `C:/work/项目/src/a.ts(12,9)` 只截到 `C:/work/`、`测试.ts(12,9)` 直接截成空串
// （第四轮缺陷 A）。中文 / 日文 / 西里尔文件名恰恰是最容易出现在真实项目里的那批。
//
// 这里改成取反类：只要不是空白、引号、括号、列表分隔符、位置标记分隔符，就算路径字符。
// 非 ASCII 天然被接受；`(12,9)`、`::test_foo`、引号、逗号、分号这些位置标记与列举
// 分隔符天然被挡掉 —— 不必再枚举「哪些字符算路径」，枚举法天生漏字符。
const PATH_ATOM = '[^\\s"\'`(){}<>,;:=|*?\\\\/]'
const PATH_ATOM_RE = new RegExp(`^(?:${PATH_ATOM})$`)
const isPathAtom = (ch) => ch !== undefined && PATH_ATOM_RE.test(ch)

// 前置必须是行首或分隔符（避免从 `xx/src/a.ts` 中间截出 `src/a.ts`），
// 后置必须是分隔符或行尾（避免把 `src/a.tsx` 截成 `src/a.ts`）。
//
// 分隔符**两种都要认**：Windows 上 tsc / cargo / pytest 打出来的相对路径是
// `src\\lib\\a.ts(12,9)`。只认 `/` 的话，在 Windows 上跑这三家编译器时目标全是空串 ——
// 与 0.3.0「抽不出目标 → 整族塌陷」是同一个后果，只是换成只有 Windows 才触发
// （本机就是 Windows，所以这条反而不会被本机漏掉；漏掉它的是只写了 `/` 的用例）。
const SOURCE_EXT_PATTERN = SOURCE_EXTENSIONS.join('|')
const REL_LEAD = "(?<=^|[\\s\"'`(\\[=,;\\\\])"
const REL_TAIL = "(?=$|[\\s\"'`()\\[\\]:;,<\\\\]|::)"
const REL_SOURCE = new RegExp(
  `${REL_LEAD}(?:${PATH_ATOM}+[\\\\/])+${PATH_ATOM}+\\.(?:${SOURCE_EXT_PATTERN})${REL_TAIL}`,
  'im',
)

// 根目录下的裸文件名：`a.ts(12,9): error TS2322: ...`。
//
// REL_SOURCE 要求「目录 + 文件名」，于是 tsc 在仓库根目录打出来的诊断目标全是空串 ——
// 目标一空就没有任何位置可剥，行号漂移继续进身份，同一个错误改一行就变成新错误
// （第三轮缺陷 1）。裸文件名必须认，但只在**后面紧跟位置标记**时认：
// 散文里的 `a.ts` 不是路径，`a.ts(12,9)` / `a.ts:10` / `test_a.py::x` 才是。
const BARE_SOURCE = new RegExp(
  `${REL_LEAD}${PATH_ATOM}+\\.(?:${SOURCE_EXT_PATTERN})(?=\\s*[(:])`,
  'im',
)

// 路径是否已经以源码扩展名收尾 —— matchSpacedAbsolute / matchSpacedBare 靠它决定
// 「这个空格还在路径里吗」。
const EXT_TAIL = new RegExp(`\\.(?:${SOURCE_EXT_PATTERN})$`, 'i')

// 裸文件名的右锚点：扩展名后面紧跟位置标记（括号、双冒号、冒号加数字）。
const BARE_ANCHOR = new RegExp(
  `\\.(?:${SOURCE_EXT_PATTERN})(?=\\s*(?:\\(|::|:\\d))`,
  'gi',
)

// 绝对路径 / `./` 相对路径的开头。
// 盘符前面不能是单词字符：`https://example.com/a/b.html` 里的 `s://` 形状上就是一个
// 盘符路径，抽出来会得到 `s://mypy.readthedocs.io/...` 这种「目标」—— mypy 的 note 里
// 常年挂着文档链接，于是同一处 error 只因附注里的 URL 不同就换了一个目标（第四轮缺陷 C
// 的第二面，基线 0.3.4 上同样成立）。
// 反斜杠相对路径的前置同样不能是 `/` 或单词字符：URL 里的 `//host/a/b.html`
// 否则会被当成「`./` 省略了点」的相对路径，抽出一个以 `//` 开头的假目标。
// 裸 \`/\` 分支必须排除「紧跟在 \`]\` 后面」的位置：\`src/app/[id]/page.tsx\` 里的
// \`/page.tsx\` 是路由段的分隔符，不是路径起点（第五轮缺陷 C 的相对形态）。
const ABS_HEAD = /(?:(?<![\w])[A-Za-z]:[\\/]|(?<![\w.\/:\]])\.{0,2}\/)/g

/**
 * 带空格的绝对路径：`C:/work/My Project/src/a.ts(12,9)`。
 *
 * 通用绝对路径正则见空白就停，只截到 `c:/work/my`（第三轮缺陷 2）。剩下的
 * `Project/src/a.ts(12,9)` 留在消息里，位置数字继续参与身份 —— 同一个错误只要编辑器
 * 把行往下推一行，身份就变了：B 永远攒不够次数，P 把每一轮都当成「修出了下一个错误」。
 *
 * 这里改成**以源码扩展名做右锚点、向右吃路径**：只有「空格后面还能续成路径段」并且
 * 「已经吃到的部分还没以扩展名收尾」时才吃这个空格。于是
 * `C:/work/a.ts: error: cannot open` 不会把 `: error: cannot open` 吃进来。
 */
function matchSpacedAbsolute(raw) {
  ABS_HEAD.lastIndex = 0
  for (let hit = ABS_HEAD.exec(raw); hit !== null; hit = ABS_HEAD.exec(raw)) {
    const start = hit.index
    let cursor = start + hit[0].length
    let end = cursor
    while (cursor < raw.length) {
      const ch = raw[cursor]
      if (isPathAtom(ch) || ch === '/' || ch === '\\') {
        cursor += 1
        end = cursor
        continue
      }
      if (ch === ' ') {
        const gap = /^ +/.exec(raw.slice(cursor))
        const next = cursor + gap[0].length
        const after = raw[next]
        const eaten = raw.slice(start, end)
        if (after !== undefined && isPathAtom(after) && !EXT_TAIL.test(eaten)) {
          cursor = next
          continue
        }
      }
      break
    }
    const token = raw.slice(start, end)
    if (token.length > hit[0].length) return { token, index: start }
  }
  return null
}

/**
 * 带空格的裸文件名：`my file.ts(12,9)`。
 *
 * 0.3.4 的 BARE_SOURCE 只吃「ASCII 单词字符 + 扩展名」，于是 `my file.ts` 塌成
 * `file.ts` —— `my file.ts` / `other file.ts` / `third file.ts` 三个不同文件变成同一个
 * 目标（第四轮缺陷 B）：P 把「逐个修独立文件」误报成补丁链，B 把不同文件的同一个报错
 * 误报成「同一个操作重复报错」。
 *
 * 修法同样是**以扩展名做右锚点、向左吃**：先定位「扩展名 + 位置标记」，再向左吃
 * 路径原子、目录分隔符与单空格。三条约束保证不越界：
 *   1. 空格段数只受 MAX_GAP_SEGMENTS 限制，不再硬编码「两段」；
 *   2. 左边那段如果**已经以扩展名收尾**就停（`a.ts b.ts(12,9)` 只认 `b.ts`）；
 *   3. 目录分隔符可以一直向左吃，但每段都做同样的收尾检查；
 *   4. 碰到诊断前缀词（ERROR in / FAILED at / see …）就停：不猜自然语言前缀。
 */
const MAX_GAP_SEGMENTS = 4

// 诊断前缀词：向左回溯时碰到这些词就停。不猜自然语言，只认已列举的前缀语法，
// 否则 'ERROR in my file.ts' 会把 'in' 吃进目标（第五轮缺陷 B）。
const LEFT_STOP_WORDS = new Set([
  'in', 'at', 'on', 'from', 'for', 'with', 'by', 'via', 'to', 'of', 'the', 'a', 'an',
  'and', 'or', 'not', 'is', 'was', 'were', 'be', 'been', 'being',
  'error', 'errors', 'failed', 'fail', 'failure', 'warning', 'warn', 'warnings',
  'see', 'open', 'opened', 'read', 'reading', 'write', 'writing', 'load', 'loading',
  'parse', 'parsing', 'while', 'during', 'when', 'where', 'which', 'that', 'this',
  'into', 'under', 'over', 'after', 'before', 'then', 'than', 'also', 'but', 'if',
])

function segmentStartAt(raw, end) {
  let pos = end
  while (pos > 0 && isPathAtom(raw[pos - 1])) pos -= 1
  return pos
}

/**
 * 从 start 向左把同一个路径的剩余部分吃回来。
 *
 * 只吃三种东西：路径原子、目录分隔符、单空格。四种情况立刻停：
 *   - 空格段数超过 maxGaps（防跑飞，不表达「文件名最多几个词」）；
 *   - 左边那段已经以源码扩展名收尾（'a.ts b.ts(12,9)' 只认 'b.ts'）；
 *   - 左边那段是诊断前缀词（'ERROR in my file.ts' 只认 'my file.ts'）；
 *   - 左边那段的左边界是冒号（'error TS2322: my file.ts' 里的 TS2322 是代码不是路径）。
 */
function extendLeft(raw, start, maxGaps) {
  let pos = start
  let gaps = 0
  for (;;) {
    if (pos <= 0) return pos
    const sep = raw[pos - 1]
    if (sep === '/' || sep === '\\') {
      const segStart = segmentStartAt(raw, pos - 1)
      if (segStart === pos - 1) return pos
      if (segStart > 0 && raw[segStart - 1] === ':') return pos
      if (EXT_TAIL.test(raw.slice(segStart, pos - 1))) return pos
      pos = segStart
      continue
    }
    if (sep !== ' ') return pos
    if (gaps >= maxGaps) return pos
    let spaceStart = pos
    while (spaceStart > 0 && raw[spaceStart - 1] === ' ') spaceStart -= 1
    if (pos - spaceStart > 1) return pos
    const segStart = segmentStartAt(raw, spaceStart)
    if (segStart === spaceStart) return pos
    if (segStart > 0 && raw[segStart - 1] === ':') return pos
    const segment = raw.slice(segStart, spaceStart)
    // 这里**不能**用 foldCase：词表判的是自然语言，不是路径。foldCase 在 Linux 上
    // 不折叠，于是 `FAIL test/pay.test.js` 里的 `FAIL` 匹配不到词表里的 `fail`，
    // 回溯会把它吃进 token，目标变成 `FAIL test/pay.test.js` —— 同一个文件在
    // Windows 与 Linux 上得到两个不同目标（linux 轮测试实测）。大小写折叠在这里
    // 无条件成立，与文件系统是否区分大小写无关。
    if (LEFT_STOP_WORDS.has(segment.toLowerCase())) return pos
    if (EXT_TAIL.test(segment)) return pos
    pos = segStart
    gaps += 1
  }
}

function matchSpacedBare(raw) {
  BARE_ANCHOR.lastIndex = 0
  for (let hit = BARE_ANCHOR.exec(raw); hit !== null; hit = BARE_ANCHOR.exec(raw)) {
    const tailEnd = hit.index + hit[0].length
    let start = hit.index
    while (start > 0 && isPathAtom(raw[start - 1])) start -= 1
    start = extendLeft(raw, start, MAX_GAP_SEGMENTS)
    const token = raw.slice(start, tailEnd)
    if (token.length > hit[0].length) return { token, index: start }
  }
  return null
}

/**
 * 剥掉 token 尾部的「位置标记」，只留路径本身。四种形态都必须认，少一种就会让
 * 同一个文件的不同报错落进不同族（或因尾部残留而整条识别失败）：
 *   1. pytest 的 `tests/test_a.py::test_foo`
 *   2. tsc / C# 的 `src/a.ts(12,9)`
 *   3. go / python / rust 的 `main.go:12:5`、`a.py:12`
 *   4. 某些工具多吐一个尾冒号：`a.py:12:`
 */
function stripLocators(token) {
  return String(token ?? '')
    // 前导装饰字符：vitest 的 ` ❯ test/a.test.js`（U+276F）、jest 的 `●`，
    // 以及 `>` / `→` / `×` 这类行首标记。只剥尾部会让它们跟着路径进目标，
    // 于是同一个文件在不同 reporter 下变成两个目标（第五轮缺陷）。
    .replace(/^[\s>\u276f\u203a\u00bb\u25cf\u00d7\u2715\u2717\u2192\u2a2f\u25b6\u2716\u2713\u2714\u221a]+/, '')
    .replace(/::.*$/, '')
    .replace(/\(\s*\d+(?:\s*,\s*\d+)*\s*\)$/, '')
    .replace(/(?::\d+)+:?$/, '')
    .replace(/:\s*$/, '')
}

/**
 * 规整成一个可比对的目录：posix 分隔符、去尾斜杠、**统一盘符方言**、按平台折叠大小写。
 *
 * 盘符方言是实测到的真 bug（0.3.6 修）：Git Bash / MSYS 里 `cd /c/Users/… && npm test`
 * 给出的候选是 `/c/users/…`，WSL 里 `cd /mnt/c/Users/…` 给出的是 `/mnt/c/users/…`，
 * 而写入侧记的是 `C:/Users/…`，两者永不相交 ⇒ `cleared`
 * 恒 0 ⇒ 上膛状态永不解除 ⇒ C 在同一个现场反复开口。真实日志 266 条 measure 里
 * 238 条（89.5%）是 cleared=0，C 占比 72.5%、命中率 8.3% 都是这一条的后果。
 *
 * 归一化对**比较双方同时生效**（候选目录与 streakEdits 键都要过 normDir/dirOf），
 * 所以一台 POSIX 机器上真有个叫 `/c/…` 的目录也不会失配 —— 两边会被折成同一个
 * 形状。唯一代价是 `/c/work` 与 `C:/work` 在 POSIX 上撞在一起，碰撞方向是「多清一次
 * 盲改计数」（漏报一次），不是误报。
 */
function normDir(path) {
  let normalized = String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  // `/c/Users/x` → `c:/Users/x`。首段必须是单个字母，`/opt/…`、`/usr/…`、`/tmp/…` 不动。
  const msys = /^\/([A-Za-z])(?=\/|$)/.exec(normalized)
  if (msys !== null) normalized = msys[1] + ':' + normalized.slice(2)
  // `/mnt/c/Users/x` → `c:/Users/x`：WSL 里跑命令时的方言
  // （`wsl.exe -e bash -c 'cd /mnt/c/…'`）。同样只认单字母挂载点，`/mnt/data/…` 不动。
  const wsl = /^\/mnt\/([A-Za-z])(?=\/|$)/.exec(normalized)
  if (wsl !== null) normalized = wsl[1] + ':' + normalized.slice(6)
  return foldCase(normalized)
}

/**
 * 文件路径 → 它所在的目录。
 *
 * 注意别把**目录**喂进来：`dirOf('C:/other')` 会返回 `'c:'`（把 other 当成文件名取了父目录），
 * 而 `'c:'` 作为前缀能匹配整个 C 盘 —— 一次无关目录的测试就会把所有文件的盲改计数洗白。
 * 目录一律走 `normDir`，只有编辑/写入的**文件路径**才走这里。
 */
function dirOf(path) {
  const normalized = String(path ?? '').replace(/\\/g, '/')
  const cut = normalized.lastIndexOf('/')
  return normDir(cut > 0 ? normalized.slice(0, cut) : normalized)
}

/**
 * 一次工具调用归成某一类，面板据此算「注入后模型换动作了吗」。
 * `measure` 由调用方算好传进来：`ops_bash` 的归类取决于参数，不看参数归不了类。
 */
export function classifyTool(name, measure) {
  if (typeof name !== 'string') return 'other'
  if (SEARCH_TOOLS.has(name)) return 'search'
  if (HARD_MEASURE_TOOLS.has(name)) return 'verify'
  if (SOFT_MEASURE_TOOLS.has(name)) return measure === true ? 'verify' : 'shell'
  if (EDIT_TOOLS.has(name)) return 'edit'
  if (name === 'skill') return 'method'
  return 'other'
}

/** 这条 `ops_bash` 调用算不算一次测量（意图层，结果层还要看 exitCode）。 */
export function isMeasurement(name, args, cfg) {
  if (HARD_MEASURE_TOOLS.has(name)) return true
  // PTC 根调用的参数只有 { code }，没有 command / script_path —— 0.3.5 之前一律判 false，
  // 于是「在 run_code 里跑 npm test」不算测量，C 永远解不开。
  // 但 code 本身就写着要调什么：`await tools.bash({command:"npm test"})`。
  // 只看代码文本是弱证据，代价是多认几次测量；漏认的代价是整条回路失明，选前者。
  if (name === 'run_code') {
    const code = typeof args?.code === 'string' ? args.code : ''
    if (code.length === 0) return false
    if (cfg.measureCommands.test(code) || cfg.measureIntent.test(code)) return true
    return false
  }
  if (!SOFT_MEASURE_TOOLS.has(name)) return false
  const command = typeof args?.command === 'string' ? args.command : ''
  const script = typeof args?.script_path === 'string' ? args.script_path : ''
  const description = typeof args?.description === 'string' ? args.description : ''
  if (command.length > 0 && cfg.measureCommands.test(command)) return true
  if (script.length > 0 && cfg.measureCommands.test(script)) return true
  // 只剩「自称在测量」这一条弱证据时，要求它同时不像读文件/列目录。
  if (description.length > 0 && cfg.measureIntent.test(description)) {
    return !/^\s*(ls|dir|cat|type|head|tail)\b/i.test(command)
  }
  return false
}

/**
 * 这次测量「管得到」哪些目录。
 *
 * `workdir` 本身是目录（直接规整）；命令里出现的路径可能是文件也可能是目录，
 * 一律按目录处理（`npm test -- src/a.test.js` 的父目录同样是它的管辖范围）。
 */
export function measureDirs(args) {
  const dirs = new Set()
  const workspace = normDir(args?.workdir)
  if (workspace.length > 0) dirs.add(workspace)
  const collect = (text) => {
    if (typeof text !== 'string' || text.length === 0) return
    // `cd <dir> && npm test`：这里那段路径本身就是目录，不能交给 dirOf（会多剥一层，
    // 让 `cd ~/projB` 变成 `~`，于是兄弟目录的测量洗白了 projA 的盲改计数）。
    let rest = text
    for (const match of text.matchAll(/\bcd\s+("[^"]+"|'[^']+'|[^\s&;|]+)/gi)) {
      const raw = match[1].replace(/^["']|["']$/g, '')
      if (raw.length > 0) {
        const expanded = raw.startsWith('~') ? expandHome(raw) : raw
        // `cd src` 这种相对写法要靠 workdir 才能落地；两者都缺就跳过，
        // 否则 `cd ..` 会变成一个恒不匹配的目录名，白占一个候选。
        const dir = isAbsPath(expanded)
          ? normDir(expanded)
          : workspace.length > 0
            ? normDir(join(workspace, expanded))
            : ''
        if (dir.length > 0) dirs.add(dir)
      }
      rest = rest.split(match[0]).join(' ')
    }
    for (const match of rest.matchAll(/[A-Za-z]:[\\/][^\s"'`;,)]+|\/(?:[\w.-]+\/)+[\w.-]*/g)) {
      dirs.add(dirOf(match[0]))
    }
  }
  collect(args?.command)
  collect(args?.script_path)
  // run_code 的 code 里同时写着 cd 与绝对路径，扫它才有机会让 PTC 里的测量管到目录。
  collect(args?.code)
  return dirs
}

/**
 * O 的「同一组验证」身份：工具名 + 规范化命令。
 *
 * 为什么必须压空白：`npm  test` / `npm test ` / 换行写成多行，是同一条命令；
 * 不归一化的话每次敲法不同就是新 key，O 永远数不到一起。
 * 没有命令时（只给 script_path 的调用、或 lsp_diagnostics 这类无命令工具）退化成目录集合，
 * 这样「同一个 workspace 反复跑诊断」仍然算同一组验证。
 */
export function measureKey(tool, args) {
  const raw = args?.command ?? args?.script_path ?? ''
  const script = String(raw).replace(/\s+/g, ' ').trim()
  if (script.length > 0) return `${tool}|${script}`
  return `${tool}|${[...measureDirs(args)].sort().join(',')}`
}

/**
 * 错误文本 → 稳定指纹。目标不是「相等」而是「同一类」：
 * 报错变的是行号、时间戳、临时路径、内存地址，不变的是异常类和消息骨架。
 */
export function errorFingerprint(text) {
  const lines = stripFileUrl(text).split('\n')
  // 取窗口的起点必须是**第一条真正的失败锚点行**，不能是文本开头。
  // 旧实现是 `.slice(0, 6)`：pytest 的前 6 行恒为会话头（`platform ...` /
  // `rootdir:` / `plugins:` / `collected N items`），jest 的前几行是 `RUNS`/`PASS`
  // 进度行 —— 于是两个完全不同的失败拿到同一个指纹（S1，实测 pytest 两个用例
  // 塌成 234f392b7ecf182d）。先跳过会话头/进度行/聚合行，再取 6 行窗口。
  let start = 0
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.replace(/\r$/, '').trim()
    if (line.length === 0) continue
    if (isAggregateLine(line)) continue
    if (PYTEST_PROGRESS.test(line)) continue
    if (LOGGER_NOISE.test(line)) continue
    if (RUNNER_NOISE.test(line)) continue
    if (PASS_LINE.test(line)) continue
    if (looksLikeFailure(line)) {
      start = index
      break
    }
  }
  const head = lines.slice(start, start + 6).join('\n')
  // 这里**不再做数字归一化**（旧的第 690 行 `.replace(/\d+(?:\.\d+)?/g, '<n>')`）。
  // 位置类数字（`:12:29`、`(12,9)`、`line 12`）已经被上面两条路径规则整体吃进 `<path>`，
  // 剩下的数字是**失败语义**：`case-1`/`case-2`、`TS2322`、`expected 3 to be 4`。
  // 把它们归一，健康 TDD 每轮换用例名就会被 B 当成「同一个错重复 N 次」（实测误报），
  // 同时 F 数「不同指纹数」永远数不到 3 种（实测漏报）—— 同一个 bug 的两个方向。
  // 这也让本函数与 failureItemFingerprint（:979）口径一致：后者刻意保留数字，见 :975。
  const normalized = head
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
    .replace(/(?<![\w.])\.{0,2}\/[^\s"']{6,}/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16)
}

/**
 * 报错文本里的「目标」——第一个像路径的东西，数字归一化后保留。
 *
 * B 的 episode key 需要它：`open 'C:/work/a.js'` 与 `open 'C:/work/b.js'`
 * 是同一类 ENOENT，但不是同一个 episode，不能合并计数（否则两个文件各错一次
 * 就被当成「同一个报错吃了两次」）。
 */
/**
 * 在一段文本里找第一个源码路径，返回 token 本身、它在文本里的位置、以及
 * **剥过 `file://` 前缀之后**的文本。
 *
 * 单独抽出来是因为调用方还需要「路径后面紧跟的那段位置标记」：
 * `src/a.ts(12,9): error TS2322: ...` 里要留的是 `error TS2322: ...`，
 * 而不是把 `(12,9)` 也算进失败身份（同一错误仅行号漂移就变成另一条失败）。
 */
function extendRelativeHit(raw, hit) {
  const start = extendLeft(raw, hit.index, MAX_GAP_SEGMENTS)
  if (start >= hit.index) return { token: hit[0], index: hit.index }
  return { token: raw.slice(start, hit.index + hit[0].length), index: start }
}

function matchSourceToken(text) {
  const raw = stripFileUrl(text)
  // ① 绝对路径或 `./` 相对路径：V8 栈帧、ENOENT 的引号路径、go/python/eslint 的 path:line。
  //    终止符含 `(`：`a.cs(12,9)` 的括号行号交给 stripLocators，正则不该跨过去。
  //    先试「带空格的绝对路径」：通用正则在第一个空格就停，会把
  //    `C:/work/My Project/src/a.ts` 截成 `c:/work/my`（第三轮缺陷 2）。
  const spaced = matchSpacedAbsolute(raw)
  // 绝对路径 / 根相对路径。**不再因为「带空格的绝对路径已命中」就跳过**：候选一律生成，
  // 最后由覆盖关系裁决（第八轮终审缺陷 1）。
  const absolute = /(?:(?<![\w])[A-Za-z]:[\\/]|(?<![\w.\/:\]])\.{0,2}\/)[^\s"';()]+/i.exec(raw)
  // ② 裸相对路径：编译器最爱这么写（tsc 的 `src/a.ts(12,9)`、pytest 的 `tests/test_a.py::x`）。
  //    必须靠「目录 + 已知源码扩展名」来认，否则 `7/8`、`and/or`、`TCP/IP` 都会被当路径。
  // 相对路径与「绝对路径的 \`/x\` 后缀分支」可能同时命中，此时取**覆盖更长**的那个：
  // \`src/app/[id]/page.tsx\` 的 REL_SOURCE 命中全长，而绝对路径正则只抢到 \`/page.tsx\`
  // （第五轮缺陷 C 的相对形态）。只按固定优先级返回会让后缀片段赢过完整路径。
  const relativeHit = REL_SOURCE.exec(raw)
  const relative = relativeHit === null ? null : extendRelativeHit(raw, relativeHit)
  // ③ 根目录裸文件名：`a.ts(12,9)`、`test_a.py::x`。只在紧跟位置标记时认（第三轮缺陷 1）。
  //    先试「带空格的裸文件名」：`my file.ts(12,9)` 只吃 `[\w.@+-]+` 会塌成 `file.ts`，
  //    于是 `my file.ts` / `other file.ts` / `third file.ts` 三个不同文件变成同一个目标
  //    （第四轮缺陷 B）：P 把「逐个修独立文件」误报成补丁链，B 把不同文件的同一个报错
  //    误报成「同一个操作重复报错」。
  const relativeWins = relative !== null && (absolute === null || relative.token.length > absolute[0].length)
  const spacedBare = spaced === null && absolute === null && relative === null ? matchSpacedBare(raw) : null
  const bare = spaced === null && absolute === null && relative === null && spacedBare === null ? BARE_SOURCE.exec(raw) : null
  // 候选**全部**生成，再按「覆盖关系」裁决，而不是谁先命中就返回谁。
  //
  // 早先是 `spaced` 一命中就 return：`src/项目/[...slug]/page.tsx(12,9)` 里那个裸 `/`
  // 分支在 `项目` 后面命中（`\\w` 只覆盖 ASCII，中文不算词字符，lookbehind 放行），
  // 于是目标被截成 `/[...slug]/page.tsx` —— 同一个文件写成 ASCII 目录就没事，
  // 写成中文目录就换身份，位置漂移判定全线失效（第八轮终审缺陷 1）。
  //
  // 通用规则：一个候选若**起点落在另一个候选内部、且被它完整覆盖**，它就是那个更长
  // 候选的后缀碎片，淘汰。这与语言、字符集无关，纯看区间包含关系。
  const ordered = []
  if (spaced !== null) ordered.push(spaced)
  const abs = absolute === null ? null : { token: absolute[0], index: absolute.index }
  if (relativeWins) {
    ordered.push(relative)
    if (abs !== null) ordered.push(abs)
  } else {
    if (abs !== null) ordered.push(abs)
    if (relative !== null) ordered.push(relative)
  }
  if (spacedBare !== null) ordered.push(spacedBare)
  if (bare !== null) ordered.push({ token: bare[0], index: bare.index })
  for (const cand of ordered) {
    const end = cand.index + cand.token.length
    const covered = ordered.some((other) => other !== cand
      && other.token.length > cand.token.length
      && other.index <= cand.index
      && other.index + other.token.length >= end)
    if (!covered) return { token: cand.token, index: cand.index, raw }
  }
  return { token: '', index: -1, raw }
}

/**
 * 多行输出的「锚点正文」：洗掉那些**带路径却不说明哪一条失败了**的行。
 *
 * 只在多行输入上生效（单行调用原样返回，主循环逐行调它时零开销、零行为变化）。
 * 为什么必须有：pytest 的 `rootdir: C:/work/proj` 是正文里第一个路径，jest 的
 * `RUNS test/a.test.js` 同理 —— 直接取「第一个路径」会把整段失败的目标记到
 * 项目根或一个**通过了**的文件上（第五轮缺陷，实测）。
 */
function anchorText(text) {
  const raw = String(text ?? '')
  if (!raw.includes('\n')) return raw
  return raw
    .split('\n')
    .filter((rawLine) => {
      const line = rawLine.replace(/\r$/, '').trim()
      if (line.length === 0) return false
      if (RUNNER_NOISE.test(line)) return false
      if (LOGGER_NOISE.test(line)) return false
      if (PYTEST_PROGRESS.test(line)) return false
      // 通过行同理：jest 的 `PASS  test/a.test.js` 是**过了**的文件，把它当成整段
      // 失败的目标，B 会对着一个没有失败的文件说「这个错重复了 N 次」。
      if (PASS_LINE.test(line)) return false
      return true
    })
    .join('\n')
}

export function errorTargetOf(text) {
  const { token } = matchSourceToken(anchorText(text))
  if (token.length === 0) return ''
  const path = stripLocators(token).replace(/\\/g, '/')
  if (path.length === 0) return ''
  // 只剥末尾的行号列号（`a.mjs:12:29` → `a.mjs`）。**不要**把路径里每个数字都归一：
  // `a1.js` 与 `a2.js`、`proj1/` 与 `proj2/` 是两个不同位置，归一后会把它们塌成一个 episode。
  // 大小写按平台折叠，和 normDir 同理：在区分大小写的系统上折叠会把 a.js 与 A.js
  // 合成同一个 episode，把两个不同文件各错一次误报成「同一个报错吃了两次」。
  return foldCase(path)
}

/** 这一行像不像一条失败记录。只用来决定「要不要把它算进失败集合」。 */
/**
 * 日志噪声：与「哪一条失败了」无关的行。同一个断言失败、每次多一行这种日志，
 * 不该被算成不同的失败（深审缺陷 6）。
 */
const LOGGER_NOISE = /^(?:warn(?:ing)?|info|debug|trace|verbose|notice|log)\b[:\s]|\b(?:deprecat|experimental|npm warn|node:warning)\b/i

/**
 * 测试 runner 的**会话头与进度行**：带路径、带数字，但不说明「哪一条失败了」。
 *
 *   pytest  `===== test session starts =====` / `platform win32 -- Python 3.12.10, pytest-8.3.4`
 *           `rootdir: C:/work/proj` / `plugins: cov-5.0.0` / `collected 2 items`
 *   jest    `RUNS  test/a.test.js`（正在跑，不是失败）
 *
 * 不排除的后果是双向的：`errorTargetOf` 会把第一个路径当成整段失败的目标（实测 jest 取到
 * 通过文件的 `test/a.test.js`、pytest 取到 `c:/work/proj`），`failureSetOf` 会给每条
 * 进度行造一个假条目（实测 pytest 5 条里 3 条是会话头噪声）。**必须**在结构层排除。
 *
 * 判据只看行首形态，不看正文：等号/短横线包起来的标题行、`key: value` 形式的会话配置、
 * `collected N items`、`RUNS <path>`。
 */
const RUNNER_NOISE =
  /^[=\u2500]{3,}.*[=\u2500]{3,}$|^(?:platform|rootdir|plugins?|collected)\b\s*[:\uFF1A]|^collected\s+\d+\s+items?\b|^\s*RUNS?\s+\S|^={3,}|={3,}$|^\s*(?:Start at|Duration|Ran all test suites)\b|^>\s+\S+@\S+(?:\s|$)|^>\s+(?:tsc|node|npx|npm|pnpm|yarn|vitest|jest|pytest|cargo|go|dotnet|make)\b|^Found\s+\d+\s+errors?\b|^Errors\s+Files\b|^\s*\d+\s+\S+:\d+\s*$/i

/**
 * 通过行：报告「这一条过了」，不是失败。
 *
 * jest 把通过与失败并列打印，只差一个前缀（U+2713 是通过，U+2717 是失败）。
 * 早先靠「通过行里没有失败关键词」侥幸躲过集合 —— 用例名本身带关键词时就不灵了：
 * 「勾 + handles TypeError gracefully」一旦被认成失败，同一份输出会多出一条
 * （jest 的失败块本来就已贡献一条），集合身份随用例名变化，收缩判定与 O 的
 * 「旧失败回来」全部失真。
 *
 * 判据只看行首前缀：正文里出现 PASS / ok 这些词不算。
 */
// `\u25b6` 是 node:test spec reporter 的**套件起始**标记（`\u25b6 TypeError handling`），
// 与 `\u2714` 的成功标记同属「结构行」：它说的是「下面开始一个套件」，不是「这一行失败了」。
// 上一版把异常类型名当成通用失败词之后，这行靠词表命中进了集合；词表收紧后它又会掉进
// 兜底分支（整段哈希）—— 两个方向都是假的，所以要在结构层就排除。
const PASS_LINE = /^(?:[\u2713\u2714\u221a\u25b6]\s*|PASS\b|ok\s+\d+\b)/

/**
 * 异常**类型名**作为失败信号，但只在它确实在渲染一条异常消息时才算：
 * `TypeError: x is not a function` 是消息，`  TypeError handling` 是套件名。
 *
 * 上一版把 typeerror 直接塞进 looksLikeFailure 的词表，于是「这一行里出现了异常类型名」
 * 就等于「这一行是失败」——全绿的 node:test 输出里 `▶ TypeError handling` 与
 * `ℹ fail 0` 一起把集合从 1 条撑到 2 条，套件改名又换一次指纹。
 * 类型名后面必须紧跟冒号或行尾，才是异常消息的形态。
 */
// 只列 JS 内置名是不够的：Python 的 ValueError / KeyError / IndexError、Java 的
// NullPointerException、Ruby 的 RuntimeError 都是「行首异常类名 + 冒号」，而它们里的
// `Error` 前面是单词字符（Value|Error），通用词表里的 \b(error|exception)\b 卡在词边界上
// 匹配不到 —— 于是整段异常输出退成兜底分支，三条失败塌成一条（第五轮缺陷 E）。
// 判据改成「行首附近有 *Error / *Exception / *Exit / *Interrupt，且后面紧跟冒号或行尾」，
// 仍然要求那个冒号/行尾，套件标题（`▶ TypeError handling`）不会被误认成消息。
const EXC_TYPE = /[\w.]*?(?:Error|Exception|Exit|Interrupt)\b(?=\s*:|\s*$)/

function looksLikeFailure(line) {
  // 内置异常类型名本身就是失败信号：`TypeError: x is not a function` 里既没有
  // error 也没有 fail，早先只靠末尾「一条都不像」的兜底分支接住 —— 那条兜底会把
  // 整段输出压成一个条目，同一份输出里的两条异常就塌成一条（多错误输出读不出差异）。
  if (EXC_TYPE.test(line)) return true
  return /\b(?:error|errors|fatal|fail|failed|failure|exception|panic|traceback|assert|assertion)\b|✗|✖/i.test(line)
}

/**
 * 一次失败的验证输出 → 失败条目集合。
 *
 * P 原来的判据是「失败 → 有写入 → 仍失败」，只比写入序号，于是这三种健康形状全被误判：
 * 逐个修独立文件（改 m1 → m2 报错）、收敛中的清扫（10 → 9 → 8 个错）、以及最讽刺的
 * 「同一个错完全没变」。区别不在「有没有失败」，而在**失败面有没有收缩**。
 *
 * 条目 = `目标|那一行的指纹`。目标取自这一行自己的路径，退化时用整段的第一个路径
 * （`AssertionError: case-one failed` 这种没有路径的表头，靠下一行的栈帧定位）。
 */
/**
 * 单条失败行的身份指纹：**保留数字**，只归一化路径与长十六进制串。
 *
 * 为什么不能用 errorFingerprint：它把数字全折成 `<n>`，于是
 * `AssertionError: case-1 not implemented` 与 `case-2 ...` 拿到同一个指纹。
 * 后果有两处，都是误报：
 *   · 健康 TDD 每轮换用例名的「新失败」被当成「旧失败回来了」→ O 数到翻转；
 *   · 失败集合身份相同 → failEpisodes 把三轮不同的红累加成一个 episode → B 也开口。
 * 集合身份要回答的是「这一条失败和那一条是不是同一条」，数字是内容的一部分，
 * 不能抹掉（深审第五节验收：健康 TDD 必须仍然零注入）。
 *
 * 反过来，**栈帧行不算失败条目**：不同错误常常落在同一行同一列
 * （`at C:/work/test/a.test.mjs:4:9`），把它算进去会让所有失败都「看起来回来过」。
 * 目标已经由 target 单独承载，栈帧只贡献噪声。
 */
/**
 * 紧跟在路径后面的「位置标记」，按位置切掉。
 *
 * 早期版本按正则在整个字符串上剥，于是**消息里的数字**也一起被剥：`case-1` 与
 * `case-2` 成了同一条失败。但反过来「数字全保留」也不行 —— 编译器打出来的诊断行
 * 自带源位置，`src/a.ts(12,9)` 与 `src/a.ts(13,9)` 是完全同一个错误，只是编辑器
 * 把行往下推了一行，指纹却不同：B 永远攒不够次数，P 把每一轮都当成「修出了下一个
 * 错误」（第二轮深审缺陷 1）。
 *
 * 所以位置只在**它确实跟在路径后面**时剥，消息里的数字一律保留。
 */
function cutLocatorAt(text, at) {
  const rest = text.slice(at)
  const patterns = [
    /^\s*\(\s*\d+(?:\s*[,:]\s*\d+)*\s*\)/, // tsc / C#：`(12,9)`
    /^(?::\d+){1,3}:?/, // go / rust / python：`:12:5`
    /^["']?\s*,?\s*\bline\s+\d+(?:\s*,\s*in\s+[^\s,)]+)?/i, // python：`", line 10, in test_case`
    /^\s*:\s*line\s+\d+/i, // jest / vitest：`: line 12`
    // webpack / eslint 的「空格 + 行:列」范围：`./src/index.js 5:0-20`。
    // 只认紧跟在路径后面的这种形态 —— 位置在前、范围在后，形状明确，
    // 不会像「数字全归一」那样把消息里的 `case-1` 也吃掉（第三轮缺陷 3）。
    /^\s+\d+:\d+(?:-\d+(?::\d+)?)?(?=\s|$)/
  ]
  for (const pattern of patterns) {
    const hit = pattern.exec(rest)
    if (hit !== null && hit[0].length > 0) return text.slice(0, at) + text.slice(at + hit[0].length)
  }
  return text
}

/**
 * 栈帧的方言。同一份输出里，V8 的 `at file:10:1` 与 Python 的 `File "x.py", line 10`
 * 与 pytest 的 `tests/a.py:10: in test_one` 混在一起，绑定方向完全不同：
 * V8 是「消息在前、帧在后」，Python/pytest 是「帧在前、消息在后」。
 * 只按位置猜方向会把后一条失败的帧借给前一条（第五轮缺陷 D）。
 */
function frameKindOf(line) {
  if (/^at\s+\S/.test(line)) return 'at'
  if (/^File\s+["']/.test(line)) return 'file'
  if (/^\S+:\d+(?::\d+)?:\s+in\s+\S/.test(line)) return 'pytest'
  return 'other'
}

/** 把一条诊断行里的路径连同它后面的位置标记一起删掉，只留消息。 */
function stripPathAndLocator(line, target) {
  if (target.length === 0) return line
  let out = line
  const forms = target.includes('\\') ? [target] : [target, target.replace(/\//g, '\\')]
  for (const form of forms) {
    let from = 0
    for (;;) {
      const haystack = CASE_INSENSITIVE ? out.toLowerCase() : out
      const needle = CASE_INSENSITIVE ? form.toLowerCase() : form
      const at = haystack.indexOf(needle, from)
      if (at === -1) break
      out = cutLocatorAt(out, at + form.length)
      out = out.slice(0, at) + out.slice(at + form.length)
      from = Math.max(0, at)
      if (from >= out.length) break
    }
  }
  return out
}

/**
 * 单条失败行的身份指纹：**路径与源位置都剥离，消息里的数字一律保留**。
 *
 * 这是第二轮深审缺陷 1 的修法核心。两个不同的信息必须分开处理：
 *   · 源位置（`:12:29`、`(12,9)`、`line 12`）是定位噪声 —— 编辑器改一行就会整体漂移，
 *     同一处的同一个错误不该因此变成「新错误」，也不该让收缩判定失效；
 *   · 消息里的数字（`case-1` / `case-2`、`TS2322`、`expected 3 to be 4`）是失败语义 ——
 *     全量归一化会把它们塌成同一条，健康 TDD 每轮换用例名的「新失败」就会被当成
 *     「旧失败回来了」（0.3.1 的 O 与 B 双误报就是这么来的）。
 */
function failureItemFingerprint(line, target = '') {
  const normalized = stripPathAndLocator(line, target)
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:,\-–—|>]+/, '')
    .trim()
    .slice(0, 240)
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16)
}

/**
 * 这一行是**栈帧**还是失败本体？
 *
 * 早期版本只认 JS 的 `at ...`，于是 Python 的 `File "...", line 10, in test_case`
 * 被当成失败条目：两个完全不同的断言只要共用同一个栈帧，集合身份就一模一样 ——
 * 不同错误被合并成「同一个错重复 2 次」，而健康 TDD 反过来被当成「旧失败回来了」
 * 数到翻转（第二轮深审缺陷 2，两个方向相反、都错）。
 *
 * 栈帧不是失败本体，但它承载**目标**：`AssertionError: case-one` 这类没有路径的
 * 异常消息要靠前面的栈帧定位。所以调用方要记下它、却不要把它算成一条条目。
 */
function isFrameLine(line) {
  if (/^at\s+\S/.test(line)) return true // JS / TS 栈帧
  if (/^File\s+["']/.test(line)) return true // Python 栈帧
  if (/^Traceback\s+\(most\s+recent\s+call\s+last\)/i.test(line)) return true // Python 表头
  if (/^-->\s/.test(line)) return true // Rust / go 的定位箭头
  if (/^\s*\|/.test(line)) return true // 带 | 的源码片段
  if (/^\S+:\d+(?::\d+)?:\s+in\s+\S/.test(line)) return true // pytest：`tests/a.py:10: in test_case`
  if (/^\S+:\d+(?::\d+)?\s*$/.test(line)) return true // 只有路径 + 行号，没有消息
  return false
}

/**
 * 聚合行：说的是「一共几个」，不是「哪一条失败了」。
 *
 * 典型：eslint 的 `✖ 10 problems (10 errors, 0 warnings)`、jest 的
 * `Tests: 1 failed, 1 total`、pytest 的 `1 failed, 2 passed in 0.31s`。
 * 这些行的措辞随剩余数量变化，收进集合会让 10 错与 9 错的集合互不包含、
 * 收缩判定失效（实测用例 42 就是这么红的）。
 *
 * 但它们**又必须**在缺陷 2 的修法之后继续被排除：那时无路径的失败行不再被整批丢掉，
 * 于是这条过滤是唯一的防线。
 */
// 汇总行还有一批**不带冒号**的写法，各个 runner 各有一套：
//   mocha   `  1 passing (5ms)` / `  2 failing`
//   vitest  ` Test Files  1 passed (1)` / `      Tests  2 passed (2)`
//   node:test `  ℹ tests 2` / `  ℹ pass 2` / `  ℹ fail 0` / `  ℹ duration_ms 5.1`
//   TAP     `TAP version 13`
// 早期只认带冒号的 `Tests: 2 passed`，于是上面这些**全绿**输出仍然各造一条失败条目：
// 一份全绿的 mocha/vitest 运行会被读成「有一个失败」，每换个耗时数字就换一次指纹。
// 这些都是统计，不是失败 —— 无论有没有冒号。
const AGGREGATE_LINE =
  /^(?:[\u2716\u2717\u00d7\u2715\u2713]\s*)?\d+\s*(?:problems?|errors?|warnings?|failures?|tests?|suites?|snapshots?|passed|failed)\b|^\s*(?:Test\s+Suites?|Tests|Snapshots?|Time|Ran|Duration|Files?)\s*[:\uff1a]|^(?:Test\s+Suites?|Tests?)\s+(?:failed|passed|skipped)\b|^(?:FAILED|ERROR)\s+\S+::|^(?:ERROR|WARNING)\s+in\s+\S+\s+\d+:\d+/i
/**
 * 汇总行里**不带冒号**的那一批（mocha / vitest / node:test / TAP 各有一套写法）：
 *   mocha      `  1 passing (5ms)` / `  2 failing`
 *   vitest     ` Test Files  1 passed (1)` / `      Tests  2 passed (2)`
 *   node:test  `  ℹ tests 2` / `  ℹ pass 2` / `  ℹ fail 0` / `  ℹ duration_ms 5.1`
 *   TAP        `TAP version 13`
 * 早期只认带冒号的 `Tests: 2 passed`，于是上面这些**全绿**输出仍然各造一条失败条目：
 * 一份全绿的 mocha / vitest 运行被读成「有一个失败」，每换个耗时数字就换一次指纹。
 * 这些都是统计，不是失败 —— 无论有没有冒号。
 */
const SUMMARY_LINE =
  /^\s*\d+\s+(?:passing|failing|pending)\b|^\s*(?:Test\s+)?Files?\s+\d+\s+(?:passed|failed)\b|^\s*Tests\s+\d+\s+(?:passed|failed|skipped)\b|^\u2139\s+\w+|^TAP\s+version\b/i

/** 汇总行判定：带冒号的旧形态与不带冒号的新形态合起来算。 */
function isAggregateLine(line) {
  return AGGREGATE_LINE.test(line) || SUMMARY_LINE.test(line)
}

/**
 * TAP 是**结构化协议**，不是自由文本：
 *   `TAP version 13`  版本头
 *   `# Subtest: ...` / `# tests 1` / `# pass 1` / `# fail 0` / `# duration_ms ...`
 *                    诊断注释与统计，`#` 后面才是内容
 *   `1..1`            计划行
 *   `---` … `...`     YAML 诊断块（缩进可有可无）
 * 这些行都不带路径，于是整批漏进兜底分支，被当成「一整段失败」——
 * 一份**全绿**的 TAP 输出因此也造出条目，耗时一改就换一次指纹（终审缺陷 2）。
 */
const TAP_VERSION = /^\s*TAP version \d+/m
// `not ok` 本身就是失败标记：它不依赖上下文，也不必等协议头出现。
const TAP_NOT_OK = /^not ok\b/i
const TAP_COMMENT = /^#\s/
const TAP_PLAN = /^\d+\.\.\d+(?:\s|$)/
const TAP_YAML_OPEN = /^---$/
const TAP_YAML_CLOSE = /^\.\.\.$/
// YAML 诊断块里只有这几个键承载语义消息。`duration_ms` / `type` / `stack` / `at` 是
// 元数据与位置，收进身份就会让「耗时变一点」变成「换了一个失败」。
const TAP_YAML_MESSAGE = /^(?:error|message|expected|actual|operator)\s*:\s*(.*)$/i

/**
 * pytest 的进度行是仪表，不是诊断：
 *   `tests/test_a.py .. [100%]` / `tests/test_a.py .F. [ 66%]`
 *   `tests/test_a.py::test_one FAILED [ 50%]`
 * 它带路径，于是「含路径 → 进集合」把整行收进去；一行里几个点、跑到几成每轮都在变，
 * 全绿的 pytest 因此被读成「有一个失败」（终审缺陷 3）。
 *
 * 判据只能是**结构**：路径 + 进度记号 + 结尾的百分比方括号。
 * `tests/test_a.py:12: error: expected 100%` 没有方括号，仍要算真诊断。
 */
const PYTEST_PROGRESS =
  /^\S.*?\s+(?:[.FEsxX]+|PASSED|FAILED|SKIPPED|XFAIL|XPASS|ERROR)\s*\[\s*\d+%\]$/

/**
 * 这一行的严重级别。`'warning'` 表示「它能定位到文件，但不是这次失败」。
 *
 * 为什么必须有这道闸：0.3.3 的分支是「含路径 → 直接进集合」，于是 ESLint 的
 * `src/a.js:1:1  warning  'first' is defined but never used  no-unused-vars`
 * 也成了失败条目 —— 同一个 error 一字不变、只有无关 warning 的变量名在变，
 * 集合就每轮不同：B 认不出来（不是同一个集合），P 反而把 warning 的变化
 * 解释成「修出了下一个错误」（实测 C1 在 step4 注入 P，第三轮缺陷 4）。
 *
 * 判据只能看**消息开头**：严重级别是行首一个独立列/前缀，不是正文里出现的词。
 * 否则 `AssertionError: warning total mismatch` 这种正话里的「warning」会被误杀。
 */
function severityOf(line, target) {
  const rest = target.length > 0 ? stripPathAndLocator(line, target) : line
  // 去掉路径之后，严重级别前面通常还剩分隔符：eslint 是两个空格，
  // tsc/csc 是 `: `，go vet 是 `: `。都剥掉再看开头。
  const lead = rest.replace(/^[\s:：,;|>-]+/, '')
  if (/^(?:warnings?|warn)\b/i.test(lead)) return 'warning'
  // `warning TS6196` / `warning CS0168` / `W0001`
  if (/^(?:W\d{3,5}\b|warnings?\s+[A-Z]{1,4}\d{2,5}\b)/i.test(lead)) return 'warning'
  // mypy / pyright 的 note 是**附加上下文**：它解释上一条 error 为什么发生，
  // 不是另一条失败。带上路径的 note 会被「含路径 → 进集合」直接收进去，
  // 于是同一处 error 一字不变、只有 note 指向的声明名在变，集合就每轮不同 ——
  // P 把 note 的变化读成「修出了下一个错误」（第四轮缺陷 C）。
  if (/^notes?\s*[:：]/i.test(lead)) return 'note'
  return ''
}

export function failureSetOf(text) {
  const raw = stripFileUrl(String(text ?? ''))
  // 整段的退化目标（没有栈帧可依时，无路径的失败行回落到它）。errorTargetOf 自己
  // 会先洗掉 runner 的会话头，所以这里直接传原文即可。
  const whole = errorTargetOf(raw)
  const items = new Set()
  const loose = new Set()
  // 最近一条栈帧的目标：给后面没有路径的异常消息定位。
  let frameTarget = ''
  // 栈帧的**作用域**：pytest 的 \`in test_case\` 与 \`FAILED path::test_case\`。
  // 两个不同用例落在同一文件、同一行、同一句 \`assert False\` 上，只有用例名不同 ——
  // 用例名不进身份，两条不同失败就塌成一条，健康 TDD 的「新失败」被读成「旧失败回来了」
  // （第四轮缺陷 D）。用例名只折进指纹哈希，不新增条目（集合仍只含一条）。
  let frameScope = ''
  // 无路径的失败行先挂起，等最近的栈帧落定归属；frames 记录每个栈帧的行号，
  // 用来判断「这条消息的栈帧在它前面还是后面」（Python 在前，V8 在后）。
  const pending = []
  const frames = []
  // 诊断块编号：空行是块边界。归属只在**同一块内**匹配 —— 否则 pytest 失败块的 E 行
  // 会去绑下一块里那条 V8 异常的栈帧，目标与作用域各自来自不同块（第四轮缺陷 D/E 的
  // 交叉面）。同一块内找不到栈帧时仍回落到全量，兼容「消息与栈帧之间空一行」的写法。
  let block = 0
  // 是否正处在一条栈帧的**上下文块**里（pytest 的 `def ...` / `> assert ...` / `E ...`，
  // Python traceback 的源码回显行）。整块都只贡献上下文，只有 `E` 诊断行例外。
  let inFrameBlock = false
  // TAP 是唯一「自带协议头」的方言：看到 `TAP version N` 就按结构逐行分类，
  // 而不是等这些行掉进兜底分支被当成一整段失败。
  const tapMode = TAP_VERSION.test(raw)
  let tapInYaml = false
  // 最近一条 `not ok` 的待定条目：YAML 诊断块里的语义消息要折进它的文本，
  // 这样「失败是什么」仍然进身份，而 `duration_ms` 不进。
  let tapLast = null
  for (const [lineNo, rawLine] of raw.split('\n').entries()) {
    const line = rawLine.replace(/\r$/, '').trim()
    // 空行是**诊断块的边界**：pytest 失败块之后隔一行再来一条裸 V8 异常，
    // 那条异常不属于上面那个用例。早先把空行当成「继续」处理，于是 inFrameBlock
    // 一直为真，裸异常的缩进行被当成回显丢掉、作用域也继续沿用上一块
    // （第四轮缺陷 D 的第二个面）。
    if (line.length === 0) {
      inFrameBlock = false
      block += 1
      continue
    }
    if (/^\[exit code: /i.test(line)) continue
    // ── TAP：先按协议结构分类，再谈失败 ──
    //
    // `# …` 是注释/统计、`1..N` 是计划、`---`…`...` 是 YAML 诊断块 —— 它们都不带路径，
    // 早期实现让它们整批漏进兜底分支，于是**全绿的 TAP 输出也造出一条失败**，
    // 而且 `duration_ms` 每跑一次就换一次指纹（终审缺陷 2）。
    if (tapMode) {
      if (tapInYaml) {
        if (TAP_YAML_CLOSE.test(line)) {
          tapInYaml = false
          continue
        }
        const pair = TAP_YAML_MESSAGE.exec(line)
        if (pair !== null && tapLast !== null) {
          const value = pair[1].replace(/^['"]|['"]$/g, '').trim()
          if (value.length > 0) tapLast.text = tapLast.text + ' ' + value
        }
        continue
      }
      if (TAP_YAML_OPEN.test(line)) {
        tapInYaml = true
        continue
      }
      if (TAP_COMMENT.test(line)) continue
      if (TAP_PLAN.test(line)) continue
      if (TAP_NOT_OK.test(line)) {
        const item = { line: lineNo, text: line, block, echo: false }
        pending.push(item)
        tapLast = item
        continue
      }
    }
    // ── pytest 进度行：仪表，不是诊断 ──
    //
    // `tests/test_a.py .. [100%]` 带路径，于是「含路径 → 进集合」把它收进去；
    // 一行里有几个点、跑到几成每轮都在变 —— 全绿的 pytest 因此被读成「有一个失败」，
    // 而身份还会随进度数字抖动（终审缺陷 3）。判据只能是结构：路径 + 进度记号 + 百分比方括号。
    if (PYTEST_PROGRESS.test(line)) continue
    if (isFrameLine(line)) {
      const frameAt = errorTargetOf(line)
      if (frameAt.length > 0) frameTarget = frameAt
      // 作用域是**这一帧自己的**，不能继承上一帧的。
      //
      // 一个输出里可以先后出现 pytest 的失败块与一条裸的 V8 异常：pytest 块以
      // "in test_one" 结尾之后再来一条 AssertionError + at a.test.mjs:4:9，若 scope
      // 沿用上一帧，这条 JS 异常的身份就被染上 ::test_one —— 同一个错误在「输出里
      // 有没有 pytest 块」两种情形下得到两个身份，收缩判定失效。
      const scopeHit = /\bin\s+(\S+)\s*$/.exec(line)
      frameScope = scopeHit !== null ? scopeHit[1] : ''
      frames.push({ at: frameTarget, scope: frameScope, line: lineNo, block, kind: frameKindOf(line) })
      inFrameBlock = true
      continue
    }
    // ── 栈帧上下文块内部：只有 `E` 行是诊断，其余都是回显 ──
    //
    // pytest 的失败块长这样：
    //     tests/test_a.py:10: in test_case
    //         def test_case():
    //     >       assert case == expected          ← 回显，逐字相同
    //     E       AssertionError: case-one        ← 诊断，每轮不同
    // 早期只跳过「紧跟栈帧且有缩进」的**一行**，于是 `def test_case():` 被跳过、
    // `> assert` 却漏进集合 —— 它带 assert 所以 looksLikeFailure 为真，而且每轮逐字
    // 相同，两个完全不同的断言因此有了公共条目，O 的条目交集判据把健康 TDD 读成
    // 「旧失败回来了」（第三轮缺陷 5）。
    const echo = /^([>E<])\s+/.exec(rawLine)
    if (inFrameBlock && echo !== null) {
      if (echo[1] !== 'E') continue // `> assert` / `< ...` 都是回显
      // `E` 行：剥掉标记，当作顶格的诊断消息处理（下面照常走分类）。
      const message = rawLine.slice(echo[0].length).trim()
      if (message.length > 0 && looksLikeFailure(message)) pending.push({ line: lineNo, text: message, block, echo: true })
      continue
    }
    // 块内的缩进行（`    def test_case():`、`    assert case == expected`）同样是回显。
    // 判据只能是结构性的：缩进 + 紧跟在栈帧之后 —— 真正的诊断消息顶格写。
    if (inFrameBlock && /^\s/.test(rawLine)) continue
    inFrameBlock = false
    const lineTarget = errorTargetOf(line)
    // ── 先分类，再决定要不要进集合 ──
    //
    // 「含路径」只能提供目标，不能单独证明这一行是失败。0.3.3 的分支直接
    // `if (lineTarget.length > 0) items.add(...)`，于是 ESLint 的 warning 行
    // （`src/a.js:1:1  warning  'first' is defined but never used`）也进了集合 ——
    // 同一个 error 一字不变、只有无关 warning 的变量名在变，集合就每轮不同：
    // B 认不出来，P 把 warning 的变化解释成「修出了下一个错误」（第三轮缺陷 4）。
    if (isAggregateLine(line)) continue
    if (LOGGER_NOISE.test(line)) continue
    // runner 的会话头（pytest 的 rootdir: / collected N items）与进度行（jest 的
    // RUNS <path>）带路径却不说明失败，留着会给每条造一个假条目。
    if (RUNNER_NOISE.test(line)) continue
    // 通过行（jest 的「勾 + 用例名」、TAP 的 ok N、jest 的 PASS 文件头）不是失败。
    if (PASS_LINE.test(line)) continue
    const severity = severityOf(line, lineTarget)
    // warning 与 note 都只是「能定位，但不是这次失败」。note 尤其危险：
    // mypy 的 note 紧跟在 error 后面、带同一个路径，收进集合就多出一条随文案变化的条目。
    if (severity !== '') continue
    if (lineTarget.length > 0) {
      items.add(`${lineTarget}|${failureItemFingerprint(line, lineTarget)}`)
      continue
    }
    // 无路径行：其余「像失败」的先放候选，等这一遍走完再决定。
    if (looksLikeFailure(line)) pending.push({ line: lineNo, text: line, block, echo: false })
  }
  // 有自带路径的诊断行（tsc / lint / go / cargo）→ 用它们，**再补上异常消息**。
  //
  // 0.3.2 在这里直接 `return items`，把 loose 全丢了。于是 Python 的
  // `AssertionError: case-one` 从不出现在集合里，只有栈帧进来（当时栈帧还被当成
  // 失败条目）—— 两个断言共用栈帧就成了同一条失败（缺陷 2）。现在栈帧只贡献目标，
  // 异常消息是条目本身，两者都不能少。
  // 无路径的失败行落定归属：**先看它后面的栈帧，再看它前面的**。
  //
  // 两种生态的栈帧位置正好相反：V8 是「消息在前、`at ...` 在后」，Python 是
  // 「`File ..., line N, in f` 在前、`AssertionError: ...` 在后」。早期实现只记
  // 「最近一条栈帧」，于是 `AssertionError: shared / at a:10 / AssertionError: shared / at b:20`
  // 里第二条消息沿用了第一条的栈帧目标，两个不同文件上的两条异常塌成一条 ——
  // 收缩判定把「两个错误变一个」看成「同一个错误没变」（第四轮缺陷 E）。
  //
  // 顺序也要固定：先算完这一遍所有帧，再逐条落定，不能边扫边定。
  const settle = () => {
    for (const item of pending) {
      const own = frames.filter((frame) => frame.block === item.block)
      const pool = own.length > 0 ? own : frames
      const after = pool.find((frame) => frame.line > item.line)
      const before = [...pool].reverse().find((frame) => frame.line < item.line)
      // 绑定方向由**方言**决定，不能一律后帧优先（第五轮缺陷 D）：
      //   · `E` 行是帧块内部的诊断 —— 它前面那一帧就是它自己的帧（pytest 帧在前）
      //   · 后面的帧是 `at ...`（V8 形态）→ 消息在前，用它
      //   · 后面的帧是 `File "x.py", line N` / `x.py:10: in f` → 那是**下一条**异常
      //     自己的帧，借给这一条就会把两条失败绑到同一目标上（实测 D 组 size=1）
      const preferAfter = item.echo !== true && after !== void 0 && after.kind === 'at'
      const frame = preferAfter ? after : before !== void 0 ? before : after
      const at = frame !== void 0 && frame.at.length > 0 ? frame.at : whole
      // 用例名（作用域）折进指纹，但不新增条目：同一文件同一行的两个不同用例
      // 必须给出两个不同身份（第四轮缺陷 D），集合大小仍受 sim 54e 约束为 1。
      const text = frame !== void 0 && frame.scope.length > 0 ? `${item.text} ::${frame.scope}` : item.text
      loose.add(`${at}|${failureItemFingerprint(text)}`)
    }
    pending.length = 0
  }
  settle()
  if (items.size > 0) {
    for (const item of loose) items.add(item)
    return items
  }
  // 整段都没有路径（jest 的「● 用例名 / 期望 / 实际」、裸的 AssertionError）：
  // 这时只能按「像失败的行」认，聚合行与日志噪声仍然被排除在外。
  if (loose.size > 0) return loose
  // 一条都不像（连断言关键词都没有）：退到「去掉日志噪声之后的整段」。
  //
  // 不能直接拿整段原文算指纹：同一个失败、每次多一行 `Warning: renderer notice-N`，
  // 身份就变了，O 永远等不到「旧失败回来」（深审缺陷 6 的另一半 —— 目标抽得出来时靠
  // 集合身份解决，抽不出来时得靠这里把噪声滤掉）。
  // 套件标题（mocha 的 `  my suite`、vitest 的 `  src/a.test.js > my suite`）没有标记、
  // 没有路径、也没有失败关键词，却能走到这里：它后面那条用例行被 PASS_LINE 排掉之后，
  // 整段就只剩这个标题，于是**一份全绿的 mocha 运行被读成一条失败**。
  // 判据只能是结构性的：一行「不像失败」且**紧跟一条通过行** —— 那是在给下面的用例起名，
  // 不是失败本身。反例 `AssertionError: x` 紧跟 `✔` 时仍保留：looksLikeFailure 为真。
  const trimmed = raw
    .split('\n')
    .map((line) => line.replace(/\r$/, '').trim())
    .filter((line) => line.length > 0)
  const core = []
  let fbYaml = false
  for (const [index, line] of trimmed.entries()) {
    if (/^\[exit code: /i.test(line)) continue
    if (isFrameLine(line)) continue
    // 同一批结构行在兜底分支里也必须排除：主循环跳过了它们，兜底若再捡回来，
    // 「全绿 TAP / 全绿 pytest 返回空集合」就又破功（终审缺陷 2、3）。
    if (tapMode) {
      if (fbYaml) {
        if (TAP_YAML_CLOSE.test(line)) fbYaml = false
        continue
      }
      if (TAP_YAML_OPEN.test(line)) {
        fbYaml = true
        continue
      }
      if (TAP_COMMENT.test(line) || TAP_PLAN.test(line)) continue
    }
    if (PYTEST_PROGRESS.test(line)) continue
    if (LOGGER_NOISE.test(line)) continue
    if (RUNNER_NOISE.test(line)) continue
    // 通过行不是失败 —— 兜底分支也不能把它捡回来（jest 的 `PASS path` 单独出现时，
    // 主循环刚把它排除，这里又会以「整段」的名义造出一条条目）。
    if (PASS_LINE.test(line)) continue
    // 聚合行（`Tests: 2 passed`）也只是统计：全绿的输出若只剩它，不该造出一条失败。
    if (isAggregateLine(line)) continue
    const next = trimmed[index + 1]
    if (next !== void 0 && PASS_LINE.test(next) && !looksLikeFailure(line)) continue
    core.push(line)
  }
  // 全段都只是通过行 / 聚合行 / 噪声：这份输出里没有失败，返回空集合比造一条假条目诚实。
  if (core.length === 0) return items
  items.add(`${whole}|${failureItemFingerprint(core.join('\n'))}`)
  return items
}

/**
 * 失败集合的稳定身份：把 `目标|指纹` 排序后哈希。
 *
 * 为什么要有它：`errorFingerprint(整段输出)` 会把无关的 warning 也算进去，
 * 于是「同一个失败、每次多一行 warning」被当成不同的失败 —— O 永远等不到「旧失败回来」
 * （深审缺陷 6）。集合身份只看**失败条目本身**，warning 不在其列。
 */
export function failureSetKey(items) {
  if (!(items instanceof Set) || items.size === 0) return ''
  return createHash('sha256').update([...items].sort().join('\n'), 'utf8').digest('hex').slice(0, 16)
}

/**
 * 失败条目集合里出现过哪些目标（`目标|指纹` 的前半段）。
 *
 * P 需要它来判断「换现场」：逐个修四个**独立文件**的单条 tsc 错误时，集合大小恒为 1，
 * 只有目标在换 —— 那是把不同地方分别修好，不是「打补丁换出下一个错」。
 * 只看集合大小会把它判成补丁链（实测误报）。
 */
export function failureTargetsOf(items) {
  const targets = new Set()
  if (!(items instanceof Set)) return targets
  for (const item of items) {
    const text = String(item)
    const cut = text.indexOf('|')
    if (cut > 0) targets.add(text.slice(0, cut))
  }
  return targets
}

/** 从 tool/result 的事件数据里拔出人能读的错误摘要。 */
function errorTextOf(data) {
  const message = data?.message
  const parts = []
  if (typeof message?.content === 'string') parts.push(message.content)
  else if (Array.isArray(message?.content)) {
    for (const block of message.content) {
      if (block && typeof block.text === 'string') parts.push(block.text)
    }
  }
  if (data?.error && typeof data.error.message === 'string') parts.push(data.error.message)
  return parts.join('\n').trim()
}

/** 结果文本 → 退出码。ops_bash 把 `[exit code: N]` 写在正文里。 */
export function exitCodeOf(text) {
  const match = /\[exit code:\s*(-?\d+)\]/i.exec(String(text ?? ''))
  if (match !== null) return Number(match[1])
  const alternate = /\bexit(?:ed)?\s+(?:with\s+)?(?:code|status)\s*[:=]?\s*(-?\d+)/i.exec(String(text ?? ''))
  if (alternate !== null) return Number(alternate[1])
  return void 0
}

function oneLine(text, limit) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

/**
 * 解析 SKILL.md：frontmatter 只取 description，正文原样作为 content。
 * 和 dsh-skill-office 的 parseSkill 同形，但**不引 yaml 依赖**——
 * 只认「description: xxx」这一行的最小正则，因为我们自己写这个文件、格式可控。
 * 一旦用户换成带多行 YAML（description: |）的版本，退化为「整段 frontmatter 当描述」也比炸掉强。
 */
function parseBundledSkill(raw, path) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (frontmatter?.[1] === undefined) throw new Error(`no YAML frontmatter in ${path}`)
  const block = frontmatter[1]
  let description = ''

  // 单行 description："..." 或 '...' 或裸值
  const inline = /^description:\s*(.+)$/m.exec(block)
  if (inline?.[1] !== undefined) {
    description = inline[1].trim()
    const quoted = /^(["'])([\s\S]*)\1$/.exec(description)
    if (quoted?.[2] !== undefined) {
      // 反转义：YAML 双引号串里 \" 与 \\ 是转义，单引号里 '' 是转义
      description =
        quoted[1] === '"'
          ? quoted[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\')
          : quoted[2].replace(/''/g, "'")
    }
  }

  // 块标量 description: |  — 取到下一个非缩进行为止
  if (description.length === 0) {
    const blockStyle = /^description:\s*[|>][-+]?\s*$/m.exec(block)
    if (blockStyle !== null) {
      const after = block.slice(blockStyle.index + blockStyle[0].length)
      const lines = []
      for (const line of after.split(/\r?\n/)) {
        if (line.length === 0) {
          lines.push('')
          continue
        }
        if (!/^\s/.test(line)) break
        lines.push(line.trim())
      }
      description = lines.join(' ').trim()
    }
  }

  if (description.length === 0) throw new Error(`no description in ${path}`)
  const body = raw.slice(frontmatter[0].length).trim()
  if (body.length === 0) throw new Error(`empty body in ${path}`)
  return { description, body }
}

/**
 * 把 assets/stuck-gate/SKILL.md 注册成 bundled 技能。
 *
 * 为什么 rank 用 600（= BUNDLED_SKILL_RANK）：`~/.dsh/skills` 是 USER_DSH_RANK=400，
 * 数值小的优先。用户自己放了一份同名技能时，他那份说话——这是对的，
 * 他显式覆盖了我们的默认文案。只有他没放，才用打包的这份。
 */
function registerBundledSkill(ctx, log) {
  const skills = ctx.skills
  if (skills === undefined || skills === null || typeof skills.registerProvider !== 'function') {
    log('skills service absent, bundled skill not registered')
    return
  }

  const directory = join(ASSET_ROOT, BUNDLED_SKILL_NAME)
  const locator = join(directory, 'SKILL.md')
  const resourceBase = directory.split(sep).join('/')

  // 启动时就解析一次：文件缺了/坏了应该在 apply 期就留痕，而不是等模型来调。
  const parsed = parseBundledSkill(readFileSync(locator, 'utf8'), locator)
  const candidate = {
    name: BUNDLED_SKILL_NAME,
    description: parsed.description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: name,
    source: 'bundled',
    rank: BUNDLED_SKILL_RANK,
    resourceBase: { kind: 'directory', path: resourceBase },
    locator
  }
  let cachedBody = parsed.body

  const provider = {
    name,
    list: () => Promise.resolve([candidate]),
    async get(_candidate, options) {
      // get 支持 signal；重读文件让用户改 assets 里的文案后无需重启。
      try {
        const raw = await readFile(locator, { encoding: 'utf8', signal: options?.signal })
        cachedBody = parseBundledSkill(raw, locator).body
      } catch (error) {
        // 读不到就退回启动时那份，别让一次 IO 抖动把技能变成不可用。
        if (options?.signal?.aborted === true) throw error
      }
      const { rank: _rank, locator: _locator, ...summary } = candidate
      return { ...summary, content: cachedBody }
    }
  }

  // 把 disposer 交回去：ctx.inject 的回调可能因为服务换代而重跑，
  // 重跑时不先摘掉上一代就会在 catalog 里堆出同名 provider。
  log(`bundled skill registered: ${BUNDLED_SKILL_NAME} <- ${locator}`)
  return ctx.skills.registerProvider(() => provider)
}

/**
 * PTC 执行器（`run_code`）内部的每一次 `tools.xxx()` 都**不**走 `tool/call`：
 * dsh-tool-executor-ptc 只 append `tool/ptc-dispatch-start`（发起）与
 * `tool/ptc-dispatch`（结算）这两类 log-only 事件。插件原先只认 tool/call，
 * 于是「用 run_code 写文件 / 跑测试 / 搜索」这一整层对它完全不可见：
 * 转向不算转向（futile 假增长 → M 误报）、失败不进 episode、盲改计数不涨。
 *
 * 这里把两类事件**改写成 tool/call 与 tool/result 的形状**，让后面整段记账原样复用，
 * 不复制任何判据。settle 事件的字段（isError / content / error）与 tool/result 同一套词汇。
 *
 * 为什么不干脆把 run_code 自己归进 SOFT_MEASURE_TOOLS：它的参数是 `code` 而不是
 * `command`，measureDirs 读不到目录 → 一次「顺手跑了下测试」会把**所有**路径的盲改
 * 计数一起清零。宁可让子调用逐个说话，也不要拿根的粗归类去洗白。
 */
/** 把 PTC 的 log-only 派发事件映射成插件已经在记的 tool/call、tool/result。 */
function eventViewOf(event) {
  const type = event?.type
  const raw = event?.data ?? {}
  if (type === 'tool/ptc-dispatch-start') {
    if (typeof raw.subCallId !== 'string' || typeof raw.name !== 'string') return void 0
    return {
      type: 'tool/call',
      data: {
        callId: raw.subCallId,
        name: raw.name,
        arguments: raw.arguments,
        // 子事件不带 step：由 tool/call 分支回落 s.pendingStep（pre-step 落的当前步）。
        step: void 0,
        ptcParent: typeof raw.parentCallId === 'string' ? raw.parentCallId : ''
      }
    }
  }
  if (type === 'tool/ptc-dispatch') {
    if (typeof raw.subCallId !== 'string') return void 0
    return {
      type: 'tool/result',
      data: {
        message: {
          isError: raw.isError === true,
          content: raw.content,
          source: { kind: 'tool', callId: raw.subCallId }
        },
        ...(raw.error === void 0 ? {} : { error: raw.error }),
        step: void 0,
        ptcParent: typeof raw.parentCallId === 'string' ? raw.parentCallId : ''
      }
    }
  }
  return { type, data: raw }
}

/**
 * 测量结果到达 → 连续盲改状态清零（可选择只清它管得到的路径）。
 *
 * 为什么要按目录过滤：`npm test` 在 `C:/other` 跑完，不能替 `C:/work/src/x.js`
 * 洗白——那道闸门守的是「这个文件改完没测」，别的目录的测试不是它的测量。
 *
 * 只依赖 cfg（体内 ctx. / state. / record( 各 0 次），所以能整段抽成模块级工厂：
 * 194 行的状态机不再必须经过 apply 才能被测（P1-8）。
 */
export function createMeasureSettler({ cfg }) {
  return (s, { tool, args, ok, exit, atStep, text }) => {
    const dirs = measureDirs(args)
    let cleared = 0
    if (cfg.decayEditsOnVerify) {
      if (dirs.size === 0) {
        cleared = s.streakEdits.size
        s.streakEdits.clear()
      } else {
        for (const path of [...s.streakEdits.keys()]) {
          const dir = dirOf(path)
          let hit = false
          for (const candidate of dirs) {
            if (dir === candidate || dir.startsWith(`${candidate}/`) || candidate.startsWith(`${dir}/`)) {
              hit = true
              break
            }
          }
          if (hit) {
            s.streakEdits.delete(path)
            cleared += 1
          }
        }
      }
      // 只要测到了一条，上膛状态就解除：C 的前提是「改了 N 处一次都没测」，
      // 测过了前提就没了。这里过去要求 streakEdits 被清空才算测过 —— 带 workdir 的
      // 测量只清它管得到的目录，剩下一条没清就保留武装，于是同一个 turn 里
      // 反复上膛反复开口（实测同一 turn 最多响 3 次）。
      if (cleared > 0) {
        s.measureArmed = false
        s.wroteWhileArmed = false
        s.blindWrites = 0
      }
    }
    s.lastMeasure = { tool, ok, exit, atStep }
    // 拿到新事实 → 重新武装：同一长 turn 的另一个阶段再犯，值得再说一次。
    s.fired.A = 0
    // C 只认**成功**的测量：失败的测量没带来任何新事实，改了 N 处之后
    // 跑一次红的测试，仍然处在「盲改」状态里，这时候重新武装等于允许同一现场
    // 再喊一遍（实测 C 命中率只有 6.3%，反复喊同一个现场是主因之一）。
    if (ok) s.fired.C = 0
    // F 的重新武装：一次 ok 测量就是这个错误族的「新事实」，族还留着（历史仍然有效），
    // 但允许它再开口一次。
    if (ok) {
      s.fired.F = 0
      // O 不在这里重新武装：振荡里每隔一次就是 ok，按 ok 重新武装等于每次翻转都
      // 重说一遍同一件事（实测一个 turn 里连发三条一样的 O）。它的重新武装放在
      // 「flips 被清零」的那一刻 —— 那条回路真的稳住了，下次再振荡才算新的一轮。
      // P 也一起重新武装：验证终于通过了，这一串补丁到此结束，下次再连起来是新的链。
      s.fired.P = 0
      // 一次成功验证也把 M 的无效计数清零：这说明提醒之后确实有人把局面推动过。
      s.futile = 0
    }
    // ── O：同一组验证在 ok/fail 之间翻转。必须夹着写入，纯测量翻转是 flaky。
    //
    // 判据不是「颜色变了」，而是「**一个已经绿过的失败又回来了**」。
    // 健康 TDD 每一轮的红都是**新的**失败（新用例没写实现），颜色同样来回变，
    // 但指纹在换 —— 那是进展，不是来回推。
    //
    // 为什么记的是「近期失败指纹集合」而不是「上一次的指纹」：最典型的振荡是
    // 改 A 让 B 红、改 B 又让 A 红，指纹按 A/B/A/B 轮换。只比对上一个指纹的话，
    // 每次 fail 都被当成「新失败」而清零，这种形态永远数不到（实测四面全哑）。
    // 集合只要**曾经绿过一次**的失败又出现就算一次推回原地，容量小、FIFO，
    // 这样健康 TDD 仍然计不到（它的每个红都是从没出现过的指纹）。
    //
    // 翻转计数记在 series 上：换一条命令（换一组用例）本来就是另一条回路，
    // 不该合并计数。
    const seriesKey = measureKey(tool, args)
    const prevSeries = s.measureSeries.get(seriesKey)
    const series = prevSeries ?? { lastOk: ok, lastWriteSeq: s.writeSeq, flips: 0, recentFailSets: [] }
    // 失败集合只算一次，下面三处（O 的复发交集、失败测量记账、P 的收缩判据）共用。
    // 它们原先各自调一遍 failureSetOf —— 同一份文本被完整解析三次，实测 98 KB 的
    // vitest 输出单次 2.66 ms、三次 7.97 ms，而失败测量是最热的路径（第五轮缺陷）。
    // 空文本仍退化成空集合，三处的语义与原来逐字等价。
    const failSet = ok || typeof text !== 'string' || text.length === 0 ? new Set() : failureSetOf(text)
    if (!ok) {
      // 判「同一个失败回来了」用的是**条目交集**，不是整集合身份相等。
      //
      // 两步都走过：先用整段输出指纹（无关 warning 一多就认不出，深审缺陷 6），
      // 再改成整集合哈希（失败集合稍微变一点也认不出）。后者的问题在于真实局面上
      // 极少有「集合一模一样地回来」——更常见的是老失败里又添了一条新的：
      // `{A} → 绿 → {A,B} → 绿 → {A,C} → 绿 → {A,D}` 是 A 一直在复发，整集合哈希
      // 却每次都不同，于是十轮都不说话（第二轮深审缺陷 3）。
      //
      // 交集判据同时守住两头：健康 TDD 的每个红都是新条目，与历史零交集 → 计不到；
      // `{A} → 绿 → {B}` 也确实不是复发 → 不算。
      if (failSet.size > 0) {
        const seen = Array.isArray(prevSeries?.recentFailSets) ? prevSeries.recentFailSets : []
        const recurring =
          prevSeries !== void 0 &&
          prevSeries.lastOk === true &&
          s.writeSeq > prevSeries.lastWriteSeq &&
          seen.some((past) => Array.isArray(past) && past.some((item) => failSet.has(item)))
        if (recurring) series.flips = (prevSeries.flips ?? 0) + 1
        // 这条回路回到「稳住了」的状态就重新武装**它自己**。
        //
        // 不能清全局 s.fired.O：0.3.0 就是这么写的，于是任何一条**新**回路首次 ok
        // （flips 天然是 0）都会把别人的静音解除，同一个局面连说两遍（实测 step 12/13
        // 连续两步文案逐字相同）。静音属于「这一条回路」这个粒度。
        if (series.flips === 0) series.announced = false
        // 新集合只是入队，**不**清零：交替振荡里 A、B 都在队列内，
        // 从第三次失败起就能连续计数；健康 TDD 的新失败永远不在队列里，仍然计不到。
        series.recentFailSets = [...seen, [...failSet]].slice(-RECENT_FAIL_LIMIT)
      }
    } else if (prevSeries !== void 0 && prevSeries.lastOk === true) {
      // 连续两次 ok = 这条回路稳了。清零并重新武装它自己（下次再振荡是新的故事）。
      series.flips = 0
      series.announced = false
    }
    series.lastOk = ok
    series.lastWriteSeq = s.writeSeq
    s.measureSeries.set(seriesKey, series)

    // ── 失败测量的重复记账（深审缺陷 1）。
    //
    // s.errors 只收 isError:true 的工具错误；`npm test` 返回 1 是 isError:false 的
    // **测量失败**，过去从不进任何重复计数 —— 于是 P 的 unchanged 分支把链清零之后，
    // 同一个失败一字未变地重复八轮也换不来一条提醒。这里按「回路 + 失败集合身份」记一份，
    // 交给 B 那条「同一个错重复 N 次」的观察接管。
    //
    // 关键限定：**只有连续失败才算重复**。这条回路一旦绿过，它名下的 episode 全部作废 ——
    // 「失败 → 绿 → 同一个失败」不是「同一个错重复 N 次」，那是振荡（O 负责），
    // 用 B 去说会与 O 撞车（实测健康 TDD 与 40 号交替振荡用例都因此多出一条 B）。
    if (ok) {
      for (const key of [...s.failEpisodes.keys()]) {
        if (key.startsWith(`${seriesKey}|`)) s.failEpisodes.delete(key)
      }
    } else {
      const failSetKey = failureSetKey(failSet)
      if (failSetKey !== '') {
        const episodeKey = `${seriesKey}|${failSetKey}`
        const seenEpisode = s.failEpisodes.get(episodeKey)
        if (seenEpisode === void 0) {
          s.failEpisodes.set(episodeKey, {
            count: 1,
            sample: oneLine(text, 160),
            searchBaseline: 0,
            firstClock: s.clock
          })
        } else {
          seenEpisode.count += 1
          seenEpisode.lastClock = s.clock
        }
      }
      // 失败测量也要推进幂等状态（第二轮深审缺陷 4）。
      //
      // 通用幂等闸只比 writeSeq / errorSeq：`npm test` 失败既不写入、又不是
      // isError:true，于是「失败 → 提醒 → 再失败到阈值」这一段 writeSeq 与 errorSeq
      // 全都没动，闸门用「什么都没变」把第二次提醒挡掉（实测 4a 只注入 1 次，
      // 本该 2 次）。给失败测量一个自己的单调序号，三项任一变化都算「局面变了」。
      //
      // **无条件推进**，不挂在 `failSetKey !== ''` 里面（P1-11 / A4）。曾经只在解析出
      // 至少一条条目时才加一，于是 vitest 崩溃、输出被截断、只有 exit code 1 而认不出
      // 失败行的那些运行，failSeq 一动不动 —— 闸门把「真的失败了一轮」读成「什么都没
      // 发生」，第二次提醒被自己挡掉。解析不出条目是解析器的能力边界，不是「局面没变」
      // 的证据。推进本身不会造成噪音：光打开幂等闸不产生注入，还得有 A/B/C 之一真的
      // 命中（A 要 streakEdits、B 要 episode、C 要上膛），空集合时 B 天然数不到。
      s.failSeq += 1
    }
    // ── P：连续「失败 → 写入 → 仍失败」，且**失败面没有收缩**。
    //
    // 只比写入序号是不够的（0.3.0 的原始判据）：它把三种健康形状全判成补丁链 ——
    // 逐个修独立文件（改 m1 之后 m2 才报错）、收敛中的清扫（10 → 9 → 8 个错）、
    // 以及「同一个错完全没变」。区别不在有没有失败，而在失败面有没有收缩：
    //   · 集合严格变小（当前 ⊆ 上一次且更小）→ 在收敛，chain 直接归零；
    //   · 集合完全没变 → 这一轮什么都没推动，不算「修出了下一个失败」，不计数；
    //   · 变了但没变小（换成别的错、或多出新的）→ 这才是补丁链。
    if (ok) {
      s.repairChain = 0
      s.lastFailSet = new Set()
    } else if (s.writeSeq > s.lastFailWriteSeq) {
      const previous = s.lastFailSet instanceof Set ? s.lastFailSet : new Set()
      const current = failSet
      const unchanged =
        previous.size > 0 && current.size === previous.size && [...current].every((item) => previous.has(item))
      const shrunk =
        previous.size > 0 && current.size < previous.size && [...current].every((item) => previous.has(item))
      // 「换现场」：这次的失败全都落在**本 turn 从未出现过**的目标上。逐个修四个独立文件
      // 就是这个形状（集合大小恒为 1，只有路径在换），把它算成补丁链就是误报。
      //
      // 比的是 s.seenFailTargets（见过的所有目标），不是「上一轮的失败目标」。
      // 只比上一轮时，A→B→A→B 这种旧现场循环里每一轮的当前目标都不在上一轮里，
      // 于是每一轮都被判成「换了新现场」→ chain 反复清零 → 十轮都不说话（深审缺陷 2）。
      const currentTargets = failureTargetsOf(current)
      const movedSite =
        s.seenFailTargets.size > 0 &&
        currentTargets.size > 0 &&
        ![...currentTargets].some((target) => s.seenFailTargets.has(target))
      for (const target of currentTargets) s.seenFailTargets.add(target)
      // unchanged（一字未变）必须**清零**，不能只是「不计数」。
      //
      // 不清零的话 A→A(不变)→B→C 会把四轮说成「连续 3 轮每一轮都修出了下一个失败」，
      // 而中间那一轮根本没换失败（深审缺陷 3）。
      s.repairChain = unchanged || shrunk || movedSite ? 0 : s.repairChain + 1
      s.lastFailWriteSeq = s.writeSeq
      s.lastFailSet = current
    }
    s.clock += 1
    return cleared
  }
}

/**
 * 把一条注入真正送出去：埋 pending、写日志、拼消息。
 *
 * 抽出来是因为 M 与普通信号走同一条投递路径，但**不进**普通预算计数——
 * 计数在调用方做，这里只管「发出去 + 记下来」，免得两条路径的日志形状漂移。
 *
 * 只依赖 ctx 与 record（体内 cfg. / stateFor / eligible / turnState 各 0 次），
 * 所以整段能抽成模块级工厂：日志形状与消息形状可直接断言，不必跑完一整轮（P1-8）。
 */
export function createDeliverer({ ctx, record }) {
  return async (session, { turn, step, decision, s, text, tag, inj, extra }) => {
    // 埋点：等注入之后的第一条工具调用 / 第一个转向动作。
    // 放在 lastFireMark 之后：这次注入确实发生了，才值得收结果。
    s.pendings.push({
      inj,
      tag,
      turn,
      atStep: Number(step),
      before: s.lastAction,
      firstSeen: false,
      first: void 0,
      changed: false
    })

    try {
      ctx.logger?.info?.(
        `dsh-better-debug: inject session=${session.id} turn=${turn} step=${step} signals=${tag}`
      )
    } catch {}
    // 日志是唯一的验收面。A 按 streakEdits 判定，必须把那个数单独写出来；
    // worstEdits 仍是本 turn 累计次数（面板沿用，不改形状）。
    let worstEdits = 0
    for (const count of s.edits.values()) if (count > worstEdits) worstEdits = count
    let worstStreak = 0
    for (const count of s.streakEdits.values()) if (count > worstStreak) worstStreak = count
    let worstErrors = 0
    let errorSample = ''
    for (const entry of s.errors.values()) {
      if (entry.count > worstErrors) {
        worstErrors = entry.count
        errorSample = entry.sample
      }
    }
    await record(
      `inject session=${session.id} turn=${turn} step=${step} signals=${tag} inj=${inj} ` +
        `chars=${text.length} tokens=${estimateTokens(text)} ` +
        `blind=${s.blindWrites} ` +
        `files=${s.edits.size} worstEdits=${worstEdits} worstStreak=${worstStreak} ` +
        `worstErrors=${worstErrors} ` +
        `searched=${s.searchedThisTurn} ` +
        `measured=${s.lastMeasure === void 0 ? 'no' : `yes:${s.lastMeasure.tool}:${s.lastMeasure.ok ? 'ok' : 'fail'}`}` +
        (extra ? ` ${extra}` : '') +
        (errorSample ? ` sample=${JSON.stringify(errorSample.slice(0, 80))}` : '')
    )

    return {
      ...decision,
      messages: [
        ...decision.messages,
        {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text }],
          // 自报家门，便于 UI 折叠与去重；必须是稳定的 kind 字符串。
          source: { kind: 'dsh-better-debug' }
        }
      ]
    }
  }
}

// P1-10：写端从 apply 里抽出来。轮转与 A12 的 mkdir 去重都是纯文件系统逻辑，
// 只依赖 cfg 与 ctx.logger；抽成模块级工厂后可以直接喂临时目录断言「到阈值就轮转」
// 「轮转后最老一份被丢弃」「目录只 mkdir 一次」，不必把整个 apply 状态机跑起来。
export function createLogWriter({ cfg, ctx }) {
  // 落盘失败只 warn 一次：目录不可写（权限、只读盘、路径写错）时，
  // 每次事件都 warn 会把 stdout 刷爆；一次不说又会变成「插件装了但面板永远空着」
  // 这种最难查的状态。
  let warnedLogFailure = false
  // A12：目录建一次就够了，不必每条日志都做一次 mkdir 系统调用。写失败时把它
  // 打回 false（目录被删、盘被拔），下一次写会重试一次而不是永久放弃。
  let logDirReady = false
  // P1-10 写端轮转：日志是 append-only 的，不轮转就无限长；而读端每次请求都要
  // 解析全文，长度直接变成面板延迟。logBytes 是内存里的游标，-1 表示未知
  // （首次写、或上一次写失败），未知时用一次 stat 补上，之后靠自增，不必每条 stat。
  let logBytes = -1
  const rotateLog = async () => {
    // 从最老的一份开始挪：log.(n-1) → log.n，最后 log → log.1。
    // rename 在 POSIX 与 Windows（MOVEFILE_REPLACE_EXISTING）上都会覆盖目标，
    // 所以最老那份自然被丢弃，不需要先 unlink。
    // 份数必须取整：`normalizeConfig` 已经 round 过，但这里是唯一直接消费它的
    // 循环，就地再夹一次，避免以后有人绕过 normalizeConfig 直接构造 cfg。
    const keep = Math.max(1, Math.trunc(cfg.logKeep))
    for (let index = keep; index >= 1; index -= 1) {
      const from = index === 1 ? cfg.logFile : `${cfg.logFile}.${index - 1}`
      try {
        await rename(from, `${cfg.logFile}.${index}`)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
  }
  const record = async (line) => {
    if (cfg.logFile.length === 0) return
    try {
      if (!logDirReady) {
        await mkdir(dirname(cfg.logFile), { recursive: true })
        logDirReady = true
      }
      if (logBytes < 0) {
        try {
          logBytes = (await stat(cfg.logFile)).size
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
          logBytes = 0
        }
      }
      if (logBytes >= cfg.logMaxBytes) {
        await rotateLog()
        logBytes = 0
      }
      const chunk = `${new Date().toISOString()} ${line}\n`
      await appendFile(cfg.logFile, chunk, 'utf8')
      logBytes += Buffer.byteLength(chunk, 'utf8')
    } catch (error) {
      // 写失败后内存游标不再可信（可能已经 rename 走、也可能整条没写进去）。
      logBytes = -1
      logDirReady = false
      if (warnedLogFailure) return
      warnedLogFailure = true
      try {
        ctx.logger?.warn?.(
          `better-debug: 写不进日志 ${cfg.logFile}（${error?.code ?? error?.message ?? error}）；` +
            '闸门仍然工作，但面板和事后验收都看不到数据。把 logFile 指到一个可写目录，或设为 "" 显式关闭。'
        )
      } catch {}
    }
  }
  return { record }
}

export function apply(ctx, config) {
  // 非法正则的告警要在 record 建好之后才能落盘，所以先在这里收集。
  const invalidRegexes = []
  const cfg = normalizeConfig(config, (message) => invalidRegexes.push(message))

  // 与 warnedLogFailure 同一纪律：同一个故障只喊一次，否则每写一个文件就刷一条。
  let warnedIntentFailure = false
  // 写端整体抽到 createLogWriter（P1-10 轮转 / A12 mkdir 去重）。
  const { record } = createLogWriter({ cfg, ctx })

  // README 承诺「三个正则键传入非法正则会回退内置默认并记 warn」。回退是静默的，
  // 不说出来用户永远查不到「我明明收窄了 measureCommands，怎么还在误判」。
  for (const message of invalidRegexes) {
    void record(`config: ${message}`)
    try {
      ctx.logger?.warn?.(`better-debug: ${message}；该键已回退内置默认。`)
    } catch {}
  }

  // 0.3.5 把 C 的判据从「步数」换成「盲改次数」，配置键随之改名。
  // 旧键仍然读入（老配置不能静默失效），但**默认值变了**（2 步 → 3 次写入），
  // 而且两者不可换算 —— 不说出来，用户会以为自己的调参还在生效。
  if (config !== null && typeof config === 'object' && config.noVerifySteps !== void 0 && config.noVerifyWrites === void 0) {
    const message =
      `noVerifySteps 已改名为 noVerifyWrites（C 现在数「盲改次数」而不是「步数」），` +
      `本次仍按旧键值 ${cfg.noVerifyWrites} 生效；请改成 noVerifyWrites。`
    void record(`config: ${message}`)
    try {
      ctx.logger?.warn?.(`better-debug: ${message}`)
    } catch {}
  }

  if (!cfg.enabled) {
    void record('disabled by config, no gate installed')
    return
  }

  // 把自带的 stuck-gate 技能注册进 catalog，否则别人装了这个插件，
  // 注入文本末尾那句「完整五条：skill `stuck-gate`」就是指向空气。
  //
  // 但 `skills` 服务不是所有宿主都有（见文件顶 inject 的注释），所以这里
  // 动态订阅：服务在就注册，不在就只是少一个可选功能。
  // 整段包 try/catch：技能注册失败（老版本 DSH、用户自己放了一份同名技能）
  // 不该让闸门本身失效。
  const mountSkill = (skillCtx) => {
    try {
      registerBundledSkill(skillCtx ?? ctx, (line) => void record(line))
    } catch (error) {
      void record(`skill register failed: ${error?.message ?? error}`)
    }
  }
  try {
    if (typeof ctx.inject === 'function') ctx.inject(['skills'], mountSkill)
    else mountSkill(ctx)
  } catch (error) {
    void record(`skill register failed: ${error?.message ?? error}`)
  }

  // 每次热重载/启动都留一行，验收靠它判断「插件到底加载了没有」。
  // ctx.logger 只进 Electron 主进程 stdout，事后没法 grep，所以必须有落盘旁路。
  void record(
    `apply pid=${process.pid} logFile=${cfg.logFile} ` +
      `A=${cfg.repeatEditThreshold} B=${cfg.repeatErrorThreshold} C=${cfg.noVerifyWrites} ` +
      `budget=${cfg.maxInjectsPerTurn} window=${cfg.changedWindow} panel=${cfg.panel} ` +
      // v0.3 的六个新键必须落在启动行里：热重载后要能一眼看出「新代码到底读到的是
      // 默认值还是 profile 里覆盖过的值」，否则阈值不生效时无从判断是代码还是配置。
      `F=${cfg.repeatFamilyThreshold}/${cfg.familyMinFingerprints} ` +
      `O=${cfg.oscillationThreshold} P=${cfg.patchChainThreshold} ` +
      `M=${cfg.metaAfterFutile}/${cfg.metaGate ? 1 : 0} ` +
      // 轮转档位同理：日志忽然只剩最后几行时，第一件事是确认是「被轮转了」而不是「写挂了」。
      `logMax=${cfg.logMaxBytes} logKeep=${cfg.logKeep}`
  )

  // 面板：只读视图，挂 /better-debug。
  // 用动态注入而不是加进 `export const inject` —— 后者是结构性变更，
  // 热重载会失败、且会让没有 webServer 的宿主连闸门都装不上。
  // 注意 mount 必须用注入回调收到的子 ctx：cordis 里没 inject 的 ctx 读服务会抛
  // `cannot get property "webServer" without inject`，外层 ctx 是拿不到 webServer 的。
  if (cfg.panel) {
    const mount = (webCtx) => {
      try {
        registerPanel(webCtx ?? ctx, () => cfg)
      } catch (error) {
        void record(`panel register failed: ${error?.message ?? error}`)
      }
    }
    try {
      if (typeof ctx.inject === 'function') ctx.inject(['webServer'], mount)
      else mount(ctx)
    } catch (error) {
      void record(`panel unavailable: ${error?.message ?? error}`)
    }
  }

  /** session → 本 turn 的全部观测。turn/start 重置。 */
  const state = new Map()

  /**
   * session → Map<信号指纹, 已提醒次数>。**跨 turn** 保留，turn/end 不清。
   *
   * 为什么不是恢复跨 turn 的阈值累计：那会让第 3 个 turn 之后永久报警（同一件事
   * 一旦发生过就再也回不到零）。这里只记「这件事被提醒过几次」，作用是让人和模型
   * 看见「这不是新问题」——实测有个 session 在 26 个 turn 里反复命中同一个坑、
   * 注入 31 次，每次文案都是「第一次」。
   */
  const seen = new Map()

  const fresh = (turn) => ({
    turn,
    /** 本 turn 累计编辑次数（按路径），只用于日志的 worstEdits。 */
    edits: new Map(),
    /**
     * 连续盲改：自上次**测量结果**以来对同一路径的编辑次数。
     * 一次测量结果返回就清零（或只清它管得到的那些路径）——有回路的收敛不该算打转。
     */
    streakEdits: new Map(),
    /**
     * 自上次**测量结果**以来的盲改次数（跨文件、跨步，全局标量）。
     *
     * 为什么不用「步数」：0.3.5 及以前用「当前步号 - 最后一次写入的步号」当判据，
     * 而那个起点每次写入都会刷新 —— 于是每步都改时差值恒为 1 永不触发（漏报），
     * 「改 → 读一眼 → 改」时差值恒为 2 立刻上膛（误报）。实测 182 条 arm 行的
     * 间隔全部等于 2，唯一值，正是这个轴的产物。
     *
     * 真正要数的是「写了几处还没验证」：读文件、搜索、思考都不该稀释它，
     * 也不该由步号去推断（步号里既有动作也有静默）。只有测量结果能把它清零。
     */
    blindWrites: 0,
    /** 盲改次数到了 noVerifyWrites：只上膛，不开口。 */
    measureArmed: false,
    /** 上膛之后真的又写了一次 —— 这时才该说话。 */
    wroteWhileArmed: false,
    /** 最近一次测量：{tool, ok, exit, atStep}，注入文本与日志都用它。 */
    lastMeasure: void 0,
    pendingStep: void 0,
    /** callId → {name, args, measure}：结果回来时才知道该不该清零。 */
    calls: new Map(),
    /**
     * PTC 记账：根 run_code 的 callId 集合，以及「这个根下面已经有子调用结算过」的集合。
     *
     * 为什么要去重：run_code 的根调用在程序抛错时也是 isError:true，而真正失败的
     * 那个子调用（比如 tools.edit 的 old_string not found）已经单独记过一次账。
     * 两条都记 → 同一次失败被数两遍，B/F 的计数直接翻倍。
     */
    ptcRoots: new Set(),
    /** 已经有子调用**失败**结算过的根 callId。 */
    ptcFailed: new Set(),
    /** episode key → {count, sample, tool, target, firstClock}。 */
    errors: new Map(),
    /** 单调时钟：工具调用/报错/搜索/测量各推进一格，用来判「搜索是否晚于 episode」。 */
    clock: 0,
    lastSearchClock: 0,
    searchedThisTurn: false,
    writeSeq: 0,
    errorSeq: 0,
    /**
     * 失败测量的单调序号（第二轮深审缺陷 4）。
     *
     * 通用幂等闸判的是「局面有没有变」，0.3.2 只比 writeSeq / errorSeq —— 而
     * 「`npm test` 又失败了一次」两者都不变（它不是写入，也不是 isError:true）。
     * 于是「失败 → 提醒 → 再失败到阈值」这个形状里，第二次提醒会被闸门当成
     * 「什么都没发生」直接挡掉。失败测量自己推进一格，闸门才算看得见它。
     */
    failSeq: 0,
    /** 本 turn 每个信号已说过的次数（测量后递减，实现重新武装）。 */
    fired: { A: 0, B: 0, C: 0, F: 0, O: 0, P: 0, M: 0 },
    injectionsThisTurn: 0,
    /** 上次提醒时的 {writeSeq, errorSeq, failSeq}；三者都没变说明白提醒了。 */
    lastFireMark: void 0,
    /** 最近一次动作 {name, cls}，注入时记进 outcome 的 before=。 */
    lastAction: void 0,
    quiet: false,
    /** 交付态：present **成功返回**之后置 true，下一次写入重新置 false。 */
    done: false,
    /**
     * F：错误族。key 是 `${tool}|${target}`（**不含指纹**），value 累积这个目标上
     * 出现过多少种指纹、各几次。
     *
     * 为什么族 key 不用指纹：F 要观察的正是「同一个目标上错误在变种」，用指纹做 key
     * 每个变种都是独立 episode，永远数不到一起，F 就退化成 B 的复制品。
     */
    errorFamilies: new Map(),
    /**
     * O：同一组验证的结果序列。key 是工具名 + 规范化命令，value 记上次 ok、
     * 当时的 writeSeq、以及**这条回路自己**的翻转次数。
     *
     * 为什么翻转次数挂在 key 上而不是全局一个数：O 的文案说的是「同一组验证」。
     * 健康 TDD 每轮换一个失败用例（`npm test -- a.test.js` → `-- b.test.js`），
     * 每组各自红转绿一次是进展；把它们加在一起算成「来回推」就是误报。
     */
    measureSeries: new Map(),
    /** P：连续「失败 → 写入 → 再失败」的轮数。一次 ok 测量清零。 */
    repairChain: 0,
    /** P：上次记链时的 writeSeq，防止同一段写入被重复计一轮。 */
    lastFailWriteSeq: 0,
    /** P：上一次失败验证的条目集合（`目标|指纹`）。比它小＝在收敛，等于它＝没推动。 */
    lastFailSet: new Set(),
    /**
     * P：本 turn 里**曾经出现过**的失败目标（滚雪球，不清零）。
     *
     * `movedSite` 只跟「上一次的失败目标」比是不够的：A→B→A→B 这种旧现场循环里
     * 每一轮的当前目标都不在上一轮里，于是每一轮都被判成「换了个新现场」→ chain 反复清零
     * → 十轮都不说话（深审缺陷 2）。改成跟「见过的所有目标」比：只有当前失败全部
     * 落在前所未见的目标上，才算真的换了现场。
     */
    seenFailTargets: new Set(),
    /**
     * 失败测量的重复 episode：key 是 `measureKey|失败集合指纹`，value 记重复次数与
     * 「最近一次被搜索时的计数」。
     *
     * 为什么要单独一份：`s.errors` 只收 isError:true 的工具错误，而「npm test 返回 1」
     * 是 isError:false 的**测量失败**，从来进不了那里（深审缺陷 1 的机制）。于是 P 的
     * unchanged 分支把链清零后，没有任何信号接手 —— 同一个失败一字未变地重复八轮，
     * 一条提醒都没有。这份 episode 让 B 那条「同一个错重复 N 次」的观察也能覆盖测量失败。
     */
    failEpisodes: new Map(),
    /**
     * M：无效注入计数。一条注入的 pending 在窗口内**没有**转向就被移除 → +1；
     * 出现转向（changed=true）或任意一次 ok 测量 → 清零。
     */
    futile: 0,
    /** 本 turn M 是否已经说过（M 每 turn 至多一次，且不占普通预算）。 */
    metaFiredThisTurn: false,
    /**
     * 注入后等着的收尾：每条注入一个 pending，只记第一条后续动作（立刻落盘），
     * 再在窗口内盯第一个真正的转向动作（verify/search）落一条 change 行。
     */
    pendings: []
  })

  const stateFor = (session) => {
    let s = state.get(session)
    if (s === void 0) {
      s = fresh(void 0)
      state.set(session, s)
    }
    return s
  }

  /** 插件可能在本 turn 中途热加载而错过 turn/start，此时也要开始记账。 */
  const turnState = (session, turn) => {
    const s = stateFor(session)
    if (turn !== void 0 && s.turn !== turn) {
      state.set(session, fresh(turn))
      return state.get(session)
    }
    return s
  }

  /**
   * 测量结果到达 → 连续盲改状态清零（可选择只清它管得到的路径）。
   *
   * 为什么要按目录过滤：`npm test` 在 `C:/other` 跑完，不能替 `C:/work/src/x.js`
   * 洗白——那道闸门守的是「这个文件改完没测」，别的目录的测试不是它的测量。
   */
  // 只依赖 cfg，抽成模块级工厂才能直接喂输入断言（P1-8）。
  const settleMeasure = createMeasureSettler({ cfg })

  ctx.on('session/event', (session, event) => {
    if (event === null || event === void 0) return
    // PTC 子调用在会话里只有 log-only 的派发事件（tool/ptc-dispatch[-start]）。
    // 统一换成 tool/call / tool/result 的视图，后面整段记账原样复用。
    const view = eventViewOf(event)
    if (view === void 0) return
    const data = view.data ?? {}
    if (view.type === 'turn/start') {
      state.set(session, fresh(data.turn))
      return
    }
    if (view.type === 'turn/end') {
      const s = state.get(session)
      if (s !== void 0 && (s.turn === void 0 || s.turn === data.turn)) state.delete(session)
      return
    }
    if (view.type === 'user/message') {
      // 只认真正的人话（source.kind === 'user'），插件自己注入的不算。
      const source = data.source ?? {}
      if (source.kind !== 'user') return
      const blocks = Array.isArray(data.content) ? data.content : []
      const text = blocks
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
      if (text.length === 0) return
      const s = stateFor(session)
      // 用户明确说「别搜/直接改」→ 整 turn 静音（D 段例外）。
      if (QUIET_PATTERN.test(text)) s.quiet = true
      return
    }
    if (view.type === 'tool/call') {
      const s = stateFor(session)
      const args = data.arguments !== null && typeof data.arguments === 'object' ? data.arguments : {}
      const measure = isMeasurement(data.name, args, cfg)
      const cls = classifyTool(data.name, measure)
      const ptcParent = typeof data.ptcParent === 'string' ? data.ptcParent : ''
      if (typeof data.callId === 'string' && typeof data.name === 'string') {
        s.calls.set(data.callId, { name: data.name, args, measure, ptcParent })
        if (ptcParent.length > 0) s.ptcRoots.add(ptcParent)
      }
      s.clock += 1

      // PTC 根调用里的写入：`await tools.write(...)` 不经过 fs/write-intent，
      // 于是「在 run_code 里连写 12 个文件」曾经是零注入的完全盲区。
      // 只看代码文本，粗粒度、不区分路径、不计 streakEdits —— 宁可多算一次盲改，
      // 也不能让整条 A/C 通道在 PTC 里失明。
      if (
        data.name === 'run_code' &&
        typeof args?.code === 'string' &&
        /(?:[.]write\s*\(|writeFile|appendFile|fs\.write)/.test(args.code)
      ) {
        s.blindWrites += 1
        s.writeSeq += 1
        if (s.measureArmed) s.wroteWhileArmed = true
      }

      // 注入后第一条工具调用，就是「模型听没听」的第一层证据。
      // 记下来、当场收尾：只收第一条，晚到的动作不能把早先的原地打转盖掉。
      const at = Number(data.step)
      // PTC 子事件不带 step：退回 pre-step 落下的当前步。窗口判定的精度不变
      // （同一 step 内发起的子调用归到这一 step），比直接放弃判定强。
      const stepNow = Number.isFinite(at)
        ? at
        : ptcParent.length > 0 && Number.isFinite(s.pendingStep)
          ? s.pendingStep
          : void 0
      for (const pending of s.pendings) {
        if (pending.firstSeen === false && typeof data.name === 'string') {
          pending.firstSeen = true
          pending.first = { name: data.name, cls }
          void record(
            `outcome session=${session.id} turn=${pending.turn} inj=${pending.inj} after=${pending.tag} ` +
              `first=${data.name} class=${cls} steps=${stepNow === void 0 ? 0 : Math.max(0, stepNow - pending.atStep)} ` +
              `before=${pending.before?.name ?? '-'}`
          )
        }
        // 第二层：窗口内第一个真正的转向动作（验证 / 搜索）。中位步数都从这算。
        if (
          pending.changed === false &&
          (cls === 'verify' || cls === 'search' || cls === 'method' || READ_TOOLS.has(data.name)) &&
          typeof data.name === 'string'
        ) {
          pending.changed = true
          // 有一次真的转向 → 之前攒的无效计数作废：M 说的「提醒没换来转向」不成立了。
          if (s.futile !== 0) s.futile = 0
          void record(
            `change session=${session.id} turn=${pending.turn} inj=${pending.inj} after=${pending.tag} ` +
              `tool=${data.name} class=${cls} steps=${stepNow === void 0 ? 0 : Math.max(0, stepNow - pending.atStep)}`
          )
        }
      }
      // 收掉已经看过第一动作、又超出窗口的 pending；窗口内继续等转向。
      //
      // 顺手记 M 的输入：一条注入看过第一动作、窗口内**没等到**转向就被移除 = 一次无效注入。
      // 只数「看过第一动作」的那些：还没人搭理的 pending 是进行中的观察，不是失败。
      // 窗口未知（stepNow 缺失）时不做判定，宁可漏计也不误计。
      const kept = []
      for (const pending of s.pendings) {
        // 已经转过向的，收尾工作早就写完了，直接移除（不参与 futile 计数）。
        if (pending.changed === true) continue
        const expired =
          pending.firstSeen === true &&
          stepNow !== void 0 &&
          stepNow > pending.atStep + cfg.changedWindow
        if (!expired) {
          kept.push(pending)
          continue
        }
        s.futile += 1
        void record(
          `futile session=${session.id} turn=${pending.turn} inj=${pending.inj} after=${pending.tag} ` +
            `count=${s.futile} window=${cfg.changedWindow}`
        )
      }
      s.pendings = kept

      s.lastAction = { name: data.name, cls }
      // 交付态：present **结果成功后**才休眠；调用发起就休眠会把失败的 present 当交付。
      if (SEARCH_TOOLS.has(data.name)) {
        s.searchedThisTurn = true
        s.lastSearchClock = s.clock
        // 搜索是外部先验，和测量同级：重新武装 A / C / F。
        //
        // F 必须在这里重新武装，不能像原来那样写在「同族又错一次」的分支里：
        // 那个分支的条件是 `lastSearchClock > family.firstClock`，而族一旦被搜索过，
        // 收集端就会用**同一个条件**把它整族跳过 —— 于是「重新武装」永远落在一个
        // 不会被读到的位置。真正需要重新武装的是**下一个族**（换了目标之后又堆出一串
        // 新报错），它的 firstClock 在搜索之后，靠族内比较永远为假。
        s.fired.A = 0
        s.fired.B = 0
        s.fired.C = 0
        s.fired.F = 0
        // 重复 episode 同理：搜索之后要重新攒够次数才再说（深审缺陷 4）。
        //
        // 不能只把触发条件改成 `lastSearchClock > lastClock` —— 那样搜索后第一次复发
        // 就满足了总数阈值，把「拿到外部事实之后又撞了一次」当成「重复报错 N 次」。
        // 记下搜索当时的计数，之后只数「搜索之后新攒的次数」：
        // 搜索的语义是「拿到外部事实了，之前的重复不算数」——但**之后**的重复仍然要算数。
        // 0.3.1 用的是 entry.firstClock（episode 首次出现的时钟），那是一次搜索终生免责：
        // 搜索后同一个错再重复六次也不响。改成记一个基线，
        // 有效重复次数 = 当前计数 − 基线，重新攒够阈值才报。
        for (const entry of s.errors.values()) entry.searchBaseline = entry.count
        for (const episode of s.failEpisodes.values()) episode.searchBaseline = episode.count
      }
      return
    }
    if (view.type === 'tool/result') {
      const s = stateFor(session)
      const callId = data.message?.source?.callId
      const call = typeof callId === 'string' ? s.calls.get(callId) : void 0
      const text = errorTextOf(data)
      const isError = data.message?.isError === true || data.error !== void 0
      const ptcParent = typeof data.ptcParent === 'string' ? data.ptcParent : ''
      if (ptcParent.length > 0 && isError === true) s.ptcFailed.add(ptcParent)
      s.clock += 1

      // 测量必须**等到结果**才清零：发起就清零等于把「打算测」当成「测过了」。
      if (call !== void 0 && call.measure === true) {
        const exit = exitCodeOf(text)
        const ok = isError !== true && (exit === void 0 || exit === 0)
        // 失败身份不在这里算：settleMeasure 内部用 failureSetOf 算一次、三处复用
        // （O 的复发交集 / 失败测量记账 / P 的收缩判据）。早先这里还额外算一次
        // errorFingerprint 传进去，而 settleMeasure 从未读过它 —— 一次白算的整段解析。
        const cleared = settleMeasure(s, {
          tool: call.name,
          args: call.args,
          ok,
          exit,
          atStep: Number(data.step),
          text
        })
        void record(
          `measure session=${session.id} turn=${s.turn ?? '-'} tool=${call.name} ok=${ok} ` +
            `exit=${exit === void 0 ? '-' : exit} cleared=${cleared}`
        )
        if (typeof callId === 'string') s.calls.delete(callId)
        // 失败的测试也是有效测量：它给了新事实，不该继续算「盲改」。所以这里不 return。
      }
      // 交付态：present 的结果回来了，且不是报错 —— 现在才算交付完成。
      if (call?.name === 'present' && isError !== true) {
        s.done = true
        if (typeof callId === 'string') s.calls.delete(callId)
        return
      }
      if (!isError) {
        if (typeof callId === 'string') s.calls.delete(callId)
        return
      }
      if (text.length === 0) return
      // PTC 去重：根 run_code 的失败只是「里面某个子调用抛了」的回声，那个子调用已经
      // 单独记过账（tool/ptc-dispatch 带 isError）。再记一遍等于把同一次失败数两遍。
      if (
        typeof callId === 'string' &&
        s.ptcRoots.has(callId) &&
        s.ptcFailed.has(callId)
      ) {
        s.calls.delete(callId)
        return
      }
      const fingerprint = errorFingerprint(text)
      const target = errorTargetOf(text)
      const tool = call?.name ?? 'tool'
      const key = `${tool}|${target}|${fingerprint}`
      const prev = s.errors.get(key)
      s.errorSeq += 1
      if (prev === void 0) {
        s.errors.set(key, {
          count: 1,
          sample: oneLine(text, 160),
          tool,
          target,
          firstClock: s.clock
        })
      } else {
        prev.count += 1
        prev.lastClock = s.clock
      }
      // ── F：错误族。同一 (工具|目标) 上出现多少种**不同**指纹。
      // 与 B 的分工：B 数「同一个错重复几次」，F 数「同一个目标换了几个错」——
      // 后者才是方案层固着的信号（改来改去只换来下一个错误）。
      //
      // 抽不出目标（`target === ''`）时**不进族**：那等于把「所有没路径的报错」当成
      // 同一个目标。实测这么干会把四个完全不同项目的 tsc 报错（0.3.0 的正则认不出
      // `src/a.ts(12,9)` 形式）在第 5 步报成「同一个目标上已经出现 4 种不同报错」。
      // F 的前提是「同一个目标」，前提不成立就不该开口 —— B 仍然能用（它的 key 带指纹）。
      const familyKey = target.length > 0 ? `${tool}|${target}` : ''
      const family = familyKey.length > 0 ? s.errorFamilies.get(familyKey) : void 0
      if (familyKey.length === 0) {
        // 没有目标：只留 B 的记账，不参与 F。
      } else if (family === void 0) {
        s.errorFamilies.set(familyKey, {
          count: 1,
          fingerprints: new Set([fingerprint]),
          sample: oneLine(text, 160),
          tool,
          target,
          firstClock: s.clock,
          // 「最近一次真的换了个新错」的时钟。搜索免疫要比的是它，不是 firstClock：
          // 拿首次出现比，会让一次搜索把这一族**终生**免责（0.3.0 的缺陷）。
          lastNewClock: s.clock
        })
      } else {
        family.count += 1
        if (!family.fingerprints.has(fingerprint)) {
          family.fingerprints.add(fingerprint)
          family.lastNewClock = s.clock
        }
        family.lastClock = s.clock
        // 这里**不**做「被搜索过就重新武装」：收集端已经用
        // `lastSearchClock > family.lastNewClock` 把整族跳过了，族内再减 fired.F
        // 是永远读不到的分支。重新武装在 tool/call 的搜索分支里统一做。
      }
      if (typeof callId === 'string') s.calls.delete(callId)
    }
  })

  ctx.on('session/disposed', (session) => {
    state.delete(session)
    // 跨 turn 的「提醒过几次」随会话一起消失：它描述的是这个会话的历史，
    // 不是全局事实。留着只会在 id 复用时把新会话标成「第 7 次」。
    seen.delete(session.id)
  })

  // 同一文件反复改：只认写入意图，不认「读」。prepend 保证在别的消费者之前拿到原始 target。
  ctx.on('fs/write-intent', async (target, actor, next) => {
    const intent = await next()
    try {
      const session = actor === null || actor === void 0 ? void 0 : actor.agent?.session
      if (session === void 0 || session === null) return intent
      const abs = targetPath(target)
      if (abs === void 0) return intent
      if (!isAbsPath(abs)) return intent
      // 生成物 / 锁文件 / 日志不算盲改：改它们本来就不该触发「你有没有测」。
      if (cfg.excludePaths.test(abs.replace(/\\/g, '/'))) return intent
      const s = stateFor(session)
      s.edits.set(abs, (s.edits.get(abs) ?? 0) + 1)
      s.streakEdits.set(abs, (s.streakEdits.get(abs) ?? 0) + 1)
      s.writeSeq += 1
      // 上膛之后又动手了 —— C 的开口条件就是这一下。
      if (s.measureArmed) s.wroteWhileArmed = true
      // 又开始改了 → 交付态解除，闸门重新武装。
      s.done = false
      // 「上一条动作」也要算上写入本身：写入走的是 fs/write-intent，
      // 不一定有对应的 tool/call（直接写文件、别的插件代写都会这样）。
      // 不记这一步的话，注入行的 before= 会空成 '-'，面板就没法说「从改转到了测」。
      s.lastAction = { name: 'write', cls: 'edit' }
      // 盲改计数：写入本身就把这个数往上推，与步号无关 —— 读多少次都不会稀释它，
      // 只有测量结果（createMeasureSettler）能清零。
      s.blindWrites += 1
    } catch (error) {
      // 这里过去是空的 `catch {}`：这段里任何一环抛错（stateFor 建状态、
      // excludePaths 正则、Map 操作、宿主给的 target 形状不对），写入计数、streakEdits、
      // writeSeq 就一起静默丢失，而闸门看起来一切正常 —— 只是永远不开口。
      // A 信号的输入**只**来自这个 handler（tool/call 里的 edit 也走 fs/write-intent），
      // 所以一次静默失败等于整条 A 通道断掉，且没有任何外部症状可查。
      // 落一行 intent-failed 让面板/事后验收能看见，warn 只报一次（每次写都报会刷屏）。
      void record(
        `intent-failed target=${String(target)} error=${error?.code ?? error?.message ?? error}`
      )
      if (!warnedIntentFailure) {
        warnedIntentFailure = true
        try {
          ctx.logger?.warn?.(
            `better-debug: fs/write-intent 处理失败（${error?.code ?? error?.message ?? error}）；` +
              'A 信号（同一文件连续改）对这些写入不可见，其余信号不受影响。'
          )
        } catch {}
      }
    }
    return intent
  }, { prepend: true })

  // 只依赖 ctx 与 record，抽成模块级工厂才能直接断言日志/消息形状（P1-8）。
  /**
   * 一条信号的「同一件事」指纹。只用于 seen 计数，不参与任何判据。
   *
   * C 不参与：C 是「改了几处没测量」，随手改的重复很正常，给它编号只是噪音。
   * 其余按 detail 里的**现场标识**取：A 是文件基名，B/F 是报错样本前 40 字，
   * P 是轮数无关的常量（同一串补丁链说第二遍就该标第 2 次），O 同理。
   */
  const fingerprintOf = (signal) => {
    if (signal.kind === 'C') return ''
    const detail = typeof signal.detail === 'string' ? signal.detail : ''
    if (signal.kind === 'A') return `A|${detail}`
    if (signal.kind === 'P') return 'P|chain'
    if (signal.kind === 'O') return 'O|series'
    return `${signal.kind}|${detail.slice(0, 40)}`
  }

  /** 只看不记：这批信号里最「老」的那条会是本会话第几次。 */
  const seenTimes = (sessionId, signals) => {
    const bucket = seen.get(sessionId)
    let times = 1
    for (const signal of signals) {
      const key = fingerprintOf(signal)
      if (key.length === 0 || bucket === void 0) continue
      const count = (bucket.get(key) ?? 0) + 1
      if (count > times) times = count
    }
    return times
  }

  /**
   * 投递成功之后再记账。
   *
   * 顺序不能反：投递失败（deliver 抛错）还先记账，下次就会谎报「第 2 次」。
   */
  const commitSeen = (sessionId, signals) => {
    let bucket = seen.get(sessionId)
    if (bucket === void 0) {
      bucket = new Map()
      seen.set(sessionId, bucket)
    }
    for (const signal of signals) {
      const key = fingerprintOf(signal)
      if (key.length === 0) continue
      bucket.set(key, (bucket.get(key) ?? 0) + 1)
    }
  }

  const deliver = createDeliverer({ ctx, record })

  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    const decision = await next()
    try {
      if (decision.kind === 'reject') return decision
      if (signal?.aborted) return decision
      const session = agent?.session
      if (session === null || session === void 0) return decision
      if (!eligible(session)) return decision

      const s = turnState(session, turn)
      // 写入发生在 step 内部，所以这里把当前 step 记下来给 write-intent 用。
      s.pendingStep = step

      if (s.quiet) return decision
      // 交付态：present 已成功，且之后没有新的写入 →
      // 本轮没有「下一次尝试」，闸门不该再落（修掉「结论 → 一串工具调用」倒挂）。
      // 留一行 suppress，让「闸门醒着但故意不出声」和「闸门根本没挂上」可区分。
      if (cfg.doneOnPresent && s.done) {
        if (!s.fired.done) {
          s.fired.done = 1
          void record(`suppress session=${session.id} turn=${turn} step=${step} reason=done`)
        }
        return decision
      }

      // M 必须排在**通用幂等闸之前**：M 的触发输入是 futile（提醒到期没换来转向），
      // 而「提醒之后既没新写入也没新错误」恰恰是 futile 增长的那段时间 —— 若先查幂等，
      // 幂等会用「什么都没变」把 M 挡掉，于是最该做元观察的局面永远等不到 M。
      // M 本身有自己的闸（fired.M < 1 + metaFiredThisTurn），每 turn 至多一次，不需要幂等兜底。
      // ── M：元闸门。优先级最高，且**不占** maxInjectsPerTurn 普通预算。
      //
      // 为什么单独一条：A/B/C/F/O/P 说的都是「你又做了同一件事」，M 说的是
      // 「我提醒过你 N 次，你既没验证也没转向」——后者是元层面的，再叠一句
      // 战术观察只会让消息更长、更不像人话。所以 M 独立成条、每 turn 至多一次。
      if (cfg.metaGate && s.fired.M < 1 && !s.metaFiredThisTurn && s.futile >= cfg.metaAfterFutile) {
        s.fired.M += 1
        s.metaFiredThisTurn = true
        // futile 不在这里清零：规格要求「M 发出后保持原值」，`fired.M < 1` 已经挡住
        // 重复触发，清零反而会让后续 futile 行的 count 从 1 重新数起、看起来像没发生过。
        const futile = s.futile
        s.lastFireMark = { writeSeq: s.writeSeq, errorSeq: s.errorSeq, failSeq: s.failSeq }
        const text = metaMessageText(futile)
        const inj = createHash('sha256')
          .update(`${session.id}|${turn}|${step}|M|${s.injectionsThisTurn}`)
          .digest('hex')
          .slice(0, 8)
        return await deliver(session, {
          turn,
          step,
          decision,
          s,
          text,
          tag: 'M',
          inj,
          extra: `futile=${futile}`
        })
      }

      // 上一次提醒之后既没多写一次、也没多吃一个错 —— 再说一遍只是噪音。
      // 模型需要的是「新事实」，不是「更严厉的同一句话」。
      if (
        s.lastFireMark !== void 0 &&
        s.lastFireMark.writeSeq === s.writeSeq &&
        s.lastFireMark.errorSeq === s.errorSeq &&
        (s.lastFireMark.failSeq ?? -1) === s.failSeq
      ) {
        return decision
      }

      // C 的上膛：盲改累计到 N 次还没测量，**只上膛不开口**。阅读和思考不该被打断，
      // 只有「上膛之后又动手」才说明它要带着没有回路的状态继续改。
      if (!s.measureArmed && s.blindWrites >= cfg.noVerifyWrites) {
        s.measureArmed = true
        void record(`arm session=${session.id} turn=${turn} step=${step} writes=${s.blindWrites}`)
      }

      if (s.injectionsThisTurn >= cfg.maxInjectsPerTurn) return decision

      const signals = []

      // A：同一文件「自上次测量以来」累计改了 N 次（不要求相邻）。
      if (s.fired.A < 1) {
        let worstPath
        let worst = 0
        for (const [path, count] of s.streakEdits) {
          if (count > worst) {
            worst = count
            worstPath = path
          }
        }
        if (worst >= cfg.repeatEditThreshold) {
          const base = worstPath.split(/[/\\]+/).pop() ?? worstPath
          signals.push({ kind: 'A', n: worst, detail: `（${base}）` })
        }
      }

      // B：同一个 error episode（工具 + 目标 + 指纹）重复，且这个 episode 之后没搜过。
      //
      // 两份来源：
      //   · s.errors     —— isError:true 的工具错误；
      //   · s.failEpisodes —— isError:false 的**测量失败**（`npm test` 返回 1）。
      // 后者过去无人接管：P 的 unchanged 分支清零后，同一个失败重复八轮都没有提醒（深审缺陷 1）。
      //
      // 两边的「搜索免疫」都按**搜索之后的净次数**算，不按 firstClock 一刀切：
      // 一次搜索就给整个 episode 终生免责，等于把「做过一次外部检索」当成「这个问题
      // 已经解决了」；而实际上搜索之后又撞了六次，恰恰说明事实没解决问题（深审缺陷 4）。
      if (s.fired.B < 1) {
        let worst
        let worstCount = 0
        for (const entry of s.errors.values()) {
          const effective = entry.count - (entry.searchBaseline ?? 0)
          if (effective < cfg.repeatErrorThreshold) continue
          if (effective > worstCount) {
            worstCount = effective
            worst = entry
          }
        }
        // 测量失败已经在补丁链上时，B 让位给 P。
        //
        // B 说的是「这一个错重复了」，P 说的是「这一串补丁本身在制造下一个失败」——
        // 后者是对的诊断，前者只是症状。实测 P 的阈值（3）永远追不上 B 的（2），
        // 于是 20 天日志里 P 一次都没响过、B 抢了所有补丁链的开口机会。
        //
        // 只让 failEpisodes 这一层让位。s.errors 那一层（工具用错：unknown tool、
        // old_string not found）不是补丁链，B 该管，不受影响。
        for (const episode of s.failEpisodes.values()) {
          if (s.repairChain >= 1) break
          const effective = episode.count - (episode.searchBaseline ?? 0)
          if (effective < cfg.repeatErrorThreshold) continue
          if (effective > worstCount) {
            worstCount = effective
            worst = episode
          }
        }
        if (worst !== void 0) {
          signals.push({ kind: 'B', n: worstCount, detail: `报错：${worst.sample}` })
        }
      }

      // C：盲改攒够了、上膛之后又写了一次，仍然没有测量。
      //
      // 与 A 互斥：A 说「同一个文件改了 N 次」，比「一共改了 N 处」更具体，
      // 同一现场两条一起发只是把同一句话换个说法（实测 C 占全部注入的 71%，
      // 其中大半与 A 的现场重叠）。
      if (s.fired.C < 1 && s.fired.A < 1 && s.measureArmed && s.wroteWhileArmed) {
        signals.push({ kind: 'C', n: s.blindWrites })
      }

      // F：同一个目标上错误在变种（不同指纹 ≥ familyMinFingerprints，总次数 ≥ repeatFamilyThreshold）。
      // 与 B 同时命中是可能的：B 说「这一个错重复了」，F 说「这里已经换了几种错」。
      // 两者一起出现时信息不重复，但会让消息变长——所以 F 命中时压掉 B（见下方排序）。
      let familyHit
      if (s.fired.F < 1) {
        for (const family of s.errorFamilies.values()) {
          if (family.fingerprints.size < cfg.familyMinFingerprints) continue
          if (family.count < cfg.repeatFamilyThreshold) continue
          // 搜索免疫按「最近一次出现**新**指纹」算，不是按族首次出现。
          // 用 firstClock 的话一次搜索就把这一族终生免责（0.3.0 的缺陷）：
          // 搜到外部事实之后照样可能继续换错，那才更该说。
          if (s.lastSearchClock > (family.lastNewClock ?? family.firstClock)) continue
          if (familyHit === void 0 || family.count > familyHit.count) familyHit = family
        }
      }

      // O：同一组验证在 ok/fail 之间翻转，且每次翻转之间都有写入。
      // 逐条回路看：换命令（换失败用例）是进展，不是来回推。
      // 静音也逐条回路记（series.announced），不用全局 s.fired.O —— 全局那份会被
      // 别的回路首次 ok 误解除，同一局面连说两遍。
      let oscillated = 0
      let oscillatedSeries = null
      for (const series of s.measureSeries.values()) {
        if (series.announced === true) continue
        if (series.flips >= cfg.oscillationThreshold && series.flips > oscillated) {
          oscillated = series.flips
          oscillatedSeries = series
        }
      }

      // P：连续「验证失败 → 写入 → 仍失败」。
      let chain = 0
      if (s.fired.P < 1 && s.repairChain >= cfg.patchChainThreshold) chain = s.repairChain

      // P 与 F 同时命中时只发 P：P 说的是「这一串补丁本身在制造下一个失败」，
      // 比 F 的「这里换了几种错」更接近方案层，且 F 的观察是 P 的成因之一。
      // F 记一次 fired，避免下一 step 立刻再来说同一件事。
      if (chain > 0) {
        signals.push({ kind: 'P', n: chain })
        if (familyHit !== void 0) s.fired.F += 1
      } else if (familyHit !== void 0) {
        // detail 按规格带 target 与最近一条 sample。target 即使看起来在 sample 里出现过
        // 也照写：sample 是截断过的一行，模型未必看得出那是同一个现场。
        const where =
          familyHit.target !== void 0 && familyHit.target.length > 0 ? `目标：${familyHit.target} ` : ''
        signals.push({
          kind: 'F',
          n: familyHit.fingerprints.size,
          m: familyHit.count,
          detail: `${where}报错：${familyHit.sample}`
        })
      }
      // F / P 一旦开口，B 就是同一件事的弱化版（「这一个错重复了」vs「这里换了几种错」），
      // 留着只会把消息撑长、把重点稀释。压掉它，但记 fired 免得下一 step 又挤进来。
      // 补丁链已经在跑时 B 也让位：那时 signals 里的 B 只可能来自 s.errors 层
      // （failEpisodes 层已被上面的 break 跳过），而「同一串补丁反复失败」这个诊断
      // 比「某个工具报错重复了」更接近真相。
      if (chain > 0 || familyHit !== void 0 || s.repairChain >= 1) {
        const at = signals.findIndex((signal) => signal.kind === 'B')
        if (at !== -1) {
          s.fired.B += 1
          signals.splice(at, 1)
        }
      }
      if (oscillated > 0) {
        signals.push({ kind: 'O', n: oscillated })
        if (oscillatedSeries !== null) oscillatedSeries.announced = true
      }

      if (signals.length === 0) return decision

      // `?? 0` 兜住动态键：fired 表里漏了 O 时，`s.fired['O'] += 1` 会得到 NaN，
      // 而 NaN < 1 恒为 false —— O 就会永久失声，且没有任何报错。
      for (const signal of signals) s.fired[signal.kind] = (s.fired[signal.kind] ?? 0) + 1
      // A/B 已经说明了局面；同一句话再补一句「改完没测量」只是换个说法。
      if (signals.some((signal) => signal.kind !== 'C')) s.fired.C += 1
      s.wroteWhileArmed = false
      s.injectionsThisTurn += 1
      s.lastFireMark = { writeSeq: s.writeSeq, errorSeq: s.errorSeq, failSeq: s.failSeq }

      const times = seenTimes(session.id, signals)
      const text = messageText(signals, times)
      const tag = signals.map((signal) => signal.kind).join('+')
      const inj = createHash('sha256')
        .update(`${session.id}|${turn}|${step}|${tag}|${s.injectionsThisTurn}`)
        .digest('hex')
        .slice(0, 8)
      const next = await deliver(session, { turn, step, decision, s, text, tag, inj, extra: '' })
      commitSeen(session.id, signals)
      return next
    } catch (error) {
      try {
        ctx.logger?.warn?.(`dsh-better-debug: pre-step error: ${error?.message ?? error}`)
      } catch {}
      return decision
    }
  }, { prepend: true })
}

export default { name, inject, apply }
