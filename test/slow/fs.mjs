// `node:fs/promises` 的替身：只把 `appendFile` 拖慢，其余原样转发。
//
// 为什么需要它：插件刻意 `void record(...)` 不 await（不能因为写日志拖慢每一步），
// 所以「日志写完没有」在测试里永远是竞态。真机 CI（windows-latest + node 24）
// 已经因此红过一次：inject/outcome/change 都落盘了，measure 还在队列里，
// 断言报「no measure line」——看起来像埋点坏了，其实只是读早了。
//
// 这个替身把那个时序放大到必然发生（默认 400ms），于是任何「等固定时长再读」
// 的写法都会稳定红，而「等条件」的写法依旧绿。这是回归防线，不是性能测试。
import * as real from 'node:fs/promises'

const DELAY = Number(process.env.BD_SLOW_MS ?? '400')

// 让用例能断言「这条防线真的在位」：如果 resolve hook 没生效，
// 插件拿到的还是真 appendFile，这个计数器就永远是 0。
const SLOW_SLOT = Symbol.for('better-debug.test.slow')
globalThis[SLOW_SLOT] = { count: 0, delay: DELAY }

export const appendFile = async (...args) => {
  globalThis[SLOW_SLOT].count += 1
  await new Promise((resolve) => setTimeout(resolve, DELAY))
  return real.appendFile(...args)
}

export const mkdir = real.mkdir
export const readFile = real.readFile
export const writeFile = real.writeFile
export const readdir = real.readdir
export const stat = real.stat
export const rm = real.rm
export const access = real.access
export const copyFile = real.copyFile
export const rename = real.rename
export const realpath = real.realpath
export const open = real.open

export default real.default
