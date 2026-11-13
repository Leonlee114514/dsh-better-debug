import { readFileSync } from 'node:fs'
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
 *   apply pid=… logFile=… A=3 B=2 C=2 budget=3 window=6 panel=true
 *   inject session=… turn=… step=… signals=C inj=a1b2c3d4 chars=302 tokens=302 files=2 …
 *   arm session=… turn=… step=… gap=3
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

  // C 只上膛不开口的那一步：用来解释「为什么改完 N 步却没提醒」。
  if (body.startsWith('arm ')) {
    const f = scanFields(body.slice(4))
    return {
      kind: 'arm',
      at,
      session: f.session ?? '',
      turn: Number(f.turn),
      step: Number(f.step),
      gap: Number(f.gap) || 0
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
 * 记录数组 → 面板要的全部数字。
 * `thresholds` 只用于展示「当前这道闸门的档位」，不参与统计。
 */
export function aggregate(records, options = {}) {
  const injects = []
  const outcomes = []
  const changes = []
  const measures = []
  const arms = []
  const applies = []
  const skills = []
  let disabled = 0
  let skillFailed = 0
  let panelFailed = 0
  let suppressed = 0

  for (const record of records) {
    if (record.kind === 'inject') injects.push(record)
    else if (record.kind === 'outcome') outcomes.push(record)
    else if (record.kind === 'change') changes.push(record)
    else if (record.kind === 'measure') measures.push(record)
    else if (record.kind === 'arm') arms.push(record)
    else if (record.kind === 'apply') applies.push(record)
    else if (record.kind === 'skill') skills.push(record)
    else if (record.kind === 'disabled') disabled += 1
    else if (record.kind === 'skill-failed') skillFailed += 1
    else if (record.kind === 'panel-failed') panelFailed += 1
    else if (record.kind === 'suppress') suppressed += 1
  }

  const bySignal = { A: 0, B: 0, C: 0 }
  const byTag = {}
  const sessions = new Set()
  const turns = new Set()
  let chars = 0
  let tokens = 0
  for (const inject of injects) {
    for (const kind of inject.signals) {
      if (bySignal[kind] !== void 0) bySignal[kind] += 1
    }
    const tag = inject.signals.join('+') || '?'
    byTag[tag] = (byTag[tag] ?? 0) + 1
    if (inject.session.length > 0) sessions.add(inject.session)
    if (Number.isFinite(inject.turn)) turns.add(`${inject.session}#${inject.turn}`)
    chars += inject.chars
    tokens += inject.tokens
  }

  // 提示后第一个动作的分布。这是描述量，不是效果量。
  const firstClass = Object.fromEntries(CLASS_KEYS.map((key) => [key, 0]))
  const firstTool = {}
  for (const outcome of outcomes) {
    const cls = firstClass[outcome.cls] === void 0 ? 'other' : outcome.cls
    firstClass[cls] += 1
    const tool = outcome.first || '(none)'
    firstTool[tool] = (firstTool[tool] ?? 0) + 1
  }

  // 窗口内的转向：只有 change 行才算「真的转去验证/搜索了」。
  const turnedClass = Object.fromEntries(CLASS_KEYS.map((key) => [key, 0]))
  const stepsToTurn = []
  for (const change of changes) {
    const cls = turnedClass[change.cls] === void 0 ? 'other' : change.cls
    turnedClass[cls] += 1
    if (change.steps >= 0) stepsToTurn.push(change.steps)
  }

  const reported = outcomes.length
  const turned = changes.length

  // 埋点世代：v0.2 之前没有 `inj=`，也就一定没有 `change` / `measure` 行。
  // 这类老日志里「0 次转向」是**没测**，不是「测了没有」——两者必须分开，
  // 否则面板会把「指标还没上线」算成「模型一次都没转向」，那就是凭空编数据。
  // 注意 `parseLine` 把缺失的 inj 补成空串（不是 undefined），判据要按长度判。
  const instrumented = injects.filter((inject) => String(inject.inj ?? '').length > 0).length

  const lastApply = applies.length > 0 ? applies[applies.length - 1] : null

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    log: {
      file: String(options.logFile ?? ''),
      exists: options.exists === true,
      bytes: Number(options.bytes) || 0,
      lines: records.length,
      disabled,
      skillFailed,
      panelFailed,
      suppressed,
      arms: arms.length,
      skills: skills.length,
      skillPath: skills.length > 0 ? skills[skills.length - 1].path : ''
    },
    thresholds: lastApply !== null && lastApply.thresholds.A > 0
      ? lastApply.thresholds
      : {
          A: Number(options.thresholds?.A) || 0,
          B: Number(options.thresholds?.B) || 0,
          C: Number(options.thresholds?.C) || 0
        },
    budget: lastApply?.budget ?? 0,
    window: lastApply?.window ?? 0,
    applied: { count: applies.length, lastAt: lastApply ? lastApply.at : '', pid: lastApply ? lastApply.pid : 0 },
    injects: {
      total: injects.length,
      sessions: sessions.size,
      turns: turns.size,
      chars,
      // 注入本身的开销是实测（chars → token 折算），保留；
      // 「省掉多少」不折算——那需要假设「模型本来会失败」，面板不编这个数。
      tokens,
      bySignal,
      byTag
    },
    // 提示后模型第一个动作是什么。字段名描述行为，不暗示因果。
    firstAction: {
      reported,
      silent: injects.length - reported,
      byClass: firstClass,
      byTool: firstTool
    },
    // 窗口内有没有真的转去取得新事实，几 step 之后转的。
    // observed 是分母：只算**埋点上线后**的注入。老日志里 observed=0，
    // 面板该说「还没开始记」而不是「0% 转向」。
    turned: {
      observed: instrumented,
      total: turned,
      rate: instrumented > 0 ? turned / instrumented : null,
      byClass: turnedClass,
      medianSteps: median(stepsToTurn)
    },
    // 测量是「有没有回路」的硬证据：与动作分类无关，直接数。
    measures: {
      total: measures.length,
      ok: measures.filter((measure) => measure.ok).length,
      failed: measures.filter((measure) => !measure.ok).length,
      cleared: measures.reduce((sum, measure) => sum + measure.cleared, 0)
    },
    estimate: {
      injectionTokens: tokens
    },
    recent: injects.slice(-40).map((inject) => ({
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

/** 读日志文件；不存在就当空，不抛。 */
export function readAggregate(logFile, extra = {}) {
  const thresholds = extra.thresholds
  if (typeof logFile !== 'string' || logFile.trim().length === 0) {
    return aggregate([], { logFile: '', exists: false, thresholds })
  }
  let text = ''
  let exists = false
  let bytes = 0
  try {
    text = readFileSync(logFile, 'utf8')
    exists = true
    bytes = Buffer.byteLength(text, 'utf8')
  } catch {
    exists = false
  }
  return aggregate(parseLog(text), { logFile, exists, bytes, thresholds })
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
  const handler = async (req, res) => {
    const send = (status, type, body) => {
      res.writeHead(status, {
        'content-type': type,
        'cache-control': 'no-store'
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
            JSON.stringify({ id: 'dsh-better-debug', version: 2 }, null, 2)
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
