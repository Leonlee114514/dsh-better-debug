/**
 * 注入文本的唯一来源。
 *
 * 为什么单独一个模块：文本长度以前在 `lib/panel.js` 里用硬编码常量
 * `{ A: 254, B: 268, C: 256 }` 回退，文案一改常量就漂，面板统计的字符数
 * 和真实注入量对不上（实测偏差 ~50 字符）。现在两边都调 `messageText()`，
 * 字符数**只有一个算法**，不存在漂移。
 *
 * 这个模块必须保持零依赖、无副作用：`lib/index.js`（运行时）和
 * `lib/panel.js`（只读视图）都会 import 它，panel 还被单测直接 import。
 */

/**
 * 每个信号的观察句。{n} 由运行时填。
 *
 * 措辞纪律：只说**观察到的事实**，不说诊断。「你在原地打转」是结论，
 * 插件能证明的只是「这几个动作重复了」——弱证据说成确定诊断会误导模型
 * 去解释自己而不是去建回路。
 */
export const SIGNAL_TEXT = {
  A: '同一个文件连续改了 {n} 次，中间没有任何测量。',
  B: '同一个操作重复报错 {n} 次，没有新事实进来。',
  C: '上次改完已经过了 {n} 步，这期间没有任何动作，也没测量。'
}

/**
 * 每个信号「最匹配的那一个动作」。只给一条：给三条等于没给。
 * A/C 的处境是「没有回路」，B 的处境是「同一堵墙」。
 */
export const SIGNAL_ACTION = {
  A: '建一条几秒能跑完、能给出数字或事实的回路（失败测试 / 复现命令 / 一条断言 / lsp_diagnostics）；建不出来就停下要现场产物。',
  B: '用报错原文整句 + 版本搜一次（10 分钟盒，GitHub closed issue 也看），或写一个只复现这一个报错的最小脚本。',
  C: '先测量或先搜，再动下一处；如果任务其实已经收敛，直接说明结论。'
}

const HEADER = '[better-debug] 观察到的重复动作（只是观察，不是结论）：'
const RECOVERY = '恢复条件：拿到一条新的测量结果或一条外部事实后，继续动手即可。'
const SKILL_HINT = '完整五条：skill `stuck-gate`。'

/**
 * 信号数组 → 注入文本。
 * @param {Array<{kind: keyof typeof SIGNAL_TEXT, n: number, detail?: string}>} signals
 */
export function messageText(signals) {
  const list = Array.isArray(signals) ? signals : []
  const reasons = list.map((signal) => {
    const template = SIGNAL_TEXT[signal.kind]
    if (template === void 0) return ''
    const observed = template.replace('{n}', String(signal.n))
    return `- ${observed}${signal.detail ? ` ${signal.detail}` : ''}`
  }).filter((line) => line.length > 0)

  // 多个信号同时命中时最多给两条动作，再多模型就开始跳过正文了。
  const actions = []
  for (const signal of list) {
    const action = SIGNAL_ACTION[signal.kind]
    if (action !== void 0 && !actions.includes(action) && actions.length < 2) actions.push(action)
  }

  return [
    HEADER,
    ...reasons,
    '下一步先做其中一件，拿到新事实再继续改：',
    ...actions.map((action, index) => `${index + 1}) ${action}`),
    RECOVERY,
    SKILL_HINT
  ].join('\n')
}

/** 中英混排的 token 粗估：CJK 1:1，其余 ~0.32。 */
const CJK = /[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/u

export function estimateTokens(text) {
  let cjk = 0
  let other = 0
  for (const char of String(text ?? '')) {
    if (CJK.test(char)) cjk += 1
    else other += 1
  }
  return Math.round(cjk + other * 0.32)
}

/**
 * 老日志行没有 `chars=` / `tokens=` 时按信号组合回退。
 * 不再是「常量表」而是「真算一遍文案」，所以永远和当前版本自洽。
 */
export function charsFor(signals) {
  const list = Array.isArray(signals) ? signals : []
  if (list.length === 0) return 0
  return messageText(list.map((kind) => ({ kind, n: 0 }))).length
}
