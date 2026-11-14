// 让 `process.platform` 在本进程里表现为 linux，用来在 Windows 开发机上跑
// 「Linux 语义」这一轮测试。
//
// 为什么需要它：2026-11-14 的真机 CI（ubuntu-latest）把 0.2.2 的两组新断言打红了，
// 而本机 Windows 上、以及 `test:posix` 那一轮（它只换 `node:path`）都是绿的——
// 因为 `CASE_INSENSITIVE` 由 `process.platform` 决定，Windows 上恒为 true，
// 于是「期望值写成小写」的断言看起来永远成立。根因不在被测代码，而在
// **断言本身也沾了本机平台**：它测的是「Windows 上通过」。
//
// 这一轮不替换 path 模块（那是 test:posix 的事），只替换 platform，
// 两轴分开：path 方言 × 大小写敏感，四种组合里有三种能在本机跑到。
//
// 用法：node --import ./test/linux/register.mjs test/sim.mjs
//
// 注意：`process.platform` 是 getter 属性，直接赋值会被静默忽略，
// 必须 defineProperty。它是可配置的，所以能覆盖。
Object.defineProperty(process, 'platform', {
  value: 'linux',
  configurable: true,
  enumerable: true,
  writable: false
})
