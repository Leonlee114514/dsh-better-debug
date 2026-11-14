// 面板的读数验证：解析器、聚合、折算，以及 inject/outcome/change/measure 埋点是否真的落盘。
// 和 sim.mjs 一样不依赖 DSH 运行时——面板只认日志文本，所以它天然可单测。
//
// 重点守的是「指标不许夸大」这条线（评审 m00176 中6）：
// 字段只能描述「提示后发生了什么」，不能出现暗示因果的名字（changed / gain / effective）。
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { aggregate, parseLine, parseLog, scanFields, estimateTokens, readAggregate } from '../lib/panel.js'
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
  const arm = parseLine('2026-11-07T02:38:30.001Z arm session=s-1 turn=39 step=8 gap=2')
  const applyLine = parseLine(
    '2026-11-07T01:24:19.226Z apply pid=17884 logFile=C:/x/better-debug.log A=3 B=2 C=2 budget=3 window=6 panel=true'
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
  check('parseLine 认 arm', arm.kind === 'arm' && arm.gap === 2, `gap=${arm.gap}`)
  check(
    'parseLine 认 apply 与阈值 + 预算',
    applyLine.kind === 'apply' && applyLine.pid === 17884 &&
      applyLine.thresholds.A === 3 && applyLine.thresholds.B === 2 && applyLine.thresholds.C === 2 &&
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
    '2026-11-07T02:00:00.000Z apply pid=1 logFile=C:/x.log A=3 B=2 C=2 budget=3 window=6 panel=true',
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
    a.thresholds.A === 3 && a.thresholds.B === 2 && a.thresholds.C === 2 && a.budget === 3 && a.window === 6,
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
    '2026-11-07T02:00:00.000Z apply pid=1 logFile=C:/x.log A=3 B=2 C=2',
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
    '2026-11-11T00:00:00.000Z apply pid=1 logFile=C:/x.log A=3 B=2 C=2 budget=3 window=6 panel=true',
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

// ── 10. arm 行：解释「改完 N 步为什么没提醒」，且不计入触发
{
  const text = [
    '2026-11-11T00:00:00.000Z arm session=s-1 turn=1 step=9 gap=2',
    '2026-11-11T00:00:01.000Z arm session=s-1 turn=1 step=10 gap=3'
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
    '2026-11-14T11:23:07.155Z apply pid=5596 logFile=C:/x.log A=3 B=2 C=2 budget=3 window=6 panel=true'
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
    '2026-11-14T11:23:07.155Z apply pid=5596 logFile=C:/x.log A=3 B=2 C=2 budget=3 window=6 panel=true',
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
  const inline = html.match(/<script>([\s\S]*)<\/script>/)
  if (inline !== null) {
    try {
      // 只做语法解析，不执行：避免页面脚本碰 document。
      new Function(inline[1])
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
  check('内联脚本能被解析（不执行）', scriptParses === true, `parses=${scriptParses}`)
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  console.log('FAILED:', failed.map((r) => r.label).join(' | '))
  process.exit(1)
}
