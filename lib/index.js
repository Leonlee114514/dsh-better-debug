import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { dirname, join, sep } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { registerPanel } from './panel.js'
import { messageText, estimateTokens } from './text.js'

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

/** 语义上「一定在测量」的工具，不需要再看参数。 */
export const HARD_MEASURE_TOOLS = new Set(['lsp_diagnostics', 'verify', 'run_tests', 'run_test'])

/** 要按参数再判一次的工具（`ops_bash` 既能跑测试也能 `ls`）。 */
export const SOFT_MEASURE_TOOLS = new Set(['ops_bash', 'bash', 'shell', 'pwsh'])

/** 会改动仓库那类工具。 */
export const EDIT_TOOLS = new Set(['edit', 'write', 'ops_write', 'str_replace', 'apply_patch', 'notebook_edit'])

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

/** D 段例外：用户显式要求别折腾。 */
const QUIET_PATTERN = /别搜|不要搜|不用搜|先别搜|直接改|快速试|别折腾|先试试/

function toRegExp(source, fallback) {
  if (typeof source !== 'string' || source.trim().length === 0) return fallback
  try {
    return new RegExp(source, 'i')
  } catch {
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
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'logs', `${name}.log`)
}

function normalizeConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const num = (value, fallback, min, max) =>
    Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
  return {
    enabled: raw.enabled !== false,
    repeatEditThreshold: num(raw.repeatEditThreshold, 3, 2, 20),
    repeatErrorThreshold: num(raw.repeatErrorThreshold, 2, 2, 20),
    noVerifySteps: num(raw.noVerifySteps, 2, 1, 20),
    // 一次测量（结果返回）就清零连续盲改计数：有测量回路的收敛不算卡住。
    decayEditsOnVerify: raw.decayEditsOnVerify !== false,
    // present 成功之后休眠闸门，下一次写入重新唤醒：修掉交付后误触发。
    doneOnPresent: raw.doneOnPresent !== false,
    // 每 turn 最多说几次：拿到测量后允许重新武装，但不能变成连击。
    maxInjectsPerTurn: num(raw.maxInjectsPerTurn, 3, 1, 10),
    // 注入后盯多少步，看模型有没有真的转去验证/搜索（面板的 steps 就靠它）。
    changedWindow: num(raw.changedWindow, 6, 1, 30),
    // 判「这条命令是不是测量」。给字符串覆盖，给了坏正则就回退默认。
    measureCommands: toRegExp(raw.measureCommands, new RegExp(DEFAULT_MEASURE_COMMANDS, 'i')),
    measureIntent: toRegExp(raw.measureIntent, new RegExp(DEFAULT_MEASURE_INTENT, 'i')),
    // 不计入盲改的路径（生成物 / 锁文件 / 日志）。
    excludePaths: toRegExp(raw.excludePaths, new RegExp(DEFAULT_EXCLUDE_PATHS, 'i')),
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

/** 规整成一个可比对的目录：posix 分隔符、去尾斜杠、按平台折叠大小写。 */
function normDir(path) {
  const normalized = String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
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
    for (const match of text.matchAll(/[A-Za-z]:[\\/][^\s"'`;,)]+|\/(?:[\w.-]+\/)+[\w.-]*/g)) {
      dirs.add(dirOf(match[0]))
    }
  }
  collect(args?.command)
  collect(args?.script_path)
  return dirs
}

/**
 * 错误文本 → 稳定指纹。目标不是「相等」而是「同一类」：
 * 报错变的是行号、时间戳、临时路径、内存地址，不变的是异常类和消息骨架。
 */
export function errorFingerprint(text) {
  const head = String(text ?? '')
    .split('\n')
    .slice(0, 6)
    .join('\n')
  const normalized = head
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
    .replace(/(?<![\w.])\.{0,2}\/[^\s"']{6,}/g, '<path>')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
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
export function errorTargetOf(text) {
  const match = /(?:[A-Za-z]:[\\/]|(?<![\w.])\.{0,2}\/)[^\s"':;)]+/i.exec(String(text ?? ''))
  if (match === null) return ''
  // 大小写按平台折叠，和 normDir 同理：在区分大小写的系统上折叠会把 a.js 与 A.js
  // 合成同一个 episode，把两个不同文件各错一次误报成「同一个报错吃了两次」。
  return foldCase(match[0].replace(/\\/g, '/').replace(/\d+/g, '<n>'))
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

export function apply(ctx, config) {
  const cfg = normalizeConfig(config)

  // 落盘失败只 warn 一次：目录不可写（权限、只读盘、路径写错）时，
  // 每次事件都 warn 会把 stdout 刷爆；一次不说又会变成「插件装了但面板永远空着」
  // 这种最难查的状态。
  let warnedLogFailure = false
  const record = async (line) => {
    if (cfg.logFile.length === 0) return
    try {
      await mkdir(dirname(cfg.logFile), { recursive: true })
      await appendFile(cfg.logFile, `${new Date().toISOString()} ${line}\n`, 'utf8')
    } catch (error) {
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
      `A=${cfg.repeatEditThreshold} B=${cfg.repeatErrorThreshold} C=${cfg.noVerifySteps} ` +
      `budget=${cfg.maxInjectsPerTurn} window=${cfg.changedWindow} panel=${cfg.panel}`
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

  const fresh = (turn) => ({
    turn,
    /** 本 turn 累计编辑次数（按路径），只用于日志的 worstEdits。 */
    edits: new Map(),
    /**
     * 连续盲改：自上次**测量结果**以来对同一路径的编辑次数。
     * 一次测量结果返回就清零（或只清它管得到的那些路径）——有回路的收敛不该算打转。
     */
    streakEdits: new Map(),
    /** 自上次测量以来的写入次数（不分路径）——C 的 arm 依据。 */
    writesSinceMeasure: 0,
    /** 已满足「N 步没测量」：只上膛，不开口。 */
    measureArmed: false,
    /** 上膛之后真的又写了一次 —— 这时才该说话。 */
    wroteWhileArmed: false,
    lastEditStep: void 0,
    lastEditLabel: void 0,
    /** 最近一次测量：{tool, ok, exit, atStep}，注入文本与日志都用它。 */
    lastMeasure: void 0,
    pendingStep: void 0,
    /** callId → {name, args, measure}：结果回来时才知道该不该清零。 */
    calls: new Map(),
    /** episode key → {count, sample, tool, target, firstClock}。 */
    errors: new Map(),
    /** 单调时钟：工具调用/报错/搜索/测量各推进一格，用来判「搜索是否晚于 episode」。 */
    clock: 0,
    lastSearchClock: 0,
    searchedThisTurn: false,
    writeSeq: 0,
    errorSeq: 0,
    /** 本 turn 每个信号已说过的次数（测量后递减，实现重新武装）。 */
    fired: { A: 0, B: 0, C: 0 },
    injectionsThisTurn: 0,
    /** 上次提醒时的 {writeSeq, errorSeq}；两者都没变说明白提醒了。 */
    lastFireMark: void 0,
    /** 最近一次动作 {name, cls}，注入时记进 outcome 的 before=。 */
    lastAction: void 0,
    quiet: false,
    turnUserText: '',
    /** 交付态：present **成功返回**之后置 true，下一次写入重新置 false。 */
    done: false,
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
  const settleMeasure = (s, { tool, args, ok, exit, atStep }) => {
    const dirs = measureDirs(args)
    let cleared = 0
    if (cfg.decayEditsOnVerify) {
      if (dirs.size === 0) {
        cleared = s.streakEdits.size
        s.streakEdits.clear()
        s.writesSinceMeasure = 0
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
        if (s.streakEdits.size === 0) s.writesSinceMeasure = 0
      }
      // 上膛状态也一起解除：刚刚测过，C 的前提没了。
      if (s.streakEdits.size === 0) {
        s.measureArmed = false
        s.wroteWhileArmed = false
      }
    }
    s.lastMeasure = { tool, ok, exit, atStep }
    // 拿到新事实 → 重新武装：同一长 turn 的另一个阶段再犯，值得再说一次。
    s.fired.A = 0
    s.fired.C = 0
    s.clock += 1
    return cleared
  }

  ctx.on('session/event', (session, event) => {
    if (event === null || event === void 0) return
    const data = event.data ?? {}
    if (event.type === 'turn/start') {
      state.set(session, fresh(data.turn))
      return
    }
    if (event.type === 'turn/end') {
      const s = state.get(session)
      if (s !== void 0 && (s.turn === void 0 || s.turn === data.turn)) state.delete(session)
      return
    }
    if (event.type === 'user/message') {
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
      s.turnUserText = text
      // 用户明确说「别搜/直接改」→ 整 turn 静音（D 段例外）。
      if (QUIET_PATTERN.test(text)) s.quiet = true
      return
    }
    if (event.type === 'tool/call') {
      const s = stateFor(session)
      const args = data.arguments !== null && typeof data.arguments === 'object' ? data.arguments : {}
      const measure = isMeasurement(data.name, args, cfg)
      const cls = classifyTool(data.name, measure)
      if (typeof data.callId === 'string' && typeof data.name === 'string') {
        s.calls.set(data.callId, { name: data.name, args, measure })
      }
      s.clock += 1

      // 注入后第一条工具调用，就是「模型听没听」的第一层证据。
      // 记下来、当场收尾：只收第一条，晚到的动作不能把早先的原地打转盖掉。
      const at = Number(data.step)
      const stepNow = Number.isFinite(at) ? at : void 0
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
        if (pending.changed === false && (cls === 'verify' || cls === 'search') && typeof data.name === 'string') {
          pending.changed = true
          void record(
            `change session=${session.id} turn=${pending.turn} inj=${pending.inj} after=${pending.tag} ` +
              `tool=${data.name} class=${cls} steps=${stepNow === void 0 ? 0 : Math.max(0, stepNow - pending.atStep)}`
          )
        }
      }
      // 收掉已经看过第一动作、又超出窗口的 pending；窗口内继续等转向。
      s.pendings = s.pendings.filter(
        (pending) =>
          pending.firstSeen === false ||
          (pending.changed === false && stepNow !== void 0 && stepNow <= pending.atStep + cfg.changedWindow)
      )

      s.lastAction = { name: data.name, cls }
      // 交付态：present **结果成功后**才休眠；调用发起就休眠会把失败的 present 当交付。
      if (SEARCH_TOOLS.has(data.name)) {
        s.searchedThisTurn = true
        s.lastSearchClock = s.clock
        // 搜索是外部先验，和测量同级：重新武装 A / C。
        s.fired.A = 0
        s.fired.C = 0
      }
      return
    }
    if (event.type === 'tool/result') {
      const s = stateFor(session)
      const callId = data.message?.source?.callId
      const call = typeof callId === 'string' ? s.calls.get(callId) : void 0
      const toolName = call?.name ?? (typeof callId === 'string' ? s.calls.get(callId) : void 0)
      const text = errorTextOf(data)
      const isError = data.message?.isError === true || data.error !== void 0
      s.clock += 1

      // 测量必须**等到结果**才清零：发起就清零等于把「打算测」当成「测过了」。
      if (call !== void 0 && call.measure === true) {
        const exit = exitCodeOf(text)
        const ok = isError !== true && (exit === void 0 || exit === 0)
        const cleared = settleMeasure(s, {
          tool: call.name,
          args: call.args,
          ok,
          exit,
          atStep: Number(data.step)
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
        // 同一个 episode 又被搜索过 → 重新武装，允许再说一次。
        if (s.lastSearchClock > prev.firstClock) s.fired.B = Math.max(0, s.fired.B - 1)
      }
      if (typeof callId === 'string') s.calls.delete(callId)
    }
  })

  ctx.on('session/disposed', (session) => {
    state.delete(session)
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
      s.writesSinceMeasure += 1
      s.writeSeq += 1
      // 上膛之后又动手了 —— C 的开口条件就是这一下。
      if (s.measureArmed) s.wroteWhileArmed = true
      // 又开始改了 → 交付态解除，闸门重新武装。
      s.done = false
      // 「上一条动作」也要算上写入本身：写入走的是 fs/write-intent，
      // 不一定有对应的 tool/call（直接写文件、别的插件代写都会这样）。
      // 不记这一步的话，注入行的 before= 会空成 '-'，面板就没法说「从改转到了测」。
      s.lastAction = { name: 'write', cls: 'edit' }
      // 写入发生在某一步内部，此刻 pre-step 已记下该步号；热加载没赶上就当本步。
      s.lastEditStep = Number.isFinite(s.pendingStep) ? s.pendingStep : 0
      s.lastEditLabel = abs
    } catch {}
    return intent
  }, { prepend: true })

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

      // 上一次提醒之后既没多写一次、也没多吃一个错 —— 再说一遍只是噪音。
      // 模型需要的是「新事实」，不是「更严厉的同一句话」。
      if (
        s.lastFireMark !== void 0 &&
        s.lastFireMark.writeSeq === s.writeSeq &&
        s.lastFireMark.errorSeq === s.errorSeq
      ) {
        return decision
      }

      // C 的上膛：改完 N 步没测量，**只上膛不开口**。阅读和思考不该被打断，
      // 只有「上膛之后又动手」才说明它要带着没有回路的状态继续改。
      if (
        Number.isFinite(s.lastEditStep) &&
        !s.measureArmed &&
        s.streakEdits.size > 0 &&
        step - s.lastEditStep >= cfg.noVerifySteps
      ) {
        s.measureArmed = true
        void record(`arm session=${session.id} turn=${turn} step=${step} gap=${step - s.lastEditStep}`)
      }

      if (s.injectionsThisTurn >= cfg.maxInjectsPerTurn) return decision

      const signals = []

      // A：同一文件「自上次测量以来」连续改了 N 次。
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
      if (s.fired.B < 1) {
        let worst
        for (const entry of s.errors.values()) {
          if (entry.count < cfg.repeatErrorThreshold) continue
          if (s.lastSearchClock > entry.firstClock) continue
          if (worst === void 0 || entry.count > worst.count) worst = entry
        }
        if (worst !== void 0) {
          signals.push({ kind: 'B', n: worst.count, detail: `报错：${worst.sample}` })
        }
      }

      // C：上膛之后又写了一次，仍然没有测量。
      if (s.fired.C < 1 && s.measureArmed && s.wroteWhileArmed) {
        const gap = Number.isFinite(s.lastEditStep) ? Math.max(0, step - s.lastEditStep) : 0
        signals.push({ kind: 'C', n: gap })
      }

      if (signals.length === 0) return decision

      for (const signal of signals) s.fired[signal.kind] += 1
      // A/B 已经说明了局面；同一句话再补一句「改完没测量」只是换个说法。
      if (signals.some((signal) => signal.kind !== 'C')) s.fired.C += 1
      s.wroteWhileArmed = false
      s.injectionsThisTurn += 1
      s.lastFireMark = { writeSeq: s.writeSeq, errorSeq: s.errorSeq }

      const text = messageText(signals)
      const tag = signals.map((signal) => signal.kind).join('+')
      const inj = createHash('sha256')
        .update(`${session.id}|${turn}|${step}|${tag}|${s.injectionsThisTurn}`)
        .digest('hex')
        .slice(0, 8)
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
          `files=${s.edits.size} worstEdits=${worstEdits} worstStreak=${worstStreak} ` +
          `worstErrors=${worstErrors} ` +
          `searched=${s.searchedThisTurn} ` +
          `measured=${s.lastMeasure === void 0 ? 'no' : `yes:${s.lastMeasure.tool}:${s.lastMeasure.ok ? 'ok' : 'fail'}`}` +
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
    } catch (error) {
      try {
        ctx.logger?.warn?.(`dsh-better-debug: pre-step error: ${error?.message ?? error}`)
      } catch {}
      return decision
    }
  }, { prepend: true })
}

export default { name, inject, apply }
