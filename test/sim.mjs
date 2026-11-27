// 本地行为验证：用假 ctx 模拟 agent-loop 的调用顺序，不依赖 DSH 运行时。
//
// 覆盖分两层：
//   · 语义层 —— 「什么算测量」「什么算同一个 episode」「C 什么时候才开口」，
//     这些是 2026-11-14 评审指出的漏报/误报根源，每条都有正例 + 反例。
//   · 结构层 —— 阈值可调、开关可回滚、子会话跳过、技能注册、导出形状。
import { readFileSync } from 'node:fs'
import {
  apply,
  name,
  inject,
  classifyTool,
  isMeasurement,
  measureDirs,
  errorFingerprint,
  errorTargetOf,
  failureSetOf,
  failureSetKey,
  failureTargetsOf,
  measureKey,
  createMeasureSettler,
  createDeliverer,
  exitCodeOf,
  isAbsPath,
  resolveLogFile,
  CASE_INSENSITIVE
} from '../lib/index.js'

// 大小写折叠是平台语义的一部分，不是巧合：win32 与 darwin 的文件系统不区分大小写，
// 所以 errorTargetOf / measureDirs 会把路径折成小写；Linux 上路径区分大小写，原样保留。
// 断言里写**原始大小写**的期望值，比较时才按平台决定折不折 —— 否则写出来的就是
// 「Windows 上通过、Linux 上红」。2026-11-14 的真机 CI 正是这样把 0.2.2 的两组
// 新断言打红的（本机 Windows + POSIX path shim 全绿，因为 shim 不伪造 platform）。
const samePath = (actual, expected) =>
  CASE_INSENSITIVE ? actual.toLowerCase() === expected.toLowerCase() : actual === expected
const sameDirs = (actual, expected) =>
  actual.length === expected.length && actual.every((dir, i) => samePath(dir, expected[i]))

const log = []
function makeCtx({ skills = true } = {}) {
  const listeners = new Map()
  const logger = {
    info: (m) => log.push(['info', m]),
    warn: (m) => log.push(['warn', m])
  }
  const providers = []
  const ctx = {
    logger,
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
      const step = async (i) => {
        if (i >= cbs.length) return next()
        return cbs[i](...args, () => step(i + 1))
      }
      return step(0)
    }
  }
  // 假的 skills 服务：只记下 provider，够断言「注册了没有」。
  // skills:false 用来模拟没装 dsh-skill 的宿主 —— 注册要被跳过且不能炸。
  if (skills) {
    ctx.skills = {
      registerProvider(create) {
        const provider = create({})
        providers.push(provider)
        return () => {}
      },
      providers
    }
  }
  ctx.providers = providers
  // ctx.inject 的最小白盒：服务存在就当场回调（真 cordis 也是这样，
  // 差别只是它还会在服务换代时重跑回调）。服务不存在就**什么都不做** ——
  // 这正是插件要能活下来的情形。
  const services = () => ({
    skills: ctx.skills,
    webServer: ctx.webServer
  })
  ctx.inject = (deps, callback) => {
    const names = Array.isArray(deps) ? deps : Object.keys(deps)
    const table = services()
    if (names.some((n) => table[n] === void 0)) return { dispose() {}, then() {} }
    const fiber = callback(ctx, void 0)
    return { dispose() { if (typeof fiber === 'function') fiber() }, then() {} }
  }
  return ctx
}

function makeSession({ origin = 'user', delegationDepth = 0, id = 'sess-1' } = {}) {
  return { id, header: { cwd: 'C:/work', origin, delegationDepth } }
}

const results = []
function check(label, pass, detail) {
  results.push({ label, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
}

/** 跑一个 turn：先 turn/start，然后按脚本逐事件派发，每步前跑 pre-step。 */
async function runTurn(ctx, agent, { turn, steps, quietText }) {
  const session = agent.session
  await ctx.emitPlain('session/event', session, { type: 'turn/start', data: { turn } })
  if (quietText !== void 0) {
    await ctx.emitPlain('session/event', session, {
      type: 'user/message',
      data: { id: 'u1', role: 'user', content: [{ type: 'text', text: quietText }], source: { kind: 'user' } }
    })
  }
  const injected = []
  let step = 0
  for (step = 1; step <= steps.length; step += 1) {
    const decision = await ctx.emitWaterfall(
      'agent/pre-step',
      { agent, turn, step, signal: { aborted: false } },
      () => ({ kind: 'enter', messages: [] })
    )
    const extra = decision.messages.filter((m) => m.source?.kind === 'dsh-better-debug')
    if (extra.length > 0) injected.push({ step, texts: extra.map((m) => m.content[0].text) })
    for (const act of steps[step - 1] ?? []) await act(session, ctx, step)
  }
  await ctx.emitPlain('session/event', session, { type: 'turn/end', data: { turn } })
  return injected
}

// ── 动作原语 ────────────────────────────────────────────────────────────

const edit = (path) => async (session, ctx) => {
  // fs/write-intent 是 waterfall：(target, actor, next)
  await ctx.emitWaterfall('fs/write-intent', path, { agent: { session } }, () => ({ ok: true }))
}

/** 一次工具调用 + 它的结果。结果是判「测量完没完成」的唯一依据。 */
const tool = (id, toolName, { args = {}, text = '', isError = false } = {}) => async (session, ctx, step) => {
  await ctx.emitPlain('session/event', session, {
    type: 'tool/call',
    data: { turn: 1, step, callId: id, name: toolName, arguments: args }
  })
  await ctx.emitPlain('session/event', session, {
    type: 'tool/result',
    data: {
      turn: 1,
      step,
      message: {
        id: `m-${id}`,
        role: 'tool',
        toolCallId: id,
        isError,
        source: { kind: 'tool', callId: id },
        content: [{ type: 'text', text }]
      }
    }
  })
}

/** 一次真测量：命令命中判据，结果带退出码。failing=true 也是有效测量。 */
const measure = (id, { command = 'npm test', workdir, exit = 0 } = {}) =>
  tool(id, 'ops_bash', {
    args: { command, description: '跑测试', ...(workdir === void 0 ? {} : { workdir }) },
    text: `[exit code: ${exit}]`,
    isError: false
  })

/** 一次「测量失败、但工具本身没报错」的运行：喂 O / P 用（isError=false 才进测量分支）。 */
const runFail = (id, text, { command = 'npm test' } = {}) =>
  tool(id, 'ops_bash', { args: { command, description: '跑测试' }, text, isError: false })

/** 一次不算测量的 shell：`ls` 这类「看起来动了手、其实没测」的命令。 */
const shell = (id, { command = 'ls -la', exit = 0 } = {}) =>
  tool(id, 'ops_bash', { args: { command, description: '看看目录' }, text: `[exit code: ${exit}]` })

const fail = (id, text, toolName = 'ops_read_files') =>
  tool(id, toolName, { text, isError: true })

/**
 * 一次 PTC 派发：根 run_code 的 tool/call，中间两次 log-only 的
 * tool/ptc-dispatch-start / tool/ptc-dispatch，最后根 tool/result。
 * 形状照抄 dsh-tool-executor-ptc（subCallId = `<root>:ptc:<n>`）。
 */
const ptc = (rootId, subName, subId, { args = {}, text = '', isError = false, rootText, rootError, code = 'x' } = {}) =>
  async (session, ctx, step) => {
    await ctx.emitPlain('session/event', session, {
      type: 'tool/call',
      data: { turn: 1, step, callId: rootId, name: 'run_code', arguments: { code, description: 'y' } }
    })
    await ctx.emitPlain('session/event', session, {
      type: 'tool/ptc-dispatch-start',
      data: { rootCallId: rootId, parentCallId: rootId, subCallId: subId, name: subName, arguments: args }
    })
    await ctx.emitPlain('session/event', session, {
      type: 'tool/ptc-dispatch',
      data: {
        rootCallId: rootId,
        parentCallId: rootId,
        subCallId: subId,
        name: subName,
        arguments: args,
        isError,
        content: text
      }
    })
    const rootIsError = rootError === void 0 ? isError : rootError
    await ctx.emitPlain('session/event', session, {
      type: 'tool/result',
      data: {
        turn: 1,
        step,
        message: {
          id: `m-${rootId}`,
          role: 'tool',
          toolCallId: rootId,
          isError: rootIsError,
          source: { kind: 'tool', callId: rootId },
          content: [{ type: 'text', text: rootText === void 0 ? (rootIsError ? text : '') : rootText }]
        }
      }
    })
  }

const has = (injected, needle) => injected.find((entry) => entry.texts.some((t) => t.includes(needle)))

/** 注入摘要：`step:信号` 列表，比光看条数更容易定位是哪个信号说的话。 */
const injections = (injected) =>
  injected.length === 0 ? 'none' : injected.map((entry) => `step${entry.step}`).join(',')

// ── 1. A 信号：同一文件改 3 次，第 4 步注入
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const P = 'C:/work/src/a.js'
  const steps = [[(s, c) => edit(P)(s, c)], [(s, c) => edit(P)(s, c)], [(s, c) => edit(P)(s, c)], [], []]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  const hit = has(injected, '同一个文件')
  check('A: 同文件改 3 次 → 注入', hit !== void 0, hit ? `step=${hit.step}` : 'no injection')
}

// ── 2. A 反例：改 2 次不响
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const P = 'C:/work/src/a.js'
  const steps = [[(s, c) => edit(P)(s, c)], [(s, c) => edit(P)(s, c)], [], []]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check('A: 改 2 次不响', has(injected, '同一个文件') === void 0)
}

// ── 3. 评审第 1 条：edit → ls → edit → edit 仍应触发 A
//    旧实现把 `ops_bash` 一律当验证，`ls` 就把盲改计数洗白了 → 漏报。
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const P = 'C:/work/src/ls.js'
  const steps = [
    [(s, c) => edit(P)(s, c)],
    [(s, c, st) => shell('l1')(s, c, st)],
    [(s, c) => edit(P)(s, c)],
    [(s, c) => edit(P)(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  const hit = has(injected, '同一个文件')
  check('A: edit→ls→edit→edit 仍触发（ls 不算测量）', hit !== void 0, hit ? `step=${hit.step}` : 'no injection')
}

// ── 4. 反例：真测量夹在中间 → 不响（有回路的收敛不算打转）
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const P = 'C:/work/src/converge.js'
  const steps = [
    [(s, c) => edit(P)(s, c), (s, c, st) => measure('v1')(s, c, st)],
    [(s, c) => edit(P)(s, c), (s, c, st) => measure('v2')(s, c, st)],
    [(s, c) => edit(P)(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check('A: 编辑间有真测量（收敛）→ 不响', injected.length === 0, `injections=${injected.length}`)
}

// ── 5. 评审第 2 条：edit → 失败的测试 → edit 不算盲改
//    失败的测试给了新事实（错在哪一行），它仍然是有效测量。
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const P = 'C:/work/src/failfast.js'
  const steps = [
    [(s, c) => edit(P)(s, c)],
    [(s, c) => edit(P)(s, c)],
    [(s, c, st) => measure('t1', { exit: 1 })(s, c, st)],
    [(s, c) => edit(P)(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check('A: 失败的测试仍是有效测量 → 不响', has(injected, '同一个文件') === void 0)
}

// ── 6. 「发起调用」不等于「测量完成」：只 call 不 result，不能清零
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const P = 'C:/work/src/noreturn.js'
  const steps = [
    [(s, c) => edit(P)(s, c)],
    [
      (s, c, st) =>
        ctx.emitPlain('session/event', s, {
          type: 'tool/call',
          data: { turn: 1, step: st, callId: 'pending', name: 'ops_bash', arguments: { command: 'npm test' } }
        })
    ],
    [(s, c) => edit(P)(s, c)],
    [(s, c) => edit(P)(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check('A: 测量没返回结果 → 不清零', has(injected, '同一个文件') !== void 0)
}

// ── 7. 评审第 7 条：无关目录的测量不清空目标文件的盲改状态
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const P = 'C:/work/src/target.js'
  const steps = [
    [(s, c) => edit(P)(s, c)],
    [(s, c) => edit(P)(s, c)],
    [(s, c, st) => measure('other', { workdir: 'C:/other', command: 'npm test' })(s, c, st)],
    [(s, c) => edit(P)(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  const hit = has(injected, '同一个文件')
  check('A: 别的目录测过不算这个文件的测量', hit !== void 0, hit ? `step=${hit.step}` : 'no injection')
}

// ── 8. 生成物 / 锁文件不计入盲改
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const L = 'C:/work/package-lock.json'
  const steps = [
    [(s, c) => edit(L)(s, c)],
    [(s, c) => edit(L)(s, c)],
    [(s, c) => edit(L)(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check('A: 锁文件/生成物不计入盲改', injected.length === 0, `injections=${injected.length}`)
}

// ── 9. B 信号：同一目标同一指纹，两次
//
// 位置漂移写成 `:42:5` / `:99:5`（0.3.6 口径）：这两段由 <path> 规则整段吃掉，
// 所以「同一个错、只是行号变了」仍然合并。旧夹具写的是 `line 42` / `line 99`，
// 那两个数字不在路径里、属于正文，新口径下会被当成不同的失败语义 —— 那是刻意的，
// 行号在正文里时就该分开（见组 66 的反例与组 65 的正例）。
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const steps = [
    [(s, c, st) => fail('c1', "Error: ENOENT: no such file or directory, open 'C:/work/a.js:42:5'")(s, c, st)],
    [(s, c, st) => fail('c2', "Error: ENOENT: no such file or directory, open 'C:/work/a.js:99:5'")(s, c, st)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  const hit = has(injected, '同一个操作重复报错')
  check('B: 同一目标同一报错 2 次 → 注入', hit !== void 0, hit ? `step=${hit.step}` : 'no injection')
}

// ── 10. 评审第 3 条：两个不同文件各错一次 ENOENT → 不触发 B
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const steps = [
    [(s, c, st) => fail('c1', "Error: ENOENT: no such file or directory, open 'C:/work/a.js' line 42")(s, c, st)],
    [(s, c, st) => fail('c2', "Error: ENOENT: no such file or directory, open 'C:/work/b.js' line 42")(s, c, st)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check('B: 不同目标各错一次 → 不触发', has(injected, '同一个操作重复报错') === void 0)
}

// ── 11. B 反例：这个 episode 之后搜过 → 不响
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const steps = [
    [(s, c, st) => fail('c1', 'TypeError: x is not a function')(s, c, st)],
    [(s, c, st) => tool('s1', 'web_search', { args: { queries: ['x is not a function'] } })(s, c, st)],
    [(s, c, st) => fail('c2', 'TypeError: x is not a function')(s, c, st)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check('B: episode 之后搜过 → 不响', has(injected, '同一个操作重复报错') === void 0)
}

// ── 12. 但「搜的是别的事」不该替这个 episode 免单
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const steps = [
    [(s, c, st) => tool('s1', 'web_search', { args: { queries: ['unrelated'] } })(s, c, st)],
    [(s, c, st) => fail('c1', 'TypeError: y is not a function')(s, c, st)],
    [(s, c, st) => fail('c2', 'TypeError: y is not a function')(s, c, st)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check('B: 先搜过无关问题不免疫（按 episode 判，不按全 turn）', has(injected, '同一个操作重复报错') !== void 0)
}

// ── 13. 评审第 4 条：C 不在阅读阶段打断，只上膛；下一次写入之后才开口
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const P = 'C:/work/src/read-log.js'
  const steps = [
    [(s, c) => edit(P)(s, c)],
    [], // 读代码，静默
    [], // 还在读，应该只 arm
    [(s, c, st) => tool('r1', 'ops_read_files', { args: { path: 'C:/work/x.log' } })(s, c, st)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check('C: 改完之后只在读东西 → 不打断', injected.length === 0, `injections=${injected.length}`)
}

// ── 14. C 的判据是「盲改次数」，不是「距上次改过了几步」（0.3.5 换轴）
//
// 旧判据 step - lastEditStep 的两种失效方式，下面两条反例各钉一个：
//   · 每步都改 → 差值恒为 1，永不触发（漏报）；
//   · 改 → 读一眼 → 改 → 差值恒为 2，立刻上膛（误报）。
// 实测 20 天日志里 182 条 arm 行的 gap 全部等于 2（唯一值），正是这个错轴的指纹。
{
  // 14a. 改 → 读 → 改：只有 2 次盲改，不该上膛，更不该开口。
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const P = 'C:/work/src/read-between.js'
  const steps = [
    [(s, c) => edit(P)(s, c)],
    [(s, c, st) => tool('r1', 'ops_read_files', { args: { path: P } })(s, c, st)],
    [(s, c) => edit(P)(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check('C: 改→读→改（2 次盲改）不响', injected.length === 0, `injections=${injected.length}`)
}

{
  // 14b. 改 → 读三次 → 改：读数次再多也不推进判据（旧轴会一路把 gap 顶上去）。
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const P = 'C:/work/src/read-more.js'
  const steps = [
    [(s, c) => edit(P)(s, c)],
    [(s, c, st) => tool('r1', 'ops_read_files', { args: { path: P } })(s, c, st)],
    [(s, c, st) => tool('r2', 'ops_read_files', { args: { path: P } })(s, c, st)],
    [(s, c, st) => tool('r3', 'ops_read_files', { args: { path: P } })(s, c, st)],
    [(s, c) => edit(P)(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check('C: 改→读×3→改（仍只有 2 次盲改）不响', injected.length === 0, `injections=${injected.length}`)
}

{
  // 14c. 跨文件连写 4 处、一次没测 → 必须响（正例：这才是 C 要抓的现场）。
  // 每个文件只改一次，所以 A（同文件连改 3 次）不会命中，命中的只能是 C。
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const steps = [
    [(s, c) => edit('C:/work/src/a.js')(s, c)],
    [(s, c) => edit('C:/work/src/b.js')(s, c)],
    [(s, c) => edit('C:/work/src/c.js')(s, c)],
    [(s, c) => edit('C:/work/src/d.js')(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  const hit = has(injected, '自上次测量以来')
  check('C: 跨文件盲改 4 处 → 注入', hit !== void 0, hit ? `step=${hit.step}` : 'no injection')
}

{
  // 14d. 改×2 → 测量 → 改：测量把计数清零，第三次写入不够阈值，不响。
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const P = 'C:/work/src/measured.js'
  const steps = [
    [(s, c) => edit(P)(s, c)],
    [(s, c) => edit(P)(s, c)],
    [(s, c, st) => measure('v1')(s, c, st)],
    [(s, c) => edit(P)(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check('C: 改×2→测量→改 不响（测量清零盲改计数）', injected.length === 0, `injections=${injected.length}`)
}

// ── 15. 评审第 5 条：A 提醒 → 有效测量恢复 → 新阶段再盲改，允许第二次提醒
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const P = 'C:/work/src/twice.js'
  const steps = [
    [(s, c) => edit(P)(s, c)],
    [(s, c) => edit(P)(s, c)],
    [(s, c) => edit(P)(s, c)], // ← 第 4 步注入 A
    [(s, c, st) => measure('v1')(s, c, st)], // 恢复：拿到测量
    [(s, c) => edit(P)(s, c)],
    [(s, c) => edit(P)(s, c)],
    [(s, c) => edit(P)(s, c)], // ← 新一轮盲改，应能再说一次
    [],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  const hits = injected.filter((entry) => entry.texts.some((t) => t.includes('同一个文件')))
  check('A: 恢复后可再次武装（第二次提醒）', hits.length === 2, `injections=${hits.length} at=${hits.map((h) => h.step)}`)
}

// ── 16. 但每 turn 有总预算，不能变成连击
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '', maxInjectsPerTurn: 2 })
  const agent = { session: makeSession() }
  const P = 'C:/work/src/budget.js'
  const steps = []
  for (let round = 0; round < 4; round += 1) {
    steps.push([(s, c) => edit(P)(s, c)])
    steps.push([(s, c) => edit(P)(s, c)])
    steps.push([(s, c) => edit(P)(s, c)])
    steps.push([(s, c, st) => measure(`v${round}`)(s, c, st)])
  }
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check('每 turn 注入预算生效', injected.length === 2, `injections=${injected.length}`)
}

// ── 17. 评审第 6 条：present 失败不得进入交付休眠
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  // 判据换轴后这里要用「够阈值的盲改次数」而不是「隔了一步」，否则测不出 done 有没有被置上。
  // 每个文件只改一次，避免 A 先命中把 C 挡掉（C 与 A 互斥）。
  const steps = [
    [(s, c) => edit('C:/work/src/pf-a.js')(s, c)],
    [(s, c, st) => tool('p1', 'present', { text: 'present rejected: no such file', isError: true })(s, c, st)],
    [(s, c) => edit('C:/work/src/pf-b.js')(s, c)],
    [(s, c) => edit('C:/work/src/pf-c.js')(s, c)],
    [(s, c) => edit('C:/work/src/pf-d.js')(s, c)],
    [(s, c) => edit('C:/work/src/pf-e.js')(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check('present 失败 → 不休眠，C 仍能开口', injected.length > 0, `injections=${injected.length}`)
}

// ── 18. present 成功 → 休眠；之后再次写入 → 重新武装
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const P = 'C:/work/src/present-ok.js'
  const steps = [
    [(s, c, st) => edit(P)(s, c)],
    [(s, c, st) => tool('p1', 'present', { text: 'presented' })(s, c, st)],
    [],
    [],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check('done-state: present 成功后不注入', injected.length === 0, `injections=${injected.length}`)
}

// ── 19. 幂等：同一局面不会每步念一次
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const P = 'C:/work/src/once.js'
  const steps = [
    [(s, c) => edit(P)(s, c)],
    [(s, c) => edit(P)(s, c)],
    [(s, c) => edit(P)(s, c)],
    [(s, c) => edit(P)(s, c)],
    [(s, c) => edit(P)(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check('幂等：连续盲改只说一次', injected.length === 1, `injections=${injected.length}`)
}

// ── 20. D 段例外：用户说「直接改」
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const P = 'C:/work/src/quiet.js'
  const steps = [
    [(s, c) => edit(P)(s, c)],
    [(s, c) => edit(P)(s, c)],
    [(s, c) => edit(P)(s, c)],
    [(s, c) => edit(P)(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps, quietText: '别搜了，直接改' })
  check('D: 用户说直接改 → 静音', injected.length === 0, `injections=${injected.length}`)
}
// ── 20b. D 段例外必须中英双语：英文用户说同一句话，待遇必须一样。
//     修复前 QUIET_PATTERN 只有中文条目，英文指令整句不识别 → 用户明确说
//     "just do it, skip the search" 却继续被提醒，是最刺人的那种误报。
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const P = 'C:/work/src/quiet-en.js'
  const steps = [
    [(s, c) => edit(P)(s, c)],
    [(s, c) => edit(P)(s, c)],
    [(s, c) => edit(P)(s, c)],
    [(s, c) => edit(P)(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps, quietText: "just do it, don't search" })
  check('D: 英文「just do it」同样静音', injected.length === 0, 'injections=' + injected.length)
}

// ── 20c. 反过来也要成立：描述性提到搜索不得静音（误静音比漏静音更贵）。
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const P = 'C:/work/src/quiet-neg.js'
  const steps = [
    [(s, c) => edit(P)(s, c)],
    [(s, c) => edit(P)(s, c)],
    [(s, c) => edit(P)(s, c)],
    [(s, c) => edit(P)(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, {
    turn: 1,
    steps,
    quietText: 'I searched before editing, here is what I found'
  })
  check('D: 描述性提到搜索不静音（反例）', injected.length === 1, 'injections=' + injected.length)
}

// ── 21. 子会话不管
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession({ origin: 'subagent', delegationDepth: 1 }) }
  const P = 'C:/work/src/sub.js'
  const steps = [
    [(s, c) => edit(P)(s, c)],
    [(s, c) => edit(P)(s, c)],
    [(s, c) => edit(P)(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check('子会话跳过', injected.length === 0, `injections=${injected.length}`)
}

// ── 22. 阈值可调
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '', repeatEditThreshold: 5 })
  const agent = { session: makeSession() }
  const P = 'C:/work/src/threshold.js'
  const steps = [
    [(s, c) => edit(P)(s, c)],
    [(s, c) => edit(P)(s, c)],
    [(s, c) => edit(P)(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check('阈值 5：改 3 次不响', has(injected, '同一个文件') === void 0)
}

// ── 23. decayEditsOnVerify:false → 退回旧行为（测量也不清零）
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '', decayEditsOnVerify: false })
  const agent = { session: makeSession() }
  const P = 'C:/work/src/converge-old.js'
  const steps = [
    [(s, c) => edit(P)(s, c), (s, c, st) => measure('v1')(s, c, st)],
    [(s, c) => edit(P)(s, c), (s, c, st) => measure('v2')(s, c, st)],
    [(s, c) => edit(P)(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check('decayEditsOnVerify:false → 收敛仍响（可回滚）', has(injected, '同一个文件') !== void 0)
}

// ── 24. enabled:false 不安装任何 listener
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '', enabled: false })
  const agent = { session: makeSession() }
  const injected = await runTurn(ctx, agent, { turn: 1, steps: [[], []] })
  check('enabled:false 静默', injected.length === 0)
}

// ── 25. 自带技能注册 + 正文可取
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const provider = ctx.providers[0]
  const candidates = provider === void 0 ? [] : await provider.list()
  const candidate = candidates[0]
  check(
    'bundled skill 注册',
    provider !== void 0 &&
      provider.name === name &&
      candidates.length === 1 &&
      candidate.name === 'stuck-gate' &&
      candidate.provider === name &&
      candidate.source === 'bundled' &&
      candidate.rank === 600 &&
      candidate.invocation.modelInvocable === true &&
      typeof candidate.description === 'string' &&
      candidate.description.length > 0,
    provider === void 0 ? 'no provider' : `${candidate.name} rank=${candidate.rank} desc=${candidate.description.length}`
  )

  const loaded = candidate === void 0 ? void 0 : await provider.get(candidate, { signal: { aborted: false } })
  const content = loaded?.content ?? ''
  check(
    'bundled skill 正文可取且已去私有化',
    content.includes('卡住闸门') &&
      content.includes('回路存在吗') &&
      !content.includes('mnemon_document_search') &&
      !content.includes('d713a6e6') &&
      loaded?.rank === void 0 &&
      loaded?.locator === void 0,
    `content=${content.length} chars`
  )
}

// ── 26. 没有 skills 服务时不能炸，闸门照常工作
{
  const ctx = makeCtx({ skills: false })
  let threw = null
  try {
    apply(ctx, { logFile: '' })
  } catch (error) {
    threw = error
  }
  const agent = { session: makeSession() }
  const P = 'C:/work/src/noskill.js'
  const steps = [
    [(s, c) => edit(P)(s, c)],
    [(s, c) => edit(P)(s, c)],
    [(s, c) => edit(P)(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  const hit = has(injected, '同一个文件')
  check(
    'skills 服务缺失：不抛且闸门仍工作',
    threw === null && hit !== void 0,
    threw === null ? `step=${hit?.step}` : String(threw?.message)
  )
}

// ── 27. 注入文本：只陈述观察，不替模型下诊断
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const P = 'C:/work/src/wording.js'
  const steps = [
    [(s, c) => edit(P)(s, c)],
    [(s, c) => edit(P)(s, c)],
    [(s, c) => edit(P)(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  const text = injected[0]?.texts[0] ?? ''
  check(
    '注入文本：措辞只陈述观察 + 给恢复条件',
    text.includes('只是观察，不是结论') &&
      text.includes('恢复条件') &&
      !text.includes('检测到你在原地打转') &&
      text.includes('stuck-gate'),
    text.slice(0, 48)
  )
}

// ── 28. 工具分类与测量判据的单元级断言
{
  const cfgLike = {
    measureCommands: /(npm|pnpm)\s+(run\s+)?(test|verify)/i,
    measureIntent: /验证|测试/i
  }
  const cases = [
    [classifyTool('ops_bash', true) === 'verify', 'ops_bash + 测量 → verify'],
    [classifyTool('ops_bash', false) === 'shell', 'ops_bash 非测量 → shell'],
    [classifyTool('skill') === 'method', 'skill → method（加载方法论是有效转向）'],
    [classifyTool('web_search') === 'search', 'web_search → search'],
    [isMeasurement('ops_bash', { command: 'npm test' }, cfgLike) === true, 'npm test 是测量'],
    [isMeasurement('ops_bash', { command: 'ls -la' }, cfgLike) === false, 'ls 不是测量'],
    [isMeasurement('ops_bash', { command: 'npm test', description: 'x' }, cfgLike) === true, '命令命中即可'],
    [isMeasurement('lsp_diagnostics', {}, cfgLike) === true, 'lsp_diagnostics 恒为测量'],
    // 反例：宿主没装 dsh-lsp-actions 时这个工具不存在，判定表不该因此变化 ——
    // 但也**不能**把别的工具名当成硬测量。三个真正恒定的名字逐个钉住，
    // 免得哪天有人把 verify 也一起删了还以为只是清理死代码。
    [isMeasurement('verify', {}, cfgLike) === true, 'verify 恒为测量'],
    [isMeasurement('run_tests', {}, cfgLike) === true, 'run_tests 恒为测量'],
    [isMeasurement('run_test', {}, cfgLike) === true, 'run_test 恒为测量'],
    [isMeasurement('ops_read_files', {}, cfgLike) === false, '只读工具不是测量'],
    [exitCodeOf('[exit code: 2]') === 2, 'exit code 解析'],
    [exitCodeOf('exited with status 1') === 1, 'exit status 解析'],
    [exitCodeOf('no code here') === void 0, '无退出码返回 undefined'],
    [
      errorTargetOf("ENOENT: open 'C:/work/a.js'") !== errorTargetOf("ENOENT: open 'C:/work/b.js'"),
      '不同路径不同目标'
    ],
    [
      errorTargetOf("ENOENT: open 'C:/work/a.js' line 42") === errorTargetOf("ENOENT: open 'C:/work/a.js' line 99"),
      '同路径不同行号同目标'
    ]
  ]
  const bad = cases.filter(([pass]) => !pass).map(([, label]) => label)
  check('工具分类 / 测量判据 / 指纹目标', bad.length === 0, bad.length === 0 ? `${cases.length} 项` : bad.join(', '))
}

// ── 28b. 路径语义必须与平台无关
//
// 这一条守的是一个真事故：入口闸原本用 `node:path` 的 `isAbsolute`，
// 在 Linux/macOS 上 `isAbsolute('C:/work/a.js')` 是 false，于是所有写入被
// 静默丢弃，A/C 两个信号彻底失效 —— 换台电脑就不好使，而 Windows 开发机上
// 永远看不出来。下面同时断言两种方言，并在 `npm run test:posix` 里把整个
// 套件再跑一遍（把 `node:path` 换成 posix 实现）。
{
  const cases = [
    [isAbsPath('C:/work/a.js') === true, 'C:/ 方言'],
    [isAbsPath('C:\\\\work\\\\a.js') === true, 'C:\\\\ 方言'],
    [isAbsPath('/home/u/a.js') === true, 'POSIX /'],
    [isAbsPath('//server/share/a.js') === true, 'UNC //server/share'],
    [isAbsPath('src/a.js') === false, '相对路径不算绝对'],
    [isAbsPath('./a.js') === false, './a.js 不算绝对'],
    [isAbsPath('') === false, '空串不算绝对'],
    [isAbsPath(void 0) === false, 'undefined 不算绝对']
  ]
  const bad = cases.filter(([pass]) => !pass).map(([, label]) => label)
  check('isAbsPath 同时认 C:/ 与 / 两种方言', bad.length === 0, bad.length === 0 ? `${cases.length} 项` : bad.join(', '))
}

// ── 28c. 日志文件默认值：装完就有数据，不用先配置
{
  const home = process.env.DSH_HOME
  const savedDshHome = home
  delete process.env.DSH_HOME
  const fallback = resolveLogFile({})
  const viaHome = resolveLogFile({ logFile: '~/x.log' })
  const explicitOff = resolveLogFile({ logFile: '' })
  const falseOff = resolveLogFile({ logFile: false })
  const verbatim = resolveLogFile({ logFile: 'C:/tmp/x.log' })
  // DSH_HOME 被写成相对路径时，日志也跟着相对 → 会落到「进程当时的 cwd」，
  // 而插件跑在 DSH 主机进程里，那个 cwd 由用户从哪儿启动决定，事后没人猜得到。
  process.env.DSH_HOME = 'relhome'
  const relHome = resolveLogFile({})
  process.env.DSH_HOME = ''
  const emptyHome = resolveLogFile({})
  if (savedDshHome !== void 0) process.env.DSH_HOME = savedDshHome
  else delete process.env.DSH_HOME

  const cases = [
    [fallback.includes('.dsh') && fallback.endsWith('better-debug.log') && !fallback.includes('dsh-better-debug.log'), '不写 logFile → 默认落盘，且文件名与文档一致'],
    [!viaHome.includes('~') && viaHome.endsWith('x.log'), '~ 被展开'],
    [explicitOff === '', '空串 = 显式关闭'],
    [falseOff === '', 'false = 显式关闭'],
    [verbatim === 'C:/tmp/x.log', '绝对路径原样使用'],
    [isAbsPath(relHome), 'DSH_HOME 是相对路径 → 日志仍解析成绝对路径'],
    [relHome.endsWith('better-debug.log'), '相对 DSH_HOME 的文件名不变'],
    [isAbsPath(emptyHome) && emptyHome.includes('.dsh'), 'DSH_HOME 为空串 → 退回 ~/.dsh']
  ]
  const bad = cases.filter(([pass]) => !pass).map(([, label]) => label)
  check('resolveLogFile 四种写法', bad.length === 0, bad.length === 0 ? `${cases.length} 项` : bad.join(', '))
}

// ── 28d. 大小写折叠按平台判，不无条件 toLowerCase()
//
// Windows/macOS 默认文件系统不区分大小写，Linux 区分。折叠错了的后果不对称：
// 该折叠却不折叠 = 同一个文件被当成两个（A 漏报）；不该折叠却折叠 = 两个不同
// 文件被当成一个（B 误报，狼来了）。误报才是这道闸门最不能犯的错，所以只在
// win32/darwin 折叠。这里断言的是「折叠行为与 CASE_INSENSITIVE 一致」，
// 而不是某个固定结果 —— 因为在 test:posix 轮里 process.platform 仍然是 win32。
{
  const upper = errorTargetOf("ENOENT: open 'C:/Work/A.js' line 1")
  const lower = errorTargetOf("ENOENT: open 'c:/work/a.js' line 1")
  const same = upper === lower
  const cases = [
    [same === CASE_INSENSITIVE, `折叠与平台一致（platform=${process.platform}, fold=${CASE_INSENSITIVE}）`],
    // 数字归一化与分隔符归一化必须与大小写无关，永远成立
    [errorTargetOf("open 'C:/work/a.js:12'") === errorTargetOf("open 'C:\\work\\a.js:99'"), '分隔符与行号归一化']
  ]
  const bad = cases.filter(([pass]) => !pass).map(([, label]) => label)
  check('大小写折叠只在不区分大小写的平台上发生', bad.length === 0, bad.length === 0 ? `${cases.length} 项` : bad.join(', '))
}

// ── 28e. 静态 inject 必须是空的
//
// 这条守的是一个真事故：原本写 `export const inject = ['skills']`，而 cordis 的
// `Fiber._refresh()` 只要 inject 里有一个服务拿不到，就把 epoch 置成 INACTIVE 并
// **直接不执行 apply** —— 没有报错、没有日志、面板里看起来装好了，实际一行没跑。
// `skills` 由 @deepseek-ai/dsh-skill 提供，裁剪过的 profile / 别的发行版可能没有；
// 而闸门本身根本不需要它。两个可选服务一律走 ctx.inject 动态订阅。
check(
  '静态 inject 为空（可选服务不得阻塞加载）',
  Array.isArray(inject) && inject.length === 0,
  JSON.stringify(inject)
)

// ── 28f. skills / webServer 都不在时，apply 仍然把闸门装好
{
  const ctx = makeCtx({ skills: false })
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const P = 'C:/work/src/bare.js'
  const steps = [[(s, c) => edit(P)(s, c)], [(s, c) => edit(P)(s, c)], [(s, c) => edit(P)(s, c)], []]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  const hit = has(injected, '同一个文件')
  check('宿主没有 skills / webServer：闸门照常装好', hit !== void 0, hit ? `step=${hit.step}` : 'no injection')
}

// ── 28g. bundle patch 必须是「纯 insert 行」，否则市场点启用没反应
//
// DshMarket 的热挂载只重放纯 insert 行（dshmarket/lib/hot.js 的 scanPatch()）：
// 一撞上 `config:` 就把整份 patch 标成 blocker:'config'，市场提示「重启后由
// bundle 层按原样加载」——新用户点「启用」看不到任何反馈，最像插件坏了。
// 因此包内 patch 只留 id + name；默认值全在 normalizeConfig() 里。
{
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const rows = []
  const keys = new Set()
  for (const raw of patch.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trimEnd()
    if (line.trim() === '' || /^-\s+insert:\s*$/.test(line)) continue
    const id = /^\s+-\s+id:\s*(\S+)\s*$/.exec(line)
    if (id !== null) {
      rows.push({ id: id[1] })
      continue
    }
    const key = /^\s*(?:-\s+)?([A-Za-z_][\w-]*)\s*:/.exec(line)
    if (key !== null) {
      keys.add(key[1])
      if (rows.length > 0 && key[1] === 'name') rows[rows.length - 1].name = line.split(':').slice(1).join(':').trim()
    }
  }
  const onlyIdName = [...keys].every((key) => key === 'id' || key === 'name')
  check(
    'bundle patch 只有 id/name（带 config 会让市场无法热挂载）',
    onlyIdName && rows.length === 1 && rows[0].id === 'better-debug' && rows[0].name === 'dsh-better-debug',
    `keys=${[...keys].join(',')} rows=${JSON.stringify(rows)}`
  )
  // 这条守的是「打出去的 tarball 里是 LF」，而 npm pack 直接读工作区文件，
  // 所以工作区是 CRLF 就等于发了个坏包。CRLF 从哪来：Windows 上
  // core.autocrlf=true（GitHub Actions 的 windows runner 默认就是）会把
  // checkout 出来的文件全转成 CRLF —— 仓库里没有 .gitattributes 时必现。
  // 修法是仓库根目录的 .gitattributes 里 `cordis.patch.yml text eol=lf`，
  // 不是放宽这条断言：断言红了说明真要发出去的包是坏的。
  const crlf = /\r/.test(patch)
  check(
    'bundle patch 是 LF（CRLF 会让市场的注释剥离失效，永远读成含 config）',
    crlf === false,
    crlf
      ? 'contains CR —— 检查 .gitattributes 里 cordis.patch.yml 是否 eol=lf，以及本地 core.autocrlf'
      : 'LF'
  )
}

// ── 28h. DSH 版本范围必须写在顶层 engines.dsh
//
// 这条守的是又一个「声明了但没人读」：
//   · 宿主 @deepseek-ai/dsh-app-boot 的 unmetRequirements() 读的是
//     `Object.hasOwn(fields,'engines') ? fields.engines.dsh : …`，
//   · 市场的 dshmarket/lib/verify.js:252 读的也是 `manifest.engines?.dsh`，
//   · 市场每日 probe 回填的 enginesDsh 也取自 manifest.engines.dsh。
// 把范围写在 dsh.engines.dsh（读起来更"DSH 味道"）没有任何代码读它 —— 实测
// evaluatePluginCompatibility({engines:{dsh:'>=9.0.0'}}) 会被拦下，而同样不满足的
// 嵌套写法返回 undefined（视为满足）。后果不是崩溃，是宿主/市场永远不会因为
// 版本太旧而拒装，装上去才在运行期炸。
{
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const range = pkg.engines?.dsh
  check(
    'package.json 的 DSH 版本范围写在顶层 engines.dsh（宿主与市场只读这个位置）',
    typeof range === 'string' && range.trim() !== '',
    `engines.dsh=${JSON.stringify(range)}`
  )
  const dead = pkg.dsh?.engines?.dsh
  check(
    '没有残留的 dsh.engines.dsh 死声明（没有代码读这个位置）',
    dead === undefined,
    `dsh.engines.dsh=${JSON.stringify(dead)}`
  )
  check(
    'engines.node 仍然声明（npm install 时要读）',
    typeof pkg.engines?.node === 'string' && pkg.engines.node.trim() !== '',
    `engines.node=${JSON.stringify(pkg.engines?.node)}`
  )
}

// ── 28i. 真实 ESM 栈是 file:/// URL，不能把所有栈塌成一个 episode
//
// 这条守的是「在 Windows 开发机上写、到真项目里就误报」的形态：node 抛异常时栈里
// 写的是 `file:///C:/Users/.../a.mjs:12:29`，而路径正则先撞上 scheme 里的 `e:`，
// 于是目标被认成 `"e:///c"` —— 三个不同文件的报错全塌成同一个 episode，B 信号对
// 任何「不同文件各错一次」都误报。同一个正则还把路径里的数字归一（`a1.js` 与
// `a2.js` 变成同一个），那是另一种塌陷。
{
  const alphaStack =
    "TypeError: Cannot read properties of undefined (reading 'x')\n" +
    '    at parse (file:///C:/Users/u/proj/alpha/lib/parse.mjs:12:29)\n' +
    '    at file:///C:/Users/u/proj/alpha/index.mjs:2:1'
  const betaStack = alphaStack.replace(/alpha/g, 'beta').replace('parse.mjs', 'other.mjs')
  const posixStack =
    "TypeError: boom\n    at f (file:///home/u/proj/alpha/lib/parse.mjs:9:11)"

  const cases = [
    [samePath(errorTargetOf(alphaStack), 'C:/Users/u/proj/alpha/lib/parse.mjs'), `windows 栈取出真路径（得到 ${errorTargetOf(alphaStack)}）`],
    [errorTargetOf(alphaStack) !== errorTargetOf(betaStack), '两个不同文件不是同一个目标'],
    [samePath(errorTargetOf(posixStack), '/home/u/proj/alpha/lib/parse.mjs'), `posix 栈取出真路径（得到 ${errorTargetOf(posixStack)}）`],
    [
      errorTargetOf("ENOENT: open 'C:/work/src/a1.js'") !== errorTargetOf("ENOENT: open 'C:/work/src/a2.js'"),
      '路径里的数字不归一（a1.js ≠ a2.js）'
    ],
    [
      errorTargetOf("ENOENT: open 'C:/work/proj1/a.js'") !== errorTargetOf("ENOENT: open 'C:/work/proj2/a.js'"),
      '目录名里的数字不归一（proj1 ≠ proj2）'
    ],
    [samePath(errorTargetOf('file:///C:/a/b.mjs:12:29'), 'C:/a/b.mjs'), '行号列号仍然剥掉'],
    [
      errorTargetOf('file:///C:/a/b.mjs:12:29') === errorTargetOf('file:///C:/a/b.mjs:99:3'),
      '同一文件不同行号仍是同一目标'
    ]
  ]
  const bad = cases.filter(([pass]) => !pass).map(([, label]) => label)
  check('file:/// 栈与路径内数字（目标识别）', bad.length === 0, bad.length === 0 ? `${cases.length} 项` : bad.join(', '))

  // 指纹同样要认 file:///，否则行号抖动之下指纹全是同一个
  const fpAlpha = errorFingerprint(alphaStack)
  const fpAlphaAgain = errorFingerprint(alphaStack.replace(':12:29', ':77:4'))
  check('file:/// 栈的指纹稳定（同文件不同行号同指纹）', fpAlpha === fpAlphaAgain, `${fpAlpha} / ${fpAlphaAgain}`)
}

// ── 28j. 端到端：两个不同文件的报错不得触发 B
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const stack = (dir) =>
    "TypeError: Cannot read properties of undefined (reading 'x')\n" +
    `    at parse (file:///C:/Users/u/projects/${dir}/lib/parse.mjs:12:29)`
  const steps = [
    [(s, c) => fail('c1', stack('alpha'))(s, c)],
    [(s, c) => fail('c2', stack('beta'))(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check('B: 两个不同文件的真实栈不触发（不能塌成一个 episode）', injected.length === 0, `injections=${injected.length}`)
}

// ── 28j-2. 端到端：同一个文件的同一个报错吃两次，B 必须响
//
// 与 28j 成对：上面证明「不塌」，这条证明「没被顺手关掉」。只做前者的话，
// 把 B 整个禁掉也能绿。
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const stack =
    "TypeError: Cannot read properties of undefined (reading 'x')\n" +
    '    at parse (file:///C:/Users/u/projects/alpha/lib/parse.mjs:12:29)'
  const steps = [
    [(s, c) => fail('d1', stack)(s, c)],
    [(s, c) => fail('d2', stack.replace(':12:29', ':12:31'))(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check(
    'B: 同一文件同一报错两次仍然触发',
    injected.length === 1 && Boolean(has(injected, '同一个操作重复报错')),
    `injections=${injected.length}`
  )
}

// ── 28k. 测量的管辖范围必须认 `cd <dir> && …` 这种真实写法
//
// 这条守的是一个真事故：`measureDirs` 把命令里抓到的路径一律当**文件**取父目录，
// 于是 `cd /home/u/projB && npm test` 被剥成 `/home/u` —— 它是 projA 的祖先，
// 一次兄弟目录的测试就把 projA 的盲改计数洗白了。而所有用例都只写 `workdir`，
// 从来没写过 `cd` 形式，所以这条一直没被测到。
{
  const cases = [
    [[...measureDirs({ command: 'cd /home/u/projB && npm test' })], ['/home/u/projB'], 'POSIX cd 绝对路径'],
    [[...measureDirs({ command: 'cd C:/work/projB && npm test' })], ['C:/work/projB'], 'Windows cd 绝对路径'],
    [[...measureDirs({ workdir: '/home/u', command: 'cd projB && npm test' })].sort(), ['/home/u', '/home/u/projB'].sort(), 'cd 相对路径靠 workdir 落地'],
    [[...measureDirs({ command: 'cd projB && npm test' })], [], 'cd 相对又没有 workdir → 不猜'],
    [[...measureDirs({ workdir: '/home/u/projB', command: 'npm test' })], ['/home/u/projB'], 'workdir 原样'],
    [[...measureDirs({ command: 'npm test -- src/a.test.js' })], [], '测试文件路径不带绝对路径 → 不猜'],
    // Git Bash / MSYS 把 C 盘写成 /c：不归一就会和写入侧的 C:/ 永不相等（30j 的根因）。
    [[...measureDirs({ command: 'cd /c/work/projB && npm test' })], ['c:/work/projB'], 'MSYS 盘符方言归一'],
    [[...measureDirs({ command: 'cd /usr/local && npm test' })], ['/usr/local'], '首段不是单个字母 → 不动'],
    // WSL 把 C 盘挂在 /mnt/c：同一台机器上 bash 走 WSL、写文件走 Windows 时同样不相交。
    [[...measureDirs({ command: 'cd /mnt/c/work/projB && npm test' })], ['c:/work/projB'], 'WSL 挂载点方言归一'],
    [[...measureDirs({ command: 'cd /mnt/data/x && npm test' })], ['/mnt/data/x'], '挂载点不是单个字母 → 不动']
  ]
  const bad = cases
    .filter(([actual, expected]) => !sameDirs(actual, expected))
    .map(([, , label]) => label)
  check('measureDirs 认 cd 形式', bad.length === 0, bad.length === 0 ? `${cases.length} 项` : bad.join(', '))
}

// ── 28l. 端到端：兄弟目录的测试不得洗白这个目录的盲改
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const mine = '/home/u/projA/src/a.js'
  const steps = [
    [(s, c) => edit(mine)(s, c)],
    [(s, c) => edit(mine)(s, c)],
    [(s, c) => measure('m1', { command: 'cd /home/u/projB && npm test', exit: 0 })(s, c)],
    [(s, c) => edit(mine)(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check('A: 兄弟目录的测量（cd 形式）不清这个目录的盲改', injected.length > 0, `injections=${injected.length}`)
}

// ── 30. F 正例：同一个目标换出三种不同报错 → 方案层闸门开口
//
// B 只说「这一个错重复了」，F 说「这里已经换了几种错」——后者才是
// 「改来改去只换来下一个错误」的形状。两者会同时满足，所以还要断言
// B 被压掉：留着它只是把同一件事说两遍。
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const at = (msg) => `${msg}\n    at parse (file:///C:/work/src/a.mjs:12:29)`
  const steps = [
    [(s, c) => fail('f1', at('TypeError: alpha is not a function'))(s, c)],
    [(s, c) => fail('f2', at('RangeError: beta out of bounds'))(s, c)],
    [(s, c) => fail('f3', at('SyntaxError: gamma unexpected token'))(s, c)],
    [(s, c) => fail('f4', at('TypeError: alpha is not a function'))(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  const hit = has(injected, '种不同报错')
  check('F: 同一目标三种指纹四次报错 → 注入 F', injected.length === 1 && Boolean(hit), `injections=${injected.length}`)
  check(
    'F: 命中时压掉 B（同一件事不说两遍）',
    Boolean(hit) && !hit.texts.some((t) => t.includes('同一个操作重复报错')),
    hit ? hit.texts[0].slice(0, 40) : 'no inject'
  )
}

// ── 30b. F 的重新武装：搜过之后，换一个目标再堆出新族，必须能再响一次
//
// 这条守的是一个真实死代码：重新武装原先写在「同族又错一次」的分支里，
// 而族一旦被搜索过，收集端就用同一个条件把它整族跳过 —— 减 fired.F 永远读不到。
//
// 每族的三条报错必须**真的不同**：指纹会把数字归一成 <n>，靠 alpha-1 / alpha-2
// 编号是造不出第二种指纹的（实测踩过，整族只剩一个指纹，F 永远不亮）。
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const at = (file, msg) => `${msg}\n    at parse (file:///C:/work/src/${file}:3:11)`
  const alpha = [
    at('a.mjs', 'TypeError: alpha is not a function'),
    at('a.mjs', 'RangeError: alpha out of bounds'),
    at('a.mjs', 'SyntaxError: alpha unexpected token')
  ]
  const beta = [
    at('b.mjs', 'TypeError: beta is not a function'),
    at('b.mjs', 'RangeError: beta out of bounds'),
    at('b.mjs', 'SyntaxError: beta unexpected token')
  ]
  const steps = [
    [(s, c) => fail('g1', alpha[0])(s, c)],
    [(s, c) => fail('g2', alpha[1])(s, c)],
    [(s, c) => fail('g3', alpha[2])(s, c)],
    [(s, c) => fail('g4', alpha[0])(s, c)],
    [(s, c) => tool('g5', 'web_search', { args: { query: 'TypeError alpha' }, text: 'ok' })(s, c)],
    [(s, c) => fail('g6', beta[0])(s, c)],
    [(s, c) => fail('g7', beta[1])(s, c)],
    [(s, c) => fail('g8', beta[2])(s, c)],
    [(s, c) => fail('g9', beta[0])(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check(
    'F: 搜索之后新目标的新族能再响一次（重新武装没写成死代码）',
    injected.length === 2,
    `injections=${injected.length}`
  )
}

// ── 31. O 正例：同一个失败绿了又回来，且每次之间都有修改 → 振荡
//
// 判据是「同一个失败回来了」，不是「颜色变了」：健康 TDD 每轮的红都是新的，
// 所以必须用同一段断言文本（数字被归一）来喂，才叫回到原地。
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  // 必须带 [exit code: 1]：没有退出码时 ok 判为 true（工具没报错 = 这次跑成功了），
  // 失败的测量就变成一次成功，O 永远数不到翻转。
  const red = 'AssertionError: expected 3 to be 4\n    at C:/work/test/a.test.mjs:12:29\n[exit code: 1]'
  const file = '/work/src/a.js'
  const steps = [
    [(s, c) => edit(file)(s, c), (s, c) => runFail('o1', red)(s, c)],
    [(s, c) => edit(file)(s, c), (s, c) => measure('o2')(s, c)],
    [(s, c) => edit(file)(s, c), (s, c) => runFail('o3', red)(s, c)],
    [(s, c) => edit(file)(s, c), (s, c) => measure('o4')(s, c)],
    [(s, c) => edit(file)(s, c), (s, c) => runFail('o5', red)(s, c)],
    [(s, c) => edit(file)(s, c), (s, c) => measure('o6')(s, c)],
    [(s, c) => edit(file)(s, c), (s, c) => runFail('o7', red)(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  const hit = has(injected, '翻转了')
  check('O: 同一个失败三次回来 → 注入 O', injected.length === 1 && Boolean(hit), `injections=${injected.length}`)
  check('O: 命中时不夹带 P（每次都重新绿过，不是补丁链）', Boolean(hit) && !hit.texts.some((t) => t.includes('轮「验证失败')), hit ? hit.texts[0].slice(0, 40) : 'no inject')
}

// ── 32. P 正例：失败 → 改 → 仍失败，每一轮都换一个新的失败 → 补丁链
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const red = (n) => `AssertionError: case-${n} failed\n    at C:/work/test/a.test.mjs:4:9\n[exit code: 1]`
  const file = '/work/src/a.js'
  const steps = [
    [(s, c) => edit(file)(s, c), (s, c) => runFail('p1', red('one'))(s, c)],
    [(s, c) => edit(file)(s, c), (s, c) => runFail('p2', red('two'))(s, c)],
    [(s, c) => edit(file)(s, c), (s, c) => runFail('p3', red('three'))(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  const hit = has(injected, '轮「验证失败')
  check('P: 连续三轮修出下一个失败 → 注入 P', injected.length === 1 && Boolean(hit), `injections=${injected.length}`)
  check(
    'P: 文案指向「第 n+1 个补丁」而不是再说一次「重复」',
    Boolean(hit) && hit.texts[0].includes('第 4 个补丁'),
    hit ? hit.texts[0].slice(-60) : 'no inject'
  )
}

// ── 33. M 正例：提醒过两次、窗口内只有改没有验证 → 元闸门，且只发一条
//
// 注意动作必须把 step 透传下去（(s, c, st) => …）：futile 的判据是
// 「窗口内没等到转向」，窗口要靠 tool/call 事件里的 step 才算得出来。
// 只写 (s, c) => … 的话 step 是 undefined，pending 永不过期，M 永远不会亮。
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const file = '/work/src/a.js'
  const stack = 'TypeError: boom\n    at C:/work/src/a.mjs:7:2'
  const steps = [
    [(s, c) => edit(file)(s, c)],
    [(s, c) => edit(file)(s, c)],
    [(s, c) => edit(file)(s, c)],
    // 第一动作必须是「既非 verify/search/method 也不在 READ_TOOLS」的调用，
    // 否则它本身就是转向，futile 会被清零、M 永远攒不出来（0.3.6 起读文件算转向）。
    // ops_write 归 edit，正好符合「带病继续改」的语义。
    [(s, c, st) => fail('m1', stack, 'ops_write')(s, c, st)], // 第 4 步 pre-step 落 A
    [(s, c, st) => fail('m2', stack, 'ops_write')(s, c, st)],
    [(s, c, st) => shell('m3')(s, c, st)], // 第 6 步 pre-step 落 B
    [(s, c) => edit(file)(s, c)],
    [(s, c) => edit(file)(s, c)],
    [(s, c) => edit(file)(s, c)],
    [(s, c) => edit(file)(s, c)],
    [(s, c) => edit(file)(s, c)],
    [(s, c, st) => shell('m4')(s, c, st)], // 12 > 4+6 → 第一条 pending 作废
    [(s, c, st) => shell('m5')(s, c, st)], // 13 > 6+6 → 第二条作废，futile=2
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  const metas = injected.filter((entry) => entry.texts.some((t) => t.includes('元观察')))
  check('M: 两次无效注入后落元闸门', metas.length === 1, `meta=${metas.length} injections=${injected.length}`)
  check(
    'M: 独立成条，不夹带 A/B/C/F/O/P 的观察句',
    metas.length === 1 &&
      !metas[0].texts.some(
        (t) =>
          t.includes('同一个文件累计改了') ||
          t.includes('同一个操作重复报错') ||
          t.includes('种不同报错') ||
          t.includes('翻转了') ||
          t.includes('轮「验证失败')
      ),
    metas.length === 1 ? metas[0].texts[0].slice(0, 40) : 'no meta'
  )
  check('M: 一个 turn 只落一次', metas.length === 1, `meta=${metas.length}`)
}

// ── 34. M 反例：每次提醒之后窗口内都有验证 → futile 一直是 0，不落 M
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const file = '/work/src/a.js'
  const steps = [
    [(s, c) => edit(file)(s, c)],
    [(s, c) => edit(file)(s, c)],
    [(s, c) => edit(file)(s, c)],
    [(s, c) => measure('v1')(s, c)], // 第 4 步 pre-step 落 A，随后立即验证
    [(s, c) => edit(file)(s, c)],
    [(s, c) => edit(file)(s, c)],
    [(s, c) => edit(file)(s, c)],
    [(s, c) => measure('v2')(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check(
    'M 反例：提醒后立刻验证 → 不落元闸门',
    injected.every((entry) => entry.texts.every((t) => !t.includes('元观察'))),
    `injections=${injected.length}`
  )
}

// ── 35. 反例：健康 TDD 多轮「失败 → 改 → 通过」不得触发 P / O / M
//
// 这是 F/O/P 最容易误报的形状：颜色来回变、每轮都在改、每轮都有测量。
// 差别只在于每轮的红是**新的**失败，且每轮都真的绿了。
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const red = (n) => `AssertionError: case-${n} not implemented\n    at C:/work/test/a.test.mjs:4:9\n[exit code: 1]`
  const file = '/work/src/a.js'
  const steps = [
    [(s, c) => edit(file)(s, c), (s, c) => runFail('t1', red(1))(s, c)],
    [(s, c) => edit(file)(s, c), (s, c) => measure('t2')(s, c)],
    [(s, c) => edit(file)(s, c), (s, c) => runFail('t3', red(2))(s, c)],
    [(s, c) => edit(file)(s, c), (s, c) => measure('t4')(s, c)],
    [(s, c) => edit(file)(s, c), (s, c) => runFail('t5', red(3))(s, c)],
    [(s, c) => edit(file)(s, c), (s, c) => measure('t6')(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check('反例：健康 TDD 不触发 P / O / M', injected.length === 0, `injections=${injected.length}`)
}

// ── 36. 反例：没有写入的 flaky 交替不算振荡
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const red = 'Error: flaky\n    at C:/work/test/a.test.mjs:9:1\n[exit code: 1]'
  const steps = [
    [(s, c) => runFail('q1', red)(s, c)],
    [(s, c) => measure('q2')(s, c)],
    [(s, c) => runFail('q3', red)(s, c)],
    [(s, c) => measure('q4')(s, c)],
    [(s, c) => runFail('q5', red)(s, c)],
    [(s, c) => measure('q6')(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check('反例：纯测量来回变（无写入）不触发 O', injected.length === 0, `injections=${injected.length}`)
}

// ── 37. 反例：同一条命令原地重跑、不改任何东西，不算补丁链
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const red = (n) => `Error: variant-${n}\n    at C:/work/test/a.test.mjs:2:2\n[exit code: 1]`
  const steps = [
    [(s, c) => runFail('r1', red('x'))(s, c)],
    [(s, c) => runFail('r2', red('y'))(s, c)],
    [(s, c) => runFail('r3', red('z'))(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check('反例：不改只重跑不触发 P', injected.length === 0, `injections=${injected.length}`)
}

// ── 38. 反例：多文件正常重构不触发 F / O / P
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const steps = [
    [(s, c) => edit('/work/src/a.js')(s, c), (s, c) => measure('w1')(s, c)],
    [(s, c) => edit('/work/src/b.js')(s, c), (s, c) => measure('w2')(s, c)],
    [(s, c) => edit('/work/src/c.js')(s, c), (s, c) => measure('w3')(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check('反例：多文件逐处改+测量不触发任何信号', injected.length === 0, `injections=${injected.length}`)
}

// ── 39. 配置：metaGate:false 关掉元闸门，其余信号照旧
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '', metaGate: false })
  const agent = { session: makeSession() }
  const file = '/work/src/a.js'
  const stack = 'TypeError: boom\n    at C:/work/src/a.mjs:7:2'
  const steps = [
    [(s, c) => edit(file)(s, c)],
    [(s, c) => edit(file)(s, c)],
    [(s, c) => edit(file)(s, c)],
    [(s, c) => fail('n1', stack)(s, c)],
    [(s, c) => fail('n2', stack)(s, c)],
    [(s, c) => shell('n3')(s, c)],
    [(s, c) => edit(file)(s, c)],
    [(s, c) => edit(file)(s, c)],
    [(s, c) => edit(file)(s, c)],
    [(s, c) => edit(file)(s, c)],
    [(s, c) => edit(file)(s, c)],
    [(s, c) => shell('n4')(s, c)],
    [(s, c) => shell('n5')(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check(
    'metaGate:false → 没有元闸门，A/B 照旧',
    injected.every((entry) => entry.texts.every((t) => !t.includes('元观察'))) && injected.length === 2,
    `injections=${injected.length}`
  )
}

// ── 40. O 正例：交替振荡（改 A 让 B 红、改 B 让 A 红）也必须能数到
//
// 这是最常见的振荡形态：指纹按 A/B/A/B 轮换。只比对「上一个指纹」的写法在这里
// 会每次 fail 都当成新失败而清零，四面全哑（曾经的实际 bug）。
// 判据改为「绿过的失败又出现」后，A、B 都在近期集合里，第三次失败即可连续计数。
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const redA = 'AssertionError: expected 3 to be 4\n    at C:/work/test/a.test.mjs:12:29\n[exit code: 1]'
  const redB = 'TypeError: cannot read properties of undefined\n    at C:/work/test/b.test.mjs:8:5\n[exit code: 1]'
  const steps = []
  for (let i = 0; i < 8; i += 1) {
    steps.push([(s, c) => edit('/work/src/a.js')(s, c), (s, c) => runFail(`x${i}`, i % 2 === 0 ? redA : redB)(s, c)])
    steps.push([(s, c) => edit('/work/src/b.js')(s, c), (s, c) => measure(`y${i}`)(s, c)])
  }
  steps.push([])
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  const hit = has(injected, '翻转了')
  check('O: 交替振荡（A/B 轮换）能数到翻转并注入', injected.length === 1 && Boolean(hit), `injections=${injected.length}`)
  check(
    'O: 同一轮振荡只提醒一次（不按每次 ok 重新武装）',
    injected.length === 1,
    `injections=${injected.length}`
  )
}

// ── 41. M 反例（搜索版）：提醒后窗口内搜索也算转向 → futile 清零，不落 M
//
// 34 覆盖的是「验证」这条转向路径；搜索是另一条（外部先验），M 的输入必须同样认。
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const file = '/work/src/a.js'
  const search = (id) => tool(id, 'web_search', { args: { query: 'TypeError boom' }, text: 'ok' })
  const steps = [
    [(s, c) => edit(file)(s, c)],
    [(s, c) => edit(file)(s, c)],
    [(s, c) => edit(file)(s, c)],
    [(s, c, st) => search('s1')(s, c, st)], // 第 4 步 pre-step 落 A，随后搜索
    [(s, c) => edit(file)(s, c)],
    [(s, c) => edit(file)(s, c)],
    [(s, c) => edit(file)(s, c)],
    [(s, c, st) => search('s2')(s, c, st)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check(
    'M 反例：提醒后搜索也算转向 → 不落元闸门',
    injected.every((entry) => entry.texts.every((t) => !t.includes('元观察'))),
    `injections=${injected.length}`
  )
}

// ── 42–48. 0.3.0 评审的四条缺陷（每条都有在 0.3.0 上会红的形状）
//
// 共同点：这四条都**不是**本机平台差异，而是判据本身写错了。它们之所以在 0.3.0
// 的 65 条用例下全绿，是因为旧用例只构造了「该响」的形状，没构造「不该响」的形状 ——
// 与 0.2.2 那两次真机 CI 红是同一类问题（断言/用例自己拟合了开发者的习惯）。

// ── 42. P 反例：收敛中的清扫（10 → 9 → 8 → 7 个错）不得算补丁链
//
// 0.3.0 的判据只比写入序号，于是「每轮都变少」也被算成「每轮修出下一个失败」。
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const lint = (n) =>
    `${Array.from({ length: n }, (_, i) => `src/f${i}.js:${i + 1}:5  error  'v${i}' is defined but never used  no-unused-vars`).join('\n')}\n\n✖ ${n} problems (${n} errors, 0 warnings)\n[exit code: 1]`
  const steps = [10, 9, 8, 7].map((n, i) => [
    (s, c) => edit('/work/src/f0.js')(s, c),
    (s, c) => runFail(`lint${i}`, lint(n), { command: 'npm run lint' })(s, c)
  ])
  steps.push([])
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check('P 反例：失败面在收缩（10→9→8→7）不得注入', injected.length === 0, `injections=${injected.length}`)
}

// ── 43. P 反例：同一个错完全没变（改的是别的文件）不得说「修出了下一个失败」
//
// 0.3.0 在这里的文案与事实正好相反：错一个字都没变，却说「每一轮都修出了下一个失败」。
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const same = 'TypeError: Cannot read properties of undefined (reading \'x\')\n    at C:/work/src/a.js:9:3\n[exit code: 1]'
  const steps = [
    [(s, c) => edit('/work/src/x.js')(s, c), (s, c) => runFail('same1', same)(s, c)],
    [(s, c) => edit('/work/src/y.js')(s, c), (s, c) => runFail('same2', same)(s, c)],
    [(s, c) => edit('/work/src/z.js')(s, c), (s, c) => runFail('same3', same)(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  // 这里**不能**断言「总注入为 0」。
  //
  // 「同一个失败一字未变地重复三轮」确实不是补丁链（P 不该说话），但它也不是
  // 「什么都没发生」——它是「同一个错重复了三次」这个事实本身。0.3.1 把两者混成一条
  // 断言（总注入 0），于是 P 一旦按规格退出，这一整类局面就变成**所有信号都不说话**：
  // 实测连续八轮注入 0 次（深审缺陷 1）。规格应该是「P 不说话，但必须有人接管」。
  check(
    'P 反例：同一个错三连（一字未变）不得注入 P',
    !has(injected, '修出了下一个失败'),
    `signals=${injections(injected)}`
  )
  check(
    'P 反例：同一个错三连必须由「重复失败」接管（不能全沉默）',
    has(injected, '重复报错'),
    `signals=${injections(injected)}`
  )
  check('P 反例：同一个错三连不夹带 O / F / M', !has(injected, '翻转了') && !has(injected, '种不同报错') && !has(injected, '元观察'), `signals=${injections(injected)}`)
}

// ── 44. P 反例：逐个修**不同文件**的单条错误 = 换现场，不是补丁链
//
// 集合大小恒为 1、只有路径在换。0.3.0 与「只比集合大小」的中间版本都把它判成补丁链；
// 判据里必须有「换现场直接归零」这一条（宁可漏判，也不要把分头修好说成打转）。
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const rows = [
    ['src/m1.ts', 2322, 'Type string is not assignable to type number'],
    ['src/m2.ts', 2304, "Cannot find name 'foo'"],
    ['src/m3.ts', 2339, "Property 'x' does not exist"],
    ['src/m4.ts', 2554, 'Expected 2 arguments, but got 1']
  ]
  const steps = rows.map(([file, code, message], i) => [
    (s, c) => edit(`/work/${file}`)(s, c),
    (s, c) => runFail(`tsc${i}`, `${file}(10,9): error TS${code}: ${message}\n[exit code: 2]`, { command: 'npx tsc --noEmit' })(s, c)
  ])
  steps.push([])
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check('P 反例：逐个修独立文件（换现场）不得注入', injected.length === 0, `injections=${injections(injected)}`)
}

// ── 45. F 反例：四个不同项目、抽不出目标的 tsc 错误不得塌进同一族
//
// 0.3.0 的 errorTargetOf 只认 V8 栈，tsc 的 `src/a.ts(12,9)` 返回空串 →
// familyKey 全变成 `ops_read_files|`，四个无关项目被算成「同一个目标上换了四种报错」。
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const rows = [
    "projA/src/a.ts(1,1): error TS2304: Cannot find name 'foo'.",
    "projB/src/b.ts(2,1): error TS2339: Property 'x' does not exist.",
    'projC/src/c.ts(3,1): error TS2554: Expected 2 arguments, but got 1.',
    "projD/src/d.ts(4,1): error TS1005: ';' expected."
  ]
  const steps = rows.map((text, i) => [
    (s, c) => edit('/work/src/a.js')(s, c),
    (s, c) => fail(`fam${i}`, text)(s, c)
  ])
  steps.push([])
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  const hit = has(injected, '种不同报错')
  check('F 反例：四个无关项目的报错不得算作同一目标', hit === void 0, `injections=${injections(injected)}`)
}

// ── 46. errorTargetOf 必须认 ≥8 种真实编译器的报错位置写法
//
// 这条是「不要过拟合本机环境」的直接落点：旧用例里只有 V8 栈一种格式，
// 换编译器（tsc / cargo / pytest / go / mypy / webpack）就全哑。
{
  const rows = [
    ['tsc 相对路径（括号行号）', 'src/a.ts(12,9): error TS2322: Type string is not assignable', 'src/a.ts'],
    ['tsc 绝对路径', 'C:/repo/src/a.ts(12,9): error TS2322: x', 'C:/repo/src/a.ts'],
    ['C# 反斜杠路径', 'C:\\repo\\src\\a.cs(12,9): error CS0103: y', 'C:/repo/src/a.cs'],
    ['cargo', 'src/main.rs:12:9: error[E0308]: mismatched types', 'src/main.rs'],
    ['pytest', 'tests/test_a.py::test_foo FAILED', 'tests/test_a.py'],
    ['go', './main.go:12:5: undefined: Foo', './main.go'],
    ['python 绝对路径', '/home/u/repo/src/a.py:12: error: bad', '/home/u/repo/src/a.py'],
    ['webpack', 'ERROR in ./src/index.js 5:0-20', './src/index.js'],
    ['mypy', 'src/app/main.py:3: error: Incompatible return value', 'src/app/main.py'],
    ['V8 栈（file:/// URL）', '    at parse (file:///C:/work/src/a.mjs:12:29)', 'C:/work/src/a.mjs'],
    // Windows 上的编译器用的是反斜杠。相对路径这一支（REL_SOURCE）如果只认 `/`，
    // 那么在 Windows 上跑 tsc / cargo / pytest 时目标全是空串 —— 与 0.3.0 的
    // 「抽不出目标就整族塌陷」是同一个后果，只是换了触发条件。
    ['tsc 反斜杠相对路径', 'src\\lib\\a.ts(12,9): error TS2322: x', 'src/lib/a.ts'],
    ['cargo 反斜杠相对路径', 'src\\main.rs:12:9: error[E0308]', 'src/main.rs'],
    ['pytest 反斜杠相对路径', 'tests\\test_a.py::test_foo FAILED', 'tests/test_a.py']
  ]
  const bad = rows.filter(([, text, expected]) => !samePath(errorTargetOf(text), expected))
  check(
    'errorTargetOf: 13 种编译器写法都能抽出路径',
    bad.length === 0,
    bad.map(([label, text]) => `${label}→${JSON.stringify(errorTargetOf(text))}`).join(', ') || 'all ok'
  )
  // 反向：不是路径的东西不能被当成路径。`7/8`、`and/or`、`TCP/IP` 都是真出现过的噪声。
  check(
    'errorTargetOf: 分数 / 连词 / 缩写不误判成路径',
    errorTargetOf('7/8 and/or TCP/IP 12/25').length === 0,
    JSON.stringify(errorTargetOf('7/8 and/or TCP/IP 12/25'))
  )
}

// ── 47. O 反例：另一条回路变绿，不得解除这条回路的静音
//
// 0.3.0 清的是**全局** fired.O，于是任何新命令首次 ok（flips 天然是 0）都会把别人的
// 静音解除 —— 同一局面在 step 8 说一次，夹两条 `npm run lint` 的成功之后再在 step 12
// 说一次，两次文案逐字相同。静音必须属于「这一条回路」。
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const red = 'AssertionError: expected 3 to be 4\n    at C:/work/test/a.test.mjs:12:29\n[exit code: 1]'
  const file = '/work/src/a.js'
  const steps = []
  // 三轮「红 → 绿」：flips 走到 3
  for (let i = 0; i < 3; i += 1) {
    steps.push([(s, c) => edit(file)(s, c), (s, c) => runFail(`r${i}`, red)(s, c)])
    steps.push([(s, c) => edit(file)(s, c), (s, c) => measure(`g${i}`)(s, c)])
  }
  steps.push([(s, c) => edit(file)(s, c), (s, c) => runFail('r9', red)(s, c)]) // 第 7 步：flips 到 3
  steps.push([]) // 第 8 步 pre-step：第一次开口
  // 另一条全新回路连续两次成功 —— 0.3.0 会在这里把全局 fired.O 清零
  steps.push([(s, c) => edit(file)(s, c), (s, c) => measure('l1', { command: 'npm run lint' })(s, c)])
  steps.push([(s, c) => edit(file)(s, c), (s, c) => measure('l2', { command: 'npm run lint' })(s, c)])
  steps.push([(s, c) => edit(file)(s, c), (s, c) => runFail('r10', red)(s, c)]) // 第 11 步：flips 到 4
  steps.push([]) // 第 12 步：必须已经静音
  steps.push([])
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  const hits = injected.filter((entry) => entry.texts.some((t) => t.includes('翻转了')))
  check(
    'O 反例：另一条回路变绿不得解除这条回路的静音',
    hits.length === 1,
    `O 注入 ${hits.length} 次（step ${hits.map((h) => h.step).join(',') || '-'}）`
  )
}

// ── 48. F 正例：搜索之后，同一目标又堆出全新指纹，必须还能响
//
// 0.3.0 比的是族的 firstClock，一次搜索就把这一族**终生**免责 —— 与 F 想抓的
// 「改来改去只换来下一个错」正好相反。改成比 lastNewClock（最近一次真的换了个新错）。
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const at = (msg) => `${msg}\n    at parse (file:///C:/work/src/a.mjs:12:29)`
  const steps = [
    [(s, c) => edit('/work/src/a.js')(s, c), (s, c) => fail('s1', at('TypeError: alpha is not a function'))(s, c)],
    [(s, c) => edit('/work/src/a.js')(s, c), (s, c) => fail('s2', at('RangeError: beta out of bounds'))(s, c)],
    [(s, c) => tool('s3', 'web_search', { args: { query: 'TypeError alpha' }, text: 'ok' })(s, c)],
    [(s, c) => edit('/work/src/a.js')(s, c), (s, c) => fail('s4', at('SyntaxError: gamma unexpected token'))(s, c)],
    [(s, c) => edit('/work/src/a.js')(s, c), (s, c) => fail('s5', at('EvalError: delta violated'))(s, c)],
    [(s, c) => edit('/work/src/a.js')(s, c), (s, c) => fail('s6', at('URIError: epsilon malformed'))(s, c)],
    [(s, c) => edit('/work/src/a.js')(s, c), (s, c) => fail('s7', at('ReferenceError: zeta not defined'))(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  const hit = has(injected, '种不同报错')
  check('F: 搜索之后同一目标的新指纹仍能触发（免疫不是终生的）', hit !== void 0, `injections=${injections(injected)}`)
}

// ── 49. B 的搜索基线（深审缺陷 4 的四条验收）
//
// 0.3.1 的触发条件是 `s.lastSearchClock > entry.firstClock`，而 firstClock 创建后
// 永不改变 —— 一次搜索就把这一条 episode **终生**免责：搜索之后同一个错再重复六次
// 也一条都不响。改成「记下搜索当时的计数，之后只数新攒的次数」。
//
// 四条一起测，因为单看任何一条都能用错的方式满足：
//   · 只测「搜索后 1 次不报」→ 沉默到底也能过；
//   · 只测「搜索后达阈值要报」→ 搜索后第一次就报也能过。
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const boom = 'TypeError: x is not a function'
  const steps = [
    [(s, c) => fail('base-1', boom)(s, c)],
    [(s, c) => tool('base-search', 'web_search', { args: { queries: [boom] } })(s, c)],
    [(s, c) => fail('base-2', boom)(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check(
    'B 搜索基线：搜索后只再撞 1 次，还不够阈值 → 不报',
    has(injected, '同一个操作重复报错') === void 0,
    `signals=${injections(injected)}`
  )
}

{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const boom = 'TypeError: y is not a function'
  const steps = [
    [(s, c) => fail('reb-1', boom)(s, c)],
    [(s, c) => tool('reb-search', 'web_search', { args: { queries: [boom] } })(s, c)],
    [(s, c) => fail('reb-2', boom)(s, c)],
    [(s, c) => fail('reb-3', boom)(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  const hit = has(injected, '同一个操作重复报错')
  check(
    'B 搜索基线：搜索后重新攒够 2 次 → 必须报（免疫不是终生的）',
    hit !== void 0,
    `signals=${injections(injected)}`
  )
}

{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const boom = 'TypeError: z is not a function'
  const steps = [
    [(s, c) => fail('re1', boom)(s, c)],
    [(s, c) => fail('re2', boom)(s, c)],
    [(s, c) => tool('re-search', 'web_search', { args: { queries: [boom] } })(s, c)],
    [(s, c) => fail('re3', boom)(s, c)],
    [(s, c) => fail('re4', boom)(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  const hits = injected.filter((entry) => entry.texts.some((t) => t.includes('同一个操作重复报错')))
  check(
    'B 搜索基线：报过一次之后再搜索、再攒够 → 能再说一次（且不超过两次）',
    hits.length === 2,
    `steps=${hits.map((h) => h.step).join(',') || '-'}`
  )
}

{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const boom = 'TypeError: w is not a function'
  const steps = [
    [(s, c) => fail('many-0', boom)(s, c)],
    [(s, c) => tool('many-search', 'web_search', { args: { queries: [boom] } })(s, c)],
    ...Array.from({ length: 6 }, (_, i) => [(s, c) => fail(`many-${i + 1}`, boom)(s, c)]),
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  const hits = injected.filter((entry) => entry.texts.some((t) => t.includes('同一个操作重复报错')))
  // 关键：不能是 0（沉默），也不能是 3（每条重复都各说一次）。
  check(
    'B 搜索基线：搜索后连撞 6 次 → 恰好一次，不沉默也不连发',
    hits.length === 1,
    `steps=${hits.map((h) => h.step).join(',') || '-'}`
  )
}

// ── 50. 失败身份：源位置是噪声，消息里的数字是语义（第二轮深审缺陷 1）
//
// 0.3.2 对整行（路径 + 位置 + 消息）取指纹、保留全部数字，于是 `src/a.ts(12,9)` 与
// `src/a.ts(13,9)` 成了两个不同的失败。但完全相反的做法（把数字全归一成 `<n>`）
// 在 0.3.0/0.3.1 已经证明会把 `case-1` 与 `case-2` 塌成同一条。两种错都必须挡住，
// 所以这节只测行为：位置可以漂，消息里的数字不能塌。
{
  const tscLine = (line) =>
    `src/a.ts(${line},9): error TS2322: Type string is not assignable to type number\n[exit code: 2]`
  const at12 = failureSetOf(tscLine(12))
  const at13 = failureSetOf(tscLine(13))
  check(
    '失败身份：tsc 错误仅行号漂移 → 仍是同一集合（位置是噪声）',
    failureSetKey(at12) === failureSetKey(at13),
    `${failureSetKey(at12)} vs ${failureSetKey(at13)}`
  )
  // 消息里的数字必须保留：`case-1` 与 `case-2` 是两条不同的失败。
  const one = failureSetOf('AssertionError: case-1 failed\n    at C:/work/test/a.test.mjs:4:9\n[exit code: 1]')
  const two = failureSetOf('AssertionError: case-2 failed\n    at C:/work/test/a.test.mjs:4:9\n[exit code: 1]')
  check(
    '失败身份：case-1 与 case-2 不得合并成同一条（数字是语义）',
    failureSetKey(one) !== failureSetKey(two),
    `${failureSetKey(one)} vs ${failureSetKey(two)}`
  )
  // 三步一起看才是完整规格：收缩判定不能被位置漂移打断。
  const shrink = [tscLine(10), tscLine(11).replace('a.ts', 'a.ts') + '\nsrc/b.ts(3,1): error TS2322: x']
  check(
    '失败身份：错误码不变、行号变 → 集合大小不变（不会因漂移看起来像收缩）',
    failureSetOf(shrink[0]).size === 1 && failureSetOf(shrink[1]).size === 2,
    `${failureSetOf(shrink[0]).size} vs ${failureSetOf(shrink[1]).size}`
  )
}

// ── 51. Python 栈帧不是失败本体（第二轮深审缺陷 2，两个方向相反的误报）
{
  const pythonRed = (name, line = 10) =>
    `Traceback (most recent call last):\n  File "C:/work/test_a.py", line ${line}, in test_case\n    assert case == expected\nAssertionError: ${name}\n[exit code: 1]`
  const a = failureSetOf(pythonRed('case-one'))
  const b = failureSetOf(pythonRed('case-two'))
  check(
    'Python：不同断言共用同一栈帧 → 集合必须不同（否则被合并成「重复报错」）',
    failureSetKey(a) !== failureSetKey(b),
    `${failureSetKey(a)} vs ${failureSetKey(b)}`
  )
  // 异常消息必须真的进了集合：把消息行拿掉，集合身份必须变化。
  // 只断言 size === 1 是弱的 —— 0.3.2 那种「用栈帧顶替消息」的错误实现也满足它。
  const noMessage = 'Traceback (most recent call last):\n  File "C:/work/test_a.py", line 10, in test_case\n    assert case == expected\n[exit code: 1]'
  check(
    'Python：异常消息确实是集合的一部分（拿掉消息行 → 身份变化）',
    failureSetKey(a) !== failureSetKey(failureSetOf(noMessage)),
    `${failureSetKey(a)} vs ${failureSetKey(failureSetOf(noMessage))}`
  )
  // 集合里只该有**一条**，且源码回显行（逐字相同）不得混进来。
  check(
    'Python：集合只含一条（栈帧与源码回显都不进集合）',
    a.size === 1,
    `size=${a.size} ${[...a].join(' , ')}`
  )
  // 同一个断言、只有栈帧行号漂移 → 仍是同一条失败。
  const drifted = failureSetOf(pythonRed('case-one', 42))
  check(
    'Python：同一断言仅栈帧行号漂移 → 同一集合',
    failureSetKey(a) === failureSetKey(drifted),
    `${failureSetKey(a)} vs ${failureSetKey(drifted)}`
  )
  // 源码回显行（`    assert case == expected`）逐字相同，绝不能成为公共条目。
  const echoShared = [...a].filter((item) => b.has(item))
  check(
    'Python：源码回显行不得成为两条不同失败的公共条目',
    echoShared.length === 0,
    `shared=${echoShared.join(',') || 'none'}`
  )
}

// ── 52. O 用条目交集判复发（第二轮深审缺陷 3）
{
  const redAt = (file, message) => `AssertionError: ${message}\n    at C:/work/test/${file}.test.mjs:4:9\n[exit code: 1]`
  const ctxA = makeCtx()
  apply(ctxA, { logFile: '' })
  const agentA = { session: makeSession() }
  const steps = [
    [(s, c) => edit('C:/work/src/a1.mjs')(s, c), (s, c) => runFail('o-1', redAt('a', 'base'))(s, c)],
    [(s, c) => measure('o-2')(s, c)],
    [(s, c) => edit('C:/work/src/a2.mjs')(s, c), (s, c) => runFail('o-3', `${redAt('a', 'base')}\nExtra failure at C:/work/test/b.test.mjs:9:1`)(s, c)],
    [(s, c) => measure('o-4')(s, c)],
    [(s, c) => edit('C:/work/src/a3.mjs')(s, c), (s, c) => runFail('o-5', `${redAt('a', 'base')}\nAnother at C:/work/test/c.test.mjs:2:3`)(s, c)],
    [(s, c) => measure('o-6')(s, c)],
    [(s, c) => edit('C:/work/src/a4.mjs')(s, c), (s, c) => runFail('o-7', `${redAt('a', 'base')}\nFourth at C:/work/test/d.test.mjs:7:7`)(s, c)],
    []
  ]
  const injected = await runTurn(ctxA, agentA, { turn: 1, steps })
  const flipped = injected.filter((entry) => entry.texts.some((t) => t.includes('翻转了')))
  check(
    'O：旧失败 A 每次都伴随一条新失败回来 → 仍要认出 A 在复发',
    flipped.length >= 1,
    `steps=${flipped.map((h) => h.step).join(',') || '-'}`
  )
}

// ── 53. 失败测量必须推进幂等状态（第二轮深审缺陷 4）
{
  // 序列：失败A → 失败A（第一次 B）→ 搜索 → 失败A → 失败A（重新达阈值）→ 下一步
  // 这一段 writeSeq 与 errorSeq 都没动，只有 failSeq 会变。闸门若只看前两项，
  // 第二次 B 就被「什么都没变」挡掉（实测只注入 1 次）。
  const boom = 'AssertionError: expected 3 to be 4\n    at C:/work/test/a.test.mjs:12:29\n[exit code: 1]'
  const ctxA = makeCtx()
  apply(ctxA, { logFile: '' })
  const agentA = { session: makeSession() }
  const steps = [
    [(s, c) => runFail('fq-1', boom)(s, c)],
    [(s, c) => runFail('fq-2', boom)(s, c)],
    [(s, c) => tool('fq-3', 'web_search', { args: { queries: ['boom'] } })(s, c)],
    [(s, c) => runFail('fq-4', boom)(s, c)],
    [(s, c) => runFail('fq-5', boom)(s, c)],
    []
  ]
  const injected = await runTurn(ctxA, agentA, { turn: 1, steps })
  const hits = injected.filter((entry) => entry.texts.some((t) => t.includes('同一个操作重复报错')))
  check(
    '失败测量：搜索后重新达阈值 → 第二次 B 不得被幂等闸挡掉（无写入）',
    hits.length === 2,
    `steps=${hits.map((h) => h.step).join(',') || '-'}`
  )
}

// ── 53b. 解析不出条目的失败测量也要推进幂等状态（P1-11 / A4）
//
// 与 53 的区别：那一条的失败**能解析出条目**（failSetKey 非空，episode 会记账）。
// 这一条故意用解析不出任何失败行的输出（只有 `[exit code: 1]`，真实里对应 vitest
// 崩溃、输出被截断、reporter 换了格式），此时没有 episode、B 天然数不到。
// 唯一还能说话的是 A：streakEdits 保留（decayEditsOnVerify=false），一次失败测量
// 之后 fired.A 归零，同一份「改了 3 次」仍然成立 → 应该再说一次。
// 闸门若因为 failSeq 没动而判「什么都没变」，第二次 A 就被自己挡掉（实测只注入 1 次）。
//
// 这条是 P1-11 的验收：failSeq 必须**无条件**推进，不挂在 failSetKey !== '' 里面。
{
  const ctxB = makeCtx()
  apply(ctxB, { logFile: '', decayEditsOnVerify: false })
  const agentB = { session: makeSession() }
  const opaque = '[exit code: 1]'
  const steps = [
    [(s, c) => edit('C:/work/src/p1.js')(s, c)],
    [(s, c) => edit('C:/work/src/p1.js')(s, c)],
    [(s, c) => edit('C:/work/src/p1.js')(s, c)],
    [(s, c) => runFail('pf-1', opaque)(s, c)],
    []
  ]
  const injected = await runTurn(ctxB, agentB, { turn: 1, steps })
  const hits = injected.filter((entry) => entry.texts.some((t) => t.includes('同一个文件累计改了')))
  check(
    'P1-11：失败测量解析不出条目，也要推进幂等状态（第二次 A 不得被挡）',
    hits.length === 2,
    `steps=${hits.map((h) => h.step).join(',') || '-'} setSize=${failureSetOf(opaque).size}`
  )
  check(
    'P1-11：该夹具确实解析不出条目（否则测的不是这条路径）',
    failureSetOf(opaque).size === 0,
    `size=${failureSetOf(opaque).size}`
  )
}

// ── 54. 第三轮深审：位置归一化与诊断类型（0.3.3 的五个缺陷）
//
// 这一组全部是**解析层**的断言：它们不看注入，只看 `failureSetOf` / `errorTargetOf`
// 的输出。为什么必须单独测解析层：0.3.3 的 46 号用例只验了 `errorTargetOf` 认得
// webpack 的位置形态，没验 `failureSetOf` 的身份**在行号漂移后仍然相同** ——
// 「支持某个编译器」于是只在目标层成立、在身份层不成立（第三轮缺陷 3 的验收缺口）。
{
  // 54a 根目录裸文件名：`a.ts(12,9)`。REL_SOURCE 要求「目录 + 文件名」，
  // 于是裸文件名抽不出目标，位置也就没得剥 → 行号一漂就成了新失败（缺陷 1）。
  const bare12 = 'a.ts(12,9): error TS2322: Type string is not assignable to type number'
  const bare13 = 'a.ts(13,9): error TS2322: Type string is not assignable to type number'
  check('裸文件名：a.ts 应被识别为目标', samePath(errorTargetOf(bare12), 'a.ts'), `actual=${errorTargetOf(bare12)}`)
  check(
    '裸文件名：仅行号漂移 → 同一集合',
    failureSetKey(failureSetOf(bare12)) === failureSetKey(failureSetOf(bare13)),
    `${failureSetKey(failureSetOf(bare12))} vs ${failureSetKey(failureSetOf(bare13))}`
  )

  // 54b 带空格的绝对路径：`C:/work/My Project/src/a.ts(12,9)`。
  // 通用绝对路径正则用 `[^\s"';()]+` 吃到第一个空格就停，目标是 `c:/work/my`，
  // 剩下的 `Project/src/a.ts(12,9)` 留在消息里 —— 于是行号漂移看起来像换了文件（缺陷 2）。
  const spaced12 = 'C:/work/My Project/src/a.ts(12,9): error TS2322: bad'
  const spaced13 = 'C:/work/My Project/src/a.ts(13,9): error TS2322: bad'
  check(
    '带空格路径：目标必须完整（不能截断在第一个空格）',
    samePath(errorTargetOf(spaced12), 'C:/work/My Project/src/a.ts'),
    `actual=${errorTargetOf(spaced12)}`
  )
  check(
    '带空格路径：仅行号漂移 → 同一集合',
    failureSetKey(failureSetOf(spaced12)) === failureSetKey(failureSetOf(spaced13)),
    `${failureSetKey(failureSetOf(spaced12))} vs ${failureSetKey(failureSetOf(spaced13))}`
  )
  // 反例：路径后面紧跟的消息不能被一起吃进目标里。
  // `C:/work/a.ts: error: cannot open` 的目标只能是那个文件，不能是「文件 + 错误开头」。
  check(
    '带空格路径反例：路径后的错误消息不得被吃进目标',
    samePath(errorTargetOf('C:/work/a.ts: error: cannot open file'), 'C:/work/a.ts'),
    `actual=${errorTargetOf('C:/work/a.ts: error: cannot open file')}`
  )

  // 54c webpack 的空格分隔位置范围：`./src/index.js 5:0-20`。
  // 位置不是括号也不是冒号开头，而是「空格 + 行:列-列」，旧 cutLocatorAt 不认（缺陷 3）。
  const webpack5 = 'ERROR in ./src/index.js 5:0-20\nModule build failed: Unexpected token'
  const webpack6 = 'ERROR in ./src/index.js 6:0-20\nModule build failed: Unexpected token'
  check(
    'webpack：空格分隔的位置范围 5:0-20 vs 6:0-20 → 同一集合',
    failureSetKey(failureSetOf(webpack5)) === failureSetKey(failureSetOf(webpack6)),
    `${failureSetKey(failureSetOf(webpack5))} vs ${failureSetKey(failureSetOf(webpack6))}`
  )

  // 54d 含路径的 warning 不得进集合（缺陷 4）。
  // 「含路径」只证明它能定位，不证明它是这次失败。同一个 error 一字不变、
  // 只有无关 warning 的变量名在变，集合若跟着变，P 就把 warning 当成「修出下一个错」。
  const lintError = "src/a.js:12:5  error  'actual' is not defined  no-undef"
  const lintWarn = (name) => `src/a.js:1:1  warning  '${name}' is defined but never used  no-unused-vars`
  check(
    'ESLint：新增无关 warning 不得改变集合',
    failureSetKey(failureSetOf(lintError)) === failureSetKey(failureSetOf(`${lintError}\n${lintWarn('first')}`)),
    `size ${failureSetOf(lintError).size} → ${failureSetOf(`${lintError}\n${lintWarn('first')}`).size}`
  )
  check(
    'ESLint：warning 文案逐轮变化 → 集合不变',
    failureSetKey(failureSetOf(`${lintError}\n${lintWarn('first')}`)) ===
      failureSetKey(failureSetOf(`${lintError}\n${lintWarn('second')}`)),
    `size ${failureSetOf(`${lintError}\n${lintWarn('first')}`).size}`
  )
  // 反例：消息正文里出现 warning 这个词的**真失败**不能被当成 warning 丢掉。
  // 判据只看行首那个严重级别列，不看正文 —— 否则 `AssertionError: warning total mismatch`
  // 会被静默排除，那是从误报换成了漏报。
  check(
    'ESLint 反例：正文含 warning 的真实错误仍要进集合',
    failureSetOf("src/a.js:12:5  error  AssertionError: warning total mismatch  no-undef").size === 1,
    `size=${failureSetOf("src/a.js:12:5  error  AssertionError: warning total mismatch  no-undef").size}`
  )

  // 54e pytest 的 `> assert …` 源码回显（缺陷 5）。
  // 两个不同的断言共用同一个文件、同一行、同样的回显行，只有 `E AssertionError: xxx` 不同。
  // 回显若进集合，就成了一条公共条目 —— O 的「条目交集」判据把健康 TDD 读成「旧失败回来了」。
  const pytest = (name, echo = true) =>
    [
      '============================= FAILURES ==============================',
      '______________________________ test_case ___________________________',
      'tests/test_a.py:10: in test_case',
      '    def test_case():',
      echo ? '>       assert case == expected' : '',
      `E       AssertionError: ${name}`,
      `FAILED tests/test_a.py::test_case - AssertionError: ${name}`
    ]
      .filter((line) => line.length > 0)
      .join('\n')
  const sharedItems = (a, b) => [...a].filter((item) => b.has(item))
  check(
    'pytest：不同断言不得共享 > assert 回显条目',
    sharedItems(failureSetOf(pytest('case-one')), failureSetOf(pytest('case-two'))).length === 0,
    `shared=${JSON.stringify(sharedItems(failureSetOf(pytest('case-one')), failureSetOf(pytest('case-two'))))}`
  )
  check(
    'pytest：不同断言的身份必须不同（E 行是条目本体）',
    failureSetKey(failureSetOf(pytest('case-one'))) !== failureSetKey(failureSetOf(pytest('case-two'))),
    `${failureSetKey(failureSetOf(pytest('case-one')))} vs ${failureSetKey(failureSetOf(pytest('case-two')))}`
  )
  check(
    'pytest：同一断言仅栈帧行号漂移 → 同一集合',
    failureSetKey(failureSetOf(pytest('case-one'))) ===
      failureSetKey(failureSetOf(pytest('case-one').replace('tests/test_a.py:10:', 'tests/test_a.py:11:'))),
    `key=${failureSetKey(failureSetOf(pytest('case-one')))}`
  )
  check('pytest：集合只含一条（栈帧、源码回显、FAILED 汇总都不进）', failureSetOf(pytest('case-one')).size === 1,
    `size=${failureSetOf(pytest('case-one')).size}`)
}

// ── 55. 第四轮深审：路径方言、诊断类型与归属（0.3.4 的六组缺陷）
//
// 这一组和前几组的区别：不再只验「目标抽得对不对」，而是直接验**失败集合的身份**。
// 第三轮的五处修复都停在目标层，于是「目标认得出、身份认不出」的缺陷一路留到第四轮 ——
// 用例 46 验了 errorTargetOf 认 webpack 位置，却没人验 webpack 的集合身份在行号漂移后不变。
{
  // 55a 非 ASCII 路径（缺陷 A）。0.3.4 的路径原子是 ASCII 单词字符类，
  // C:/work/项目/src/a.ts 只截到 C:/work/，测试.ts(12,9) 直接截成空串。
  const zhAbs = (n) => 'C:/work/项目/src/a.ts(' + n + ',9): error TS2322: 类型不匹配'
  check(
    '中文绝对路径：目标必须完整',
    samePath(errorTargetOf(zhAbs(12)), 'C:/work/项目/src/a.ts'),
    'actual=' + errorTargetOf(zhAbs(12))
  )
  check(
    '中文绝对路径：仅行号漂移 → 同一集合',
    failureSetKey(failureSetOf(zhAbs(12))) === failureSetKey(failureSetOf(zhAbs(13))),
    failureSetKey(failureSetOf(zhAbs(12))) + ' vs ' + failureSetKey(failureSetOf(zhAbs(13)))
  )
  check(
    '中文裸文件名：目标必须是文件名本身',
    samePath(errorTargetOf('测试.ts(12,9): error TS2322'), '测试.ts'),
    'actual=' + errorTargetOf('测试.ts(12,9): error TS2322')
  )
  check(
    '两个不同中文文件不得塌成同一目标',
    !samePath(errorTargetOf('C:/work/项目/a.ts(12,9): error'), errorTargetOf('C:/work/项目/b.ts(12,9): error')),
    errorTargetOf('C:/work/项目/a.ts(12,9): error') + ' vs ' + errorTargetOf('C:/work/项目/b.ts(12,9): error')
  )

  // 55b 带空格裸文件名（缺陷 B）。0.3.4 只吃 ASCII 单词字符，my file.ts 塌成 file.ts，
  // 于是三个不同文件变成同一个目标：P 把「逐个修独立文件」误报成补丁链。
  const spacedBare = (name) => name + '(12,9): error TS2322: not assignable'
  check(
    '带空格裸文件名：目标必须完整（不能塌成 file.ts）',
    samePath(errorTargetOf(spacedBare('my file.ts')), 'my file.ts'),
    'actual=' + errorTargetOf(spacedBare('my file.ts'))
  )
  const spacedSets = ['my file.ts', 'other file.ts', 'third file.ts'].map((name) => failureSetOf(spacedBare(name)))
  check(
    '三个带空格文件名互不相同（否则 P 会把逐个修文件读成补丁链）',
    new Set(spacedSets.map((set) => failureSetKey(set))).size === 3,
    spacedSets.map((set) => [...set][0]).join(' , ')
  )
  check(
    '带空格裸文件名：仅行号漂移 → 同一集合',
    failureSetKey(failureSetOf(spacedBare('my file.ts'))) ===
      failureSetKey(failureSetOf('my file.ts(13,9): error TS2322: not assignable')),
    failureSetKey(failureSetOf(spacedBare('my file.ts')))
  )

  // 55c 附注不是失败（缺陷 C）。mypy 的 note 带同一个路径、紧跟在 error 后面，
  // 「含路径就进集合」把它收成第二条条目：error 一字未变、只有 note 文案在变，集合每轮不同。
  const mypy = (extra) => ['src/a.py:10: error: Incompatible return value type', extra].filter((line) => line.length > 0).join('\n')
  check(
    'mypy：增删 note 不得改变集合',
    failureSetKey(failureSetOf(mypy(''))) === failureSetKey(failureSetOf(mypy('src/a.py:10: note: See first for the original declaration'))),
    failureSetOf(mypy('src/a.py:10: note: See first')).size + ' 条'
  )
  check(
    'mypy：note 文案变化不得改变集合',
    failureSetKey(failureSetOf(mypy('src/a.py:10: note: See first'))) ===
      failureSetKey(failureSetOf(mypy('src/a.py:10: note: See second'))),
    failureSetKey(failureSetOf(mypy('src/a.py:10: note: See first')))
  )
  check(
    'mypy：真正新增第二条 error 仍必须改变集合',
    failureSetOf(mypy('') + '\nsrc/b.py:3: error: Name x is not defined').size === 2,
    'size=' + failureSetOf(mypy('') + '\nsrc/b.py:3: error: Name x is not defined').size
  )
  // note 里常挂文档链接，https://… 的 s:// 形状上就是一个盘符路径 ——
  // 抽出来会得到 s://mypy.readthedocs.io/... 这种「目标」，同一处 error 只因链接不同就换目标。
  check(
    'note 里的 URL 不得被当成路径目标',
    errorTargetOf('src/a.py:10: note: See https://mypy.readthedocs.io/en/stable/x.html#y') === '' ||
      samePath(errorTargetOf('src/a.py:10: note: See https://mypy.readthedocs.io/en/stable/x.html#y'), 'src/a.py'),
    'actual=' + errorTargetOf('src/a.py:10: note: See https://mypy.readthedocs.io/en/stable/x.html#y')
  )

  // 55d 测试用例作用域（缺陷 D）。同一文件、同一行、同一句 assert False，只有用例名不同，
  // 用例名不进身份就塌成一条：健康 TDD 每轮新增用例被读成「旧失败回来了」，O 数到翻转。
  const pytestCase = (name, line = 10) => [
    'tests/test_a.py:' + line + ': in ' + name,
    '    def ' + name + '():',
    '>       assert False',
    'E       assert False',
    'FAILED tests/test_a.py::' + name + ' - assert False'
  ].join('\n')
  check(
    'pytest：不同用例即使断言文本相同也必须是不同身份',
    failureSetKey(failureSetOf(pytestCase('test_one'))) !== failureSetKey(failureSetOf(pytestCase('test_two'))),
    failureSetKey(failureSetOf(pytestCase('test_one'))) + ' vs ' + failureSetKey(failureSetOf(pytestCase('test_two')))
  )
  check(
    'pytest：同一用例仅行号漂移 → 同一集合',
    failureSetKey(failureSetOf(pytestCase('test_one'))) === failureSetKey(failureSetOf(pytestCase('test_one', 20))),
    failureSetKey(failureSetOf(pytestCase('test_one')))
  )
  check(
    'pytest：用例名只折进指纹，不新增条目',
    failureSetOf(pytestCase('test_one')).size === 1,
    'size=' + failureSetOf(pytestCase('test_one')).size
  )

  // 55e 异常与栈帧的归属（缺陷 E）。早期只记「最近一条栈帧」，于是
  // AssertionError / at a / AssertionError / at b 里第二条沿用了第一条的目标，
  // 两个不同文件上的两条异常塌成一条 —— 真实收缩被读成「同一个错误没变」。
  const twoAssert = ['AssertionError: shared', '    at C:/work/test/a.test.mjs:4:9', 'AssertionError: shared', '    at C:/work/test/b.test.mjs:4:9'].join('\n')
  const onlyA = ['AssertionError: shared', '    at C:/work/test/a.test.mjs:4:9'].join('\n')
  check(
    '两条同消息不同文件的断言 → 两条条目',
    failureSetOf(twoAssert).size === 2,
    'size=' + failureSetOf(twoAssert).size
  )
  check(
    '收缩到只剩一条时，剩下的那条与单独出现时同一身份',
    failureSetKey(failureSetOf(twoAssert)) !== failureSetKey(failureSetOf(onlyA)) &&
      [...failureSetOf(onlyA)].every((item) => failureSetOf(twoAssert).has(item)),
    [...failureSetOf(onlyA)].join(' , ')
  )
  // 作用域不能跨诊断块继承：pytest 块之后的裸 V8 异常若被染上 ::test_one，
  // 同一个错误在「输出里有没有 pytest 块」两种情形下会得到两个身份。
  const mixedBlocks = [pytestCase('test_one'), 'AssertionError: shared', '    at C:/work/test/a.test.mjs:4:9'].join('\n\n')
  // 断言的是**子集**而不是相等：pytest 块自己还有一条条目，两块合起来当然是两条。
  // 要证明的是「裸异常的身份与它前面有没有 pytest 块无关」—— 被染上 ::test_one 时
  // 这条子集关系就不成立。
  const mixedSet = failureSetOf(mixedBlocks)
  check(
    '作用域不得跨诊断块继承（裸异常的身份与上下文无关）',
    [...failureSetOf(onlyA)].every((item) => mixedSet.has(item)),
    [...failureSetOf(onlyA)].join(' , ') + ' ⊄ ' + [...mixedSet].join(' , ')
  )

  // 55f 普通 Error 不是聚合行（缺陷 F）。AGGREGATE_LINE 的 \d* 可空，
  // 于是 Error: shared 被当成「1 errors」吞掉，3 个错误缩到 2 个时集合形状完全错位。
  const jsError = (name) => 'Error: ' + name + '\n    at C:/work/test/' + name + '.test.mjs:1:1'
  check(
    '普通 Error：3 → 2 → 1 必须表现为条目数 3、2、1',
    failureSetOf([jsError('a'), jsError('b'), jsError('c')].join('\n')).size === 3 &&
      failureSetOf([jsError('a'), jsError('b')].join('\n')).size === 2 &&
      failureSetOf(jsError('a')).size === 1,
    'sizes=' + [
      failureSetOf([jsError('a'), jsError('b'), jsError('c')].join('\n')).size,
      failureSetOf([jsError('a'), jsError('b')].join('\n')).size,
      failureSetOf(jsError('a')).size
    ].join(',')
  )
  check(
    '普通 Error：Error: 开头的行不得被聚合规则吞掉',
    failureSetOf('Error: shared').size === 1,
    'size=' + failureSetOf('Error: shared').size
  )
  check(
    '真实聚合行仍被排除（error 本体不变，只多一行统计）',
    failureSetKey(failureSetOf('src/a.ts(12,9): error TS2322: nope')) ===
      failureSetKey(failureSetOf('src/a.ts(12,9): error TS2322: nope\n\u2716 1 problem (1 error, 0 warnings)')),
    'size=' + failureSetOf('src/a.ts(12,9): error TS2322: nope\n\u2716 1 problem (1 error, 0 warnings)').size
  )
  // webpack 的 ERROR in ./x 5:0-20 是**位置头**，不是失败本体：
  // 位置已经由 cutLocatorAt 剥掉，整行进集合会让同一错误在行号漂移后多出一条。
  const webpackAt = (n) => 'ERROR in ./src/index.js ' + n + ':0-20\nModule build failed: Unexpected token'
  check(
    'webpack：位置头不进条目（集合只含模块构建失败那一条）',
    failureSetOf(webpackAt(5)).size === 1 &&
      failureSetKey(failureSetOf(webpackAt(5))) === failureSetKey(failureSetOf(webpackAt(6))),
    'size=' + failureSetOf(webpackAt(5)).size + ' ' + [...failureSetOf(webpackAt(5))].join(' , ')
  )

  // 55g 全绿输出不产条目。看着像小事，实际是「失败集合」的语义底线：
  // 一份没有任何失败的输出若还返回一条条目，O/B 两个信号会把「测试全绿」当失败计数，
  // 而且这条假条目每次行号一变就换个指纹，反复触发「新失败」。
  const greenJest = [
    'PASS src/a.test.js',
    '  \u2713 handles TypeError gracefully (3 ms)',
    '  \u2713 rejects bad input (2 ms)',
    '',
    'Tests: 2 passed, 2 total'
  ].join('\n')
  check(
    '全绿输出（jest 通过行 + 汇总）不得产出任何失败条目',
    failureSetOf(greenJest).size === 0,
    [...failureSetOf(greenJest)].join(' , ') || '(empty)'
  )
  check(
    '单个通过行（TAP ok N / vitest 勾）不得产出失败条目',
    failureSetOf('ok 1 - parses input').size === 0 &&
      failureSetOf('  \u2713 handles TypeError gracefully').size === 0,
    'tap=' + failureSetOf('ok 1 - parses input').size + ' vitest=' + failureSetOf('  \u2713 handles TypeError gracefully').size
  )
  check(
    '只有聚合行时不得产出失败条目（统计不是失败）',
    failureSetOf('\u2716 10 problems (10 errors, 0 warnings)').size === 0,
    [...failureSetOf('\u2716 10 problems (10 errors, 0 warnings)')].join(' , ') || '(empty)'
  )
  // 反面：全绿里混一条真失败，条目只能是那一条 —— 排除逻辑不能把失败一起排掉。
  const failOnly =
    '  \u2717 rejects bad input\n    expect(received).toBe(expected)\n    at Object.<anonymous> (C:/w/a.test.js:5:9)'
  const greenPlusOne = greenJest + '\n  \u2717 rejects bad input\n    expect(received).toBe(expected)\n    at Object.<anonymous> (C:/w/a.test.js:5:9)'
  check(
    '全绿里混一条真失败时，只报那一条（排除不能吃掉失败）',
    failureSetKey(failureSetOf(greenPlusOne)) === failureSetKey(failureSetOf(failOnly)),
    [...failureSetOf(greenPlusOne)].join(' , ')
  )
  // PASS_THROUGH 这类以 PASS 开头但不是通过行的 token 不能被行首锚定误伤。
  check(
    'PASS_THROUGH error 仍算失败（PASS_LINE 只吃行首独立的 PASS）',
    failureSetOf('PASS_THROUGH error at src/a.js:1:1').size === 1,
    [...failureSetOf('PASS_THROUGH error at src/a.js:1:1')].join(' , ')
  )
  // 55h 全绿的**套件形态**同样不产条目。node:test 的 spec reporter、mocha、vitest
  // 各有一套不带冒号的统计行；早期只认 `Tests: 2 passed` 这种带冒号写法，于是全绿的
  // mocha / vitest / node:test 运行仍各造一条假条目，而且套件名或耗时一改就换指纹 ——
  // 「测试全绿」被读成「有失败」，还每轮都是「新失败」。
  const greenNodeTest = [
    'TAP version 13',
    '\u25b6 TypeError handling',
    '  \u2714 works (1ms)',
    '  \u2139 tests 2',
    '  \u2139 pass 2',
    '  \u2139 fail 0',
    '  \u2139 duration_ms 5.1',
    '\u2714 TypeError handling (5.1ms)'
  ].join('\n')
  const greenMocha = ['  my suite', '    \u2714 works (2ms)', '  1 passing (5ms)'].join('\n')
  const greenVitest = [' Test Files  1 passed (1)', '      Tests  2 passed (2)'].join('\n')
  check(
    'node:test / mocha / vitest 的全绿输出也不得产出失败条目',
    failureSetOf(greenNodeTest).size === 0 &&
      failureSetOf(greenMocha).size === 0 &&
      failureSetOf(greenVitest).size === 0,
    'node:test=' + ([...failureSetOf(greenNodeTest)].join(' , ') || '(empty)') +
      ' mocha=' + ([...failureSetOf(greenMocha)].join(' , ') || '(empty)') +
      ' vitest=' + ([...failureSetOf(greenVitest)].join(' , ') || '(empty)')
  )
  // 套件标题里的异常类型名（`\u25b6 TypeError handling`）只是词，不是失败：
  // 类型名只有在「类型名 + 冒号或行尾」的消息形态下才算信号。改了套件名不该换身份。
  check(
    '套件名里的异常类型名不算失败，改名也不换身份',
    failureSetOf(greenNodeTest).size === failureSetOf(greenNodeTest.split('TypeError').join('RangeError')).size &&
      failureSetKey(failureSetOf(greenNodeTest)) === failureSetKey(failureSetOf(greenNodeTest.split('TypeError').join('RangeError')))
  )
  // 反面：真正的异常消息仍然是失败，收紧不能把这一层一起吃掉。
  check(
    'TypeError: x is not a function 仍是失败（收紧只针对套件标题）',
    failureSetOf('TypeError: x is not a function\n    at foo (a.js:1:1)').size === 1,
    [...failureSetOf('TypeError: x is not a function\n    at foo (a.js:1:1)')].join(' , ')
  )
}
// ── 56. PTC 执行器（run_code）：子调用必须和普通工具一样被看见
//
// run_code 内部的每次 tools.xxx() 都不走 tool/call，只有 log-only 的
// tool/ptc-dispatch-start / tool/ptc-dispatch。插件原先只认 tool/call，于是
// 「用 run_code 写文件 / 跑测试 / 搜索」这一整层完全不可见：转向不算转向，
// futile 假增长，M 报「提醒没换来转向」，而模型其实已经在跑了。
{
  const cfgLike = {
    measureCommands: /(npm|pnpm)\s+(run\s+)?(test|verify)/i,
    measureIntent: /验证|测试/i
  }
  // 根 run_code 的参数是 code 而不是 command。0.3.5 之前这里一律 false，
  // 于是「在 run_code 里跑测试」既不算测量也解不开 C —— PTC 整层失明。
  // 现在读 code 文本里的命令意图（measureCommands / measureIntent），
  // 命中即算测量；measureDirs 同步从 code 里抽目录，避免一次
  // 「顺手跑了个测试」把所有路径的盲改一起清零。
  check(
    'run_code 里的 npm test 算测量（读 code 文本里的命令意图）',
    isMeasurement('run_code', { code: 'await tools.bash({command:"npm test"})', description: '跑测试' }, cfgLike) === true,
    'isMeasurement(run_code)=' + isMeasurement('run_code', { code: 'await tools.bash({command:"npm test"})' }, cfgLike)
  )
  check(
    'run_code 里没有测量意图的代码不算测量',
    isMeasurement('run_code', { code: 'const x = 1 + 1' }, cfgLike) === false,
    'isMeasurement(plain run_code)=' + isMeasurement('run_code', { code: 'const x = 1 + 1' }, cfgLike)
  )
  check(
    'run_code 归类为 other（不冒充 verify / edit）',
    classifyTool('run_code', false) === 'other' && classifyTool('run_code', true) === 'other',
    classifyTool('run_code', true)
  )

  // 56a. PTC 子调用里的测量算转向：A 提醒之后在 run_code 里跑测试，
  // 不得因为「看不见」而攒出无效注入、最后落 M。
  {
    const ctx = makeCtx()
    apply(ctx, { logFile: '' })
    const agent = { session: makeSession() }
    const file = 'C:/work/src/ptc-a.js'
    const steps = [
      [(s, c) => edit(file)(s, c)],
      [(s, c) => edit(file)(s, c)],
      [(s, c) => edit(file)(s, c)],
      [],
      [(s, c, st) => ptc('rc1', 'ops_bash', 'rc1:ptc:1', { args: { command: 'npm test', description: '跑测试' }, text: '[exit code: 0]' })(s, c, st)],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      []
    ]
    const injected = await runTurn(ctx, agent, { turn: 1, steps })
    check(
      'PTC: run_code 里跑测试算转向，不落 M',
      injected.filter((e) => e.texts.some((t) => t.includes('元观察'))).length === 0,
      'injections=' + injections(injected)
    )
  }

  // 56b. PTC 子调用里的搜索同样算转向。
  {
    const ctx = makeCtx()
    apply(ctx, { logFile: '' })
    const agent = { session: makeSession() }
    const steps = [
      [(s, c) => edit('C:/work/src/ptc-b.js')(s, c)],
      [(s, c) => edit('C:/work/src/ptc-b.js')(s, c)],
      [(s, c) => edit('C:/work/src/ptc-b.js')(s, c)],
      [],
      [(s, c, st) => ptc('rc2', 'web_search', 'rc2:ptc:1', { args: { queries: ['x'] }, text: 'results' })(s, c, st)],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      []
    ]
    const injected = await runTurn(ctx, agent, { turn: 1, steps })
    check(
      'PTC: run_code 里搜索算转向，不落 M',
      injected.filter((e) => e.texts.some((t) => t.includes('元观察'))).length === 0,
      'injections=' + injections(injected)
    )
  }

  // 56c. PTC 子调用的失败要进 episode：同一个错两次仍然触发 B。
  {
    const ctx = makeCtx()
    apply(ctx, { logFile: '' })
    const agent = { session: makeSession() }
    const boom = 'TypeError: boom is not a function'
    const steps = [
      [(s, c, st) => ptc('rc3', 'ops_read_files', 'rc3:ptc:1', { args: { path: 'C:/work/a.js' }, text: boom, isError: true })(s, c, st)],
      [(s, c, st) => ptc('rc4', 'ops_read_files', 'rc4:ptc:1', { args: { path: 'C:/work/a.js' }, text: boom, isError: true })(s, c, st)],
      []
    ]
    const injected = await runTurn(ctx, agent, { turn: 1, steps })
    const hit = has(injected, '同一个操作重复报错')
    check('PTC: 子调用里的同一个错两次 → B 仍然响', hit !== void 0, hit ? 'step=' + hit.step : 'no injection')
  }

  // 56d. 根 run_code 的 isError 只是子调用失败的回声：不能把同一次失败数成两次。
  {
    const ctx = makeCtx()
    apply(ctx, { logFile: '' })
    const agent = { session: makeSession() }
    const boom = 'TypeError: echo is not a function'
    const steps = [
      [(s, c, st) => ptc('rc5', 'ops_read_files', 'rc5:ptc:1', { args: { path: 'C:/work/e.js' }, text: boom, isError: true })(s, c, st)],
      []
    ]
    const injected = await runTurn(ctx, agent, { turn: 1, steps })
    check(
      'PTC: 一次子调用失败 + 根回声只算一次（不触发 B）',
      has(injected, '同一个操作重复报错') === void 0,
      'injections=' + injections(injected)
    )
  }

  // 56e. 反面：真正的两次失败（两个不同的 run_code）仍然要数两次。
  {
    const ctx = makeCtx()
    apply(ctx, { logFile: '' })
    const agent = { session: makeSession() }
    const boom = 'TypeError: twice is not a function'
    const steps = [
      [(s, c, st) => ptc('rc6', 'ops_read_files', 'rc6:ptc:1', { args: { path: 'C:/work/t.js' }, text: boom, isError: true })(s, c, st)],
      [(s, c, st) => ptc('rc7', 'ops_read_files', 'rc7:ptc:1', { args: { path: 'C:/work/t.js' }, text: boom, isError: true })(s, c, st)],
      []
    ]
    const injected = await runTurn(ctx, agent, { turn: 1, steps })
    check(
      'PTC: 两个根各自失败一次 → B 照常响（去重不能吃掉真重复）',
      has(injected, '同一个操作重复报错') !== void 0,
      'injections=' + injections(injected)
    )
  }

  // 56f. PTC 子调用里的测量结果要清零盲改计数：A 不该在测量之后立刻再响。
  {
    const ctx = makeCtx()
    apply(ctx, { logFile: '' })
    const agent = { session: makeSession() }
    const file = 'C:/work/src/ptc-c.js'
    const steps = [
      [(s, c) => edit(file)(s, c)],
      [(s, c) => edit(file)(s, c)],
      [(s, c) => edit(file)(s, c)],
      [],
      [(s, c, st) => ptc('rc8', 'ops_bash', 'rc8:ptc:1', { args: { command: 'npm test', workdir: 'C:/work', description: '跑测试' }, text: '[exit code: 0]' })(s, c, st)],
      [(s, c) => edit(file)(s, c)],
      [(s, c) => edit(file)(s, c)],
      []
    ]
    const injected = await runTurn(ctx, agent, { turn: 1, steps })
    const hits = injected.filter((e) => e.texts.some((t) => t.includes('同一个文件')))
    check(
      'PTC: 子调用测量清零盲改计数（测量后只改 2 次不响）',
      hits.length === 1,
      'A 注入 ' + hits.length + ' 次'
    )
  }
}
// ── 57. 第五轮深审：路径方言、异常类型与帧归属（0.3.5 的五个缺陷）
//
// 这一组把第五轮探针里最容易被「优先级 / 方言 / 词表」三件事惄惄改坏的不变量固化成仓库内的断言：
//   A 带空格的相对目录必须整段识别，不能因为「空格之后局部匹配成功」就提前返回；
//   B 裸文件名向左回溯不限固定段数，但碰到诊断前缀词就停（ERROR in my file.ts）；
//   C 方括号路由段是合法路径原子，绝对与相对都要完整，行号漂移不换身份；
//   D E 行属于它前面那一帧，后面的帧属于下一条异常（pytest 方言）；
//   E 异常类型名不能只列 JS 内置名，Python / Java 的类名同样是失败本体。
{
  const spacedRel = (root, line = 12) => root + '/src/a.ts(' + line + ',9): error TS2322: same failure'
  const spacedAbs = (root, line = 12) => 'C:/work/' + root + '/src/a.ts(' + line + ',9): error TS2322: same failure'
  const longBare = (name, line = 12) => name + '.ts(' + line + ',9): error TS2322: same failure'
  const pytestCase = (file, testName, message = 'assert False', line = 10) => [
    file + ':' + line + ': in ' + testName,
    '    def ' + testName + '():',
    '>       ' + message,
    'E       ' + message,
    'FAILED ' + file + '::' + testName + ' - ' + message
  ].join('\n')
  const pyTrace = (file, exc, line = 10) => [
    'Traceback (most recent call last):',
    '  File "C:/work/' + file + '.py", line ' + line + ', in test_case',
    exc + ': shared'
  ].join('\n')

  // A. 带空格的相对目录。
  check(
    'A: 带空格的相对目录要整段识别',
    samePath(errorTargetOf(spacedRel('my project')), 'my project/src/a.ts'),
    'target=' + errorTargetOf(spacedRel('my project'))
  )
  check(
    'A: 带空格的绝对目录同样整段识别',
    samePath(errorTargetOf(spacedAbs('My Project')), 'C:/work/My Project/src/a.ts'),
    'target=' + errorTargetOf(spacedAbs('My Project'))
  )
  check(
    'A: 行号漂移不换身份',
    failureSetKey(failureSetOf(spacedRel('my project', 12))) === failureSetKey(failureSetOf(spacedRel('my project', 13))),
    'key=' + failureSetKey(failureSetOf(spacedRel('my project', 12)))
  )
  {
    const keys = ['my project', 'other project', 'third project'].map((root) =>
      failureSetKey(failureSetOf(spacedRel(root)))
    )
    check(
      'A: 三个带空格的不同项目不得塔成同一目标',
      new Set(keys).size === 3,
      keys.join(' / ')
    )
  }

  // B. 裸文件名的左回溯范围与停词。
  check(
    'B: 三段空格的裸文件名要整段识别',
    samePath(errorTargetOf(longBare('my long file name')), 'my long file name.ts'),
    'target=' + errorTargetOf(longBare('my long file name'))
  )
  check(
    'B: 诊断前缀不得进入目标（ERROR in my file.ts）',
    samePath(errorTargetOf('ERROR in my file.ts(12,9): error TS2322: same failure'), 'my file.ts'),
    'target=' + errorTargetOf('ERROR in my file.ts(12,9): error TS2322: same failure')
  )
  {
    const keys = ['my long file name', 'other long file name', 'third long file name'].map((n) =>
      failureSetKey(failureSetOf(longBare(n)))
    )
    check(
      'B: 三个不同的长文件名不得塔成同一目标',
      new Set(keys).size === 3,
      keys.join(' / ')
    )
  }
  check(
    'B: a.ts b.ts(12,9) 仍只取后一个文件',
    samePath(errorTargetOf('a.ts b.ts(12,9): error TS2322: same failure'), 'b.ts'),
    'target=' + errorTargetOf('a.ts b.ts(12,9): error TS2322: same failure')
  )

  // C. 方括号路由段。
  const bracketAbs = (line = 12) => 'C:/work/app/[id]/page.tsx(' + line + ',9): error TS2322: same failure'
  const bracketRel = (line = 12) => 'src/app/[id]/page.tsx(' + line + ',9): error TS2322: same failure'
  check(
    'C: 方括号的绝对路径要完整',
    samePath(errorTargetOf(bracketAbs()), 'C:/work/app/[id]/page.tsx'),
    'target=' + errorTargetOf(bracketAbs())
  )
  check(
    'C: 方括号的相对路径要完整',
    samePath(errorTargetOf(bracketRel()), 'src/app/[id]/page.tsx'),
    'target=' + errorTargetOf(bracketRel())
  )
  check(
    'C: [...slug] 这种展开写法同样是合法路由段',
    samePath(errorTargetOf('src/app/[...slug]/page.tsx(12,9): error TS2322: same failure'), 'src/app/[...slug]/page.tsx'),
    'target=' + errorTargetOf('src/app/[...slug]/page.tsx(12,9): error TS2322: same failure')
  )
  check(
    'C: 行号漂移不换身份',
    failureSetKey(failureSetOf(bracketAbs(12))) === failureSetKey(failureSetOf(bracketAbs(13))),
    'key=' + failureSetKey(failureSetOf(bracketAbs(12)))
  )
  check(
    'C: [id] 与 [...slug] 两个路由不得塔成同一目标',
    failureSetKey(failureSetOf(bracketAbs(12))) !== failureSetKey(failureSetOf('src/app/[...slug]/page.tsx(12,9): error TS2322: same failure')),
    'key=' + failureSetKey(failureSetOf(bracketAbs(12)))
  )

  // D. pytest 方言：帧在前，E 行在后，后面的帧不是自己的帧。
  {
    const twoSame = pytestCase('tests/a.py', 'test_one') + '\n' + pytestCase('tests/b.py', 'test_two', 'assert False', 20)
    const onlyB = pytestCase('tests/b.py', 'test_two', 'assert False', 20)
    const setTwo = failureSetOf(twoSame)
    check(
      'D: 两个连续的 pytest 失败要形成两条',
      setTwo.size === 2,
      'size=' + setTwo.size + ' items=' + [...setTwo].join(', ')
    )
    check(
      'D: 收缩到只剩 B 是严格子集（不是同一个集合）',
      failureSetKey(setTwo) !== failureSetKey(failureSetOf(onlyB)) && failureSetOf(onlyB).size === 1,
      'keys=' + failureSetKey(setTwo) + ' vs ' + failureSetKey(failureSetOf(onlyB))
    )
  }
  check(
    'D: JS 第四轮形态（消息在前、at 帧在后）不回归',
    failureSetOf('AssertionError: one\n    at C:/work/a.test.mjs:4:9\nAssertionError: two\n    at C:/work/b.test.mjs:4:9').size === 2,
    'size=' + failureSetOf('AssertionError: one\n    at C:/work/a.test.mjs:4:9\nAssertionError: two\n    at C:/work/b.test.mjs:4:9').size
  )

  // E. 异常类型名不能只列 JS 内置名。
  {
    const pyNames = ['ValueError', 'KeyError', 'IndexError', 'AttributeError', 'ZeroDivisionError', 'ImportError']
    const six = pyNames.map((exc, i) => pyTrace('f' + i, exc)).join('\n')
    check(
      'E: 六种 Python 异常各成一条（不得退成整段单条目）',
      failureSetOf(six).size === 6,
      'size=' + failureSetOf(six).size
    )
    const three = ['a', 'b', 'c'].map((f) => pyTrace(f, 'ValueError')).join('\n')
    const two = ['a', 'b'].map((f) => pyTrace(f, 'ValueError')).join('\n')
    const one = pyTrace('a', 'ValueError')
    check(
      'E: ValueError 的 3→2→1 是严格子集',
      failureSetOf(three).size === 3 &&
        failureSetOf(two).size === 2 &&
        failureSetOf(one).size === 1 &&
        [...failureSetOf(one)].every((item) => failureSetOf(two).has(item)) &&
        [...failureSetOf(two)].every((item) => failureSetOf(three).has(item)),
      'sizes=' + failureSetOf(three).size + ',' + failureSetOf(two).size + ',' + failureSetOf(one).size
    )
    check(
      'E: JS TypeError 对照仍然是两条',
      failureSetOf('TypeError: shared\n    at C:/work/a.test.mjs:10:1\nTypeError: shared\n    at C:/work/b.test.mjs:10:1').size === 2,
      'size=' + failureSetOf('TypeError: shared\n    at C:/work/a.test.mjs:10:1\nTypeError: shared\n    at C:/work/b.test.mjs:10:1').size
    )
    check(
      'E: 套件标题里的异常类型名不算失败',
      failureSetOf('\u25b6 TypeError handling\n  \u2714 works (1ms)\n\u2139 fail 0').size === 0,
      'size=' + failureSetOf('\u25b6 TypeError handling\n  \u2714 works (1ms)\n\u2139 fail 0').size
    )
  }

  // 这三类常见误伤仍然不得因放宽词表而回来。
  check(
    'E: 文档 URL 不当路径（mypy note 里的链接）',
    errorTargetOf('see https://mypy.readthedocs.io/en/stable/x.html for details') === '',
    'target=' + JSON.stringify(errorTargetOf('see https://mypy.readthedocs.io/en/stable/x.html for details'))
  )
  // 兜底分支对「一条像样但抽不出路径的失败」仍会留一条无目标条目（整段哈希），
  // 那是刻意的：宁可记一条不知道在哪的失败，也不要静默丢掉。这里要守住的是
  // **别把分数当路径**，所以断言的是「没有任何条目带假目标」。
  check(
    'E: 分数与 and/or 不当路径（兜底条目不得带假目标）',
    [...failureSetOf('7/8 and/or TCP/IP 12/25')].every((item) => item.startsWith('|')),
    [...failureSetOf('7/8 and/or TCP/IP 12/25')].join(', ') || 'empty'
  )
}
// ── 28b. 终审合同（第八轮）：路径候选裁决、TAP 元数据、pytest 进度行
{
  // 1. 路径候选裁决要看重叠与包含，不是“谁先命中谁赢”。
  //    「src/项目/[...slug]/page.tsx》里那个裸 `/` 分支抢到的是后缀片段，
  //    早先它一命中就不再计算相对路径，于是整条路径被截成 `/[...slug]/page.tsx`。
  const routeUnicode = 'src/项目/[...slug]/page.tsx'
  const routeCase = routeUnicode + '(12,9): error TS2322: same'
  check(
    '终审1: Unicode 目录 + 路由段的目标不得被截成后缀片段',
    samePath(errorTargetOf(routeCase), routeUnicode),
    'actual=' + JSON.stringify(errorTargetOf(routeCase))
  )
  check(
    '终审1: 路由段目标行号漂移不换身份',
    failureSetKey(failureSetOf(routeUnicode + '(12,9): error TS2322: same')) ===
      failureSetKey(failureSetOf(routeUnicode + '(37,9): error TS2322: same')),
    'keys=' + failureSetKey(failureSetOf(routeCase))
  )
  check(
    '终审1: [id] 与 [...slug] 仍是不同目标',
    !samePath(errorTargetOf(routeCase), errorTargetOf('src/app/[id]/page.tsx(12,9): error TS2322: same')),
    'slug=' + JSON.stringify(errorTargetOf(routeCase)) + ' id=' + JSON.stringify(errorTargetOf('src/app/[id]/page.tsx(12,9): error TS2322: same'))
  )
  // 候选裁决改成通用规则后，这些已经对的形态一个也不能变。
  const routeKeeps = [
    ['ASCII 路由段', 'src/app/[id]/page.tsx(12,9): error TS2322: same', 'src/app/[id]/page.tsx'],
    ['Windows 绝对 + 路由段', 'C:/work/app/[id]/page.tsx(12,9): error TS2322: same', 'C:/work/app/[id]/page.tsx'],
    ['POSIX 带空格与 Unicode', '/home/me/我的 项目/src/a.ts:12:9: error TS2322: same', '/home/me/我的 项目/src/a.ts'],
    ['带空格相对目录', 'my project/src/a.ts(12,9): error TS2322: same', 'my project/src/a.ts'],
    ['带空格裸文件名', 'my long file name.ts(12,9): error TS2322: same', 'my long file name.ts'],
    ['诊断前缀不进目标', 'ERROR in my file.ts(12,9): error TS2322: same', 'my file.ts']
  ]
  for (const [label, text, expected] of routeKeeps) {
    check('终审1: 不回归 — ' + label, samePath(errorTargetOf(text), expected), 'actual=' + JSON.stringify(errorTargetOf(text)))
  }
  check(
    '终审1: URL 与分数仍不当目标',
    errorTargetOf('see https://mypy.readthedocs.io/en/stable/x.html') === '' &&
      [...failureSetOf('7/8 and/or TCP/IP 12/25')].every((item) => item.startsWith('|')),
    'url=' + JSON.stringify(errorTargetOf('see https://mypy.readthedocs.io/en/stable/x.html'))
  )

  // 2. TAP 是结构化协议：`# …` 是诊断注释、`1..1` 是计划、`---`/`...` 之间是 YAML 诊断块。
  //    它们都不带路径，于是全漏进兜底分支，被当成一整段失败。
  const tapGreenShort = ['TAP version 13', 'ok 1 - handles Error objects', '1..1'].join('\n')
  check(
    '终审2: TAP 简式全绿返回空集合',
    failureSetOf(tapGreenShort).size === 0,
    'items=' + [...failureSetOf(tapGreenShort)].join(',')
  )
  // 真实语料：node --test --test-reporter=tap 的原样输出。
  const tapGreenReal = [
    'TAP version 13',
    '# Subtest: handles Error objects',
    'ok 1 - handles Error objects',
    '  ---',
    '  duration_ms: 2.0705',
    "  type: 'test'",
    '  ...',
    '1..1',
    '# tests 1',
    '# suites 0',
    '# pass 1',
    '# fail 0',
    '# cancelled 0',
    '# skipped 0',
    '# todo 0',
    '# duration_ms 269.2532'
  ].join('\n')
  check(
    '终审2: 真实 Node TAP 全绿语料返回空集合',
    failureSetOf(tapGreenReal).size === 0,
    'items=' + [...failureSetOf(tapGreenReal)].join(',')
  )
  // 反例守卫：真失败不能因“排除元数据”而一并吞掉。
  const tapFail = (ms) => [
    'TAP version 13',
    '# Subtest: adds numbers',
    'not ok 1 - adds numbers',
    '  ---',
    '  duration_ms: ' + ms,
    "  type: 'test'",
    "  error: 'expected 3 to equal 4'",
    '  ...',
    '1..1',
    '# tests 1',
    '# pass 0',
    '# fail 1'
  ].join('\n')
  check(
    '终审2: TAP 真失败仍是一条',
    failureSetOf(tapFail('2.0705')).size === 1,
    'size=' + failureSetOf(tapFail('2.0705')).size + ' items=' + [...failureSetOf(tapFail('2.0705'))].join(',')
  )
  check(
    '终审2: TAP 失败的耗时变化不换身份',
    failureSetKey(failureSetOf(tapFail('2.0705'))) === failureSetKey(failureSetOf(tapFail('99.5'))),
    failureSetKey(failureSetOf(tapFail('2.0705'))) + ' vs ' + failureSetKey(failureSetOf(tapFail('99.5')))
  )
  check(
    '终审2: not ok 行本身不得被当成通过行吃掉',
    failureSetOf('not ok 1 - actual failure').size === 1,
    'size=' + failureSetOf('not ok 1 - actual failure').size
  )

  // 3. pytest 进度行：路径 + 点号进度记号，不是失败条目。
  const pytestProgress = 'tests/test_a.py .. [100%]\n2 passed in 0.03s'
  check(
    '终审3: pytest 进度行返回空集合',
    failureSetOf(pytestProgress).size === 0,
    'items=' + [...failureSetOf(pytestProgress)].join(',')
  )
  const pytestProgressForms = [
    'tests/test_a.py . [ 50%]',
    'tests/test_a.py .F. [ 66%]',
    'tests/test_a.py s [ 10%]',
    'tests/test_a.py::test_one PASSED [ 50%]',
    'tests/test_a.py::test_one FAILED [ 50%]'
  ]
  for (const line of pytestProgressForms) {
    check(
      '终审3: 进度行形态 — ' + line,
      failureSetOf(line).size === 0,
      'items=' + [...failureSetOf(line)].join(',')
    )
  }
  check(
    '终审3: 真实 pytest 失败仍进集合（E 行 + 帧）',
    failureSetOf('tests/test_a.py:12: in test_one\n    def test_one():\n>       assert False\nE       AssertionError: same').size === 1,
    'size=' + failureSetOf('tests/test_a.py:12: in test_one\n    def test_one():\n>       assert False\nE       AssertionError: same').size
  )
  check(
    '终审3: 含百分号的真实诊断仍进集合',
    failureSetOf('tests/test_a.py:12: error: expected 100%').size === 1,
    'size=' + failureSetOf('tests/test_a.py:12: error: expected 100%').size
  )
}
// ── 28c. 终审合同（第九轮）：四套真实 runner 输出的身份基线
//
// 为什么要有这一组：此前所有 runner 断言都是「单行 / 两行」的形态断言，没有一份
// **完整输出**。而 errorFingerprint 的塌陷（jest 两种完全不同的失败得到同一指纹）与
// failureSetOf 的假条目（tsc 的 2 条真 error 被撑成 7 条）都只在完整输出里才暴露 ——
// 单行夹具永远测不出来，因为噪声来自 runner 的「自由格式尾巴」，只有整段才有。
//
// 这一组钉三件事：目标是谁、身份可不可区分、集合里到底几条。
//
// 注意 pytestB 那条断言：数字归一（402 与 403 折成同一 errorFingerprint）是**设计取舍**
// 不是缺陷 —— 集合身份由 failureItemFingerprint 承担，它保留消息里的数字。把它写成
// 显式期望，是为了让后来者别把它当 bug「修掉」：真身份在集合里，不在整段指纹里。
{
  const jestA = [
    'PASS test/a.test.js',
    'FAIL test/pay.test.js',
    '  ● pay rejects expired card',
    '',
    '    expect(received).toBe(expected)',
    '',
    '    Expected: 402',
    '    Received: 200',
    '',
    'Test Suites: 1 failed, 1 passed, 2 total',
    'Tests:       1 failed, 1 passed, 2 total',
    'Ran all test suites.'
  ].join('\n')
  const jestB = [
    'PASS test/a.test.js',
    'FAIL test/pay.test.js',
    '  ● pay rejects expired card',
    '',
    '    TypeError: Cannot read properties of undefined (reading amount)',
    '',
    '      at Object.<anonymous> (test/pay.test.js:12:9)',
    '',
    'Test Suites: 1 failed, 1 passed, 2 total',
    'Tests:       1 failed, 1 passed, 2 total',
    'Ran all test suites.'
  ].join('\n')
  const vitestA = [
    ' RUN  v2.1.8 C:/work/proj',
    '',
    ' ❯ test/pay.test.js (3 tests | 1 failed) 12ms',
    '   × pay rejects expired card 8ms',
    '     → expected 200 to be 402',
    '',
    ' Test Files  1 failed (1)',
    '      Tests  1 failed (3)',
    '   Start at  12:04:31',
    '   Duration  412ms'
  ].join('\n')
  const pytestA = [
    '============================= test session starts =============================',
    'platform win32 -- Python 3.12.10, pytest-8.3.4, pluggy-1.5.0',
    'rootdir: C:/work/proj',
    'plugins: cov-5.0.0',
    'collected 2 items',
    '',
    'tests/test_pay.py ..F                                                    [100%]',
    '',
    '=================================== FAILURES ===================================',
    '______________________________ test_expired ___________________________________',
    '',
    '    def test_expired():',
    '>       assert charge() == 402',
    'E       assert 200 == 402',
    '',
    'tests/test_pay.py:12: AssertionError',
    '=========================== short test summary info ===========================',
    'FAILED tests/test_pay.py::test_expired - assert 200 == 402',
    '============================== 1 failed in 0.31s =============================='
  ].join('\n')
  const pytestB = pytestA.replace('test_expired', 'test_currency').replace('assert 200 == 402', 'assert 200 == 403')
  const tscA = [
    '> proj@1.0.0 typecheck',
    '> tsc --noEmit',
    '',
    'src/a.ts(12,9): error TS2322: Type number is not assignable to type string.',
    'src/b.ts(31,3): error TS2345: Argument of type string is not assignable to parameter of type number.',
    '',
    'Found 2 errors in 2 files.',
    '',
    'Errors  Files',
    '     2  src/a.ts:12',
    '     1  src/b.ts:31'
  ].join('\n')

  // ── jest：S1 的原始现场。失败行是 FAIL，断言块在下面；PASS 行必须先被排除，
  //    否则目标会取到通过的那个文件 —— 那正是 0.3.5 之前的真实故障。
  check(
    'golden jest: 目标取 FAIL 的文件，不是 PASS 的文件',
    samePath(errorTargetOf(jestA), 'test/pay.test.js'),
    'target=' + JSON.stringify(errorTargetOf(jestA))
  )
  check(
    'golden jest: 两种不同失败不得塌成同一指纹（S1 回归位）',
    errorFingerprint(jestA) !== errorFingerprint(jestB),
    errorFingerprint(jestA) + ' vs ' + errorFingerprint(jestB)
  )
  const jestSetA = failureSetOf(jestA)
  const jestSetB = failureSetOf(jestB)
  check(
    'golden jest: 断言块（Expected/Received）本身不产生条目',
    jestSetA.size === 1,
    'size=' + jestSetA.size + ' items=' + [...jestSetA].join(',')
  )
  check(
    'golden jest: 换成 TypeError 后集合严格变大（新失败是新身份）',
    jestSetB.size === 2 && [...jestSetA].every((it) => jestSetB.has(it)),
    'A=' + jestSetA.size + ' B=' + jestSetB.size
  )
  check(
    'golden jest: 集合里每一条都指向失败文件',
    [...jestSetA].every((it) => it.startsWith('test/pay.test.js|')),
    [...jestSetA].join(',')
  )
  // ── 大小写：词表判的是**自然语言**，不是路径，折叠必须无条件成立。
  //    修复前这一条用的是 foldCase（按平台折叠），于是 Linux 上 `FAIL` 匹配不到
  //    词表里的 `fail`，回溯把它吃进 token，目标变成 `FAIL test/pay.test.js` ——
  //    同一个文件在 Windows 与 Linux 上是两个身份，A/B 全线错位。
  //    这条断言在任何平台都必须绿（linux 轮之前是红的，正是它抓到的）。
  check(
    '大小写: 全大写前缀词不得被吃进目标（平台无关）',
    samePath(errorTargetOf('FAIL test/pay.test.js'), 'test/pay.test.js'),
    'target=' + JSON.stringify(errorTargetOf('FAIL test/pay.test.js'))
  )
  check(
    '大小写: ERROR 前缀同理（tsc / eslint 形态）',
    samePath(errorTargetOf('ERROR in src/a.ts:12'), 'src/a.ts'),
    'target=' + JSON.stringify(errorTargetOf('ERROR in src/a.ts:12'))
  )

  // ── vitest：` RUN  v2.1.8 <项目根>` 是版本头，不是失败目标。
  //    修复前它抢到了整段目标 c:/work/proj，并把项目根当成一条失败。
  check(
    'golden vitest: RUN 版本头不得成为目标（不得取到项目根）',
    samePath(errorTargetOf(vitestA), 'test/pay.test.js'),
    'target=' + JSON.stringify(errorTargetOf(vitestA))
  )
  check(
    'golden vitest: 整段只有一条失败，不因 Start at / Duration 增条目',
    failureSetOf(vitestA).size === 1,
    'items=' + [...failureSetOf(vitestA)].join(',')
  )
  // 0.3.6 口径变更：不再把数字归一成 <n>。
  // 位置类数字（:line:col）已被 <path> 规则整段吃掉；剩下的数字是失败语义
  // （expected 200 to be 402 / TS2322 / case-1），归一会把不同的失败抹成同一个。
  // 于是「只换期望值」也必须换指纹 —— 这才是 B 判「同一个错」的可靠口径。
  check(
    'golden vitest: 断言里的数字变化必须改变整段指纹（0.3.6 口径）',
    errorFingerprint(vitestA) !== errorFingerprint(vitestA.replace('402', '403')),
    errorFingerprint(vitestA) + ' vs ' + errorFingerprint(vitestA.replace('402', '403'))
  )

  // ── pytest：会话头（platform / rootdir / plugins / collected）与进度行都不许进集合。
  check(
    'golden pytest: 目标取失败文件，不取 rootdir',
    samePath(errorTargetOf(pytestA), 'tests/test_pay.py'),
    'target=' + JSON.stringify(errorTargetOf(pytestA))
  )
  check(
    'golden pytest: 集合里每一条都指向失败文件（会话头未造出 rootdir 条目）',
    [...failureSetOf(pytestA)].every((it) => it.startsWith('tests/test_pay.py|')),
    [...failureSetOf(pytestA)].join(',')
  )
  check(
    'golden pytest: 换用例名 + 换断言数字 → 集合身份改变',
    failureSetKey(failureSetOf(pytestA)) !== failureSetKey(failureSetOf(pytestB)),
    failureSetKey(failureSetOf(pytestA)) + ' vs ' + failureSetKey(failureSetOf(pytestB))
  )
  // 同上：换用例名 + 换断言数字，整段指纹也必须变（0.3.6 口径）。
  // 集合身份与整段指纹在这里终于同向 —— 之前是「集合分得开、指纹塌成一样」，
  // 正是 B 误报与 F 漏报的共同根因。
  check(
    'golden pytest: 换用例名 + 换数字 → 整段指纹也变（0.3.6 口径）',
    errorFingerprint(pytestA) !== errorFingerprint(pytestB),
    errorFingerprint(pytestA) + ' vs ' + errorFingerprint(pytestB)
  )

  // ── tsc：汇总尾部（Found N errors / Errors Files / 计数表行）曾被算成失败条目，
  //    于是「2 个错误」在集合里是 7 条，身份随错误计数漂移。
  const tscSet = failureSetOf(tscA)
  check(
    'golden tsc: 目标取第一条 error 的文件',
    samePath(errorTargetOf(tscA), 'src/a.ts'),
    'target=' + JSON.stringify(errorTargetOf(tscA))
  )
  check(
    'golden tsc: 两条真 error 恰好两条条目（汇总尾部与 npm banner 不进集合）',
    tscSet.size === 2,
    'size=' + tscSet.size + ' items=' + [...tscSet].join(',')
  )
  check(
    'golden tsc: 没有任何条目带空目标（计数表行曾造出 |hash）',
    [...tscSet].every((it) => !it.startsWith('|')),
    [...tscSet].join(',')
  )

  // ── 噪声行逐条：这些行单独喂进去必须一条都不产出。
  //    整段测试只能证明「这一段收敛了」，逐条才能定位是哪个形态漏了。
  const noiseLines = [
    '   Start at  12:04:31',
    '   Duration  412ms',
    ' Ran all test suites.',
    '> proj@1.0.0 typecheck',
    '> tsc --noEmit',
    'Found 2 errors in 2 files.',
    'Errors  Files',
    '     2  src/a.ts:12',
    ' RUN  v2.1.8 C:/work/proj',
    'RUNS  test/a.test.js',
    'tests/test_pay.py ..F                      [ 66%]',
    '> npm run build'
  ]
  for (const line of noiseLines) {
    check(
      'golden 噪声行不产生条目 — ' + line.trim(),
      failureSetOf(line).size === 0,
      'items=' + [...failureSetOf(line)].join(',')
    )
  }
}
// ── 30A. createMeasureSettler：不经过 apply，直接喂状态对象（P1-8 抽工厂的验收）
//
// 抽工厂的全部意义在这里：194 行的测量状态机原先只能靠 runTurn 端到端驱动，
// 想断言「失败面收缩时 repairChain 归零」得先造一整轮工具调用 + 事件顺序，
// 一旦红了只知道「第几步不对」。现在给个裸状态对象就能断言，失败直接指到分支。
const settlerState = (over = {}) => ({
  streakEdits: new Map(),
  blindWrites: 0,
  measureArmed: false,
  wroteWhileArmed: false,
  lastMeasure: void 0,
  fired: { A: 0, B: 0, C: 0, F: 0, P: 0, M: 0 },
  measureSeries: new Map(),
  writeSeq: 0,
  failEpisodes: new Map(),
  clock: 0,
  failSeq: 0,
  repairChain: 0,
  lastFailSet: new Set(),
  lastFailWriteSeq: 0,
  seenFailTargets: new Set(),
  futile: 0,
  ...over
})
const settler = createMeasureSettler({ cfg: { decayEditsOnVerify: true } })
const tscA = "src/a.ts(12,9): error TS2322: Type 'string' is not assignable to type 'number'."
const tscB = "src/b.ts(3,1): error TS2304: Cannot find name 'foo'."

// 30a：测量不带目录 → 全部路径的盲改计数清零（那次测试覆盖了整个工作区）。
{
  const s = settlerState({ streakEdits: new Map([['C:/work/src/a.js', 3]]), blindWrites: 4, measureArmed: true, wroteWhileArmed: true })
  const cleared = settler(s, { tool: 'bash', args: {}, ok: true, exit: 0, atStep: 4, text: 'ok' })
  check('settler 无目录：streakEdits 清空，返回清掉的条数', cleared === 1 && s.streakEdits.size === 0, 'cleared=' + cleared + ' size=' + s.streakEdits.size)
  check('settler 无目录：上膛解除', s.measureArmed === false && s.wroteWhileArmed === false, 'armed=' + s.measureArmed + ' wrote=' + s.wroteWhileArmed)
  check('settler 无目录：盲改计数清零', s.blindWrites === 0, 'blindWrites=' + s.blindWrites)
  check('settler 记下 lastMeasure 并推进 clock', s.lastMeasure?.atStep === 4 && s.lastMeasure.ok === true && s.clock === 1, JSON.stringify(s.lastMeasure) + ' clock=' + s.clock)
}

// 30b：测量带目录 → 只清它管得到的路径（在 C:/other 跑测试不能替 src 洗白）。
{
  const s = settlerState({ streakEdits: new Map([['C:/work/src/a.js', 2], ['C:/other/b.js', 2]]) })
  const cleared = settler(s, { tool: 'bash', args: { command: 'cd C:/work && npm test' }, ok: true, exit: 0, atStep: 5, text: 'ok' })
  check('settler 按目录：只清 C:/work 下的路径', cleared === 1 && s.streakEdits.size === 1 && s.streakEdits.has('C:/other/b.js'), 'cleared=' + cleared + ' left=' + [...s.streakEdits.keys()].join(','))
  check('settler 按目录：还剩没清的路径时不清空整张表', s.streakEdits.size === 1, 'left=' + s.streakEdits.size)
}

// 30c：decayEditsOnVerify=false 是完全关掉这条闸，不是「只关一半」。
{
  const off = createMeasureSettler({ cfg: { decayEditsOnVerify: false } })
  const s = settlerState({ streakEdits: new Map([['C:/work/src/a.js', 3]]), measureArmed: true })
  const cleared = off(s, { tool: 'bash', args: {}, ok: true, exit: 0, atStep: 6, text: 'ok' })
  check('settler 开关关掉：一条都不清', cleared === 0 && s.streakEdits.size === 1 && s.measureArmed === true, 'cleared=' + cleared + ' size=' + s.streakEdits.size)
}

// 30d：ok 测量重新武装 A / C / F / P，并把 futile 清零；B 不在此重新武装。
{
  const s = settlerState({ fired: { A: 2, B: 1, C: 2, F: 1, P: 2, M: 0 }, futile: 3 })
  settler(s, { tool: 'bash', args: {}, ok: true, exit: 0, atStep: 7, text: 'ok' })
  check('settler ok：A/C/F/P 重新武装、B 保持', s.fired.A === 0 && s.fired.C === 0 && s.fired.F === 0 && s.fired.P === 0 && s.fired.B === 1, JSON.stringify(s.fired))
  check('settler ok：futile 清零', s.futile === 0, 'futile=' + s.futile)
}

// 30e：失败测量无条件推进 failSeq —— 哪怕一条条目都解析不出来（P1-11 的直接断言）。
{
  const s = settlerState({ writeSeq: 1, lastFailWriteSeq: 0 })
  settler(s, { tool: 'bash', args: { command: 'npm test' }, ok: false, exit: 1, atStep: 8, text: '[exit code: 1]' })
  check('settler 失败但解析不出条目：failSeq 仍然 +1', s.failSeq === 1, 'failSeq=' + s.failSeq)
  check('settler 失败但解析不出条目：不造 episode', s.failEpisodes.size === 0, 'episodes=' + s.failEpisodes.size)
}

// 30f：P 的三态 —— 严格变小归零、一字未变归零、变了没变小才 +1。
{
  const one = failureSetOf(tscA)
  const two = new Set([...one, ...failureSetOf(tscB)])
  const shrunk = settlerState({ writeSeq: 2, lastFailWriteSeq: 1, repairChain: 2, lastFailSet: two, seenFailTargets: failureTargetsOf(two) })
  settler(shrunk, { tool: 'bash', args: { command: 'npx tsc --noEmit' }, ok: false, exit: 1, atStep: 9, text: tscA })
  check('settler P：失败面严格变小 → repairChain 归零', shrunk.repairChain === 0, 'chain=' + shrunk.repairChain)
  const same = settlerState({ writeSeq: 2, lastFailWriteSeq: 1, repairChain: 2, lastFailSet: one, seenFailTargets: failureTargetsOf(one) })
  settler(same, { tool: 'bash', args: { command: 'npx tsc --noEmit' }, ok: false, exit: 1, atStep: 9, text: tscA })
  check('settler P：一字未变 → 清零且不计数', same.repairChain === 0, 'chain=' + same.repairChain)
  const grew = settlerState({ writeSeq: 2, lastFailWriteSeq: 1, repairChain: 0, lastFailSet: one, seenFailTargets: failureTargetsOf(one) })
  settler(grew, { tool: 'bash', args: { command: 'npx tsc --noEmit' }, ok: false, exit: 1, atStep: 9, text: tscA + '\n' + tscB })
  check('settler P：变了但没变小 → 补丁链 +1', grew.repairChain === 1, 'chain=' + grew.repairChain)
  check('settler P：写入序号被记下，下一轮没有新写入就不再计', grew.lastFailWriteSeq === 2, 'lastFailWriteSeq=' + grew.lastFailWriteSeq)
}

// 30g：O 用条目交集判复发 —— 老失败里又添一条新的，仍算「同一个失败回来了」。
{
  const one = failureSetOf(tscA)
  const key = measureKey('bash', { command: 'npx tsc --noEmit' })
  const recurring = settlerState({ writeSeq: 3, measureSeries: new Map([[key, { lastOk: true, lastWriteSeq: 2, flips: 0, recentFailSets: [[...one]] }]]) })
  settler(recurring, { tool: 'bash', args: { command: 'npx tsc --noEmit' }, ok: false, exit: 1, atStep: 10, text: tscA + '\n' + tscB })
  check('settler O：整集合变了但与历史有交集 → flips +1', recurring.measureSeries.get(key)?.flips === 1, 'flips=' + recurring.measureSeries.get(key)?.flips)
  const fresh = settlerState({ writeSeq: 3, measureSeries: new Map([[key, { lastOk: true, lastWriteSeq: 2, flips: 0, recentFailSets: [[...failureSetOf(tscB)]] }]]) })
  settler(fresh, { tool: 'bash', args: { command: 'npx tsc --noEmit' }, ok: false, exit: 1, atStep: 10, text: tscA })
  check('settler O：零交集（健康 TDD 的新红）→ 不计翻转', fresh.measureSeries.get(key)?.flips === 0, 'flips=' + fresh.measureSeries.get(key)?.flips)
}
// ── 30h：部分清除也解除武装（C 误报的直接根因）
//
// 旧逻辑要求 streakEdits 被清空才算「测过了」。带 workdir 的测量只清它管得到的目录，
// 剩下一条没清就保留 measureArmed + wroteWhileArmed —— 同一个 turn 里于是反复上膛
// 反复开口（实测同一 turn 最多响 3 次，全库 C 占注入的 71%）。
{
  const s = settlerState({
    streakEdits: new Map([['C:/work/src/a.js', 2], ['C:/other/b.js', 2]]),
    blindWrites: 4,
    measureArmed: true,
    wroteWhileArmed: true
  })
  const cleared = settler(s, { tool: 'bash', args: { command: 'cd C:/work && npm test' }, ok: true, exit: 0, atStep: 5, text: 'ok' })
  check('settler 部分清除：cleared===1 但武装照样解除', cleared === 1 && s.measureArmed === false, 'cleared=' + cleared + ' armed=' + s.measureArmed)
  check('settler 部分清除：wroteWhileArmed 解除且盲改计数清零', s.wroteWhileArmed === false && s.blindWrites === 0, 'wrote=' + s.wroteWhileArmed + ' blind=' + s.blindWrites)
  check('settler 部分清除：管不到的路径仍然留着', s.streakEdits.has('C:/other/b.js') && s.streakEdits.size === 1, 'left=' + [...s.streakEdits.keys()].join(','))
}

// ── 30i：失败的测量不重新武装 C（没带来新事实，现场还在）
{
  const s = settlerState({ fired: { A: 1, B: 0, C: 1, F: 0, P: 0, M: 0 } })
  settler(s, { tool: 'bash', args: { command: 'npm test' }, ok: false, exit: 1, atStep: 6, text: '[exit code: 1]' })
  check('settler 失败测量：fired.C 保持 1（不重新武装）', s.fired.C === 1, 'C=' + s.fired.C)
  check('settler 失败测量：fired.A 仍归 0（A 只认新事实，与 C 不同轴）', s.fired.A === 0, 'A=' + s.fired.A)
}

// ── 30j：Git Bash 的 /c/… 方言必须与写入侧的 C:/… 对上（0.3.6 实测 bug）
//
// 真实日志 266 条 measure 里 238 条 cleared=0（89.5%）：本机 bash 工具是 MSYS Git Bash，
// `cd /c/Users/… && npm test` 给出的候选是 `/c/users/…`，写入侧记的是 `C:/Users/…`，
// 两边永不相交 ⇒ 上膛状态永不解除 ⇒ C 在同一个现场反复开口（占注入 72.5%、命中率 8.3%）。
{
  // 两侧统一写小写：这条断言只测「方言归一」，大小写折叠是 foldCase 的事，
  // 而 test:posix / test:linux 变体把 CASE_INSENSITIVE 关掉了，混在一起会红。
  const s = settlerState({
    streakEdits: new Map([['c:/users/x/src/a.js', 3]]),
    blindWrites: 4,
    measureArmed: true,
    wroteWhileArmed: true
  })
  const cleared = settler(s, { tool: 'bash', args: { command: 'cd /c/users/x && npm test' }, ok: true, exit: 0, atStep: 6, text: 'ok' })
  check('settler MSYS 方言：/c/… 与 c:/… 视为同一目录', cleared === 1 && s.streakEdits.size === 0, 'cleared=' + cleared + ' size=' + s.streakEdits.size)
  check('settler MSYS 方言：上膛解除、盲改清零', s.measureArmed === false && s.blindWrites === 0, 'armed=' + s.measureArmed + ' blind=' + s.blindWrites)
  const wrong = settlerState({ streakEdits: new Map([['c:/users/x/src/a.js', 3]]) })
  const other = settler(wrong, { tool: 'bash', args: { command: 'cd /c/users/y && npm test' }, ok: true, exit: 0, atStep: 6, text: 'ok' })
  check('settler MSYS 方言：别的目录仍然不清（不是把 /c/ 一律当 C 盘根）', other === 0 && wrong.streakEdits.size === 1, 'cleared=' + other)

  // WSL 方言：同一条命令经 `wsl.exe -e bash -c` 跑出来，候选是 /mnt/c/users/x。
  const wslState = settlerState({
    streakEdits: new Map([['c:/users/x/src/a.js', 3]]),
    blindWrites: 4,
    measureArmed: true,
    wroteWhileArmed: true
  })
  const wslCleared = settler(wslState, { tool: 'bash', args: { command: 'cd /mnt/c/users/x && npm test' }, ok: true, exit: 0, atStep: 6, text: 'ok' })
  check('settler WSL 方言：/mnt/c/… 与 c:/… 视为同一目录', wslCleared === 1 && wslState.measureArmed === false, 'cleared=' + wslCleared + ' armed=' + wslState.measureArmed)
  const wslOther = settlerState({ streakEdits: new Map([['c:/users/x/src/a.js', 3]]) })
  const wslMiss = settler(wslOther, { tool: 'bash', args: { command: 'cd /mnt/data/x && npm test' }, ok: true, exit: 0, atStep: 6, text: 'ok' })
  check('settler WSL 方言：/mnt/data 不是盘符挂载点，不清', wslMiss === 0 && wslOther.streakEdits.size === 1, 'cleared=' + wslMiss)
}

// ── 31. createDeliverer：不经过 apply，直接断言日志形状与消息形状（P1-8）
//
// 抽工厂的收益就在这里：deliver 过去只能在跑完一整轮、等到某个信号真的开口之后才被间接覆盖，
// 日志字段少一个 / 顺序变了 / sample 忘了截断，都没有断言会红。现在直接喂状态对象。
{
  const delivererState = (over = {}) => ({
    pendings: [],
    lastAction: 'bash',
    edits: new Map(),
    streakEdits: new Map(),
    errors: new Map(),
    searchedThisTurn: false,
    lastMeasure: void 0,
    ...over
  })
  const makeDeliverer = () => {
    const records = []
    const infos = []
    const ctx = { logger: { info: (line) => infos.push(line) } }
    const deliver = createDeliverer({ ctx, record: async (line) => { records.push(line) } })
    return { deliver, records, infos }
  }
  const decision = () => ({ kind: 'inject', messages: [{ role: 'system', content: [] }], reason: 'A' })
  const session = { id: 'sess-1' }

  // 31a. 埋点形状：pendings 是「这次注入之后发生了什么」的唯一来源，字段缺一个就永远收不到结果
  {
    const { deliver } = makeDeliverer()
    const s = delivererState()
    await deliver(session, { turn: 3, step: '7', decision: decision(), s, text: 'hi', tag: 'A', inj: 2, extra: '' })
    const p = s.pendings[0]
    check(
      'deliverer 埋点：atStep 转成数字、before 取注入前的最后动作',
      s.pendings.length === 1 && p.inj === 2 && p.tag === 'A' && p.turn === 3 && p.atStep === 7 && p.before === 'bash',
      JSON.stringify(p)
    )
    check(
      'deliverer 埋点：firstSeen / first / changed 都是初始态',
      p.firstSeen === false && p.first === void 0 && p.changed === false,
      JSON.stringify(p)
    )
  }

  // 31b. 日志行：面板按 inj= 关联、按 chars/tokens 统计，字段名是外部契约
  {
    const { deliver, records, infos } = makeDeliverer()
    const s = delivererState()
    await deliver(session, { turn: 3, step: 7, decision: decision(), s, text: 'hello', tag: 'A', inj: 2, extra: '' })
    const line = records[0]
    check('deliverer 日志：inject 前缀与 session/turn/step/signals/inj 都在', /^inject session=sess-1 turn=3 step=7 signals=A inj=2 /.test(line), line)
    check('deliverer 日志：chars 与 tokens 按实际文本算', line.includes('chars=5 ') && / tokens=\d+ /.test(line), line)
    check('deliverer 日志：没测量过写 measured=no', line.includes('measured=no'), line)
    check('deliverer 日志：logger.info 也收到一条，且带注入序号', infos.length === 1 && infos[0].includes('inject session=sess-1 turn=3 step=7 signals=A'), infos.join(' | '))
  }

  // 31c. measured=yes 的两种结局必须可区分：ok 与 fail 都是「测过了」，但结论相反
  {
    const okRun = makeDeliverer()
    await okRun.deliver(session, { turn: 1, step: 1, decision: decision(), s: delivererState({ lastMeasure: { tool: 'bash', ok: true } }), text: 'x', tag: 'C', inj: 1, extra: '' })
    const failRun = makeDeliverer()
    await failRun.deliver(session, { turn: 1, step: 1, decision: decision(), s: delivererState({ lastMeasure: { tool: 'bash', ok: false } }), text: 'x', tag: 'C', inj: 1, extra: '' })
    check('deliverer 日志：测过且通过写 yes:bash:ok', okRun.records[0].includes('measured=yes:bash:ok'), okRun.records[0])
    check('deliverer 日志：测过但失败写 yes:bash:fail', failRun.records[0].includes('measured=yes:bash:fail'), failRun.records[0])
  }

  // 31d. 三个 worst 数：面板的 intensity 全靠它们，取错（比如取最后一次而不是最大值）不会报错只会静默偏小
  {
    const { deliver, records } = makeDeliverer()
    const s = delivererState({
      edits: new Map([['a.js', 2], ['b.js', 5]]),
      streakEdits: new Map([['a.js', 4]]),
      errors: new Map([
        ['e1', { count: 1, sample: 'ENOENT a' }],
        ['e2', { count: 3, sample: 'ENOENT b' }]
      ]),
      searchedThisTurn: true
    })
    await deliver(session, { turn: 2, step: 2, decision: decision(), s, text: 'x', tag: 'B', inj: 1, extra: '' })
    const line = records[0]
    check('deliverer 日志：worstEdits 取最大值不是末值', line.includes('files=2 worstEdits=5 '), line)
    check('deliverer 日志：worstStreak 单独写出（A 的判据）', line.includes('worstStreak=4 '), line)
    check('deliverer 日志：worstErrors 与 sample 取自同一条（计数最大的那条）', line.includes('worstErrors=3 ') && line.includes('sample="ENOENT b"'), line)
    check('deliverer 日志：searched 反映本 turn 是否搜过', line.includes('searched=true '), line)
  }

  // 31e. sample 必须截断：报错原文可能上千字符，日志一行爆掉会让面板整行解析失败
  {
    const { deliver, records } = makeDeliverer()
    const long = 'E'.repeat(300)
    const s = delivererState({ errors: new Map([['k', { count: 1, sample: long }]]) })
    await deliver(session, { turn: 1, step: 1, decision: decision(), s, text: 'x', tag: 'B', inj: 1, extra: '' })
    const line = records[0]
    const m = line.match(/sample=(".*?")$/)
    check('deliverer 日志：sample 截到 80 字符并保留 JSON 引号', m !== null && JSON.parse(m[1]).length === 80, line.slice(-40))
  }

  // 31f. extra 是 M / done 这类附加字段的通道；空 extra 不能留下尾空格（面板按空格切分）
  {
    const withExtra = makeDeliverer()
    await withExtra.deliver(session, { turn: 1, step: 1, decision: decision(), s: delivererState(), text: 'x', tag: 'M', inj: 1, extra: 'futile=2' })
    const plain = makeDeliverer()
    await plain.deliver(session, { turn: 1, step: 1, decision: decision(), s: delivererState(), text: 'x', tag: 'A', inj: 1, extra: '' })
    check('deliverer 日志：extra 拼在 measured 之后', /measured=no futile=2$/.test(withExtra.records[0]), withExtra.records[0])
    check('deliverer 日志：空 extra 不留尾空格', plain.records[0] === plain.records[0].trimEnd(), JSON.stringify(plain.records[0].slice(-12)))
  }

  // 31g. 消息形状：decision 其余字段原样透传，追加的是一条带 source.kind 的 user 消息
  {
    const { deliver } = makeDeliverer()
    const d = decision()
    const out = await deliver(session, { turn: 1, step: 1, decision: d, s: delivererState(), text: '观察：同一文件改了 3 次', tag: 'A', inj: 1, extra: '' })
    const added = out.messages[out.messages.length - 1]
    check('deliverer 消息：decision 的 kind / reason 原样透传', out.kind === 'inject' && out.reason === 'A', out.kind + '/' + out.reason)
    check('deliverer 消息：原有消息保留在前面', out.messages.length === 2 && out.messages[0] === d.messages[0], 'len=' + out.messages.length)
    check('deliverer 消息：追加的是 user 文本消息且自报 kind', added.role === 'user' && added.content[0].type === 'text' && added.content[0].text === '观察：同一文件改了 3 次' && added.source.kind === 'dsh-better-debug', JSON.stringify(added))
    check('deliverer 消息：每条都有独立 id（UI 去重靠它）', typeof added.id === 'string' && added.id.length >= 8, String(added.id))
    check('deliverer 消息：不改动传入的 decision 对象', d.messages.length === 1, 'len=' + d.messages.length)
  }

  // 31h. logger 抛错不能把注入本身带下去：日志是观测面，不是投递路径的一部分
  {
    const records = []
    const ctx = { logger: { info: () => { throw new Error('logger boom') } } }
    const deliver = createDeliverer({ ctx, record: async (line) => { records.push(line) } })
    const s = delivererState()
    let threw = false
    let out
    try {
      out = await deliver(session, { turn: 1, step: 1, decision: decision(), s, text: 'x', tag: 'A', inj: 1, extra: '' })
    } catch { threw = true }
    check('deliverer logger 抛错：不冒泡，注入照常返回', threw === false && out?.messages.length === 2, 'threw=' + threw)
    check('deliverer logger 抛错：文件日志仍然写了', records.length === 1 && records[0].startsWith('inject '), 'records=' + records.length)
  }
}
// ── 58. 配置：doneOnPresent:false 关掉 present 之后的休眠
//
// 默认 true：present 成功视为交付，之后的 pre-step 直接 return（只记一次 suppress）。
// 这个键此前只有真分支被测过 —— 关掉它到底会不会照常开口，没人验证。
{
  const run = async (extra) => {
    const ctx = makeCtx()
    apply(ctx, { logFile: '', ...extra })
    const agent = { session: makeSession() }
    const steps = [
      [(s, c) => edit('/work/src/a.js')(s, c)],
      [(s, c) => edit('/work/src/a.js')(s, c)],
      [(s, c) => edit('/work/src/a.js')(s, c)],
      [(s, c, st) => fail('d1', 'TypeError: boom')(s, c, st)], // pre-step 4 落 A
      [(s, c, st) => tool('d2', 'present', { text: 'presented' })(s, c, st)], // 交付态
      [(s, c, st) => fail('d3', 'RangeError: other')(s, c, st)],
      [(s, c, st) => fail('d4', 'RangeError: other')(s, c, st)],
      []
    ]
    return await runTurn(ctx, agent, { turn: 1, steps })
  }
  const on = await run({})
  const off = await run({ doneOnPresent: false })
  check(
    'doneOnPresent 默认 true：present 之后不再开口',
    has(on, '同一个操作重复报错') === void 0,
    'signals=' + injections(on)
  )
  check(
    'doneOnPresent:false → present 之后 B 照常开口',
    has(off, '同一个操作重复报错') !== void 0,
    'signals=' + injections(off)
  )
}

// ── 59. 配置：repeatFamilyThreshold 参与 F 的判据（默认 4）
//
// F 要同时过两道闸：族内不同指纹数 >= familyMinFingerprints、族内总次数 >= repeatFamilyThreshold。
// 用 5 个互不相同的指纹（每个只出现一次）把 B 摘掉，剩下的注入只可能来自 F。
{
  const at = (msg) => msg + '\n    at parse (file:///C:/work/src/a.mjs:12:29)'
  const msgs = ['TypeError: alpha', 'RangeError: beta', 'SyntaxError: gamma', 'EvalError: delta', 'URIError: epsilon']
  const run = async (extra) => {
    const ctx = makeCtx()
    apply(ctx, { logFile: '', ...extra })
    const agent = { session: makeSession() }
    // 每步换一个文件：避免 streakEdits 攒够 3 次把 A 引进来。
    const steps = msgs.map((m, i) => [
      [(s, c) => edit('/work/src/f' + i + '.js')(s, c)],
      [(s, c, st) => fail('f' + i, at(m))(s, c, st)]
    ].flat())
    steps.push([])
    return await runTurn(ctx, agent, { turn: 1, steps })
  }
  const base = await run({})
  const high = await run({ repeatFamilyThreshold: 6 })
  check('F: 默认阈值 4，5 次不同指纹触发', has(base, '种不同报错') !== void 0, 'signals=' + injections(base))
  check(
    'repeatFamilyThreshold:6 → 同样 5 次不够阈值，不报 F',
    has(high, '种不同报错') === void 0,
    'signals=' + injections(high)
  )
}

// ── 60. 配置：familyMinFingerprints 参与 F 的判据（默认 3）
{
  const at = (msg) => msg + '\n    at parse (file:///C:/work/src/a.mjs:12:29)'
  const msgs = ['TypeError: alpha', 'RangeError: beta', 'SyntaxError: gamma', 'EvalError: delta', 'URIError: epsilon']
  const run = async (extra) => {
    const ctx = makeCtx()
    apply(ctx, { logFile: '', ...extra })
    const agent = { session: makeSession() }
    const steps = msgs.map((m, i) => [
      [(s, c) => edit('/work/src/g' + i + '.js')(s, c)],
      [(s, c, st) => fail('h' + i, at(m))(s, c, st)]
    ].flat())
    steps.push([])
    return await runTurn(ctx, agent, { turn: 1, steps })
  }
  const base = await run({})
  const strict = await run({ familyMinFingerprints: 6 })
  check('F: 默认 3 种指纹即够', has(base, '种不同报错') !== void 0, 'signals=' + injections(base))
  check(
    'familyMinFingerprints:6 → 5 种指纹不够，不报 F（总次数已过 repeatFamilyThreshold）',
    has(strict, '种不同报错') === void 0,
    'signals=' + injections(strict)
  )
}

// ── 61. 配置：oscillationThreshold 参与 O 的判据（默认 3）
//
// 同一段断言文本绿→红→绿→红，每次翻转之间都有修改，实测 flips=3。
// 阈值抬到 5 之后同样的剧本必须一声不响 —— 否则这个键就是死配置。
{
  const red = 'AssertionError: expected 3 to be 4\n    at C:/work/test/a.test.mjs:12:29\n[exit code: 1]'
  const run = async (extra) => {
    const ctx = makeCtx()
    apply(ctx, { logFile: '', ...extra })
    const agent = { session: makeSession() }
    const file = '/work/src/a.js'
    const steps = [
      [(s, c) => edit(file)(s, c), (s, c) => runFail('o1', red)(s, c)],
      [(s, c) => edit(file)(s, c), (s, c) => measure('o2')(s, c)],
      [(s, c) => edit(file)(s, c), (s, c) => runFail('o3', red)(s, c)],
      [(s, c) => edit(file)(s, c), (s, c) => measure('o4')(s, c)],
      [(s, c) => edit(file)(s, c), (s, c) => runFail('o5', red)(s, c)],
      [(s, c) => edit(file)(s, c), (s, c) => measure('o6')(s, c)],
      [(s, c) => edit(file)(s, c), (s, c) => runFail('o7', red)(s, c)],
      []
    ]
    return await runTurn(ctx, agent, { turn: 1, steps })
  }
  const base = await run({})
  const high = await run({ oscillationThreshold: 5 })
  check('O: 默认阈值 3，三次翻转触发', has(base, '翻转了') !== void 0, 'signals=' + injections(base))
  check('oscillationThreshold:5 → 三次翻转不够，不报 O', has(high, '翻转了') === void 0, 'signals=' + injections(high))
}

// ── 62. 配置：patchChainThreshold 参与 P 的判据（默认 3）
//
// 三轮「验证失败 → 修改 → 验证仍失败」，每轮换一个新失败 → repairChain=3。
// 阈值抬到 4 之后必须不响。
{
  const red = (n) => 'AssertionError: case-' + n + ' failed\n    at C:/work/test/a.test.mjs:4:9\n[exit code: 1]'
  const run = async (extra) => {
    const ctx = makeCtx()
    apply(ctx, { logFile: '', ...extra })
    const agent = { session: makeSession() }
    const file = '/work/src/a.js'
    const steps = [
      [(s, c) => edit(file)(s, c), (s, c) => runFail('p1', red('one'))(s, c)],
      [(s, c) => edit(file)(s, c), (s, c) => runFail('p2', red('two'))(s, c)],
      [(s, c) => edit(file)(s, c), (s, c) => runFail('p3', red('three'))(s, c)],
      []
    ]
    return await runTurn(ctx, agent, { turn: 1, steps })
  }
  const base = await run({})
  const high = await run({ patchChainThreshold: 4 })
  check('P: 默认阈值 3，三轮补丁链触发', has(base, '轮「验证失败') !== void 0, 'signals=' + injections(base))
  check('patchChainThreshold:4 → 三轮不够，不报 P', has(high, '轮「验证失败') === void 0, 'signals=' + injections(high))
}

// ── 63. 配置：metaAfterFutile 参与 M 的判据（默认 2）
//
// 剧本同组 33：两条注入各自在窗口内没等到转向 → futile=2。
// 阈值抬到 3 之后必须不落 M（其余 A/B 照旧）。
{
  const run = async (extra) => {
    const ctx = makeCtx()
    apply(ctx, { logFile: '', ...extra })
    const agent = { session: makeSession() }
    const file = '/work/src/a.js'
    const stack = 'TypeError: boom\n    at C:/work/src/a.mjs:7:2'
    const steps = [
      [(s, c) => edit(file)(s, c)],
      [(s, c) => edit(file)(s, c)],
      [(s, c) => edit(file)(s, c)],
      [(s, c, st) => fail('m1', stack, 'ops_write')(s, c, st)],
      [(s, c, st) => fail('m2', stack, 'ops_write')(s, c, st)],
      [(s, c, st) => shell('m3')(s, c, st)],
      [(s, c) => edit(file)(s, c)],
      [(s, c) => edit(file)(s, c)],
      [(s, c) => edit(file)(s, c)],
      [(s, c) => edit(file)(s, c)],
      [(s, c) => edit(file)(s, c)],
      [(s, c, st) => shell('m4')(s, c, st)], // 12 > 4+6 → 第一条作废
      [(s, c, st) => shell('m5')(s, c, st)], // 13 > 6+6 → 第二条作废，futile=2
      []
    ]
    return await runTurn(ctx, agent, { turn: 1, steps })
  }
  const base = await run({})
  const high = await run({ metaAfterFutile: 3 })
  check('M: 默认阈值 2，两条无效注入后落元闸门', has(base, '元观察') !== void 0, 'signals=' + injections(base))
  check('metaAfterFutile:3 → futile=2 不够，不落 M', has(high, '元观察') === void 0, 'signals=' + injections(high))
}

// ── 64. 配置：excludePaths 命中即完全不计入盲改
//
// 判据在 fs/write-intent 里、计数之前：命中的路径连 edits / streakEdits / writeSeq 都不动。
// 默认值只排除 node_modules / 锁文件 / *.log 之类；这里换成一个自定义生成目录。
{
  const run = async (extra, target) => {
    const ctx = makeCtx()
    apply(ctx, { logFile: '', ...extra })
    const agent = { session: makeSession() }
    const steps = [
      [(s, c) => edit(target)(s, c)],
      [(s, c) => edit(target)(s, c)],
      [(s, c) => edit(target)(s, c)],
      []
    ]
    return await runTurn(ctx, agent, { turn: 1, steps })
  }
  const gen = '/work/gen/a.js'
  const def = await run({}, gen)
  const custom = await run({ excludePaths: '(^|/)gen/' }, gen)
  const other = await run({ excludePaths: '(^|/)gen/' }, '/work/src/a.js')
  check('excludePaths: 默认值不排除 /work/gen/，三次改仍落 A', has(def, '同一个文件累计改了') !== void 0, 'signals=' + injections(def))
  check('excludePaths 自定义命中 → 三次改完全不计入', custom.length === 0, 'signals=' + injections(custom))
  check('excludePaths 自定义未命中 → 照常落 A', has(other, '同一个文件累计改了') !== void 0, 'signals=' + injections(other))
}
// ── 65. 指纹换轴：换用例名不再被当成「同一个错重复」
//
// 0.3.6 之前 errorFingerprint 把数字一律归一成 <n>，健康 TDD 每轮换用例名
// （case-one / case-two / case-three）也会塌成同一个指纹 → B 抢答、P 一次不响。
// 现在数字保留：新用例 = 新失败 = 这一串补丁在制造下一个失败，B 让位给 P。
{
  const red = (n) => 'AssertionError: case-' + n + ' failed\n    at C:/work/test/a.test.mjs:4:9\n[exit code: 1]'
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const file = '/work/src/a.js'
  const names = ['one', 'two', 'three', 'four', 'five']
  const steps = []
  for (const name of names) {
    steps.push([(s, c) => edit(file)(s, c), (s, c) => runFail('q-' + name, red(name))(s, c)])
  }
  steps.push([])
  const base = await runTurn(ctx, agent, { turn: 1, steps })
  check('换用例名：B 不再抢答（补丁链让位给 P）', has(base, '同一个操作重复报错') === void 0, 'signals=' + injections(base))
  check('换用例名：P 在补丁链上开口', has(base, '轮「验证失败') !== void 0, 'signals=' + injections(base))
}

// ── 66. 指纹反例：只漂行号仍然合并
//
// 行号已经被 <path> 规则整段吃掉，所以同一个失败换个行号仍是同一条 episode。
// 这条是 65 的反例守卫：别把「位置类数字」也一起保留下来。
//
// 为什么第三轮才断言：第一次失败测量就把 repairChain 推到 1，B 的 failEpisodes
// 层这时让位给 P；第二轮测量发现失败集合一字未变（unchanged）→ repairChain 归零，
// 于是第三轮的 pre-step 才轮到 B 开口，n=2 正好证明前两次合并成了一条。
{
  const at = (line) => 'AssertionError: boom\n    at C:/work/test/a.test.mjs:' + line + ':9\n[exit code: 1]'
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const file = '/work/src/a.js'
  const steps = [
    [(s, c) => edit(file)(s, c), (s, c) => runFail('r1', at(4))(s, c)],
    [(s, c) => edit(file)(s, c), (s, c) => runFail('r2', at(9))(s, c)],
    [(s, c) => edit(file)(s, c), (s, c) => runFail('r3', at(4))(s, c)],
    []
  ]
  const base = await runTurn(ctx, agent, { turn: 1, steps })
  check('只漂行号：前两次仍合成一条 episode（n=2）', has(base, '同一个操作重复报错 2 次') !== void 0, 'signals=' + injections(base))
}

// ── 67. PTC 根调用里的测量
//
// 根 run_code 的参数是 { code }，没有 command / script_path —— 0.3.5 之前一律
// 判成非测量，于是 PTC 里跑 npm test 也不算测过，C 永远解不开上膛。
// 这里让**子调用**故意是非测量（ls -la），唯一的测量来源就是根 code 文本。
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const file = '/work/src/a.js'
  const steps = [
    [(s, c) => edit(file)(s, c)],
    [(s, c) => edit(file)(s, c)],
    [(s, c) => edit(file)(s, c)],
    [(s, c, st) => ptc('rc1', 'ops_bash', 'sc1', {
      code: 'await tools.bash({command:"npm test"})',
      args: { command: 'ls -la', description: '看看目录' },
      text: 'ok'
    })(s, c, st)],
    []
  ]
  const base = await runTurn(ctx, agent, { turn: 1, steps })
  check('PTC：run_code 里的 npm test 算测量，C 不上膛', has(base, '自上次测量以来') === void 0, 'signals=' + injections(base))
}

// ── 68. PTC 根调用里的写入
//
// 写文件走 fs/write-intent，PTC 里 tools.write 不经过那条通道 —— 0.3.5 之前
// 连写十几个文件也零注入。这里只做粗粒度识别（code 里出现 .write( / writeFile
// / appendFile / fs.write 就记一次盲改）：宁可偶尔多算，也不能整条通道失明。
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const code = 'await tools.write({path:"C:/work/src/a.js", content:"x"})'
  const steps = []
  for (let i = 1; i <= 6; i += 1) {
    steps.push([(s, c, st) => ptc('rw' + i, 'ops_read_files', 'sw' + i, { code, args: { path: 'C:/work/src/a.js' }, text: 'ok' })(s, c, st)])
  }
  steps.push([])
  const base = await runTurn(ctx, agent, { turn: 1, steps })
  check('PTC：run_code 里的 write 计入盲改，C 开口', has(base, '自上次测量以来') !== void 0, 'signals=' + injections(base))
}

// ── 69. 读文件算转向：不再计入「无效注入」
//
// M 的文案是「写完之前不要发起任何修改类工具调用」，而读文件是在收集信息，
// 不是带病继续改。把它算成「没转向」会让 M 在正常的读—改循环里误报。
// 对照组用 ops_write（编辑类、非读）证明这条判据真的在起作用。
{
  // 剧本同组 63：A 在第 4 步上膛开口、B 在第 6 步开口，两条 pending 分别在
  // 第 12 / 13 步过期，futile 攒到 2 —— 只有「读文件算不算转向」这一个变量不同。
  const run = async (actionName) => {
    const ctx = makeCtx()
    apply(ctx, { logFile: '' })
    const agent = { session: makeSession() }
    const file = '/work/src/a.js'
    const stack = 'TypeError: boom\n    at C:/work/src/a.mjs:7:2'
    const act = (id) => [(s, c, st) => fail(id, stack, actionName)(s, c, st)]
    const steps = [
      [(s, c) => edit(file)(s, c)],
      [(s, c) => edit(file)(s, c)],
      [(s, c) => edit(file)(s, c)],
      act('k1'),
      act('k2'),
      [(s, c, st) => shell('k3')(s, c, st)],
      [(s, c) => edit(file)(s, c)],
      [(s, c) => edit(file)(s, c)],
      [(s, c) => edit(file)(s, c)],
      [(s, c) => edit(file)(s, c)],
      [(s, c) => edit(file)(s, c)],
      [(s, c, st) => shell('k4')(s, c, st)], // 12 > 4+6 → 第一条作废
      [(s, c, st) => shell('k5')(s, c, st)], // 13 > 6+6 → 第二条作废，futile=2
      []
    ]
    return await runTurn(ctx, agent, { turn: 1, steps })
  }
  const reads = await run('ops_read_files')
  const writes = await run('ops_write')
  check('读文件算转向 → 无效计数不涨，不落 M', has(reads, '元观察') === void 0, 'signals=' + injections(reads))
  check('对照组：ops_write 不算转向 → 落 M', has(writes, '元观察') !== void 0, 'signals=' + injections(writes))
}

// ── 70. fired 表不再漏键（O 的 NaN 定时炸弹）
//
// s.fired['O'] += 1 在缺键时得到 NaN，而 NaN < 1 恒为 false —— O 会永久失声且
// 不报错。state 不导出，NaN 只能靠观察状态发现，所以这里用两条源码形状断言
// 钉住「表里有 O 键」与「累加兜住动态键」，再用组 61 的剧本跑一次真实 O 正例，
// 确认改造之后 O 仍然照常开口。
{
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  check('fired 表含 O 键', /fired:\s*\{[^}]*\bO:\s*0\b/.test(src), 'lib/index.js')
  check('fired 累加兜住动态键', src.includes('(s.fired[signal.kind] ?? 0) + 1'), 'lib/index.js')
  const red = 'AssertionError: expected 3 to be 4\n    at C:/work/test/a.test.mjs:12:29\n[exit code: 1]'
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const file = '/work/src/a.js'
  const steps = [
    [(s, c) => edit(file)(s, c), (s, c) => runFail('z1', red)(s, c)],
    [(s, c) => edit(file)(s, c), (s, c) => measure('z2')(s, c)],
    [(s, c) => edit(file)(s, c), (s, c) => runFail('z3', red)(s, c)],
    [(s, c) => edit(file)(s, c), (s, c) => measure('z4')(s, c)],
    [(s, c) => edit(file)(s, c), (s, c) => runFail('z5', red)(s, c)],
    [(s, c) => edit(file)(s, c), (s, c) => measure('z6')(s, c)],
    [(s, c) => edit(file)(s, c), (s, c) => runFail('z7', red)(s, c)],
    []
  ]
  const base = await runTurn(ctx, agent, { turn: 1, steps })
  check('O 正例照常开口（fired.O 参与累加不崩）', has(base, '翻转了') !== void 0, 'signals=' + injections(base))
}

// ── 纯函数：指纹口径与 PTC 测量（最便宜的三条，失败时先看这里）
{
  const cfgLike = { measureCommands: /(npm|pnpm)\s+(run\s+)?(test|verify)/i, measureIntent: /验证|测试/i }
  const caseA = 'AssertionError: case-1 failed\n    at C:/work/test/a.test.mjs:1:9'
  const caseB = 'AssertionError: case-2 failed\n    at C:/work/test/a.test.mjs:2:9'
  const locA = 'TypeError: x\n    at C:/work/src/a.js:10:5'
  const locB = 'TypeError: x\n    at C:/work/src/a.js:11:5'
  check('指纹：换用例名要分开', errorFingerprint(caseA) !== errorFingerprint(caseB), errorFingerprint(caseA))
  check('指纹：只漂行号要合并', errorFingerprint(locA) === errorFingerprint(locB), errorFingerprint(locA))
  check('run_code 里的 npm test 算测量', isMeasurement('run_code', { code: 'await tools.bash({command:"npm test"})' }, cfgLike) === true, 'run_code')
}
// ── 29. 导出形状
check('导出 name', name === 'dsh-better-debug', name)
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  console.log('FAILED:', failed.map((r) => r.label).join(' | '))
  process.exit(1)
}
