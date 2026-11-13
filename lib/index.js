import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerPanel } from './panel.js'

/**
 * dsh-better-debug — 卡住闸门的代码版。
 *
 * 背景：方法论（Mnemon `d713a6e6`）与 `stuck-gate` 技能都是**自觉条款**——
 * 模型得先想起来自己卡住了，条款才会生效。可「想不起来」正是卡住时的症状本身。
 * 这个插件把其中**能被事件证明**的部分升级成代码闸门：不看模型说了什么，
 * 只看它做了什么。
 *
 * 三个信号（用户 2026-11-06 定稿：只做 1+2+4，收尾清零归 dsh-turn-cleanup）：
 *   A 同一文件重复改    —— `fs/write-intent` 按路径计数，第 N 次（默认 3）
 *   B 同一报错重复      —— `tool/result` 归一化后的错误指纹第 N 次（默认 2）
 *   C 改完不验证        —— 最后一次写入后过了 N 步（默认 2），这期间既没验证也没搜
 *
 * 不做的事：
 *   - 不做「我猜是」措辞检测（插件看不见模型内心独白，留给 skill 自检）
 *   - 不做收尾探针清零（归 dsh-turn-cleanup）
 *   - 不用 `{kind:'reject'}`（那会把整个 turn 变成 no-op），只往 messages 尾部追加一条
 *   - 不对子会话生效（`origin === 'subagent'` 或 `delegationDepth > 0` 直接跳过）
 *
 * D 段例外（AGENTS.md）：读出本 turn 最后一条用户原话，命中「别搜/直接改/快速试/
 * 不用搜」就整 turn 静音 —— 用户显式要求硬来的时候不做任何事。
 *
 * 幂等：每条信号每个 turn 最多注入一次。否则模型每多跑一步就被念一次。
 */

export const name = 'dsh-better-debug'
// `skills` 只用来把自带的 stuck-gate 技能注册进 catalog。
// 注册失败不该拖垮闸门本身——apply 里整段包了 try/catch。
export const inject = ['skills']

/** 自带技能的名字。注入文本里写的就是它，改这里要同步改 messageText。 */
const BUNDLED_SKILL_NAME = 'stuck-gate'
const BUNDLED_SKILL_RANK = 600 // = BUNDLED_SKILL_RANK，与 dsh-skill-office 一致
const ASSET_ROOT = fileURLToPath(new URL('../assets/', import.meta.url))

/** 全局调用一次就能拿到外部先验的那些工具。 */
const SEARCH_TOOLS = new Set([
  'web_search',
  'research',
  'advanced_search',
  'multi_search',
  'platform_search',
  'domain_search',
  'cache_search',
  'video_search'
])

/** 能给出新事实的验证类工具（`ops_bash` 覆盖跑测试/复现命令）。 */
const VERIFY_TOOLS = new Set(['ops_bash', 'lsp_diagnostics', 'verify', 'run_tests'])

/** 会改动仓库那类工具 —— 用来判「注入后模型还是在原地改」。 */
const EDIT_TOOLS = new Set(['edit', 'write', 'ops_write', 'str_replace', 'apply_patch', 'notebook_edit'])

/** 一次工具调用归成四类之一，面板据此算「注入后首个动作变没变」。 */
function classifyTool(name) {
  if (typeof name !== 'string') return 'other'
  if (SEARCH_TOOLS.has(name)) return 'search'
  if (VERIFY_TOOLS.has(name)) return 'verify'
  if (EDIT_TOOLS.has(name)) return 'edit'
  return 'other'
}

/** D 段例外：用户显式要求别折腾。 */
const QUIET_PATTERN = /别搜|不要搜|不用搜|先别搜|直接改|快速试|别折腾|先试试/

const SIGNAL_TEXT = {
  A: '同一个文件你连续改了 {n} 次，中间夹不进任何验证或新信息。',
  B: '同一个报错你已经吃到第 {n} 次，一行代码都没多知道。',
  C: '上次改完已经过了 {n} 步，既没跑验证也没查外部资料。'
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
    // 一次 verify 到达就清零连续盲改计数：有测量回路的收敛不算卡住。
    decayEditsOnVerify: raw.decayEditsOnVerify !== false,
    // present / 终稿答复之后休眠闸门，下一次写入重新唤醒：修掉交付后误触发。
    doneOnPresent: raw.doneOnPresent !== false,
    // 只在明确命中 D 段例外时静音，其余一律照常。
    logFile: typeof raw.logFile === 'string' ? raw.logFile.trim() : '',
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
 * 错误文本 → 稳定指纹。目标不是「相等」而是「同一类」：
 * 报错变的是行号、时间戳、临时路径、内存地址，不变的是异常类和消息骨架。
 */
function errorFingerprint(text) {
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

function oneLine(text, limit) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

function messageText(signals) {
  const reasons = signals.map((signal) => {
    const template = SIGNAL_TEXT[signal.kind]
    return `- ${template.replace('{n}', String(signal.n))}${signal.detail ? ` ${signal.detail}` : ''}`
  })
  return [
    '[better-debug] 检测到你在原地打转：',
    ...reasons,
    '下一步别急着再改，先做其中一件、拿到新事实再往下走：',
    '1) 建一条几秒能跑完、能给出数字或事实的回路（失败测试 / 复现命令 / 词数段数统计 / 一条 checklist 断言 / lsp_diagnostics）；拿不出就停下要现场产物。',
    '2) 用报错原文整句或需求关键词 + 版本搜一次，10 分钟盒，GitHub closed issue 也看。',
    '3) 拿到新证据后，一次只动一个变量；数字朝目标收敛且每步有测量 = 有进展，不算打转。',
    '完整五条：skill `stuck-gate`。'
  ].join('\n')
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

  ctx.skills.registerProvider(() => provider)
  log(`bundled skill registered: ${BUNDLED_SKILL_NAME} <- ${locator}`)
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config)

  const record = async (line) => {
    if (cfg.logFile.length === 0) return
    try {
      await mkdir(dirname(cfg.logFile), { recursive: true })
      await appendFile(cfg.logFile, `${new Date().toISOString()} ${line}\n`, 'utf8')
    } catch {}
  }

  if (!cfg.enabled) {
    void record('disabled by config, no gate installed')
    return
  }

  // 把自带的 stuck-gate 技能注册进 catalog，否则别人装了这个插件，
  // 注入文本末尾那句「完整五条：skill `stuck-gate`」就是指向空气。
  // 包装在 try/catch 里：技能注册失败（老版本 DSH 没有 skills 服务、
  // 或者用户自己已经放了一份同名技能）不该让闸门本身失效。
  try {
    registerBundledSkill(ctx, (line) => void record(line))
  } catch (error) {
    void record(`skill register failed: ${error?.message ?? error}`)
  }

  // 每次热重载/启动都留一行，验收靠它判断「插件到底加载了没有」。
  // ctx.logger 只进 Electron 主进程 stdout，事后没法 grep，所以必须有落盘旁路。
  void record(
    `apply pid=${process.pid} logFile=${cfg.logFile} ` +
      `A=${cfg.repeatEditThreshold} B=${cfg.repeatErrorThreshold} C=${cfg.noVerifySteps} ` +
      `panel=${cfg.panel}`
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
    edits: new Map(),
    /** 连续盲改：自上次「测量/验证」以来对同一文件的编辑次数。
     *  一次 verify 到达就清零 —— 有回路的收敛不该被当成原地打转。 */
    streakEdits: new Map(),
    consecutiveEdits: 0,
    /** 交付态：present / 终稿答复后置 true，下一次写入重新置 false。 */
    done: false,
    /** 本 turn 累计写入次数 —— 用来判断「上次提醒之后有没有新事实」。 */
    writeSeq: 0,
    /** 本 turn 累计报错次数。 */
    errorSeq: 0,
    lastEditStep: void 0,
    lastEditLabel: void 0,
    usefulSinceEdit: true,
    pendingStep: void 0,
    calls: new Map(),
    errors: new Map(),
    searchedThisTurn: false,
    /** 每条信号每 turn 最多一次。 */
    fired: new Set(),
    /** 上次提醒时的 {writeSeq, errorSeq}；两者都没变说明白提醒了。 */
    lastFireMark: void 0,
    quiet: false,
    turnUserText: '',
    /**
     * 注入之后等着收的那一条「结果」。面板的增益全靠它：
     * 没有它就只能数「我说了几次」，有它才能数「说完之后模型换动作了吗」。
     * 一次注入只收第一条后续动作，之后不再覆盖——否则晚到的验证会把早先的无效盖掉。
     */
    pendingOutcome: void 0
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
      if (typeof data.callId === 'string' && typeof data.name === 'string') {
        s.calls.set(data.callId, data.name)
      }
      // 注入后第一条工具调用，就是「模型听没听」的唯一客观证据。
      // 记下来、当场清掉 pending：只收第一条，晚到的验证不能把早先的原地打转盖掉。
      const pending = s.pendingOutcome
      if (pending !== void 0 && typeof data.name === 'string') {
        const at = Number(data.step)
        if (Number.isFinite(at) && at >= pending.afterStep) {
          s.pendingOutcome = void 0
          void record(
            `outcome session=${session.id} turn=${pending.turn} after=${pending.tag} ` +
              `first=${data.name} class=${classifyTool(data.name)} steps=${at - pending.afterStep}`
          )
        }
      }
      // 交付态：present 之后本轮没有「下一次尝试」，闸门休眠到下一次写入。
      if (data.name === 'present') s.done = true
      // 一次测量（verify）到达 → 连续盲改计数清零：有回路的收敛不算打转。
      if (VERIFY_TOOLS.has(data.name)) {
        s.usefulSinceEdit = true
        if (cfg.decayEditsOnVerify) {
          s.streakEdits.clear()
          s.consecutiveEdits = 0
        }
      }
      if (SEARCH_TOOLS.has(data.name)) {
        s.searchedThisTurn = true
        s.usefulSinceEdit = true
      }
      return
    }
    if (event.type === 'tool/result') {
      const s = stateFor(session)
      const isError = data.message?.isError === true || data.error !== void 0
      const callId = data.message?.source?.callId
      const toolName = typeof callId === 'string' ? s.calls.get(callId) : void 0
      if (VERIFY_TOOLS.has(toolName)) {
        s.usefulSinceEdit = true
        // 测量结果回来了，同样清零连续盲改计数。
        if (cfg.decayEditsOnVerify) {
          s.streakEdits.clear()
          s.consecutiveEdits = 0
        }
      }
      if (!isError) return
      const text = errorTextOf(data)
      if (text.length === 0) return
      const key = errorFingerprint(text)
      const prev = s.errors.get(key)
      if (prev === void 0) {
        s.errors.set(key, { count: 1, sample: oneLine(text, 160), tool: toolName })
      } else {
        prev.count += 1
      }
      s.errorSeq += 1
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
      if (!isAbsolute(abs)) return intent
      const s = stateFor(session)
      s.edits.set(abs, (s.edits.get(abs) ?? 0) + 1)
      s.streakEdits.set(abs, (s.streakEdits.get(abs) ?? 0) + 1)
      s.consecutiveEdits += 1
      s.writeSeq += 1
      // 又开始改了 → 交付态解除，闸门重新武装。
      s.done = false
      // 写入发生在某一步内部，此刻 pre-step 已记下该步号；热加载没赶上就当本步。
      s.lastEditStep = Number.isFinite(s.pendingStep) ? s.pendingStep : 0
      s.lastEditLabel = abs
      s.usefulSinceEdit = false
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
      // 交付态：present / 终稿答复已经发生，且之后没有新的写入 →
      // 本轮没有「下一次尝试」，闸门不该再落（修掉「结论 → 一串工具调用」倒挂）。
      // 留一行 suppress，让「闸门醒着但故意不出声」和「闸门根本没挂上」可区分。
      if (cfg.doneOnPresent && s.done) {
        if (!s.fired.has('done')) {
          s.fired.add('done')
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

      const signals = []

      // A：同一文件「连续盲改」（自上次测量以来），且改完没有验证过。
      if (!s.fired.has('A') && !s.usefulSinceEdit) {
        let worstPath
        let worst = 0
        for (const [path, count] of s.streakEdits) {
          if (count > worst) {
            worst = count
            worstPath = path
          }
        }
        if (worst >= cfg.repeatEditThreshold) {
          const name = worstPath.split(/[/\\]+/).pop() ?? worstPath
          signals.push({ kind: 'A', n: worst, detail: `（${name}）` })
        }
      }

      // B：同一类报错重复，且本 turn 还没搜过。
      if (!s.fired.has('B') && !s.searchedThisTurn) {
        for (const entry of s.errors.values()) {
          if (entry.count >= cfg.repeatErrorThreshold) {
            signals.push({ kind: 'B', n: entry.count, detail: `报错：${entry.sample}` })
            break
          }
        }
      }

      // C：改完 N 步，既没验证也没搜。
      if (!s.fired.has('C') && !s.usefulSinceEdit && Number.isFinite(s.lastEditStep)) {
        const gap = step - s.lastEditStep
        if (gap >= cfg.noVerifySteps) signals.push({ kind: 'C', n: gap })
      }

      if (signals.length === 0) return decision

      for (const signal of signals) s.fired.add(signal.kind)
      // A/B 已经说明了局面；同 turn 再补一句「改完没验证」只是同一句话换个说法。
      if (signals.some((signal) => signal.kind !== 'C')) s.fired.add('C')
      s.lastFireMark = { writeSeq: s.writeSeq, errorSeq: s.errorSeq }
      const text = messageText(signals)
      const tag = signals.map((signal) => signal.kind).join('+')
      // 埋点：等注入之后的第一条工具调用，用来算「模型换动作了吗」。
      // 放在 lastFireMark 之后：这次注入确实发生了，才值得收结果。
      s.pendingOutcome = { tag, turn, afterStep: step }

      try {
        ctx.logger?.info?.(
          `dsh-better-debug: inject session=${session.id} turn=${turn} step=${step} signals=${tag}`
        )
      } catch {}
      // 日志是唯一的验收面。A 现在按「连续盲改」(streakEdits) 判定，
      // 必须把那个数单独写出来；worstEdits 仍是本 turn 累计次数（面板沿用，不改形状）。
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
        `inject session=${session.id} turn=${turn} step=${step} signals=${tag} chars=${text.length} ` +
          `files=${s.edits.size} worstEdits=${worstEdits} worstStreak=${worstStreak} ` +
          `worstErrors=${worstErrors} ` +
          `searched=${s.searchedThisTurn}` +
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
