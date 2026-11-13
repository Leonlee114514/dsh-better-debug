// 让 `node:path` 在**任意操作系统上**都表现为 posix 语义。
//
// 为什么需要它：本插件所有判据都同时认 `C:/x` 与 `/x` 两种方言，
// 只有入口闸用过平台相关的 `isAbsolute`。那个 bug 在 Windows 开发机上
// 永远复现不出来 —— 必须能在同一台机器上冒充另一套路径语义，
// 才能让 CI 与本地都守住它。
//
// 用法：node --import ./test/posix/register.mjs test/sim.mjs
//
// 两条注册通道，按可用性挑：
//   · `module.registerHooks()`（node ≥ 22.15 / 23.5）：进程内同步钩子，无告警。
//   · `module.register()`（node 20 起）：在线程外跑，可用但在 node 24+ 已被标记
//     deprecated（DEP0205「Use module.registerHooks() instead」）。
// 只写老的那条会在新 node 上每次跑测试都刷一行弃用告警；只写新的那条会让
// engines.node >=20 的老用户直接跑不起来。所以两条都留着，运行时挑。
import { register, registerHooks } from 'node:module'

const PATH_SHIM = new URL('./path.mjs', import.meta.url).href

if (typeof registerHooks === 'function') {
  // 同步钩子：不能返回 Promise，所以这里不用 async。
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'node:path') return { url: PATH_SHIM, shortCircuit: true }
      return nextResolve(specifier, context)
    }
  })
} else {
  register('./hooks.mjs', import.meta.url)
}
