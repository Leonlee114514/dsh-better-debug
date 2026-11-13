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
  errorTargetOf,
  exitCodeOf,
  isAbsPath,
  resolveLogFile,
  CASE_INSENSITIVE
} from '../lib/index.js'

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

/** 一次不算测量的 shell：`ls` 这类「看起来动了手、其实没测」的命令。 */
const shell = (id, { command = 'ls -la', exit = 0 } = {}) =>
  tool(id, 'ops_bash', { args: { command, description: '看看目录' }, text: `[exit code: ${exit}]` })

const fail = (id, text, toolName = 'ops_read_files') =>
  tool(id, toolName, { text, isError: true })

const has = (injected, needle) => injected.find((entry) => entry.texts.some((t) => t.includes(needle)))

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
  if (savedDshHome !== void 0) process.env.DSH_HOME = savedDshHome

  const cases = [
    [fallback.includes('.dsh') && fallback.endsWith('better-debug.log'), '不写 logFile → 默认落盘'],
    [!viaHome.includes('~') && viaHome.endsWith('x.log'), '~ 被展开'],
    [explicitOff === '', '空串 = 显式关闭'],
    [falseOff === '', 'false = 显式关闭'],
    [verbatim === 'C:/tmp/x.log', '绝对路径原样使用']
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
  const crlf = /\r/.test(patch)
  check(
    'bundle patch 是 LF（CRLF 会让市场的注释剥离失效，永远读成含 config）',
    crlf === false,
    crlf ? 'contains CR' : 'LF'
  )
}

// ── 29. 导出形状
check('导出 name', name === 'dsh-better-debug', name)
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  console.log('FAILED:', failed.map((r) => r.label).join(' | '))
  process.exit(1)
}
