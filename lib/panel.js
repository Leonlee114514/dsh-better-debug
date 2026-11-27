import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { charsFor, estimateTokens } from './text.js'

/**
 * dsh-better-debug 的读数面板（server 半）。
 *
 * 设计原则：**每一个数字都必须能从日志里逐行数出来**。
 * 这个插件能证明的只有「我在第几步、因为什么信号、说了什么话、说完后模型下一个动作是什么」。
 * 「省掉了多少 token」这类折算需要假设「本来会失败」，面板不做，也不展示。
 *
 * 数据源就是 cfg.logFile 那一个文件，没有第二个真相来源：
 *   apply pid=… logFile=… A=3 B=2 C=3 budget=3 window=6 panel=true
 *   inject session=… turn=… step=… signals=C inj=a1b2c3d4 chars=302 tokens=302 blind=3 files=2 …
 *   arm session=… turn=… step=… writes=3
 *   measure session=… turn=… tool=ops_bash ok=true exit=0 cleared=1
 *   outcome session=… turn=… inj=… after=C first=ops_bash class=verify steps=1 before=edit
 *   change session=… turn=… inj=… after=C tool=ops_bash class=verify steps=1
 *   suppress session=… turn=… step=… reason=done
 *   bundled skill registered: stuck-gate <- …
 *   disabled by config, no gate installed
 *   skill register failed: …
 *
 * 指标措辞纪律（评审 m00176 中6）：`outcome` 只说明「提示之后模型第一个动作是什么」，
 * 它**不能**证明提示促成了改变、更不能证明它发现了缺陷——那需要对照组或历史回放。
 * 所以字段名一律描述性（`firstAction` / `turnedWithinWindow`），不叫「增益」「有效」。
 */

const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url))

/**
 * 路由的跨代句柄。
 *
 * 热重载会重新 import 本模块，模块级变量全部重置；但 `webServer` 是另一个插件，
 * 它的路由表在两代之间**是同一个对象**。所以上一代挂上去的 `/better-debug`
 * 会留在表里，新一代再 register 就撞 `webserver: duplicate prefix route`。
 *
 * 用 globalThis 上的 Symbol 记住「谁挂的、怎么摘」，新一代先摘旧的再挂新的。
 * 既能自愈，也能保证热重载后服务的是新代码而不是旧闭包。
 */
const PANEL_SLOT = Symbol.for('dsh-better-debug/panel-route')

// token 估算与文本长度回退都来自 lib/text.js：注入文案与面板用的是同一个算法，
// 不会出现「改了文案、面板里的字符数还是旧常量」这种漂移。
export { estimateTokens }

/**
 * `key=value key="quoted value"` 扫描器。
 * sample= 里可能带空格和等号，只有引号形态能安全切开。
 */
export function scanFields(rest) {
  const out = {}
  let i = 0
  const text = String(rest ?? '')
  while (i < text.length) {
    while (i < text.length && text[i] === ' ') i += 1
    if (i >= text.length) break
    const eq = text.indexOf('=', i)
    if (eq === -1) break
    const key = text.slice(i, eq)
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
      // 不是 key=，跳过一个词
      const sp = text.indexOf(' ', i)
      i = sp === -1 ? text.length : sp + 1
      continue
    }
    let value = ''
    let cursor = eq + 1
    if (text[cursor] === '"') {
      cursor += 1
      let escaped = false
      while (cursor < text.length) {
        const char = text[cursor]
        if (escaped) {
          value += char
          escaped = false
        } else if (char === '\\') {
          escaped = true
        } else if (char === '"') {
          cursor += 1
          break
        } else {
          value += char
        }
        cursor += 1
      }
    } else {
      const sp = text.indexOf(' ', cursor)
      value = sp === -1 ? text.slice(cursor) : text.slice(cursor, sp)
      cursor = sp === -1 ? text.length : sp
    }
    out[key] = value
    i = cursor
  }
  return out
}

/**
 * 阈值回退：既认面板自己的 `{A,B,C}`，也认插件配置的原始键名
 * （`repeatEditThreshold` / `repeatErrorThreshold` / `noVerifyWrites`）。
 *
 * 为什么要两套：`/better-debug/api` 传进来的是**整个 cfg**，键名是配置项原名；
 * 而测试与老调用方传的是 `{A,B,C}`。只认其中一套，另一套就静默变 0 ——
 * 面板上三个阈值条全空，看不出插件到底在什么档位上跑（第五轮缺陷 S3）。
 */
function fallbackThresholds(source) {
  const cfg = source !== null && typeof source === 'object' ? source : {}
  const pick = (a, b) => Number(cfg[a] ?? cfg[b]) || 0
  return {
    A: pick('A', 'repeatEditThreshold'),
    B: pick('B', 'repeatErrorThreshold'),
    C: pick('C', 'noVerifyWrites')
  }
}

const LINE_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+([\s\S]*)$/

/** 单行 → 结构化记录。认不出就返回 {kind:'other'}，绝不抛。 */
export function parseLine(raw) {
  const line = String(raw ?? '').replace(/\r$/, '')
  if (line.trim().length === 0) return void 0
  const head = LINE_RE.exec(line)
  const at = head ? head[1] : ''
  const body = head ? head[2] : line

  if (body.startsWith('inject ')) {
    const f = scanFields(body.slice(7))
    const signals = String(f.signals ?? '').split('+').filter((s) => s.length > 0)
    const chars = Number.isFinite(Number(f.chars)) && Number(f.chars) > 0 ? Number(f.chars) : charsFor(signals)
    const tokens = Number.isFinite(Number(f.tokens)) && Number(f.tokens) > 0
      ? Number(f.tokens)
      : estimateTokens('x'.repeat(chars))
    return {
      kind: 'inject',
      at,
      session: f.session ?? '',
      turn: Number(f.turn),
      step: Number(f.step),
      // 每次注入一个 id：把 inject / outcome / change 三行串起来的唯一办法。
      inj: f.inj ?? '',
      signals,
      chars,
      tokens,
      files: Number(f.files) || 0,
      worstEdits: Number(f.worstEdits) || 0,
      // A 按「自上次测量以来的连续盲改」判定；老日志没有这个字段 → 0。
      worstStreak: Number(f.worstStreak) || 0,
      worstErrors: Number(f.worstErrors) || 0,
      searched: f.searched === 'true',
      // measured=no | yes:<tool>:<ok|fail>
      measured: f.measured ?? '',
      sample: f.sample ?? ''
    }
  }

  // 交付态静默：闸门醒着、判定过、故意不注入。和「插件没挂上」必须能区分。
  if (body.startsWith('suppress ')) {
    const f = scanFields(body.slice(9))
    return {
      kind: 'suppress',
      at,
      session: f.session ?? '',
      turn: Number(f.turn),
      step: Number(f.step),
      reason: f.reason ?? ''
    }
  }

  // C 只上膛不开口的那一步：用来解释「为什么改了 N 处却没提醒」。
  //
  // 字段是 writes= 而不是 gap=：0.3.5 把 C 的判据从「距上次改过了几步」换成
  // 「一共盲改了几处」。gap 恒等于阈值（实测 182 条全是 2），本身就是那个错轴的证据。
  if (body.startsWith('arm ')) {
    const f = scanFields(body.slice(4))
    return {
      kind: 'arm',
      at,
      session: f.session ?? '',
      turn: Number(f.turn),
      step: Number(f.step),
      writes: Number(f.writes) || 0
    }
  }

  // 测量结果：这是「有没有回路」的唯一硬证据，比任何动作分类都强。
  if (body.startsWith('measure ')) {
    const f = scanFields(body.slice(8))
    return {
      kind: 'measure',
      at,
      session: f.session ?? '',
      turn: Number(f.turn),
      tool: f.tool ?? '',
      ok: f.ok === 'true',
      exit: f.exit === '-' || f.exit === void 0 || f.exit === '' ? null : Number(f.exit),
      cleared: Number(f.cleared) || 0
    }
  }

  if (body.startsWith('outcome ')) {
    const f = scanFields(body.slice(8))
    return {
      kind: 'outcome',
      at,
      session: f.session ?? '',
      turn: Number(f.turn),
      inj: f.inj ?? '',
      after: String(f.after ?? ''),
      first: f.first ?? '',
      // `class` 是保留字，日志里写信的是 class=，读的时候两个都认。
      cls: f.class ?? f.cls ?? 'other',
      steps: Number(f.steps) || 0,
      // 提示之前那一步在干什么：有它才能说「从什么动作转到了什么动作」。
      before: f.before ?? ''
    }
  }

  // 窗口内第一个真转向动作（verify/search）。中位步数只能从这算。
  if (body.startsWith('change ')) {
    const f = scanFields(body.slice(7))
    return {
      kind: 'change',
      at,
      session: f.session ?? '',
      turn: Number(f.turn),
      inj: f.inj ?? '',
      after: String(f.after ?? ''),
      tool: f.tool ?? '',
      cls: f.class ?? 'other',
      steps: Number(f.steps) || 0
    }
  }

  if (body.startsWith('apply ')) {
    const f = scanFields(body.slice(6))
    return {
      kind: 'apply',
      at,
      pid: Number(f.pid) || 0,
      logFile: f.logFile ?? '',
      thresholds: { A: Number(f.A) || 0, B: Number(f.B) || 0, C: Number(f.C) || 0 },
      budget: Number(f.budget) || 0,
      window: Number(f.window) || 0,
      // v0.3 的档位。老日志没有这些字段 → 0，面板按「未知」处理而不是显示 0。
      // F 写成 `4/3`（族次数/最少指纹数）两段，拆开存，否则展示时要再解析一次。
      family: String(f.F ?? ''),
      oscillation: Number(f.O) || 0,
      patchChain: Number(f.P) || 0,
      meta: String(f.M ?? '')
    }
  }

  // M 的输入：一条注入看过第一动作、窗口内没等到转向就被移除。
  // 单独一行而不是塞进 inject，因为它是**之后**才知道的结果，写 inject 行时就还不知道。
  if (body.startsWith('futile ')) {
    const f = scanFields(body.slice(7))
    return {
      kind: 'futile',
      at,
      session: f.session ?? '',
      turn: Number(f.turn),
      inj: f.inj ?? '',
      after: String(f.after ?? ''),
      count: Number(f.count) || 0,
      window: Number(f.window) || 0
    }
  }

  if (body.startsWith('bundled skill registered:')) {
    return { kind: 'skill', at, path: body.slice('bundled skill registered:'.length).trim() }
  }
  if (body.startsWith('disabled by config')) return { kind: 'disabled', at }
  if (body.startsWith('skill register failed')) return { kind: 'skill-failed', at, message: body }
  if (body.startsWith('panel register failed') || body.startsWith('panel unavailable')) {
    return { kind: 'panel-failed', at, message: body }
  }

  return { kind: 'other', at, text: body }
}

/** 日志全文 → 记录数组。坏行跳过，不影响其余。 */
export function parseLog(text) {
  const records = []
  for (const raw of String(text ?? '').split('\n')) {
    const record = parseLine(raw)
    if (record !== void 0) records.push(record)
  }
  return records
}

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** 这五类是「动作类别」，不是「好坏标签」。 */
const CLASS_KEYS = ['verify', 'search', 'edit', 'shell', 'method', 'other']

/**
 * 面板要的全部数字，来自**流式累加**而不是每次重扫整份日志。
 *
 * 为什么是累加器：面板每 5 秒轮询一次，而 `webServer` 与闸门共用一条线程。
 * 全量重算在 2 MiB 日志上是 48 ms、16 MiB 上是 143 ms 级的同步阻塞（实测），
 * 面板开着就等于每 5 秒卡一次 agent 循环。这里单遍喂、O(1)/条的常驻，
 * 读端只把新增的行推进来即可（见 `readAggregate`）。
 *
 * `aggregate()` 仍是原来的签名与返回体，只是「喂完再取结果」的糖 ——
 * 老调用方与测试一行都不用改。
 * `thresholds` 只用于展示「当前这道闸门的档位」，不参与统计。
 */
export function createAggregator() {
  let total = 0
  let injectCount = 0
  const bySignal = { A: 0, B: 0, C: 0, F: 0, O: 0, P: 0, M: 0 }
  const byTag = {}
  const sessions = new Set()
  const turns = new Set()
  let chars = 0
  let tokens = 0
  let instrumented = 0
  /** inj → 该 id 的注入条数。同一个 id 可能被多条注入复用，所以要计数不是置位。 */
  const injectInjCounts = new Map()
  let outcomeCount = 0
  let changeCount = 0
  const outcomeInjs = new Set()
  const changeInjs = new Set()
  let reported = 0
  let turned = 0
  const firstClass = Object.fromEntries(CLASS_KEYS.map((key) => [key, 0]))
  const firstTool = {}
  const turnedClass = Object.fromEntries(CLASS_KEYS.map((key) => [key, 0]))
  const stepsToTurn = []
  let measureTotal = 0
  let measureOk = 0
  let measureCleared = 0
  let armCount = 0
  let applyCount = 0
  let lastApply = null
  let skillCount = 0
  let skillPath = ''
  let futileCount = 0
  const futileBySession = {}
  let lastFutileCount = 0
  let disabled = 0
  let skillFailed = 0
  let panelFailed = 0
  let suppressed = 0
  /**
   * 世代计数：只算**最后一次 apply 之后**发生的失败。
   *
   * 为什么必须分两套：`disabled by config` / `panel register failed` 这类行是
   * 「那一刻的状态」，不是「永久事实」。全量计数会让历史里挂过一次的插件
   * 在修好之后仍然永久显示红条 —— 面板说「插件当前被关闭」，而它明明在跑，
   * 这比没有面板更坏。全量留在 log.disabled 等字段里给「历史上出过事」用。
   */
  const current = { disabled: 0, skillFailed: 0, panelFailed: 0, since: '', pid: 0, markers: 0 }
  /** 最近 40 条注入，面板表格用。环形保留，不存整份日志。 */
  const recent = []

  /** 喂一条解析后的记录。任何未知 kind 只计行数，不影响统计。 */
  const push = (record) => {
    total += 1
    const kind = record.kind
    if (kind === 'inject') {
      injectCount += 1
      for (const sig of record.signals) {
        if (bySignal[sig] !== void 0) bySignal[sig] += 1
      }
      const tag = record.signals.join('+') || '?'
      byTag[tag] = (byTag[tag] ?? 0) + 1
      if (record.session.length > 0) sessions.add(record.session)
      if (Number.isFinite(record.turn)) turns.add(record.session + '#' + record.turn)
      chars += record.chars
      tokens += record.tokens
      const inj = String(record.inj ?? '')
      if (inj.length > 0) {
        instrumented += 1
        injectInjCounts.set(inj, (injectInjCounts.get(inj) ?? 0) + 1)
        // 注入行总在 outcome / change 之前，但两边都判一次：日志被拼接、
        // 或片段里只剩后半段时，顺序反过来也不至于少算。
        if (outcomeInjs.has(inj)) reported += 1
        if (changeInjs.has(inj)) turned += 1
      }
      recent.push(record)
      if (recent.length > 40) recent.shift()
      return
    }
    if (kind === 'outcome') {
      outcomeCount += 1
      const cls = firstClass[record.cls] === void 0 ? 'other' : record.cls
      firstClass[cls] += 1
      const tool = record.first || '(none)'
      firstTool[tool] = (firstTool[tool] ?? 0) + 1
      const inj = String(record.inj ?? '')
      if (inj.length > 0 && !outcomeInjs.has(inj)) {
        outcomeInjs.add(inj)
        reported += injectInjCounts.get(inj) ?? 0
      }
      return
    }
    if (kind === 'change') {
      changeCount += 1
      const cls = turnedClass[record.cls] === void 0 ? 'other' : record.cls
      turnedClass[cls] += 1
      if (record.steps >= 0) stepsToTurn.push(record.steps)
      const inj = String(record.inj ?? '')
      if (inj.length > 0 && !changeInjs.has(inj)) {
        changeInjs.add(inj)
        turned += injectInjCounts.get(inj) ?? 0
      }
      return
    }
    if (kind === 'measure') {
      measureTotal += 1
      if (record.ok) measureOk += 1
      measureCleared += record.cleared
      return
    }
    if (kind === 'arm') {
      armCount += 1
      return
    }
    if (kind === 'apply') {
      applyCount += 1
      lastApply = record
      // 新的世代开始：之前那些失败属于上一代，不再代表「现在」。
      current.disabled = 0
      current.skillFailed = 0
      current.panelFailed = 0
      current.since = record.at
      current.pid = record.pid
      current.markers += 1
      return
    }
    if (kind === 'skill') {
      skillCount += 1
      skillPath = record.path
      return
    }
    if (kind === 'disabled') {
      disabled += 1
      // `disabled by config` 之后 apply 不会再写（index.js 里直接 return），
      // 所以它本身就是一次世代分界：这一代的状态就是「关着」。不认这一点的话，
      // 一个真的被关掉的插件会因为「没有 apply 行」被判成「无从判断」。
      current.disabled = 1
      current.skillFailed = 0
      current.panelFailed = 0
      current.since = record.at
      current.markers += 1
      return
    }
    if (kind === 'skill-failed') {
      skillFailed += 1
      current.skillFailed += 1
      return
    }
    if (kind === 'panel-failed') {
      panelFailed += 1
      current.panelFailed += 1
      return
    }
    if (kind === 'suppress') {
      suppressed += 1
      return
    }
    if (kind === 'futile') {
      futileCount += 1
      const key = record.session || '(none)'
      futileBySession[key] = (futileBySession[key] ?? 0) + 1
      lastFutileCount = record.count
    }
  }

  /** 取结果。可重复调用；返回体每次都是新对象，调用方改了不影响累加器。 */
  const finish = (options = {}) => {
    // 埋点世代：v0.2 之前没有 `inj=`，也就一定没有 `change` / `measure` 行。
    // 这类老日志里「0 次转向」是**没测**，不是「测了没有」——两者必须分开，
    // 否则面板会把「指标还没上线」算成「模型一次都没转向」，那就是凭空编数据。
    // 注意 `parseLine` 把缺失的 inj 补成空串（不是 undefined），判据要按长度判。
    //
    // 一次注入可以产出**多条** outcome / change 行（窗口里每一步都能结算一次），
    // 所以必须按 `inj=` 关联到注入上，不能直接数行数：数行数会让转向率超过 100%、
    // 让 silent 变成负数（第五轮缺陷 S4，实测 rate 到过 300%、silent 到过 -2）。
    // 老日志没有 inj → 无从关联，退化成「行数与注入数取小」，仍然保证 0 ≤ reported ≤ total。
    const reportedNow = instrumented > 0 ? reported : Math.min(outcomeCount, injectCount)
    const turnedNow = instrumented > 0 ? turned : Math.min(changeCount, injectCount)
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      log: {
        file: String(options.logFile ?? ''),
        exists: options.exists === true,
        bytes: Number(options.bytes) || 0,
        lines: total,
        disabled,
        skillFailed,
        panelFailed,
        suppressed,
        arms: armCount,
        skills: skillCount,
        skillPath,
        // 「现在这一代怎么样」——横幅只看这一段。全量在上面，供事后查历史。
        // markers=0 表示日志里没有任何世代分界（既没有 apply 也没有 disabled），
        // 说明读到的是残缺片段；此时失败仍然照实计入，只是面板没法说「这是哪一次加载之后」。
        current: {
          disabled: current.disabled,
          skillFailed: current.skillFailed,
          panelFailed: current.panelFailed,
          since: current.since,
          pid: current.pid,
          markers: current.markers
        }
      },
      thresholds: lastApply !== null && lastApply.thresholds.A > 0
        ? lastApply.thresholds
        : fallbackThresholds(options.thresholds),
      // 没有 apply 行（日志被截断、或这一代还没写 apply）时，回退到**配置对象本身**。
      // 调用方 registerPanel 传的是整个 cfg（键名是 repeatEditThreshold / maxInjectsPerTurn /
      // changedWindow），过去这里只认 A/B/C 与 budget/window，于是面板恒显示 0 ——
      // 阈值条全空、预算 0（第五轮缺陷 S3）。
      budget: lastApply?.budget ?? (Number(options.budget ?? options.maxInjectsPerTurn ?? options.thresholds?.maxInjectsPerTurn) || 0),
      window: lastApply?.window ?? (Number(options.window ?? options.changedWindow ?? options.thresholds?.changedWindow) || 0),
      // v0.3 的档位。`family` / `meta` 在日志里是复合字段（`4/3`、`2/1`），
      // 面板原样透出，展示层再拆——这里不做二次解析，免得两处逻辑漂移。
      // 老日志没有这些键 → 空串 / 0，展示层据此显示「未知」。
      advanced: {
        family: lastApply?.family ?? '',
        oscillation: lastApply?.oscillation ?? 0,
        patchChain: lastApply?.patchChain ?? 0,
        meta: lastApply?.meta ?? ''
      },
      // M 的输入：窗口内没等到转向的注入条数。这是「提醒是否白说」的硬计数，
      // 与 turned 的分母不同——turned 数的是转向率，futile 数的是被窗口判死的次数。
      futile: {
        total: futileCount,
        bySession: { ...futileBySession },
        lastCount: lastFutileCount
      },
      applied: { count: applyCount, lastAt: lastApply ? lastApply.at : '', pid: lastApply ? lastApply.pid : 0 },
      injects: {
        total: injectCount,
        sessions: sessions.size,
        turns: turns.size,
        chars,
        // 注入本身的开销是实测（chars → token 折算），保留；
        // 「省掉多少」不折算——那需要假设「模型本来会失败」，面板不编这个数。
        tokens,
        bySignal: { ...bySignal },
        byTag: { ...byTag }
      },
      // 提示后模型第一个动作是什么。字段名描述行为，不暗示因果。
      firstAction: {
        reported: reportedNow,
        silent: injectCount - reportedNow,
        byClass: { ...firstClass },
        byTool: { ...firstTool }
      },
      // 窗口内有没有真的转去取得新事实，几 step 之后转的。
      // observed 是分母：只算**埋点上线后**的注入。老日志里 observed=0，
      // 面板该说「还没开始记」而不是「0% 转向」。
      turned: {
        observed: instrumented,
        total: turnedNow,
        rate: instrumented > 0 ? turnedNow / instrumented : null,
        byClass: { ...turnedClass },
        medianSteps: median(stepsToTurn)
      },
      // 测量是「有没有回路」的硬证据：与动作分类无关，直接数。
      measures: {
        total: measureTotal,
        ok: measureOk,
        failed: measureTotal - measureOk,
        cleared: measureCleared
      },
      estimate: {
        injectionTokens: tokens
      },
      recent: recent.map((inject) => ({
        at: inject.at,
        session: inject.session,
        turn: inject.turn,
        step: inject.step,
        inj: inject.inj,
        tag: inject.signals.join('+'),
        chars: inject.chars,
        worstEdits: inject.worstEdits,
        worstStreak: inject.worstStreak || 0,
        worstErrors: inject.worstErrors,
        searched: inject.searched,
        measured: inject.measured,
        sample: inject.sample
      }))
    }
  }

  return { push, finish }
}

/** 一次性把记录数组算成面板数据。测试与老调用方走这条。 */
export function aggregate(records, options = {}) {
  const acc = createAggregator()
  for (const record of records) acc.push(record)
  return acc.finish(options)
}

/**
 * 读端增量缓存（P1-10）。
 *
 * 面板是每次 HTTP 请求都重算一遍的：日志长到 2 MB 时，全量 readFileSync + parseLog
 * 就是每请求 100 ms 级的同步阻塞，而 webServer 是单线程 —— 面板开着的时候闸门也在
 * 这条线程上。所以这里两头都省：**只解析新增的字节**，并且把解析结果直接喂进常驻的
 * 累加器，每请求 O(新增) 而不是 O(全文)。
 *
 * 失效判据（任一命中就整份重读）：换了文件、换了 inode / 创建时间（说明被轮转走了）、
 * 文件变小（被截断）、mtime 回退（时钟乱序）。tail 存的是**未完结的最后一行**的原始
 * 字节，不是字符串 —— 切在多字节字符中间时先解码会造出替换字符，那一行就废了。
 *
 * 常驻的是累加器而不是记录数组：记录数组只增不减（唯一清空点是 resetCache），
 * 64 MiB 日志约 70 万条、实测每条约 233 字节 ≈ 156 MB 常驻，只有重启才释放。
 * 累加器只保留计数与最近 40 条，内存与日志长度无关。
 */
let logCache = { file: '', ino: 0, birthtimeMs: 0, size: 0, mtimeMs: 0, tail: Buffer.alloc(0), acc: createAggregator() }

/** 读 [from, to) 字节。文件读不到时返回 null —— 调用方据此「下一轮再试」而不是抛。 */
function readRangeSync(logFile, from, to) {
  const length = to - from
  if (length <= 0) return Buffer.alloc(0)
  let fd = -1
  try {
    fd = openSync(logFile, 'r')
    const buffer = Buffer.allocUnsafe(length)
    let read = 0
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, from + read)
      if (n <= 0) break
      read += n
    }
    return buffer.subarray(0, read)
  } catch {
    // 典型的真实窗口：statSync 与 openSync 之间正好轮转（rotateLog 是 rename 不是
    // truncate），文件在这一瞬间被改名走。这不是错误状态，只是这一轮没读到东西。
    return null
  } finally {
    if (fd >= 0) {
      try { closeSync(fd) } catch {}
    }
  }
}

/**
 * 把一段新字节并进累加器，只把**完整的行**交给 parseLog，剩下的留在 tail 里等下一轮。
 * 返回 false 表示这一轮没读到（文件不在了），缓存进度不推进。
 */
function absorb(logFile, from, to) {
  const chunk = readRangeSync(logFile, from, to)
  if (chunk === null) return false
  const buffer = logCache.tail.length === 0 ? chunk : Buffer.concat([logCache.tail, chunk])
  const text = buffer.toString('utf8')
  const cut = text.lastIndexOf('\n')
  if (cut < 0) {
    // 一整段里连一个换行都没有：全都还不完整，留到下一轮。
    logCache.tail = buffer
    return true
  }
  const head = text.slice(0, cut + 1)
  logCache.tail = buffer.subarray(Buffer.byteLength(head, 'utf8'))
  for (const record of parseLog(head)) logCache.acc.push(record)
  return true
}

function resetCache(logFile) {
  logCache = { file: logFile, ino: 0, birthtimeMs: 0, size: 0, mtimeMs: 0, tail: Buffer.alloc(0), acc: createAggregator() }
}

/** 读日志文件；不存在就当空，不抛。 */
export function readAggregate(logFile, extra = {}) {
  const thresholds = extra.thresholds
  if (typeof logFile !== 'string' || logFile.trim().length === 0) {
    resetCache('')
    return aggregate([], { logFile: '', exists: false, thresholds })
  }
  let stats = null
  try {
    stats = statSync(logFile)
  } catch {
    resetCache(logFile)
    return aggregate([], { logFile, exists: false, bytes: 0, thresholds })
  }
  const rotated =
    logCache.file !== logFile ||
    logCache.ino !== stats.ino ||
    logCache.birthtimeMs !== stats.birthtimeMs ||
    stats.size < logCache.size ||
    stats.mtimeMs < logCache.mtimeMs
  if (rotated) {
    resetCache(logFile)
    // 读失败就不推进 ino / size：下一轮还会判成 rotated 再整份重读，自愈。
    // 过去这里不判返回值，openSync 的 ENOENT 会一路穿到 HTTP handler，
    // 面板直接变 500 错误页 —— 一次正常轮转就把面板打成「坏了」。
    if (absorb(logFile, 0, stats.size)) {
      logCache.ino = stats.ino
      logCache.birthtimeMs = stats.birthtimeMs
      logCache.size = stats.size
      logCache.mtimeMs = stats.mtimeMs
    }
  } else if (stats.size > logCache.size) {
    if (absorb(logFile, logCache.size, stats.size)) {
      logCache.size = stats.size
      logCache.mtimeMs = stats.mtimeMs
    }
  } else {
    logCache.mtimeMs = stats.mtimeMs
  }
  // bytes 保持「文件总字节数」语义（面板和测试都按它判断「日志多大了」），
  // 与「这一轮解析了多少」是两件事。
  return logCache.acc.finish({ logFile, exists: true, bytes: stats.size, thresholds })
}

/**
 * 面板路由的准入闸 —— 每个请求都要先过这一关。
 *
 * 为什么必须有：`webServer.register({ kind: 'prefix' })` 只负责**路由**，不负责**鉴权**。
 * 宿主把鉴权做在 `connection` 服务上（`dsh-client-connection`），由每个自己注册路由的插件
 * 主动调用 `requestRejection(req)` —— `dsh-host-open-in-app` 与 `dsh-experimental-inspector`
 * 都是这么做的。少了这一步，`/better-debug` 就成了整条 web 面上唯一不需要凭证的路径：
 * 实测本机 `dsh web` 被 `@linxin666/dsh-remote-web-ui` 通过 relay 暴露到公网后，
 * `https://<instance>.dsh-market.com/` 是 401，而同主机的 `/better-debug/api` 是 200 ——
 * 返回的是真实会话 id、报错样本与日志绝对路径。
 *
 * 闸的判据完全交给宿主，本函数不自己判断：
 *   - 403：Host/Origin 不是本机（防 DNS rebinding 与跨站读）
 *   - 401：没有有效 cookie（浏览器没走过 dsh web 的 launch token 兑换）
 *   - 0  ：放行
 *
 * 宿主没有 `connection` 服务时（headless profile、单元测试的假 ctx）返回恒放行的闸：
 * 那种部署里 webServer 只监听回环地址，且没有浏览器鉴权层可依，
 * 强加一层自己的鉴权只会把面板关掉而不增加任何安全性。
 * @param ctx - 插件上下文（只读 `ctx.get('connection')`，不进 inject 依赖）
 * @returns 判定函数：请求 → 拒绝码（0 表示放行）
 */
export function createRequestGate(ctx) {
  // 服务在**每次请求时**才查，不在注册时查一次就缓存：cordis 的服务就绪顺序不保证，
  // 面板挂在 webServer 上时 connection 可能还没起来。注册时取一次会永久拿到 undefined，
  // 闸就静默退化成恒放行 —— 这种失效没有任何信号，比不做还危险。
  const lookup = typeof ctx?.get === 'function' ? () => ctx.get('connection') : () => void 0
  return (req) => {
    const connection = lookup()
    if (connection === void 0 || typeof connection.requestRejection !== 'function') return 0
    const rejection = connection.requestRejection(req)
    return typeof rejection === 'number' ? rejection : 0
  }
}

/**
 * 把 `/better-debug` 前缀挂到 webServer 上。
 * 只读：没有任何写接口，面板不改变插件行为。
 */
export function registerPanel(ctx, getConfig) {
  // 摘掉上一代留下的路由（热重载时 webServer 的路由表是跨代共享的）。
  // 两条路都走一遍：优先用上一代记下的 disposer；若上一代是没记 disposer 的旧版本，
  // 直接从路由表里删掉同 key 的那条（`prefixes` 是 Map<path, route>）。
  const previous = globalThis[PANEL_SLOT]
  if (typeof previous === 'function') {
    try { previous() } catch {}
  }
  globalThis[PANEL_SLOT] = void 0
  const table = ctx.webServer?.prefixes
  if (table instanceof Map && table.has('/better-debug')) table.delete('/better-debug')

  let dispose
  // 准入闸与路由同寿：`connection` 服务在热重载期间不会换实例，闸只读它一个方法。
  const gate = createRequestGate(ctx)
  const handler = async (req, res) => {
    // 鉴权必须先于一切路由分支：面板返回的 JSON 里有会话 id 与报错样本，
    // 一旦被公网 relay 直接读到，等于把本机调试日志匿名公开（实测过）。
    // 拒绝时不带 CSP —— 响应体是一行纯文本，没有任何可执行内容。
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
    // 面板页是纯静态 + 一条同源 fetch，没有任何外部资源（web/index.html 里
    // 没有 src= / href= / @import / url()，脚本与样式全部内联），所以 CSP 可以收到
    // 最紧的一档：default-src 'none' 把 img/font/frame/form 一次性关掉，只留
    // style/script 的内联（页面本身就是内联的）与 connect-src 'self'（那条 fetch）。
    // nosniff 防宿主或反代把 JSON 嗅探成 HTML —— /better-debug/api 返回的是
    // 用户可控的会话 id 与报错样本，能被当 HTML 执行就是一条现成的 XSS。
    const CSP = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      "script-src 'unsafe-inline'",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'self'"
    ].join('; ')
    const send = (status, type, body) => {
      res.writeHead(status, {
        'content-type': type,
        'cache-control': 'no-store',
        'content-security-policy': CSP,
        'x-content-type-options': 'nosniff'
      })
      res.end(body)
    }
    try {
      const url = new URL(req.url, 'http://localhost')
      const pathname = url.pathname

      if (pathname === '/better-debug' || pathname === '/better-debug/' || pathname === '/better-debug/index.html') {
        send(200, 'text/html; charset=utf-8', readFileSync(join(WEB_ROOT, 'index.html')))
        return
      }

      if (pathname === '/better-debug/api') {
        const cfg = getConfig()
        const stats = readAggregate(cfg.logFile, { thresholds: cfg })
        if (url.searchParams.get('raw') === '1') {
          send(
            200,
            'application/json; charset=utf-8',
            JSON.stringify({ id: 'dsh-better-debug', version: 3 }, null, 2)
          )
          return
        }
        send(200, 'application/json; charset=utf-8', JSON.stringify(stats))
        return
      }

      send(404, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: 'not-found' }))
    } catch (error) {
      try {
        send(500, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
      } catch {}
    }
  }

  dispose = ctx.webServer.register({ kind: 'prefix', path: '/better-debug', handler })
  globalThis[PANEL_SLOT] = dispose
  // 交给 cordis 管生命周期：插件卸载/热重载时自动摘路由。
  if (typeof ctx.effect === 'function' && typeof dispose === 'function') {
    ctx.effect(() => dispose, 'better-debug.panel-route')
  }
  return dispose
}

export { WEB_ROOT }
