// 面板的读数验证：解析器、聚合、折算，以及 inject/outcome/change/measure 埋点是否真的落盘。
// 和 sim.mjs 一样不依赖 DSH 运行时——面板只认日志文本，所以它天然可单测。
//
// 重点守的是「指标不许夸大」这条线（评审 m00176 中6）：
// 字段只能描述「提示后发生了什么」，不能出现暗示因果的名字（changed / gain / effective）。
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, createLogWriter } from '../lib/index.js'
import { aggregate, createRequestGate, parseLine, parseLog, scanFields, estimateTokens, readAggregate, registerPanel } from '../lib/panel.js'
import { charsFor, messageText } from '../lib/text.js'

// record() 是 appendFile，插件里刻意不 await（不能因为写日志拖慢每一步）。
// 所以「读回日志」必须等**条件**而不是等**时长**：固定 sleep 在慢盘上就是
// 用测试去赌文件系统时序 —— 2026-11-14 的真机 CI（windows-latest + node 24）
// 正是这样红的：inject/outcome/change 都写好了，measure 还在队列里，
// 断言报「no measure line」，看起来像埋点坏了，其实只是读早了。
// 这个助手每 10ms 读一次，直到目标行型齐了；超时则把**缺哪个**报出来，
// 让失败信息指向真正的缺口，而不是一句无信息的 'no measure line'。
async function readLogWhenReady(logFile, kinds, budgetMs = 5000) {
  const startedAt = Date.now()
  let text = ''
  for (;;) {
    try {
      text = readFileSync(logFile, 'utf8')
    } catch {
      text = ''
    }
    const have = new Set(parseLog(text).map((record) => record.kind))
    const missing = kinds.filter((kind) => !have.has(kind))
    if (missing.length === 0) return { text, missing, waited: Date.now() - startedAt }
    if (Date.now() - startedAt >= budgetMs) return { text, missing, waited: Date.now() - startedAt }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

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

// ── 2. 六种行型各自解析成结构化记录
{
  const inject = parseLine(
    '2026-11-07T02:38:23.965Z inject session=s-1 turn=39 step=19 signals=C inj=a1b2c3d4 chars=302 tokens=302 files=2 worstEdits=1 worstStreak=1 worstErrors=0 searched=true measured=yes:ops_bash:fail'
  )
  const outcome = parseLine(
    '2026-11-07T02:38:40.001Z outcome session=s-1 turn=39 inj=a1b2c3d4 after=C first=ops_bash class=verify steps=1 before=edit'
  )
  const change = parseLine(
    '2026-11-07T02:38:41.001Z change session=s-1 turn=39 inj=a1b2c3d4 after=C tool=ops_bash class=verify steps=2'
  )
  const measured = parseLine('2026-11-07T02:38:39.001Z measure session=s-1 turn=39 tool=ops_bash ok=true exit=0 cleared=2')
  const arm = parseLine('2026-11-07T02:38:30.001Z arm session=s-1 turn=39 step=8 writes=3')
  const applyLine = parseLine(
    '2026-11-07T01:24:19.226Z apply pid=17884 logFile=C:/x/better-debug.log A=3 B=2 C=3 budget=3 window=6 panel=true'
  )
  check(
    'parseLine 认 inject（含 inj / tokens / measured）',
    inject.kind === 'inject' && inject.signals.length === 1 && inject.signals[0] === 'C' &&
      inject.inj === 'a1b2c3d4' && inject.chars === 302 && inject.tokens === 302 &&
      inject.worstStreak === 1 && inject.searched === true &&
      inject.measured === 'yes:ops_bash:fail',
    `${inject.kind} ${inject.signals} inj=${inject.inj} ${inject.measured}`
  )
  check(
    'parseLine 认 outcome（含 inj / before）',
    outcome.kind === 'outcome' && outcome.cls === 'verify' && outcome.first === 'ops_bash' &&
      outcome.steps === 1 && outcome.inj === 'a1b2c3d4' && outcome.before === 'edit',
    `${outcome.cls}/${outcome.first} before=${outcome.before}`
  )
  check(
    'parseLine 认 change',
    change.kind === 'change' && change.cls === 'verify' && change.steps === 2 && change.tool === 'ops_bash',
    `${change.cls} steps=${change.steps}`
  )
  check(
    'parseLine 认 measure（失败的测量照样记 ok=false）',
    measured.kind === 'measure' && measured.ok === true && measured.exit === 0 && measured.cleared === 2,
    `ok=${measured.ok} exit=${measured.exit} cleared=${measured.cleared}`
  )
  check('parseLine 认 arm', arm.kind === 'arm' && arm.writes === 3, `writes=${arm.writes}`)
  check(
    'parseLine 认 apply 与阈值 + 预算',
    applyLine.kind === 'apply' && applyLine.pid === 17884 &&
      applyLine.thresholds.A === 3 && applyLine.thresholds.B === 2 && applyLine.thresholds.C === 3 &&
      applyLine.budget === 3 && applyLine.window === 6,
    JSON.stringify({ ...applyLine.thresholds, budget: applyLine.budget, window: applyLine.window })
  )
}

// ── 3. 老日志没有 chars= 时按信号组合回退，且回退值与真实文案一致（不再有硬编码漂移）
{
  const record = parseLine('2026-11-07T02:38:23.965Z inject session=s turn=1 step=2 signals=A+B files=1 worstEdits=3 worstErrors=2 searched=false')
  check('缺 chars= 时按信号回退', record.chars > 0 && record.chars === charsFor(['A', 'B']), `chars=${record.chars}`)
  const drift = ['A', 'B', 'C', 'A+B', 'A+C', 'B+C'].filter((tag) => {
    const signals = tag.split('+')
    return charsFor(signals) !== messageText(signals.map((kind) => ({ kind, n: 0 }))).length
  })
  check('回退长度 == 真实文案长度（无硬编码漂移）', drift.length === 0, drift.length === 0 ? '6 组组合' : drift.join(','))
}

// ── 4. 聚合：分布、会话去重、提示后首个动作、窗口内转向、测量
{
  const text = [
    '2026-11-07T02:00:00.000Z apply pid=1 logFile=C:/x.log A=3 B=2 C=3 budget=3 window=6 panel=true',
    '2026-11-07T02:01:00.000Z bundled skill registered: stuck-gate <- C:/a/SKILL.md',
    '2026-11-07T02:02:00.000Z inject session=s-1 turn=1 step=3 signals=A inj=i1 chars=305 tokens=200 files=1 worstEdits=3 worstStreak=3 worstErrors=0 searched=false measured=no',
    '2026-11-07T02:02:10.000Z outcome session=s-1 turn=1 inj=i1 after=A first=ops_bash class=verify steps=1 before=edit',
    '2026-11-07T02:02:11.000Z change session=s-1 turn=1 inj=i1 after=A tool=ops_bash class=verify steps=1',
    '2026-11-07T02:02:12.000Z measure session=s-1 turn=1 tool=ops_bash ok=true exit=0 cleared=1',
    '2026-11-07T02:03:00.000Z inject session=s-1 turn=1 step=9 signals=C inj=i2 chars=302 tokens=210 files=2 worstEdits=1 worstStreak=1 worstErrors=0 searched=false measured=no',
    '2026-11-07T02:03:30.000Z outcome session=s-1 turn=1 inj=i2 after=C first=edit class=edit steps=2 before=ops_read_files',
    '2026-11-07T02:04:00.000Z inject session=s-2 turn=4 step=7 signals=B inj=i3 chars=302 tokens=205 files=0 worstEdits=0 worstStreak=0 worstErrors=2 searched=false measured=no sample="Error: boom"',
    '2026-11-07T02:04:20.000Z outcome session=s-2 turn=4 inj=i3 after=B first=web_search class=search steps=0 before=edit',
    '2026-11-07T02:04:25.000Z change session=s-2 turn=4 inj=i3 after=B tool=web_search class=search steps=3',
    '2026-11-07T02:04:26.000Z measure session=s-2 turn=4 tool=ops_bash ok=false exit=1 cleared=0'
  ].join('\n')
  const a = aggregate(parseLog(text), { logFile: 'C:/x.log', exists: true, bytes: text.length })
  check(
    '聚合：次数/会话/信号分布',
    a.injects.total === 3 && a.injects.sessions === 2 && a.injects.turns === 2 &&
      a.injects.bySignal.A === 1 && a.injects.bySignal.B === 1 && a.injects.bySignal.C === 1 &&
      a.injects.chars === 305 + 302 + 302 && a.injects.tokens === 200 + 210 + 205,
    `${a.injects.total} 次 / ${a.injects.sessions} 会话 / A${a.injects.bySignal.A} B${a.injects.bySignal.B} C${a.injects.bySignal.C}`
  )
  check(
    '聚合：提示后首个动作（描述性，不叫 changed）',
    a.firstAction.reported === 3 && a.firstAction.silent === 0 &&
      a.firstAction.byClass.verify === 1 && a.firstAction.byClass.search === 1 && a.firstAction.byClass.edit === 1 &&
      a.firstAction.byTool.ops_bash === 1 && a.firstAction.byTool.web_search === 1,
    JSON.stringify(a.firstAction.byClass)
  )
  check(
    '聚合：窗口内转向率与中位步数（只从 change 算）',
    a.turned.observed === 3 && a.turned.total === 2 &&
      a.turned.byClass.verify === 1 && a.turned.byClass.search === 1 &&
      Math.abs(a.turned.rate - 2 / 3) < 1e-9 && a.turned.medianSteps === 2,
    `observed=${a.turned.observed} turned=${a.turned.total} median=${a.turned.medianSteps}`
  )
  check(
    '聚合：测量统计把失败也算进回路',
    a.measures.total === 2 && a.measures.ok === 1 && a.measures.failed === 1 && a.measures.cleared === 1,
    `ok=${a.measures.ok} failed=${a.measures.failed} cleared=${a.measures.cleared}`
  )
  check(
    '聚合：阈值与预算取最后一条 apply',
    a.thresholds.A === 3 && a.thresholds.B === 2 && a.thresholds.C === 3 && a.budget === 3 && a.window === 6,
    JSON.stringify({ ...a.thresholds, budget: a.budget, window: a.window })
  )
  check(
    '聚合：只保留实测的注入开销，没有折算字段',
    a.estimate.injectionTokens === a.injects.tokens &&
      a.estimate.avoidedTokens === void 0 &&
      a.estimate.netTokens === void 0 &&
      a.estimate.assumedRoundtripTokens === void 0,
    `注入 ${a.estimate.injectionTokens} tok，keys=${Object.keys(a.estimate).join(',')}`
  )
  check('聚合：技能路径取最后一条', a.log.skills === 1 && a.log.skillPath.includes('SKILL.md'), a.log.skillPath)
  check(
    '聚合：旧字段名不得复活（changed / changedRate / outcomes）',
    a.outcomes === void 0 && a.firstAction.changed === void 0 && a.firstAction.changedRate === void 0,
    `keys=${Object.keys(a).join(',')}`
  )
}

// ── 4b. 方案层信号（F/O/P/M）与 futile 行：解析、聚合、旧日志兼容
//
// 这一层的数据形状是新增的，面板最容易在这里悄悄漏掉一条：
// bySignal 少一个键，那条信号在条形图上就永远是 0（看起来像「从没响过」）。
{
  const fLine = parseLine(
    '2026-11-24T15:27:38.308Z inject session=s-1 turn=1 step=5 signals=F inj=36d335f2 chars=297 tokens=207 files=0 worstEdits=0 worstStreak=0 worstErrors=2 searched=false measured=no sample="TypeError: alpha is not a function"'
  )
  const mLine = parseLine(
    '2026-11-24T15:27:38.340Z inject session=s-1 turn=1 step=14 signals=M inj=9f9f9f9f chars=264 tokens=190 files=1 worstEdits=5 worstStreak=0 worstErrors=0 searched=false measured=no futile=2'
  )
  check('parseLine 认 signals=F（方案层信号照旧进同一形状）', fLine.kind === 'inject' && fLine.signals.includes('F'), fLine.signals)
  check('parseLine 认 signals=M 与 futile= 附加字段', mLine.kind === 'inject' && mLine.signals.includes('M'), mLine.signals)

  const futileLine = parseLine(
    '2026-11-24T15:27:38.330Z futile session=s-1 turn=1 inj=42aaa905 after=3 count=2 window=6'
  )
  check(
    'parseLine 认 futile（无效注入累计）',
    futileLine.kind === 'futile' && futileLine.count === 2 && futileLine.window === 6 && futileLine.inj === '42aaa905',
    JSON.stringify({ count: futileLine.count, window: futileLine.window })
  )

  const applyAdv = parseLine(
    '2026-11-24T15:27:38.307Z apply pid=20268 logFile=.tmp-samples.log A=3 B=2 C=3 budget=3 window=6 panel=true F=4/3 O=3 P=3 M=2/1'
  )
  check(
    'parseLine 认 apply 的方案层阈值',
    applyAdv.kind === 'apply' && applyAdv.family === '4/3' && applyAdv.oscillation === 3 &&
      applyAdv.patchChain === 3 && applyAdv.meta === '2/1',
    JSON.stringify({ F: applyAdv.family, O: applyAdv.oscillation, P: applyAdv.patchChain, M: applyAdv.meta })
  )

  const text = [
    '2026-11-24T15:00:00.000Z apply pid=1 logFile=C:/x.log A=3 B=2 C=3 budget=3 window=6 panel=true F=4/3 O=3 P=3 M=2/1',
    '2026-11-24T15:01:00.000Z inject session=s-1 turn=1 step=5 signals=F inj=i1 chars=297 tokens=207 files=0 worstEdits=0 worstStreak=0 worstErrors=2 searched=false measured=no',
    '2026-11-24T15:02:00.000Z inject session=s-1 turn=1 step=8 signals=O inj=i2 chars=235 tokens=204 files=1 worstEdits=7 worstStreak=0 worstErrors=0 searched=false measured=yes:ops_bash:fail',
    '2026-11-24T15:03:00.000Z inject session=s-2 turn=1 step=4 signals=P inj=i3 chars=242 tokens=197 files=1 worstEdits=3 worstStreak=0 worstErrors=0 searched=false measured=yes:ops_bash:fail',
    '2026-11-24T15:04:00.000Z inject session=s-2 turn=1 step=14 signals=M inj=i4 chars=264 tokens=190 files=1 worstEdits=5 worstStreak=0 worstErrors=0 searched=false measured=no futile=2',
    '2026-11-24T15:04:10.000Z futile session=s-2 turn=1 inj=42aaa905 after=3 count=1 window=6',
    '2026-11-24T15:04:20.000Z futile session=s-2 turn=1 inj=42aaa905 after=9 count=2 window=6'
  ].join('\n')
  const a = aggregate(parseLog(text), { logFile: 'C:/x.log', exists: true, bytes: text.length })
  check(
    '聚合：bySignal 覆盖 F/O/P/M 四条（少一个键就是面板上永远为 0）',
    a.injects.bySignal.F === 1 && a.injects.bySignal.O === 1 && a.injects.bySignal.P === 1 && a.injects.bySignal.M === 1 &&
      a.injects.bySignal.A === 0 && a.injects.bySignal.B === 0 && a.injects.bySignal.C === 0,
    JSON.stringify(a.injects.bySignal)
  )
  check(
    '聚合：方案层阈值来自最后一条 apply',
    a.advanced.family === '4/3' && a.advanced.oscillation === 3 &&
      a.advanced.patchChain === 3 && a.advanced.meta === '2/1',
    JSON.stringify(a.advanced)
  )
  check(
    '聚合：futile 行计数与最近一次累计值',
    a.futile.total === 2 && a.futile.bySession['s-2'] === 2 && a.futile.lastCount === 2,
    JSON.stringify(a.futile)
  )

  // 老日志（v0.2.x）没有 F=/O=/P=/M= 也没有 futile 行：阈值必须是空串 / 0，不能瞎补默认值。
  const legacy = aggregate(
    parseLog('2026-11-07T02:00:00.000Z apply pid=1 logFile=C:/x.log A=3 B=2 C=3 budget=3 window=6 panel=true'),
    { logFile: 'C:/x.log', exists: true, bytes: 80 }
  )
  check(
    '聚合：老 apply 行没有方案层字段时不编造阈值',
    legacy.advanced.family === '' && legacy.advanced.oscillation === 0 &&
      legacy.advanced.patchChain === 0 && legacy.advanced.meta === '' &&
      legacy.futile.total === 0 && legacy.futile.lastCount === 0,
    JSON.stringify(legacy.advanced) + ' ' + JSON.stringify(legacy.futile)
  )
}

// ── 5. 空日志与坏行不能让面板炸
{
  const a = aggregate(parseLog(''), { logFile: '', exists: false, bytes: 0 })
  const bad = parseLog('完全不是日志的一行\n\n2026-11-07T02:00:00.000Z inject session=s turn=1')
  check(
    '空日志：不炸，转向率为 null',
    a.injects.total === 0 && a.firstAction.reported === 0 && a.turned.rate === null && a.turned.medianSteps === null,
    `total=${a.injects.total}`
  )
  check('坏行：跳过而不是抛', bad.length === 2 && bad[0].kind === 'other', `records=${bad.length}`)
  check('缺失文件：exists=false', readAggregate('', {}).log.exists === false)
}

// ── 5b. 埋点上线前的老日志：不能说成「0% 转向」
// v0.1 的 inject 行没有 inj=，也就不可能有 change/measure 行。
// 这时「转向 0 次」是「没测」，不是「测了没有」——rate 必须是 null 而不是 0。
{
  const legacy = [
    '2026-11-07T02:00:00.000Z apply pid=1 logFile=C:/x.log A=3 B=2 C=3',
    '2026-11-07T02:02:00.000Z inject session=s-1 turn=1 step=3 signals=C chars=254 files=1 worstEdits=1 worstStreak=1 worstErrors=0 searched=false',
    '2026-11-07T02:02:10.000Z outcome session=s-1 turn=1 after=C first=ops_bash class=verify steps=0',
    '2026-11-07T02:03:00.000Z inject session=s-1 turn=1 step=9 signals=C chars=254 files=2 worstEdits=1 worstStreak=1 worstErrors=0 searched=false',
    '2026-11-07T02:03:20.000Z outcome session=s-1 turn=1 after=C first=edit class=edit steps=0'
  ].join('\n')
  const a = aggregate(parseLog(legacy), { logFile: 'C:/x.log', exists: true, bytes: legacy.length })
  check(
    '老日志（无 inj=）：转向率是 null 而不是 0，且 observed=0',
    a.injects.total === 2 &&
      a.turned.observed === 0 &&
      a.turned.total === 0 &&
      a.turned.rate === null &&
      a.measures.total === 0,
    `observed=${a.turned.observed} rate=${a.turned.rate}`
  )
  // 但「提示后首个动作」在 v0.1 就有 outcome 行，那部分照常算。
  check(
    '老日志：outcome 仍可统计（这部分 v0.1 就有）',
    a.firstAction.reported === 2 && a.firstAction.byClass.verify === 1 && a.firstAction.byClass.edit === 1,
    JSON.stringify(a.firstAction.byClass)
  )
}

// ── 6. token 折算：CJK 1:1，ASCII 约三分之一
{
  const zh = estimateTokens('卡住闸门')
  const en = estimateTokens('abcdefghij')
  check('estimateTokens 中英分别计', zh === 4 && en > 0 && en < 10, `zh=${zh} en=${en}`)
}

// ── 7. 端到端埋点：真跑一次 apply，注入后的行必须全都落盘且能串起来
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
  // 注入后：一次真测量（命令命中判据）+ 它的结果
  await ctx.emitPlain('session/event', session, {
    type: 'tool/call',
    data: { turn: 1, step: 5, callId: 'c1', name: 'ops_bash', arguments: { command: 'npm test' } }
  })
  await ctx.emitPlain('session/event', session, {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 5,
      message: {
        id: 'm-c1',
        role: 'tool',
        toolCallId: 'c1',
        isError: false,
        source: { kind: 'tool', callId: 'c1' },
        content: [{ type: 'text', text: '[exit code: 1]' }]
      }
    }
  })
  await ctx.emitPlain('session/event', session, { type: 'turn/end', data: { turn: 1 } })

  // 等条件，不等时长（见文件顶部 readLogWhenReady 的注释）。
  const ready = await readLogWhenReady(logFile, ['apply', 'inject', 'outcome', 'change', 'measure'])
  const text = ready.text
  if (ready.missing.length > 0) {
    console.log(
      `  [注意] 等了 ${ready.waited}ms 仍有行型没落盘：${ready.missing.join(', ')}` +
        '（下面相关断言会照实失败，缺口在这里而不是在断言里）'
    )
  }
  const records = parseLog(text)
  const inject = records.find((r) => r.kind === 'inject')
  const outcome = records.find((r) => r.kind === 'outcome')
  const measured = records.find((r) => r.kind === 'measure')
  const change = records.find((r) => r.kind === 'change')
  check(
    '埋点：注入行带 chars= 与 inj=',
    inject !== void 0 && inject.chars > 0 && inject.inj.length > 0 && inject.signals.includes('A'),
    inject ? `chars=${inject.chars} inj=${inject.inj}` : 'no inject line'
  )
  check(
    '埋点：首个 tool/call 写出 outcome，且带 inj 与 before',
    outcome !== void 0 && outcome.first === 'ops_bash' && outcome.cls === 'verify' &&
      outcome.after === 'A' && outcome.inj === inject?.inj &&
      // 上一动作是「写入」本身（走 fs/write-intent，没有对应的 tool/call），
      // 不能变成 '-' —— 否则面板没法说「从改转到了测」。
      outcome.before === 'write' &&
      outcome.steps === 5 - injectedAt,
    outcome ? `${outcome.cls}/${outcome.first} steps=${outcome.steps} before=${outcome.before}` : 'no outcome line'
  )
  check(
    '埋点：测量结果行写出 ok/exit/cleared（失败也是测量）',
    measured !== void 0 && measured.ok === false && measured.exit === 1 && measured.cleared >= 1,
    measured ? `ok=${measured.ok} exit=${measured.exit} cleared=${measured.cleared}` : 'no measure line'
  )
  check(
    '埋点：窗口内转向写出 change 行',
    change !== void 0 && change.after === 'A' && change.tool === 'ops_bash' && change.steps === 5 - injectedAt,
    change ? `${change.tool} steps=${change.steps}` : 'no change line'
  )
  const a = aggregate(records, { logFile, exists: true, bytes: text.length })
  check(
    '埋点：聚合把这次算成「窗口内转向 1 次」',
    a.firstAction.reported === 1 && a.firstAction.byClass.verify === 1 &&
      a.turned.total === 1 && a.turned.rate === 1 && a.measures.total === 1 && a.measures.failed === 1,
    `turned=${a.turned.total} measures=${a.measures.total}`
  )

  // 慢盘那一轮（test:slow）要能证明「这条防线真在位」：如果 resolve hook 没生效，
  // 插件拿到的是真 appendFile，计数器为 0，于是「等条件」有没有生效根本无从判断。
  // 普通轮里这个 symbol 不存在 → 记为「不适用」，不冒充通过。
  const slow = globalThis[Symbol.for('better-debug.test.slow')]
  if (slow !== void 0) {
    check(
      '慢盘轮：appendFile 替身确实被插件用到（不是在测空气）',
      slow.count > 0,
      `slowAppends=${slow.count} delay=${slow.delay}ms`
    )
  }

  try {
    rmSync(logFile, { force: true })
  } catch {}
}

// ── 8. A 的判据字段必须全链路活下来
{
  const text = [
    '2026-11-11T00:00:00.000Z inject session=s-1 turn=1 step=4 signals=A inj=j1 chars=305 files=1 worstEdits=3 worstStreak=3 worstErrors=0 searched=false measured=no',
    '2026-11-11T00:00:01.000Z inject session=s-2 turn=1 step=4 signals=A inj=j2 chars=305 files=1 worstEdits=3 worstStreak=1 worstErrors=0 searched=false measured=no'
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

// ── 9. done-state 的 suppress 行要能被面板读出来（醒着但故意不出声 ≠ 没挂上）
{
  const text = [
    '2026-11-11T00:00:00.000Z apply pid=1 logFile=C:/x.log A=3 B=2 C=3 budget=3 window=6 panel=true',
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

// ── 10. arm 行：解释「改了几处为什么没提醒」，且不计入触发
//
// 字段是 writes=（盲改次数），不是旧的 gap=（距上次改的步数）：gap 恒等于阈值，
// 说明它数的是步而不是盲改，那正是 C 误报的根因（0.3.5 换轴）。
{
  const text = [
    '2026-11-11T00:00:00.000Z arm session=s-1 turn=1 step=9 writes=3',
    '2026-11-11T00:00:01.000Z arm session=s-1 turn=1 step=10 writes=5'
  ].join('\n')
  const a = aggregate(parseLog(text), { logFile: '', exists: true, bytes: text.length })
  check('arm 行计数，不算注入', a.log.arms === 2 && a.injects.total === 0, `arms=${a.log.arms}`)
}

// ── 11. 面板挂载失败要能被看见（不能静默）
{
  const text = '2026-11-11T00:00:00.000Z panel register failed: duplicate prefix route'
  const a = aggregate(parseLog(text), { logFile: '', exists: true, bytes: text.length })
  check('panel register failed 被计入', a.log.panelFailed === 1, `panelFailed=${a.log.panelFailed}`)
  // 没有 apply 行也没有 disabled 行 = 日志里没有世代分界（残缺片段）。
  // 失败照实计入，但要标记 markers=0，面板据此说「无法判断当前世代」，
  // 而不是冒充「现在健康」——也不冒充「现在坏了」。
  check(
    '没有世代分界时 markers=0，面板不冒充判断',
    a.log.current.panelFailed === 1 && a.log.current.markers === 0 && a.log.current.since === '',
    `current=${JSON.stringify(a.log.current)}`
  )
}

// ── 11b. 世代分界：历史里挂过，最后一次 apply 之后是干净的 → 横幅不该亮
{
  const text = [
    '2026-11-07T04:34:36.011Z panel register failed: cannot get property "webServer" without inject',
    '2026-11-07T05:00:36.666Z panel register failed: webserver: duplicate prefix route "/better-debug"',
    '2026-11-07T05:01:51.152Z panel register failed: webserver: duplicate prefix route "/better-debug"',
    '2026-11-14T00:44:41.005Z disabled by config, no gate installed',
    '2026-11-14T11:23:07.155Z apply pid=5596 logFile=C:/x.log A=3 B=2 C=3 budget=3 window=6 panel=true'
  ].join('\n')
  const a = aggregate(parseLog(text), { logFile: 'C:/x.log', exists: true, bytes: text.length })
  check(
    '历史上的失败不染红当前世代（全量仍留着）',
    a.log.disabled === 1 && a.log.panelFailed === 3 &&
      a.log.current.disabled === 0 && a.log.current.panelFailed === 0 &&
      a.log.current.scoped === undefined && a.log.current.markers === 2 &&
      a.log.current.since === '2026-11-14T11:23:07.155Z',
    `total=${a.log.disabled}/${a.log.panelFailed} current=${JSON.stringify(a.log.current)}`
  )
}

// ── 11c. 世代之内仍有失败 → current 必须亮（否则就是「修好了」的假绿）
{
  const text = [
    '2026-11-14T11:23:07.155Z apply pid=5596 logFile=C:/x.log A=3 B=2 C=3 budget=3 window=6 panel=true',
    '2026-11-14T11:23:09.000Z panel register failed: duplicate prefix route "/better-debug"',
    '2026-11-14T11:23:10.000Z skill register failed: duplicate skill name'
  ].join('\n')
  const a = aggregate(parseLog(text), { logFile: 'C:/x.log', exists: true, bytes: text.length })
  check(
    '当前世代内的失败会被计入 current',
    a.log.current.panelFailed === 1 && a.log.current.skillFailed === 1 && a.log.current.disabled === 0,
    `current=${JSON.stringify(a.log.current)}`
  )
}

// ── 11d. 页面本身必须真的按世代判断（否则后端算对了、界面还在报旧账）
// 后端修好而 HTML 仍读 lg.disabled 的回归，测试必须能抓住 —— 所以直接读页面源码断言。
{
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8')
  const usesCurrent = html.includes('lg.current') && html.includes('curDisabled')
  const noOldBranch = !/if\s*\(\s*lg\.disabled\s*\)/.test(html) && !/else if\s*\(\s*lg\.panelFailed\s*\)/.test(html)
  const hasStaleApiNote = html.includes('lg.current === undefined') && html.includes('这个页面比插件新')
  const hasNoBoundaryNote = html.includes('认不出是哪一次加载之后的记录')
  let scriptParses = false
  // 页面里现在有两个 <script>（主题判定 + 主脚本）。必须逐块解析：
  // 非贪婪 /<script>([\s\S]*?)<\/script>/g 逐块取，否则贪婪匹配会跨块
  // 把两段拼成一段，中间隔着 </script><script> 就必然语法错误 —— 那是
  // 断言写错，不是页面错。
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  if (blocks.length === 0) scriptParses = 'no <script> block'
  else {
    try {
      for (const block of blocks) {
        // 只做语法解析，不执行：避免页面脚本碰 document。
        new Function(block[1])
      }
      scriptParses = true
    } catch (error) {
      scriptParses = `${error?.message ?? error}`
    }
  }
  check('页面横幅读 log.current 而不是全量计数', usesCurrent, `usesCurrent=${usesCurrent}`)
  check('页面没有残留「按全量计数判红」的老分支', noOldBranch, `noOldBranch=${noOldBranch}`)
  check(
    '老 API（无 current 段）不静默变成绿灯，而是退回全量口径并说明',
    hasStaleApiNote,
    `hasStaleApiNote=${hasStaleApiNote}`
  )
  check('日志没有 apply 行时页面明说「不能当作现在健康」', hasNoBoundaryNote, `note=${hasNoBoundaryNote}`)
  check('每段内联脚本都能被解析（逐块，不执行）', scriptParses === true, `blocks=${blocks.length} parses=${scriptParses}`)
}

// ── 11e. 亮/暗两套调色板必须都在面板自己的文档里（iframe 里继承不到宿主的变量）
// 用户 2026-11-21 的反馈是「面板没有考虑暗色亮色模式」——那时面板的 :root 里写着
// var(--dsw-alias-text-primary, #e7ebf0) 之类，而宿主的真实名字是 --dsw-alias-label-primary；
// 名字全落空、回退值又是深色，于是在亮色模式下整块面板仍然是黑的。
// 这里直接读页面源码断言：两套都在、真有差异、不再引用宿主变量、样式规则区没有裸颜色。
{
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8')
  const styleStart = html.indexOf('<style>')
  const styleEnd = html.indexOf('</style>')
  const style = styleStart >= 0 && styleEnd > styleStart ? html.slice(styleStart + '<style>'.length, styleEnd) : ''

  const lightBlock = /:root\s*\{([\s\S]*?)\}/.exec(style)
  const darkBlock = /:root\[data-bd-scheme="dark"\]\s*\{([\s\S]*?)\}/.exec(style)
  const hasBoth = lightBlock !== null && darkBlock !== null
  const varsIn = (block) => {
    const map = new Map()
    if (block === null) return map
    for (const m of block[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) map.set(m[1], m[2].trim())
    return map
  }
  const light = varsIn(lightBlock)
  const dark = varsIn(darkBlock)
  const REQUIRED = ['--bg', '--card', '--card-border', '--fg', '--fg-dim', '--accent', '--bad', '--good']
  const bothDefine = REQUIRED.filter((name) => light.has(name) && dark.has(name))
  // 两套必须真的不一样：背景与正文色都相同就说明只是复制了一遍。
  // 同时要求两边都不是空集 —— 否则「空的 vs 空的」也会被算成「不同」。
  const differs =
    light.size > 0 &&
    dark.size > 0 &&
    light.get('--bg') !== dark.get('--bg') &&
    light.get('--fg') !== dark.get('--fg')

  // 亮度：正文色与背景的明暗关系必须相反，否则其中一套的对比度是反的。
  const luma = (value) => {
    const hex = /^#([0-9a-f]{6})$/i.exec(String(value ?? '').trim())
    if (hex === null) return null
    const n = parseInt(hex[1], 16)
    return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
  }
  const lightBg = luma(light.get('--bg'))
  const lightFg = luma(light.get('--fg'))
  const darkBg = luma(dark.get('--bg'))
  const darkFg = luma(dark.get('--fg'))
  const lightContrastOk = lightBg !== null && lightFg !== null && lightBg > 0.5 && lightFg < 0.5
  const darkContrastOk = darkBg !== null && darkFg !== null && darkBg < 0.5 && darkFg > 0.5

  // 不再引用宿主的变量名（它们在 iframe 里恒为空）。
  const hostVarRefs = [...style.matchAll(/var\(--dsw-[a-z0-9-]+/gi)].length
  // 样式规则区不该有裸颜色：允许出现的位置只有变量定义行。
  const withoutVars = style.replace(/:root\s*\{[\s\S]*?\}/g, '').replace(/:root\[data-bd-scheme="dark"\]\s*\{[\s\S]*?\}/g, '')
  const strayColors = withoutVars.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) ?? []

  // color-scheme 两套都该声明，否则滚动条/表单控件不跟随。
  const lightScheme = /color-scheme:\s*light/.test(style)
  const darkScheme = /color-scheme:\s*dark/.test(style)

  // 主题属性的取值域只能是 light / dark：脚本里 setAttribute 的第二个参数
  // 必须来自 hostScheme()/systemScheme()，而那两个函数只返回这两个字符串。
  const setsSchemeAttr = html.includes("setAttribute('data-bd-scheme'")
  const returnsOnlyTwo = (() => {
    const fnNames = ['hostScheme', 'systemScheme']
    for (const name of fnNames) {
      const body = new RegExp(`function ${name}\\(\\)\\s*\\{([\\s\\S]*?)\\n  \\}`).exec(html)
      if (body === null) return false
      const returns = [...body[1].matchAll(/return\s+'([^']*)'/g)].map((m) => m[1])
      if (returns.length === 0) return false
      if (returns.some((v) => v !== 'dark' && v !== 'light')) return false
    }
    return true
  })()
  const onlyTwoStates = returnsOnlyTwo

  check('面板自带亮/暗两套调色板，关键变量两边都定义', hasBoth && bothDefine.length === REQUIRED.length,
    `blocks=${hasBoth} defined=${bothDefine.length}/${REQUIRED.length}` +
      (bothDefine.length === REQUIRED.length ? '' : ` missing=${REQUIRED.filter((n) => !bothDefine.includes(n)).join(',')}`))
  check('两套不是复制的：背景与正文色都不同', differs,
    `light bg=${light.get('--bg')} fg=${light.get('--fg')} / dark bg=${dark.get('--bg')} fg=${dark.get('--fg')}`)
  check('亮色是深字浅底、暗色是浅字深底（对比度方向没反）', lightContrastOk && darkContrastOk,
    `light ${lightBg}->${lightFg} ok=${lightContrastOk} / dark ${darkBg}->${darkFg} ok=${darkContrastOk}`)
  check('面板不再引用宿主变量（iframe 里继承不到）', hostVarRefs === 0, `hostVarRefs=${hostVarRefs}`)
  check('样式规则区没有裸颜色字面量（全走变量）', strayColors.length === 0,
    `stray=${strayColors.length ? strayColors.slice(0, 6).join(' ') : 'none'}`)
  check('两套都声明 color-scheme（滚动条/表单控件跟随）', lightScheme && darkScheme,
    `light=${lightScheme} dark=${darkScheme}`)
  check('主题属性只有 light/dark 两态，且由脚本设置', setsSchemeAttr && onlyTwoStates,
    `sets=${setsSchemeAttr} onlyTwo=${onlyTwoStates}`)
  check('主题脚本写明「读宿主文档」而不是读自己（iframe 边界的根因）', html.includes('hostDocument') && html.includes('data-ds-dark-theme'),
    `hostDocument=${html.includes('hostDocument')} attr=${html.includes('data-ds-dark-theme')}`)
}

// ── 11f. 页面把七条信号都画出来，方案层阈值与 futile 也有位置
// 只测数据形状不够：bySignal 有 F，页面却只画 A/B/C 的话，
// 面板上那条信号永远显示 0，看起来就像「这层闸门从没生效」。
{
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8')
  const styleStart = html.indexOf('<style>')
  const styleEnd = html.indexOf('</style>')
  const style = styleStart >= 0 && styleEnd > styleStart ? html.slice(styleStart + '<style>'.length, styleEnd) : ''
  const lightBlock = /:root\s*\{([\s\S]*?)\}/.exec(style)
  const darkBlock = /:root\[data-bd-scheme="dark"\]\s*\{([\s\S]*?)\}/.exec(style)
  const varsIn = (block) => {
    const map = new Map()
    if (block === null) return map
    for (const m of block[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) map.set(m[1], m[2].trim())
    return map
  }
  const light = varsIn(lightBlock)
  const dark = varsIn(darkBlock)

  const signalBars = (() => {
    // 从 `var bs = inj.bySignal` 起切：分母 total 写在 innerHTML 之前，
    // 只从 innerHTML 起切会把分母漏掉，断言就变成「找不到 total」的假红。
    const start = html.indexOf('var bs = inj.bySignal')
    if (start < 0) return ''
    const end = html.indexOf("$('advanced-bars')", start)
    return end > start ? html.slice(start, end) : html.slice(start, start + 2500)
  })()
  const drawn = ['A', 'B', 'C', 'F', 'O', 'P', 'M'].filter((kind) => signalBars.includes('bs.' + kind))
  check('页面画出七条信号（少画一条，那层闸门就永远显示 0）', drawn.length === 7, `drawn=${drawn.join('')}`)

  // 分母那行是 `var total = Math.max(1, (bs.A || 0) + …)`：里面有嵌套括号，
  // 用 `[^)]*` 截会只拿到第一个 `(bs.A || 0)`，所以按整行取。
  const totalLine = signalBars.split('\n').find((line) => line.includes('var total = Math.max(1,')) ?? null
  const totalCovers = ['A', 'B', 'C', 'F', 'O', 'P', 'M'].every(
    (kind) => totalLine !== null && totalLine.includes('bs.' + kind)
  )
  check('条形图分母把这七条都算进去（否则某条会超过 100%）', totalCovers, totalLine ? totalLine.trim().slice(0, 60) : 'no total')

  const advanced = (() => {
    const start = html.indexOf("$('advanced-bars').innerHTML")
    if (start < 0) return ''
    return html.slice(start, start + 2500)
  })()
  const advKeys = ['adv.family', 'adv.oscillation', 'adv.patchChain', 'adv.meta', 'fut.total'].filter((k) =>
    advanced.includes(k)
  )
  check(
    '页面有方案层阈值与 futile 累计的位置',
    advKeys.length === 5 && html.includes('id="advanced-bars"') && html.includes('id="advanced-note"'),
    `keys=${advKeys.join(',')}`
  )

  const tagVars = ['--tag-f-bg', '--tag-f-fg', '--tag-o-bg', '--tag-o-fg', '--tag-p-bg', '--tag-p-fg', '--tag-m-bg', '--tag-m-fg']
  const tagsBoth = tagVars.filter((name) => light.has(name) && dark.has(name))
  check(
    'F/O/P/M 的标签配色亮暗两套都有（否则暗色下标签看不见）',
    tagsBoth.length === tagVars.length,
    `defined=${tagsBoth.length}/${tagVars.length}` +
      (tagsBoth.length === tagVars.length ? '' : ` missing=${tagVars.filter((n) => !tagsBoth.includes(n)).join(',')}`)
  )

  const tagRules = ['.tag.F', '.tag.O', '.tag.P', '.tag.M'].filter((rule) => style.includes(rule + ' {'))
  check('F/O/P/M 的标签样式规则都在', tagRules.length === 4, `rules=${tagRules.join(',')}`)

  // 方案层四条用 f/e/d/g 四个填充色，和 A/B/C 的 a/b/c 不能撞色
  const fills = ['f', 'e', 'd', 'g'].filter((name) => light.has('--fill-' + name) && dark.has('--fill-' + name))
  check('方案层四条条形各有自己的填充色（亮暗两套）', fills.length === 4, `fills=${fills.join('')}`)
}

// ── 12. 转向率必须按 inj= 关联注入，不能数行数（否则 >100% / silent 为负）
{
  const lines = []
  for (let i = 0; i < 3; i += 1) {
    lines.push('2026-11-11T00:00:0' + i + '.000Z inject session=s-1 turn=' + (i + 1) + ' step=1 signals=C inj=j' + i + ' chars=100 tokens=25 files=0 worstEdits=0 worstStreak=0 worstErrors=0 searched=false measured=no')
  }
  // 一次注入在窗口内每一步都结算一次：同一个 inj 出现 4 次 outcome、5 次 change。
  for (let i = 0; i < 4; i += 1) {
    lines.push('2026-11-11T00:01:0' + i + '.000Z outcome session=s-1 turn=1 inj=j0 after=C first=bash class=shell steps=' + i)
  }
  lines.push('2026-11-11T00:01:09.000Z outcome session=s-1 turn=2 inj=j1 after=C first=bash class=shell steps=0')
  for (let i = 0; i < 5; i += 1) {
    lines.push('2026-11-11T00:02:0' + i + '.000Z change session=s-1 turn=1 inj=j1 after=C first=verify class=verify steps=' + i)
  }
  const text = lines.join('\n')
  const a = aggregate(parseLog(text), { logFile: '', exists: true, bytes: text.length })
  check(
    '转向率按 inj= 去重关联：rate ≤ 100% 且 silent ≥ 0',
    a.turned.rate !== null && a.turned.rate <= 1 && a.firstAction.silent >= 0 &&
      a.turned.total === 1 && a.firstAction.reported === 2,
    'rate=' + a.turned.rate + ' silent=' + a.firstAction.silent + ' turned=' + a.turned.total + ' reported=' + a.firstAction.reported
  )
  check(
    '三条注入里两条有 outcome、一条没有 → reported=2 / silent=1',
    a.firstAction.reported === 2 && a.firstAction.silent === 1,
    'reported=' + a.firstAction.reported + ' silent=' + a.firstAction.silent
  )
}

// ── 13. 没有 apply 行时，阈值/预算/窗口必须回退到**配置对象本身**的键名
{
  const text = '2026-11-11T00:00:00.000Z inject session=s-1 turn=1 step=1 signals=A inj=j1 chars=100 tokens=25 files=0 worstEdits=3 worstStreak=3 worstErrors=0 searched=false measured=no'
  // registerPanel 传的是整个 cfg：键名是配置项原名，不是 A/B/C。
  const cfg = { repeatEditThreshold: 4, repeatErrorThreshold: 5, noVerifyWrites: 6, maxInjectsPerTurn: 7, changedWindow: 8 }
  const a = aggregate(parseLog(text), { logFile: '', exists: true, bytes: text.length, thresholds: cfg })
  check(
    '无 apply 行时阈值回退认配置原名（A/B/C 过去恒为 0）',
    a.thresholds.A === 4 && a.thresholds.B === 5 && a.thresholds.C === 6,
    'thresholds=' + JSON.stringify(a.thresholds)
  )
  check(
    '无 apply 行时预算/窗口回退认 maxInjectsPerTurn / changedWindow',
    a.budget === 7 && a.window === 8,
    'budget=' + a.budget + ' window=' + a.window
  )
  // 反面：显式给 A/B/C 的调用方仍然优先，别被配置键名抢走。
  const b = aggregate(parseLog(text), { logFile: '', exists: true, bytes: text.length, thresholds: { A: 2, B: 3, C: 4, repeatEditThreshold: 9 } })
  check(
    '显式 A/B/C 优先于同名的配置键',
    b.thresholds.A === 2 && b.thresholds.B === 3 && b.thresholds.C === 4,
    'thresholds=' + JSON.stringify(b.thresholds)
  )
}

// ── 14. registerPanel 真跑一次：路由注册、HTML、API、404、热重载摘路由
//
// 过去这一段完全没有测试：sim.mjs 的假 ctx 在 webServer 缺失时让 ctx.inject 什么都不做，
// 于是 registerPanel 那 63 行在 CI 里从未被执行过 —— 它坏了没有任何信号。
// 这里直接调用它，用一个假 webServer（register 收集路由 + prefixes 是真 Map），
// 再把 handler 当普通函数调，喂进伪造的 req/res。
{
  const routes = []
  const prefixes = new Map()
  const effects = []
  const ctx = {
    webServer: {
      prefixes,
      register(route) {
        routes.push(route)
        prefixes.set(route.path, route)
        return () => {
          const at = routes.indexOf(route)
          if (at >= 0) routes.splice(at, 1)
          prefixes.delete(route.path)
        }
      }
    },
    effect(run, label) {
      effects.push({ label, dispose: run() })
    }
  }
  const cfg = { logFile: '', repeatEditThreshold: 3, repeatErrorThreshold: 2, noVerifyWrites: 2, maxInjectsPerTurn: 3, changedWindow: 6 }
  const dispose = registerPanel(ctx, () => cfg)
  check(
    'registerPanel: 注册了 /better-debug 前缀路由，且返回 disposer',
    routes.length === 1 && routes[0].path === '/better-debug' && routes[0].kind === 'prefix' && typeof dispose === 'function',
    'routes=' + routes.map((r) => r.kind + ':' + r.path).join(',')
  )
  check(
    'registerPanel: 路由交给 ctx.effect 管生命周期（热重载能摘）',
    effects.length === 1 && effects[0].label === 'better-debug.panel-route' && typeof effects[0].dispose === 'function',
    'effects=' + effects.map((e) => e.label).join(',')
  )

  // 假的 req/res：res 只记状态码、头与 body。
  const call = async (path) => {
    const out = { status: 0, headers: {}, body: '' }
    const res = {
      writeHead(status, headers) {
        out.status = status
        out.headers = headers ?? {}
      },
      end(body) {
        out.body = String(body ?? '')
      }
    }
    await routes[0].handler({ url: path }, res)
    return out
  }

  const page = await call('/better-debug/index.html')
  check(
    'registerPanel: /better-debug/index.html 返回真实页面（不是 404 空框）',
    page.status === 200 && page.body.includes('<html') && page.body.length > 2000,
    'status=' + page.status + ' bytes=' + page.body.length
  )
  check(
    'registerPanel: 页面禁用缓存（否则面板会一直显示旧数据）',
    page.headers['cache-control'] === 'no-store',
    'cache-control=' + page.headers['cache-control']
  )
  // 面板页是纯内联（无 src= / href= / @import / url()），CSP 该收到最紧一档；
  // nosniff 防 /better-debug/api 的 JSON 被嗅探成 HTML 执行（响应体里有会话 id 与报错样本）。
  const csp = page.headers['content-security-policy'] ?? ''
  check(
    'registerPanel: 页面带 CSP 且关掉外部资源（default-src none + 内联 style/script + connect-src self）',
    csp.includes("default-src 'none'") &&
      csp.includes("script-src 'unsafe-inline'") &&
      csp.includes("style-src 'unsafe-inline'") &&
      csp.includes("connect-src 'self'"),
    'csp=' + csp
  )
  check(
    'registerPanel: 页面与 API 都带 nosniff（JSON 不能被当 HTML 嗅探执行）',
    page.headers['x-content-type-options'] === 'nosniff',
    'page nosniff=' + page.headers['x-content-type-options']
  )

  const api = await call('/better-debug/api')
  let parsed
  try {
    parsed = JSON.parse(api.body)
  } catch {
    parsed = void 0
  }
  check(
    'registerPanel: /better-debug/api 返回可解析的 JSON 聚合（日志不存在也不炸）',
    api.status === 200 && parsed !== void 0 && parsed.log?.exists === false && parsed.thresholds?.A === 3,
    'status=' + api.status + ' exists=' + parsed?.log?.exists + ' A=' + parsed?.thresholds?.A
  )
  check(
    'registerPanel: API 的阈值来自 getConfig()（不是写死的默认）',
    parsed?.thresholds?.B === 2 && parsed?.thresholds?.C === 2 && parsed?.budget === 3 && parsed?.window === 6,
    'B=' + parsed?.thresholds?.B + ' budget=' + parsed?.budget + ' window=' + parsed?.window
  )

  const raw = await call('/better-debug/api?raw=1')
  check(
    'registerPanel: raw=1 走另一条分支（面板用来判断后端版本）',
    raw.status === 200 && raw.body.includes('\"version\": 3'),
    'status=' + raw.status
  )

  const miss = await call('/better-debug/nope')
  check(
    'registerPanel: 未匹配的路径回 404 JSON，不是 HTML',
    miss.status === 404 && miss.body.includes('not-found') && miss.headers['content-type'].includes('application/json'),
    'status=' + miss.status
  )

  // 热重载：第二次注册必须把上一代的路由摘掉，否则 prefixes 里会堆同名路由。
  registerPanel(ctx, () => cfg)
  check(
    'registerPanel: 第二次注册摘掉上一代路由（热重载不堆叠）',
    routes.length === 1 && prefixes.size === 1,
    'routes=' + routes.length + ' prefixes=' + prefixes.size
  )
  // 再模拟「上一代没记 disposer」的旧版本：手塞一条陈旧路由进 prefixes。
  // 新代码必须先删同名 key 再注册，否则路由表里会同时存在新旧两条 handler。
  const stale = { kind: 'prefix', path: '/better-debug', handler: async () => 'stale' }
  prefixes.set('/better-debug', stale)
  registerPanel(ctx, () => cfg)
  check(
    'registerPanel: 上一代没留 disposer 时也能从 prefixes 里删掉同名路由',
    prefixes.size === 1 && prefixes.get('/better-debug') !== stale,
    'prefixes=' + prefixes.size + ' replaced=' + (prefixes.get('/better-debug') !== stale)
  )
}

// ── 14b. 面板路由的准入闸
//
// webServer.register 只负责路由，鉴权要插件自己调 connection.requestRejection ——
// dsh-host-open-in-app 与 dsh-experimental-inspector 都这么做。少了这一步，面板就成了
// 整条 web 面上唯一不要凭证的路径：2026-11-26 实测本机 dsh web 被 relay 暴露到公网后，
// `https://<instance>.dsh-market.com/` 是 401，而 `/better-debug/api` 是 200，
// 返回真实会话 id、报错样本与日志绝对路径。
{
  // 假 connection：只实现 requestRejection，按请求上带的 cookie 头决定拒绝码。
  const makeCtx = (requestRejection) => {
    const routes = []
    const prefixes = new Map()
    const services = new Map()
    if (requestRejection !== void 0) services.set('connection', { requestRejection })
    return {
      webServer: {
        prefixes,
        register(route) {
          routes.push(route)
          prefixes.set(route.path, route)
          return () => { routes.splice(routes.indexOf(route), 1); prefixes.delete(route.path) }
        }
      },
      get(name) {
        return services.get(name)
      },
      effect(run) {
        run()
      },
      routes
    }
  }

  const callWith = async (route, req) => {
    const out = { status: 0, headers: {}, body: '' }
    const res = {
      writeHead(status, headers) {
        out.status = status
        out.headers = headers ?? {}
      },
      end(body) {
        out.body = String(body ?? '')
      }
    }
    await route.handler(req, res)
    return out
  }

  // 有 connection 服务：宿主说 401 就必须 401，且不能泄漏面板内容。
  const guarded = makeCtx((req) => (req.headers?.cookie === 'ok' ? 0 : 401))
  registerPanel(guarded, () => ({ logFile: '' }))
  const route = guarded.routes[0]
  const denied = await callWith(route, { url: '/better-debug/api', headers: {} })
  check(
    '面板准入: 无凭证时 /better-debug/api 回 401，不返回任何日志内容',
    denied.status === 401 && denied.body === 'authentication required',
    'status=' + denied.status + ' body=' + denied.body
  )
  check(
    '面板准入: 401 响应体是纯文本且带 nosniff（拒绝页也不许被嗅探执行）',
    denied.headers['content-type'].includes('text/plain') && denied.headers['x-content-type-options'] === 'nosniff',
    'type=' + denied.headers['content-type'] + ' nosniff=' + denied.headers['x-content-type-options']
  )
  const pageDenied = await callWith(route, { url: '/better-debug/index.html', headers: {} })
  check(
    '面板准入: 页面同样要过闸（不能只挡 API 放行 HTML）',
    pageDenied.status === 401 && !pageDenied.body.includes('<html'),
    'status=' + pageDenied.status + ' bytes=' + pageDenied.body.length
  )
  const allowed = await callWith(route, { url: '/better-debug/api?raw=1', headers: { cookie: 'ok' } })
  check(
    '面板准入: 宿主放行时照常返回（闸不改变正常路径）',
    allowed.status === 200,
    'status=' + allowed.status
  )

  // Host/Origin 不合规：宿主回 403，body 也要区分开。
  const forbidden = makeCtx(() => 403)
  registerPanel(forbidden, () => ({ logFile: '' }))
  const blocked = await callWith(forbidden.routes[0], { url: '/better-debug/api', headers: { host: 'evil.example' } })
  check(
    '面板准入: 宿主判 403 时回 forbidden（与 401 区分，便于排查是 Host 还是 cookie）',
    blocked.status === 403 && blocked.body === 'forbidden',
    'status=' + blocked.status + ' body=' + blocked.body
  )

  // 没有 connection 服务（headless profile、单测假 ctx）：恒放行，面板仍可用。
  const bare = makeCtx(void 0)
  registerPanel(bare, () => ({ logFile: '' }))
  const open = await callWith(bare.routes[0], { url: '/better-debug/api?raw=1', headers: {} })
  check(
    '面板准入: 没有 connection 服务时恒放行（headless profile 不被自家闸关掉）',
    open.status === 200,
    'status=' + open.status
  )
  check(
    '面板准入: 服务缺 requestRejection 方法时也恒放行（不因宿主版本差异炸掉面板）',
    createRequestGate({ get: () => ({}) })({}) === 0,
    'gate=' + createRequestGate({ get: () => ({}) })({})
  )
  // 服务晚到：注册时 connection 还不存在，请求时才起来 —— 闸必须那时才读，
  // 否则会永久退化成恒放行（没有任何信号）。
  const late = new Map()
  const lateCtx = { get: (name) => late.get(name) }
  const lateGate = createRequestGate(lateCtx)
  const before = lateGate({ headers: {} })
  late.set('connection', { requestRejection: () => 401 })
  const after = lateGate({ headers: {} })
  check(
    '面板准入: connection 服务晚于面板注册就绪时，闸在请求时才读、仍然生效',
    before === 0 && after === 401,
    'before=' + before + ' after=' + after
  )
}

// ── 15. createLogWriter：轮转、最老一份被丢弃、目录只 mkdir 一次（P1-10 / A12）
{
  const base = join(tmpdir(), 'better-debug-writer-' + process.pid + '-' + Date.now())
  const logFile = join(base, 'nested', 'better-debug.log')
  const warns = []
  const ctx = { logger: { warn: (line) => warns.push(line) } }
  const line = (index) => 'apply pid=1 logFile=x A=3 B=2 C=3 seq=' + index
  const readAll = (path) => readFileSync(path, 'utf8').split('\n').filter((row) => row.length > 0)

  // 15a logFile 为空串 = 显式关闭：不建目录、不写、不 warn。
  const off = createLogWriter({ cfg: { logFile: '', logMaxBytes: 1024, logKeep: 2 }, ctx })
  await off.record(line(0))
  check('createLogWriter: logFile 为空串时什么都不做', warns.length === 0 && !existsSync(base))

  // 15b 首次写自动建多级目录（A12 只建一次的前提是先建起来）。
  const writer = createLogWriter({ cfg: { logFile, logMaxBytes: 1024, logKeep: 2 }, ctx })
  await writer.record(line(1))
  await writer.record(line(2))
  check(
    'createLogWriter: 首次写自动建多级目录并追加两行',
    existsSync(join(base, 'nested')) && readAll(logFile).length === 2,
    'lines=' + readAll(logFile).length
  )

  // 15c 游标从 stat 补上：新实例不知道已有长度，到量就先轮转再写。
  const rotator = createLogWriter({ cfg: { logFile, logMaxBytes: 1, logKeep: 2 }, ctx })
  await rotator.record(line(3))
  check(
    'createLogWriter: 超过 logMaxBytes 先轮转再写，旧内容进 .1',
    existsSync(logFile + '.1') && readAll(logFile + '.1').at(-1).includes('seq=2') && readAll(logFile).at(-1).includes('seq=3'),
    'main=' + JSON.stringify(readAll(logFile))
  )

  // 15d logKeep 是保留份数上限：连续轮转后最老的一份被丢弃，不会出现 .3。
  for (let index = 4; index <= 6; index += 1) await rotator.record(line(index))
  check(
    'createLogWriter: 轮转到 logKeep 份后最老一份被丢弃（不生成 .3）',
    existsSync(logFile + '.2') && !existsSync(logFile + '.3'),
    'has1=' + existsSync(logFile + '.1') + ' has2=' + existsSync(logFile + '.2') + ' has3=' + existsSync(logFile + '.3')
  )

  // 15e A12：目录建过就不再 mkdir。删掉目录后写一次必须失败 —— 若每条都 mkdir，
  // 这里会被重新建出来，写成功、warn 为 0，A12 就白改了。
  rmSync(join(base, 'nested'), { recursive: true, force: true })
  const beforeWarns = warns.length
  await rotator.record(line(7))
  check(
    'createLogWriter: 目录被删后不重建（mkdir 只在第一次做）',
    warns.length === beforeWarns + 1 && !existsSync(logFile),
    'warns=' + (warns.length - beforeWarns) + ' exists=' + existsSync(logFile)
  )

  // 15f 失败后把目录/游标打回未知：下一次写自愈（mkdir 重试一次，游标重新 stat）。
  await rotator.record(line(8))
  check(
    'createLogWriter: 写失败后状态打回，下一次写自愈',
    existsSync(logFile) && readAll(logFile).length === 1 && readAll(logFile)[0].includes('seq=8'),
    'lines=' + readAll(logFile).length
  )

  // 15g 落盘失败只 warn 一次：logFile 指向一个目录，appendFile 必然失败。
  const doomed = join(base, 'is-a-dir.log')
  mkdirSync(doomed, { recursive: true })
  const badWarns = []
  const bad = createLogWriter({
    cfg: { logFile: doomed, logMaxBytes: 64 * 1024, logKeep: 2 },
    ctx: { logger: { warn: (row) => badWarns.push(row) } }
  })
  await bad.record(line(9))
  await bad.record(line(10))
  await bad.record(line(11))
  check('createLogWriter: 持续写失败只 warn 一次', badWarns.length === 1, 'warns=' + badWarns.length)

  rmSync(base, { recursive: true, force: true })
}

// ── 16. readAggregate 增量解析：只读新增、变小重来、多字节不切坏（P1-10）
{
  const dir = join(tmpdir(), 'better-debug-read-' + process.pid + '-' + Date.now())
  mkdirSync(dir, { recursive: true })
  const at = '2026-11-07T02:00:00.000Z '
  const injectLine = (inj, sample) =>
    at + 'inject session=s1 turn=1 step=1 signals=C chars=10 files=1 worstEdits=0 worstStreak=0 worstErrors=0 searched=false measured=no inj=' + inj + ' sample=' + sample + '\n'
  const Q = String.fromCharCode(34)
  const quoted = (text) => Q + text + Q

  const logFile = join(dir, 'a.log')
  writeFileSync(logFile, injectLine('i1', quoted('a')) + injectLine('i2', quoted('b')), 'utf8')
  const first = readAggregate(logFile, {})
  check(
    'readAggregate: 首次全量解析，bytes 是文件总字节数',
    first.log.lines === 2 && first.log.bytes === statSync(logFile).size && first.injects.total === 2,
    'lines=' + first.log.lines + ' bytes=' + first.log.bytes
  )

  appendFileSync(logFile, injectLine('i3', quoted('c')), 'utf8')
  const second = readAggregate(logFile, {})
  check(
    'readAggregate: 追加后只解析新增，累计行数与总字节同步增长',
    second.log.lines === 3 && second.injects.total === 3 && second.log.bytes === statSync(logFile).size,
    'lines=' + second.log.lines + ' bytes=' + second.log.bytes
  )

  // 同一路径变短 = 被截断或被换掉，必须丢掉旧记录重读，不能把旧行留在聚合里。
  writeFileSync(logFile, injectLine('i9', quoted('z')), 'utf8')
  const shrunk = readAggregate(logFile, {})
  check(
    'readAggregate: 文件变小就重置缓存，不残留旧行',
    shrunk.log.lines === 1 && shrunk.injects.total === 1 && shrunk.recent.at(-1).inj === 'i9',
    'lines=' + shrunk.log.lines + ' inj=' + (shrunk.recent.at(-1) || {}).inj
  )

  // 多字节字符跨块：tail 存字节不存字符串。若先解码再切，半个「中」会变成 U+FFFD。
  const wideFile = join(dir, 'b.log')
  const wide = Buffer.from(injectLine('i4', quoted('中文')), 'utf8')
  const cut = wide.indexOf(Buffer.from('中', 'utf8')) + 1
  writeFileSync(wideFile, wide.subarray(0, cut))
  const partial = readAggregate(wideFile, {})
  check(
    'readAggregate: 半个多字节字符只留在 tail，不产出坏行',
    partial.log.lines === 0 && partial.log.bytes === cut,
    'lines=' + partial.log.lines + ' bytes=' + partial.log.bytes
  )
  appendFileSync(wideFile, wide.subarray(cut))
  const whole = readAggregate(wideFile, {})
  check(
    'readAggregate: 补齐后解析出完整样本（tail 存字节不存字符串）',
    whole.log.lines === 1 && whole.recent.at(-1).sample === '中文' && whole.log.bytes === wide.length,
    'lines=' + whole.log.lines + ' sample=' + JSON.stringify((whole.recent.at(-1) || {}).sample)
  )

  // 轮转：主文件被换掉（更短的新文件），缓存必须按新文件重来。
  const rotFile = join(dir, 'c.log')
  writeFileSync(rotFile, injectLine('r1', quoted('1')) + injectLine('r2', quoted('2')) + injectLine('r3', quoted('3')), 'utf8')
  readAggregate(rotFile, {})
  renameSync(rotFile, rotFile + '.1')
  writeFileSync(rotFile, injectLine('r9', quoted('9')), 'utf8')
  const afterRotate = readAggregate(rotFile, {})
  check(
    'readAggregate: 轮转后主文件变小即重置，只读新文件',
    afterRotate.log.lines === 1 && afterRotate.injects.total === 1 && afterRotate.recent.at(-1).inj === 'r9',
    'lines=' + afterRotate.log.lines + ' inj=' + (afterRotate.recent.at(-1) || {}).inj
  )

  rmSync(dir, { recursive: true, force: true })
}
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  console.log('FAILED:', failed.map((r) => r.label).join(' | '))
  process.exit(1)
}
