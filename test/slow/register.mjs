// 把 `node:fs/promises` 换成一个「appendFile 慢 400ms」的替身。
//
// 目的不是模拟慢盘，而是把「日志还在写、测试已经读完」这个竞态放大到必然发生：
// 只要读日志的写法是「等一段固定时间」，这一轮就会稳定红；写成「等到目标行出现」，
// 不管慢多少都绿。
//
// 用法：node --import ./test/slow/register.mjs test/panel.mjs
// 可调：BD_SLOW_MS=800 node --import ./test/slow/register.mjs test/panel.mjs
//
// 注意 shim 自己要把真实模块拿回来，所以放行条件是「父模块就是 shim 自己」——
// 换成别的判据（比如按 specifier 放行）会让 shim 递归 import 自己。
import * as nodeModule from 'node:module'

const FS_SHIM = new URL('./fs.mjs', import.meta.url).href

const { registerHooks } = nodeModule

if (typeof registerHooks !== 'function') {
  // node 20 没有 registerHooks；这一轮慢盘回归只在 node ≥ 22.15 上真正生效，
  // 老 node 上跳过而不是让整条 verify 挂掉 —— 与 test:posix 的两通道策略一致。
  // 但必须**说出声**：静默跳过会让人以为这条防线在现场，其实没跑。
  console.log(`  [跳过] node ${process.versions.node} 没有 module.registerHooks，慢盘回归未生效`)
} else {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier !== 'node:fs/promises') return nextResolve(specifier, context)
      // shim 自己取真实模块时放行
      if (String(context.parentURL ?? '').endsWith('/test/slow/fs.mjs')) {
        return nextResolve(specifier, context)
      }
      return { url: FS_SHIM, shortCircuit: true }
    }
  })
}
