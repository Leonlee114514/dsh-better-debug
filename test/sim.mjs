// 本地行为验证：用假 ctx 模拟 agent-loop 的调用顺序，不依赖 DSH 运行时。
// 覆盖：A/B/C 三个信号各一条正例 + 反例 + D 段静音 + 幂等 + 子会话 + 阈值可调。
import { apply, name, inject } from '../lib/index.js'

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
    async emitSerial(evt, payload) {
      let out
      for (const cb of listeners.get(evt) ?? []) out = await cb(payload)
      return out
    },
    async emitWaterfall(evt, ...args) {
      const cbs = listeners.get(evt) ?? []
      const next = args.pop()
      const step = async (i) => {
        if (i >= cbs.length) return next()
        return cbs[i](...args, () => step(i + 1))
      }
      return step(0)
    },
    async emitPlain(evt, ...args) {
      for (const cb of listeners.get(evt) ?? []) await cb(...args)
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
  return ctx
}

function makeSession({ origin = 'user', delegationDepth = 0, id = 'sess-1' } = {}) {
  return { id, header: { cwd: 'C:/work', origin, delegationDepth } }
}

function makeAgent(session) {
  return { session, status: 'running' }
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
  for (let step = 1; step <= steps.length; step += 1) {
    const decision = await ctx.emitWaterfall(
      'agent/pre-step',
      { agent, turn, step, signal: { aborted: false } },
      () => ({ kind: 'enter', messages: [] })
    )
    const extra = decision.messages.filter((m) => m.source?.kind === 'dsh-better-debug')
    if (extra.length > 0) injected.push({ step, texts: extra.map((m) => m.content[0].text) })

    for (const act of steps[step - 1] ?? []) await act(session)
  }
  await ctx.emitPlain('session/event', session, { type: 'turn/end', data: { turn } })
  return injected
}

const edit = (path) => async (session, ctx) => {
  // fs/write-intent 是 waterfall：(target, actor, next)
  const actor = { agent: { session } }
  await ctx.emitWaterfall('fs/write-intent', path, actor, () => ({ ok: true }))
}
const call = (id, toolName) => async (session, cx) => {
  await cx.emitPlain('session/event', session, {
    type: 'tool/call',
    data: { turn: 1, step: 1, callId: id, name: toolName, arguments: {} }
  })
}
const fail = (id, text) => async (session, cx) => {
  await cx.emitPlain('session/event', session, {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `m-${id}`,
        role: 'tool',
        toolCallId: id,
        isError: true,
        source: { kind: 'tool', callId: id },
        content: [{ type: 'text', text }]
      }
    }
  })
}

// ── 1. A 信号：同一文件改 3 次，第 3 步注入
{
  const ctx = makeCtx()
  apply(ctx, {})
  const agent = makeAgent(makeSession())
  const P = 'C:/work/src/a.js'
  const steps = [[], [], []]
  for (let i = 0; i < 3; i += 1) steps[i] = [(s) => edit(P)(s, ctx)]
  const injected = await runTurn(ctx, agent, { turn: 1, steps: [...steps, [], []] })
  const hit = injected.find((entry) => entry.texts.some((t) => t.includes('同一个文件')))
  check('A: 同文件改 3 次 → 注入', hit !== void 0, hit ? `step=${hit.step}` : 'no injection')
}

// ── 2. A 反例：改 2 次不应该响
{
  const ctx = makeCtx()
  apply(ctx, {})
  const agent = makeAgent(makeSession())
  const P = 'C:/work/src/a.js'
  const steps = [[(s) => edit(P)(s, ctx)], [(s) => edit(P)(s, ctx)], [], []]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  const hit = injected.find((entry) => entry.texts.some((t) => t.includes('同一个文件')))
  check('A: 改 2 次不响', hit === void 0)
}

// ── 3. A 反例：改 3 次但中间有验证 → 不响
{
  const ctx = makeCtx()
  apply(ctx, {})
  const agent = makeAgent(makeSession())
  const P = 'C:/work/src/a.js'
  const steps = [
    [(s) => edit(P)(s, ctx)],
    [(s) => edit(P)(s, ctx)],
    [(s) => edit(P)(s, ctx), (s) => call('c1', 'ops_bash')(s, ctx)],
    [],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  const hit = injected.find((entry) => entry.texts.some((t) => t.includes('同一个文件')))
  check('A: 有验证后不响', hit === void 0)
}

// ── 4. B 信号：同一类错误两次（数字/路径/hex 不同，指纹相同）
{
  const ctx = makeCtx()
  apply(ctx, {})
  const agent = makeAgent(makeSession())
  const steps = [
    [(s) => fail('c1', 'Error: ENOENT: no such file or directory, open \'C:/work/a.js\' line 42')(s, ctx)],
    [(s) => fail('c2', 'Error: ENOENT: no such file or directory, open \'C:/work/b.js\' line 99')(s, ctx)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  const hit = injected.find((entry) => entry.texts.some((t) => t.includes('同一个报错')))
  check('B: 同类报错 2 次 → 注入', hit !== void 0, hit ? `step=${hit.step}` : 'no injection')
}

// ── 5. B 反例：报错两次但本 turn 搜过 → 不响
{
  const ctx = makeCtx()
  apply(ctx, {})
  const agent = makeAgent(makeSession())
  const steps = [
    [(s) => call('s1', 'web_search')(s, ctx)],
    [(s) => fail('c1', 'TypeError: x is not a function')(s, ctx)],
    [(s) => fail('c2', 'TypeError: x is not a function')(s, ctx)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  const hit = injected.find((entry) => entry.texts.some((t) => t.includes('同一个报错')))
  check('B: 搜过之后不响', hit === void 0)
}

// ── 6. C 信号：改完之后过 2 步什么都没做
{
  const ctx = makeCtx()
  apply(ctx, {})
  const agent = makeAgent(makeSession())
  const P = 'C:/work/src/c.js'
  const steps = [[(s) => edit(P)(s, ctx)], [], [], []]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  const hit = injected.find((entry) => entry.texts.some((t) => t.includes('上次改完')))
  check('C: 改完 2 步无验证 → 注入', hit !== void 0, hit ? `step=${hit.step}` : 'no injection')
}

// ── 7. 幂等：连续两个 pre-step 都命中条件，只注入一次
{
  const ctx = makeCtx()
  apply(ctx, {})
  const agent = makeAgent(makeSession())
  const P = 'C:/work/src/d.js'
  const steps = [[(s) => edit(P)(s, ctx)], [(s) => edit(P)(s, ctx)], [(s) => edit(P)(s, ctx)], [], [], []]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check('幂等：多步命中只注入一次', injected.length === 1, `injections=${injected.length}`)
}

// ── 8. D 段例外：用户说「直接改」
{
  const ctx = makeCtx()
  apply(ctx, {})
  const agent = makeAgent(makeSession())
  const P = 'C:/work/src/e.js'
  const steps = [[(s) => edit(P)(s, ctx)], [(s) => edit(P)(s, ctx)], [(s) => edit(P)(s, ctx)], [], []]
  const injected = await runTurn(ctx, agent, { turn: 1, steps, quietText: '别搜了，直接改' })
  check('D: 用户说直接改 → 静音', injected.length === 0, `injections=${injected.length}`)
}

// ── 9. 子会话不管
{
  const ctx = makeCtx()
  apply(ctx, {})
  const agent = makeAgent(makeSession({ origin: 'subagent', delegationDepth: 1 }))
  const P = 'C:/work/src/f.js'
  const steps = [[(s) => edit(P)(s, ctx)], [(s) => edit(P)(s, ctx)], [(s) => edit(P)(s, ctx)], []]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check('子会话跳过', injected.length === 0, `injections=${injected.length}`)
}

// ── 10. 阈值可调：把 repeatEditThreshold 调到 5，改 3 次不响
{
  const ctx = makeCtx()
  apply(ctx, { repeatEditThreshold: 5 })
  const agent = makeAgent(makeSession())
  const P = 'C:/work/src/g.js'
  const steps = [[(s) => edit(P)(s, ctx)], [(s) => edit(P)(s, ctx)], [(s) => edit(P)(s, ctx)], []]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  const hit = injected.find((entry) => entry.texts.some((t) => t.includes('同一个文件')))
  check('阈值 5：改 3 次不响', hit === void 0)
}

// ── 11. enabled:false 不安装任何 listener
{
  const ctx = makeCtx()
  apply(ctx, { enabled: false })
  const agent = makeAgent(makeSession())
  const injected = await runTurn(ctx, agent, { turn: 1, steps: [[], []] })
  check('enabled:false 静默', injected.length === 0)
}

// ── 12. 自带技能注册
{
  const ctx = makeCtx()
  apply(ctx, {})
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

  // get() 要能吐正文，且正文里不能残留私有依赖（mnemon 文档 id / 工具名）
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

// ── 13. 没有 skills 服务时不能炸，闸门照常工作
{
  const ctx = makeCtx({ skills: false })
  let threw = null
  try {
    apply(ctx, {})
  } catch (error) {
    threw = error
  }
  const agent = makeAgent(makeSession())
  const P = 'C:/work/src/noskill.js'
  const steps = [[(s) => edit(P)(s, ctx)], [(s) => edit(P)(s, ctx)], [(s) => edit(P)(s, ctx)], [], []]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  const hit = injected.find((entry) => entry.texts.some((t) => t.includes('同一个文件')))
  check(
    'skills 服务缺失：不抛且闸门仍工作',
    threw === null && hit !== void 0,
    threw === null ? `step=${hit?.step}` : String(threw?.message)
  )
}

// ── 14. 导出形状
check(
  '导出 name/inject',
  name === 'dsh-better-debug' && Array.isArray(inject) && inject.includes('skills'),
  `${name} / ${JSON.stringify(inject)}`
)

// ── 15. 收敛不算卡住：每两次编辑之间夹一次测量，连续盲改计数被清零
{
  const ctx = makeCtx()
  apply(ctx, {})
  const agent = makeAgent(makeSession())
  const P = 'C:/work/src/converge.js'
  const steps = [
    [(s) => edit(P)(s, ctx), (s) => call('v1', 'ops_bash')(s, ctx)],
    [(s) => edit(P)(s, ctx), (s) => call('v2', 'ops_bash')(s, ctx)],
    [(s) => edit(P)(s, ctx)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check('A: 编辑间有测量（收敛）→ 不响', injected.length === 0, `injections=${injected.length}`)
}

// ── 16. decayEditsOnVerify:false → 退回旧行为（收敛也会响）
{
  const ctx = makeCtx()
  apply(ctx, { decayEditsOnVerify: false })
  const agent = makeAgent(makeSession())
  const P = 'C:/work/src/converge-old.js'
  const steps = [
    [(s) => edit(P)(s, ctx), (s) => call('v1', 'ops_bash')(s, ctx)],
    [(s) => edit(P)(s, ctx), (s) => call('v2', 'ops_bash')(s, ctx)],
    [(s) => edit(P)(s, ctx)],
    []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  const hit = injected.find((entry) => entry.texts.some((t) => t.includes('同一个文件')))
  check('decayEditsOnVerify:false → 收敛仍响（可回滚）', hit !== void 0, hit ? `step=${hit.step}` : 'no injection')
}

// ── 17. done-state：present 之后改完不验证也不该再注入
{
  const ctx = makeCtx()
  apply(ctx, {})
  const agent = makeAgent(makeSession())
  const P = 'C:/work/src/deliver.js'
  const steps = [
    [(s) => edit(P)(s, ctx), (s) => call('p1', 'present')(s, ctx)],
    [], [], []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check('done-state: present 后不注入', injected.length === 0, `injections=${injected.length}`)
}

// ── 18. doneOnPresent:false → 退回旧行为（交付后仍会响）
{
  const ctx = makeCtx()
  apply(ctx, { doneOnPresent: false })
  const agent = makeAgent(makeSession())
  const P = 'C:/work/src/deliver-old.js'
  const steps = [
    [(s) => edit(P)(s, ctx), (s) => call('p1', 'present')(s, ctx)],
    [], [], []
  ]
  const injected = await runTurn(ctx, agent, { turn: 1, steps })
  check('doneOnPresent:false → 交付后仍注入（可回滚）', injected.length > 0, `injections=${injected.length}`)
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  console.log('FAILED:', failed.map((r) => r.label).join(' | '))
  process.exit(1)
}
