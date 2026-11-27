// client.js 的契约验证：面板注册这条路只能在浏览器里跑，但**它能被静态守住**。
//
// 2026-11-27 的真机故障：客户端插件拿到的不是 cordis Context，而是
// dsh-cordis-client-runner 造的 dynamic facade。facade 的 get trap 只放行
// CTX_VERBS（effect / on / once / provide / 定时器六兄弟）和插件 inject 数组里
// 声明过的服务；其余属性一律 rejectGuard 抛错，而 `typeof ctx?.inject === 'function'`
// 这种防御写法根本拦不住 —— 取属性本身就抛。于是 apply 在第一行就炸，
// settings.section 从未注册，面板静默消失，日志里连一行痕迹都没有。
//
// 所以这里用一个**会抛错的 inject 属性**复刻那个 trap：只要有人把动态订阅写回来，
// 这条测试立刻红。不需要装 DSH，也不会因为宿主版本漂移而失效。
import { readFileSync } from 'node:fs'

const results = []
function check(label, pass, detail) {
  results.push({ label, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
}

// 加载真 client.js：它走 `window.__ModuleLoader__.load({ id, factory })`，
// 由宿主在浏览器里调用。这里给一个最小壳子把 factory 截下来自己调。
function loadClient() {
  let captured = null
  globalThis.window = { __ModuleLoader__: { load: (definition) => { captured = definition } } }
  const react = {
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    createElement: (type, props, children) => ({ type, props, children })
  }
  const jsxRuntime = { jsx: (type, props) => ({ type, props }) }
  const requireStub = (id) => {
    if (id === 'react') return react
    if (id === 'react/jsx-runtime') return jsxRuntime
    throw new Error('client.js 引用了未预期的模块: ' + id)
  }
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  // 不用 dynamic import：client.js 是给浏览器用的普通脚本，没有 export。
  // new Function 里跑一遍就能拿到 factory 的返回值，且不会污染本模块作用域。
  const run = new Function('window', 'document', 'fetch', source)
  run(globalThis.window, undefined, undefined)
  if (captured === null) throw new Error('client.js 没有调用 window.__ModuleLoader__.load')
  return { id: captured.id, plugin: captured.factory(requireStub) }
}

// dynamic facade 的 get trap 复刻：inject 不在白名单里，取值即抛。
// 文案照抄宿主（dsh-cordis-client-runner/lib/client.js 的 rejectGuard），
// 这样失败信息能直接指向机制，而不是一句 "not a function"。
const FACADE_MESSAGE =
  'dynamic ctx does not expose "inject". Available: ctx.on / ctx.provide / timer helpers after injecting timer, ' +
  'and any service your returned plugin declared in inject (slots and theme are the usual UI seats).'

// 两条拒绝路径必须分开，和宿主一致：
//   · 服务**没声明** → 无论存不存在都抛（未声明就是越权读）；
//   · 服务**声明了但当前缺席** → 返回 undefined（cordis 会把 fiber 挂在 waitingFor 上，
//     而不是让 apply 炸掉）。合并成一条会写出错误的回归测试。
function makeFacade(services, declared, sink) {
  const verbs = { effect: true, on: true, once: true, provide: true }
  const readService = (name, requireDeclaration) => {
    if (requireDeclaration === true && declared.has(name) === false) {
      const message = services[name] === undefined ? FACADE_MESSAGE.replace('inject', name) : 'service "' + name + '" is not declared by your plugin'
      sink.guard.push(message)
      throw new Error(message)
    }
    return services[name]
  }
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === 'get') return (name) => readService(name, false)
      if (typeof prop !== 'string') return undefined
      if (verbs[prop] === true) {
        if (prop === 'effect') return (run) => { const dispose = run(); sink.effects.push(dispose) }
        return () => {}
      }
      return readService(prop, true)
    },
    set(_target, prop) {
      sink.guard.push('assign ' + String(prop))
      throw new Error('dynamic ctx is read-only; cannot assign "' + String(prop) + '"')
    }
  })
}

function makeServices(sink) {
  const services = {
    slots: {
      // 真实 slots 服务的三件事：spec 判座位形态、inject 订阅、register 返回 disposer。
      spec: () => ({ kind: 'list' }),
      inject: (slotName, callback) => {
        sink.calls.push({ via: 'slots.inject', slotName })
        return callback()
      },
      register: (options, component) => {
        sink.calls.push({ via: 'slots.register', options, component })
        return () => {}
      }
    },
    locale: {
      register: (ns, dicts) => { sink.calls.push({ via: 'locale.register', ns, keys: Object.keys(dicts) }); return () => {} },
      bind: (ns) => (key) => ns + '.' + key
    }
  }
  return services
}

// ── 1. 插件导出面：inject 必须静态声明 slots
{
  const { id, plugin } = loadClient()
  check('client.js: module id 是 dsh-better-debug', id === 'dsh-better-debug', id)
  check(
    'client.js: inject 静态声明 slots（动态订阅在 facade 下会抛）',
    Array.isArray(plugin.inject) && plugin.inject.includes('slots'),
    JSON.stringify(plugin.inject)
  )
  check('client.js: apply 是函数', typeof plugin.apply === 'function')
}

// ── 2. apply 在 facade 下真的能跑通，并注册出 settings.section
{
  const sink = { calls: [], guard: [], effects: [] }
  const { plugin } = loadClient()
  const facade = makeFacade(makeServices(sink), new Set(plugin.inject), sink)
  let thrown = null
  try {
    plugin.apply(facade)
  } catch (error) {
    thrown = error
  }
  check('client.js: apply 在 dynamic facade 下不抛', thrown === null, thrown === null ? '' : String(thrown.message).slice(0, 160))
  check('client.js: 没有触发任何 guard 拒绝', sink.guard.length === 0, sink.guard.join(' | '))

  const register = sink.calls.find((call) => call.via === 'slots.register')
  check('client.js: 注册了 settings.section', register !== undefined && register.options.name === 'settings.section')
  check(
    'client.js: section 身份稳定（id/order/locale 是面板入口的锚点）',
    register !== undefined && register.options.id === 'better-debug' && register.options.order === 40 && register.options.locale === 'better-debug',
    register === undefined ? '' : JSON.stringify({ id: register.options.id, order: register.options.order, locale: register.options.locale })
  )
  check('client.js: 组件是函数（React 组件）', register !== undefined && typeof register.component === 'function')

  const subscribe = sink.calls.find((call) => call.via === 'slots.inject')
  check('client.js: 通过 slots.inject 订阅 settings.section 座位', subscribe !== undefined && subscribe.slotName === 'settings.section')
  check('client.js: 注册与订阅都交给 effect 管清理', sink.effects.length >= 2, 'effects=' + sink.effects.length)
  check(
    'client.js: 字典注册到 better-debug 命名空间',
    sink.calls.some((call) => call.via === 'locale.register' && call.ns === 'better-debug')
  )
}

// ── 3. locale 缺席时不许影响面板（可选服务不能变成硬依赖）
{
  const sink = { calls: [], guard: [], effects: [] }
  const { plugin } = loadClient()
  const services = makeServices(sink)
  delete services.locale
  const facade = makeFacade(services, new Set(plugin.inject), sink)
  let thrown = null
  try {
    plugin.apply(facade)
  } catch (error) {
    thrown = error
  }
  check('client.js: locale 缺席时 apply 仍然成功', thrown === null, thrown === null ? '' : String(thrown.message).slice(0, 160))
  check('client.js: locale 缺席时仍然注册面板', sink.calls.some((call) => call.via === 'slots.register'))
}

// ── 4. slots 缺席时安静退出，不抛错（没有 UI 座位不是故障）
{
  const sink = { calls: [], guard: [], effects: [] }
  const { plugin } = loadClient()
  const services = makeServices(sink)
  delete services.slots
  const facade = makeFacade(services, new Set(plugin.inject), sink)
  let thrown = null
  try {
    plugin.apply(facade)
  } catch (error) {
    thrown = error
  }
  check('client.js: slots 缺席时安静退出', thrown === null, thrown === null ? '' : String(thrown.message).slice(0, 160))
  check('client.js: slots 缺席时不做任何注册', sink.calls.length === 0, JSON.stringify(sink.calls.map((call) => call.via)))
}

// ── 5. 反例守卫：源码里不许再出现 ctx.inject 动态订阅
{
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const offending = source
    .split('\n')
    .map((text, index) => ({ text, line: index + 1 }))
    // 注释里提到 ctx.inject 是在解释这条机制为什么不能用，不是用法本身。
    .filter((row) => /^\s*(?:\/\/|\*|\/\*)/.test(row.text) === false)
    .filter((row) => /\.inject\s*\(/.test(row.text) && /ctx\.inject|ctx\?\.inject/.test(row.text))
  check(
    'client.js: 源码里没有 ctx.inject(...) 动态订阅',
    offending.length === 0,
    offending.map((row) => row.line + ': ' + row.text.trim()).join(' | ')
  )
}

const failed = results.filter((row) => !row.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  console.log('FAILED:', failed.map((row) => row.label).join(' | '))
  process.exit(1)
}
