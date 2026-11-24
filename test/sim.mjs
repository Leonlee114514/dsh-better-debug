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
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const steps = [
    [(s, c, st) => fail('c1', "Error: ENOENT: no such file or directory, open 'C:/work/a.js' line 42")(s, c, st)],
    [(s, c, st) => fail('c2', "Error: ENOENT: no such file or directory, open 'C:/work/a.js' line 99")(s, c, st)],
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

// ── 14. C 正中例：arm 之后又写了一次 → 注入
{
  const ctx = makeCtx()
  apply(ctx, { logFile: '' })
  const agent = { session: makeSession() }
  const P = 'C:/work/src/no-verify.js'
  const steps = [
    [(s, c) => edit(P)(s, c)],
    [],
    [],
    [(s, c) => edit(P)(s, c)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  const hit = has(injected, '上次改完')
  check('C: 上膛后又动手 → 注入', hit !== void 0, hit ? `step=${hit.step}` : 'no injection')
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
  const P = 'C:/work/src/present-fail.js'
  const steps = [
    [(s, c, st) => edit(P)(s, c)],
    [(s, c, st) => tool('p1', 'present', { text: 'present rejected: no such file', isError: true })(s, c, st)],
    [],
    [(s, c) => edit(P)(s, c)],
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
    [[...measureDirs({ command: 'npm test -- src/a.test.js' })], [], '测试文件路径不带绝对路径 → 不猜']
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
    [(s, c, st) => fail('m1', stack)(s, c, st)], // 第 4 步 pre-step 落 A
    [(s, c, st) => fail('m2', stack)(s, c, st)],
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
          t.includes('同一个文件连续改了') ||
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
  check('P 反例：同一个错三连（一字未变）不得注入', injected.length === 0, `injections=${injected.length}`)
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

// ── 29. 导出形状
check('导出 name', name === 'dsh-better-debug', name)
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  console.log('FAILED:', failed.map((r) => r.label).join(' | '))
  process.exit(1)
}
