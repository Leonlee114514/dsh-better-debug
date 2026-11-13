import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * dsh-better-debug 的读数面板（server 半）。
 *
 * 设计原则：**每一个数字都必须能从日志里逐行数出来**。
 * 这个插件能证明的只有「我在第几步、因为什么信号、说了什么话、说完后模型下一个动作是什么」。
 * 「省掉了多少 token」这类折算需要假设「本来会失败」，面板不做，也不展示。
 *
 * 数据源就是 cfg.logFile 那一个文件，没有第二个真相来源：
 *   apply pid=… logFile=… A=3 B=2 C=2
 *   inject session=… turn=… step=… signals=C chars=256 files=2 worstEdits=1 worstStreak=1 worstErrors=0 searched=true
 *   suppress session=… turn=… step=… reason=done
 *   outcome session=… turn=… after=C first=ops_bash class=verify steps=1
 *   bundled skill registered: stuck-gate <- …
 *   disabled by config, no gate installed
 *   skill register failed: …
 */

const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url))

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/u

/** 中英混排的 token 粗估：CJK 1:1，其余 ~0.32。 */
export function estimateTokens(text) {
  let cjk = 0
  let other = 0
  for (const char of String(text ?? '')) {
    if (CJK.test(char)) cjk += 1
    else other += 1
  }
  return Math.round(cjk + other * 0.32)
}

/** 老日志行没有 chars=，按信号组合回退到实测长度。 */
const CHARS_BY_SIGNALS = { A: 254, B: 268, C: 256, 'A+B': 307 }

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

function charsFor(signals) {
  const tag = signals.join('+')
  if (CHARS_BY_SIGNALS[tag] !== void 0) return CHARS_BY_SIGNALS[tag]
  let total = 0
  for (const kind of signals) total += CHARS_BY_SIGNALS[kind] ?? 256
  return total
}

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
    return {
      kind: 'inject',
      at,
      session: f.session ?? '',
      turn: Number(f.turn),
      step: Number(f.step),
      signals,
      chars,
      files: Number(f.files) || 0,
      worstEdits: Number(f.worstEdits) || 0,
      // A 现在按「自上次 verify 以来的连续盲改」判定；老日志没有这个字段 → 0。
      worstStreak: Number(f.worstStreak) || 0,
      worstErrors: Number(f.worstErrors) || 0,
      searched: f.searched === 'true',
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

  if (body.startsWith('outcome ')) {
    const f = scanFields(body.slice(8))
    return {
      kind: 'outcome',
      at,
      session: f.session ?? '',
      turn: Number(f.turn),
      after: String(f.after ?? ''),
      first: f.first ?? '',
      // `class` 是保留字，日志里写信的是 class=，读的时候两个都认。
      cls: f.class ?? f.cls ?? 'other',
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
      thresholds: { A: Number(f.A) || 0, B: Number(f.B) || 0, C: Number(f.C) || 0 }
    }
  }

  if (body.startsWith('bundled skill registered:')) {
    return { kind: 'skill', at, path: body.slice('bundled skill registered:'.length).trim() }
  }
  if (body.startsWith('disabled by config')) return { kind: 'disabled', at }
  if (body.startsWith('skill register failed')) return { kind: 'skill-failed', at, message: body }

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

const CHANGED_CLASSES = new Set(['verify', 'search'])

/**
 * 记录数组 → 面板要的全部数字。
 * `thresholds` 只用于展示「当前这道闸门的档位」，不参与统计。
 */
export function aggregate(records, options = {}) {
  const injects = []
  const outcomes = []
  const applies = []
  const skills = []
  let disabled = 0
  let skillFailed = 0
  let suppressed = 0

  for (const record of records) {
    if (record.kind === 'inject') injects.push(record)
    else if (record.kind === 'outcome') outcomes.push(record)
    else if (record.kind === 'apply') applies.push(record)
    else if (record.kind === 'skill') skills.push(record)
    else if (record.kind === 'disabled') disabled += 1
    else if (record.kind === 'skill-failed') skillFailed += 1
    else if (record.kind === 'suppress') suppressed += 1
  }

  const bySignal = { A: 0, B: 0, C: 0 }
  const byTag = {}
  const sessions = new Set()
  const turns = new Set()
  let chars = 0
  for (const inject of injects) {
    for (const kind of inject.signals) {
      if (bySignal[kind] !== void 0) bySignal[kind] += 1
    }
    const tag = inject.signals.join('+') || '?'
    byTag[tag] = (byTag[tag] ?? 0) + 1
    if (inject.session.length > 0) sessions.add(inject.session)
    if (Number.isFinite(inject.turn)) turns.add(`${inject.session}#${inject.turn}`)
    chars += inject.chars
  }

  const byClass = { verify: 0, search: 0, edit: 0, other: 0 }
  const stepsToAction = []
  for (const outcome of outcomes) {
    const cls = byClass[outcome.cls] === void 0 ? 'other' : outcome.cls
    byClass[cls] += 1
    if (outcome.steps > 0) stepsToAction.push(outcome.steps)
  }
  const changed = byClass.verify + byClass.search
  const reported = outcomes.length
  const changedRate = reported > 0 ? changed / reported : null

  // 注入自身的开销是实测（chars → token），保留；「省掉多少」不做折算——
  // 那需要假设「模型本来会失败」，面板不编这个数。
  const injectionTokens = Math.round(chars * 0.72)

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
      suppressed,
      skills: skills.length,
      skillPath: skills.length > 0 ? skills[skills.length - 1].path : ''
    },
    thresholds: lastApply !== null && lastApply.thresholds.A > 0
      ? lastApply.thresholds
      : { A: Number(options.thresholds?.A) || 0, B: Number(options.thresholds?.B) || 0, C: Number(options.thresholds?.C) || 0 },
    applied: { count: applies.length, lastAt: lastApply ? lastApply.at : '', pid: lastApply ? lastApply.pid : 0 },
    injects: {
      total: injects.length,
      sessions: sessions.size,
      turns: turns.size,
      chars,
      estTokens: estimateTokens('x'.repeat(0)) === 0 ? Math.round(chars * 0.72) : 0,
      bySignal,
      byTag
    },
    outcomes: {
      reported,
      byClass,
      changed,
      changedRate,
      medianSteps: median(stepsToAction),
      silent: injects.length - reported
    },
    estimate: {
      injectionTokens
    },
    recent: injects.slice(-40).map((inject) => ({
      at: inject.at,
      session: inject.session,
      turn: inject.turn,
      step: inject.step,
      tag: inject.signals.join('+'),
      chars: inject.chars,
      worstEdits: inject.worstEdits,
      worstStreak: inject.worstStreak || 0,
      worstErrors: inject.worstErrors,
      searched: inject.searched,
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
          send(200, 'application/json; charset=utf-8', JSON.stringify({ id: 'dsh-better-debug', version: 1 }, null, 2))
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
