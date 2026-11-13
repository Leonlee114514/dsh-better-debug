// 面板的读数验证：解析器、聚合、折算，以及 `outcome` 埋点是否真的落盘。
// 和 sim.mjs 一样不依赖 DSH 运行时——面板只认日志文本，所以它天然可单测。
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { aggregate, parseLine, parseLog, scanFields, estimateTokens, readAggregate } from '../lib/panel.js'

const results = []
function check(label, pass, detail) {
  results.push({ label, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
}

// ── 1. 字段扫描器：带引号的值里有空格、冒号、转义引号
{
  const f = scanFields('session=s1 turn=3 signals=B searched=false sample="Error: cannot modify \\"a b\\": file"')
  check(
    'scanFields 切开带引号的值',
    f.session === 's1' && f.turn === '3' && f.signals === 'B' &&
      f.searched === 'false' && f.sample === 'Error: cannot modify "a b": file',
    JSON.stringify(f.sample)
  )
}

// ── 2. 三种行型各自解析成结构化记录
{
  const inject = parseLine(
    '2026-11-07T02:38:23.965Z inject session=s-1 turn=39 step=19 signals=C chars=256 files=2 worstEdits=1 worstStreak=1 worstErrors=0 searched=true'
  )
  const outcome = parseLine(
    '2026-11-07T02:38:40.001Z outcome session=s-1 turn=39 after=C first=ops_bash class=verify steps=1'
  )
  const applyLine = parseLine(
    '2026-11-07T01:24:19.226Z apply pid=17884 logFile=C:/x/better-debug.log A=3 B=2 C=2 panel=true'
  )
  check(
    'parseLine 认 inject',
    inject.kind === 'inject' && inject.signals.length === 1 && inject.signals[0] === 'C' &&
      inject.chars === 256 && inject.worstEdits === 1 && inject.worstStreak === 1 && inject.searched === true,
    `${inject.kind} ${inject.signals} ${inject.chars}`
  )
  check(
    'parseLine 认 outcome',
    outcome.kind === 'outcome' && outcome.cls === 'verify' && outcome.first === 'ops_bash' && outcome.steps === 1,
    `${outcome.kind} ${outcome.cls} ${outcome.first}`
  )
  check(
    'parseLine 认 apply 与阈值',
    applyLine.kind === 'apply' && applyLine.pid === 17884 &&
      applyLine.thresholds.A === 3 && applyLine.thresholds.B === 2 && applyLine.thresholds.C === 2,
    JSON.stringify(applyLine.thresholds)
  )
}

// ── 3. 老日志没有 chars= 时按信号组合回退，不能算成 0
{
  const record = parseLine('2026-11-07T02:38:23.965Z inject session=s turn=1 step=2 signals=A+B files=1 worstEdits=3 worstErrors=2 searched=false')
  check('缺 chars= 时按信号回退', record.chars > 0, `chars=${record.chars}`)
}

// ── 4. 聚合：分布、会话去重、折算
{
  const text = [
    '2026-11-07T02:00:00.000Z apply pid=1 logFile=C:/x.log A=3 B=2 C=2 panel=true',
    '2026-11-07T02:01:00.000Z bundled skill registered: stuck-gate <- C:/a/SKILL.md',
    '2026-11-07T02:02:00.000Z inject session=s-1 turn=1 step=3 signals=A chars=254 files=1 worstEdits=3 worstErrors=0 searched=false',
    '2026-11-07T02:02:10.000Z outcome session=s-1 turn=1 after=A first=ops_bash class=verify steps=1',
    '2026-11-07T02:03:00.000Z inject session=s-1 turn=1 step=9 signals=C chars=256 files=2 worstEdits=1 worstErrors=0 searched=false',
    '2026-11-07T02:03:30.000Z outcome session=s-1 turn=1 after=C first=edit class=edit steps=2',
    '2026-11-07T02:04:00.000Z inject session=s-2 turn=4 step=7 signals=B chars=268 files=0 worstEdits=0 worstErrors=2 searched=false sample="Error: boom"',
    '2026-11-07T02:04:20.000Z outcome session=s-2 turn=4 after=B first=web_search class=search steps=0'
  ].join('\n')
  const a = aggregate(parseLog(text), { logFile: 'C:/x.log', exists: true, bytes: text.length })
  check(
    '聚合：次数/会话/信号分布',
    a.injects.total === 3 && a.injects.sessions === 2 && a.injects.turns === 2 &&
      a.injects.bySignal.A === 1 && a.injects.bySignal.B === 1 && a.injects.bySignal.C === 1,
    `${a.injects.total} 次 / ${a.injects.sessions} 会话 / A${a.injects.bySignal.A} B${a.injects.bySignal.B} C${a.injects.bySignal.C}`
  )
  check(
    '聚合：outcome 分类与改变率',
    a.outcomes.reported === 3 && a.outcomes.byClass.verify === 1 &&
      a.outcomes.byClass.search === 1 && a.outcomes.byClass.edit === 1 &&
      Math.abs(a.outcomes.changedRate - 2 / 3) < 1e-9,
    `changedRate=${a.outcomes.changedRate?.toFixed(3)}`
  )
  check(
    '聚合：阈值取最后一条 apply',
    a.thresholds.A === 3 && a.thresholds.B === 2 && a.thresholds.C === 2,
    JSON.stringify(a.thresholds)
  )
  check(
    '聚合：只保留实测的注入开销，没有折算字段',
    a.estimate.injectionTokens > 0 &&
      a.estimate.avoidedTokens === void 0 &&
      a.estimate.netTokens === void 0 &&
      a.estimate.assumedRoundtripTokens === void 0,
    `注入 ${a.estimate.injectionTokens} tok，keys=${Object.keys(a.estimate).join(',')}`
  )
  check('聚合：技能路径取最后一条', a.log.skills === 1 && a.log.skillPath.includes('SKILL.md'), a.log.skillPath)
}

// ── 5. 空日志与坏行不能让面板炸
{
  const a = aggregate(parseLog(''), { logFile: '', exists: false, bytes: 0 })
  const bad = parseLog('完全不是日志的一行\n\n2026-11-07T02:00:00.000Z inject session=s turn=1')
  check(
    '空日志：不炸，改变率为 null',
    a.injects.total === 0 && a.outcomes.reported === 0 && a.outcomes.changedRate === null,
    `total=${a.injects.total}`
  )
  check('坏行：跳过而不是抛', bad.length === 2 && bad[0].kind === 'other', `records=${bad.length}`)
  check('缺失文件：exists=false', readAggregate('', {}).log.exists === false)
}

// ── 6. token 折算：CJK 1:1，ASCII 约三分之一
{
  const zh = estimateTokens('卡住闸门')
  const en = estimateTokens('abcdefghij')
  check('estimateTokens 中英分别计', zh === 4 && en > 0 && en < 10, `zh=${zh} en=${en}`)
}

// ── 7. 端到端埋点：真跑一次 apply，注入后一条 tool/call 必须写出 outcome 行
{
  const logFile = join(tmpdir(), `better-debug-test-${process.pid}-${Date.now()}.log`)
  const listeners = new Map()
  const ctx = {
    on(evt, cb) {
      if (!listeners.has(evt)) listeners.set(evt, [])
      listeners.get(evt).push(cb)
    },
    async emitPlain(evt, ...args) {
      for (const cb of listeners.get(evt) ?? []) await cb(...args)
    },
    async emitWaterfall(evt, ...args) {
      const cbs = listeners.get(evt) ?? []
      const next = args.pop()
      const step = async (i) => (i >= cbs.length ? next() : cbs[i](...args, () => step(i + 1)))
      return step(0)
    }
  }
  apply(ctx, { logFile, panel: false })
  const session = { id: 'sess-e2e', header: { cwd: 'C:/work', origin: 'user', delegationDepth: 0 } }
  const agent = { session, status: 'running' }

  await ctx.emitPlain('session/event', session, { type: 'turn/start', data: { turn: 1 } })
  // 三步都改同一个文件 → 第 4 步 pre-step 命中 A
  let injectedAt = 0
  for (let step = 1; step <= 4; step += 1) {
    const decision = await ctx.emitWaterfall(
      'agent/pre-step',
      { agent, turn: 1, step, signal: { aborted: false } },
      () => ({ kind: 'enter', messages: [] })
    )
    if (decision.messages.some((m) => m.source?.kind === 'dsh-better-debug')) injectedAt = step
    if (step <= 3) {
      await ctx.emitWaterfall('fs/write-intent', 'C:/work/src/a.js', { agent: { session } }, () => ({ ok: true }))
    }
  }
  // 注入后的第一条工具调用
  await ctx.emitPlain('session/event', session, {
    type: 'tool/call',
    data: { turn: 1, step: 5, callId: 'c1', name: 'ops_bash', arguments: {} }
  })
  await ctx.emitPlain('session/event', session, { type: 'turn/end', data: { turn: 1 } })

  // record() 是 appendFile，插件里刻意不 await（不能因为写日志拖慢每一步）。
  // 所以读回之前得给文件系统一个落盘机会，否则测的是竞态而不是行为。
  await new Promise((resolve) => setTimeout(resolve, 100))

  let text = ''
  try {
    text = readFileSync(logFile, 'utf8')
  } catch {}
  const records = parseLog(text)
  const inject = records.find((r) => r.kind === 'inject')
  const outcome = records.find((r) => r.kind === 'outcome')
  check(
    '埋点：注入行带 chars=',
    inject !== void 0 && inject.chars > 0 && inject.signals.includes('A'),
    inject ? `chars=${inject.chars} signals=${inject.signals.join('+')}` : 'no inject line'
  )
  check(
    '埋点：注入后首个 tool/call 写出 outcome',
    outcome !== void 0 && outcome.first === 'ops_bash' && outcome.cls === 'verify' &&
      outcome.after === 'A' && outcome.steps === 5 - injectedAt,
    outcome ? `${outcome.cls}/${outcome.first} steps=${outcome.steps}` : 'no outcome line'
  )
  const a = aggregate(records, { logFile, exists: true, bytes: text.length })
  check(
    '埋点：聚合把这次算成「换了动作」',
    a.outcomes.reported === 1 && a.outcomes.changed === 1 && a.outcomes.changedRate === 1,
    `changedRate=${a.outcomes.changedRate}`
  )

  try {
    rmSync(logFile, { force: true })
  } catch {}
}

// ── 18. A 的判据字段必须在「日志 → parseLine → aggregate.recent → 面板」全链路活下来
{
  const text = [
    '2026-11-11T00:00:00.000Z inject session=s-1 turn=1 step=4 signals=A chars=254 files=1 worstEdits=3 worstStreak=3 worstErrors=0 searched=false',
    '2026-11-11T00:00:01.000Z inject session=s-2 turn=1 step=4 signals=A chars=254 files=1 worstEdits=3 worstStreak=1 worstErrors=0 searched=false'
  ].join('\n')
  const records = parseLog(text)
  const a = aggregate(records, { logFile: '', exists: true, bytes: text.length })
  const blind = a.recent.find((r) => String(r.at).includes('00:00:00'))
  const checked = a.recent.find((r) => String(r.at).includes('00:00:01'))
  check(
    '面板保留 A 的判据 worstStreak（累计相同、连续盲改不同）',
    records[0].worstStreak === 3 && records[1].worstStreak === 1 &&
      blind.worstStreak === 3 && checked.worstStreak === 1 &&
      blind.worstEdits === checked.worstEdits,
    `worstEdits=${blind.worstEdits} streak=${blind.worstStreak}/${checked.worstStreak}`
  )
}

// ── 19. done-state 的 suppress 行要能被面板读出来（醒着但故意不出声 ≠ 没挂上）
{
  const text = [
    '2026-11-11T00:00:00.000Z apply pid=1 logFile=C:/x.log A=3 B=2 C=2 panel=true',
    '2026-11-11T00:00:01.000Z suppress session=s-1 turn=1 step=7 reason=done',
    '2026-11-11T00:00:02.000Z suppress session=s-2 turn=1 step=8 reason=done'
  ].join('\n')
  const records = parseLog(text)
  const sup = records.filter((r) => r.kind === 'suppress')
  const a = aggregate(records, { logFile: 'C:/x.log', exists: true, bytes: text.length })
  check(
    'done-state suppress 行可解析与计数，且不算触发',
    sup.length === 2 && sup[0].reason === 'done' && sup[0].session === 's-1' &&
      a.log.suppressed === 2 && a.injects.total === 0,
    `suppressed=${a.log.suppressed} injects=${a.injects.total}`
  )
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  console.log('FAILED:', failed.map((r) => r.label).join(' | '))
  process.exit(1)
}
