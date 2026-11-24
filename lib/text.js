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
  C: '上次改完已经过了 {n} 步，这期间没有任何动作，也没测量。',
  // F/O/P 是「方案层」观察：动作在变、测量也有，但局面没往前走。
  // 措辞仍然只陈述可数的事实（几次、几种、几轮），不说「你在固着」。
  F: '同一个目标上已经连续出现 {n} 种不同报错，共 {m} 次。',
  O: '同一组验证的结果已经在通过和不通过之间翻转了 {n} 次，每次翻转之间都有修改。',
  P: '已经连续 {n} 轮「验证失败 → 修改 → 验证仍失败」，每一轮都修出了下一个失败。'
}

/**
 * 每个信号「最匹配的那一个动作」。只给一条：给三条等于没给。
 * A/C 的处境是「没有回路」，B 的处境是「同一堵墙」。
 */
export const SIGNAL_ACTION = {
  A: '建一条几秒能跑完、能给出数字或事实的回路（失败测试 / 复现命令 / 一条断言 / lsp_diagnostics）；建不出来就停下要现场产物。',
  B: '用报错原文整句 + 版本搜一次（10 分钟盒，GitHub closed issue 也看），或写一个只复现这一个报错的最小脚本。',
  C: '先测量或先搜，再动下一处；如果任务其实已经收敛，直接说明结论。',
  // F/P 的处境是「同一层反复修」，给的动作必须换层，不是再修一次。
  F: '这些报错共享同一个现场：先停下来找它们的共同前提（环境 / 数据 / 假设），而不是逐个修症状；能写一个同时复现其中两种报错的最小脚本最好。',
  O: '修改在把问题来回推：先固定一个当前为红的用例，只做让它变绿的最小改动，其余改动先撤下；如果两次修改互相破坏，说明它们共享一个错误假设，先写出这个假设再动。',
  P: '这一串补丁共享一个还没被检验的假设：用 3–5 行写下它，并给出一个机制上不同的修法（换数据结构 / 换责任层 / 先最小复现再重写），不要直接打第 {n+1} 个补丁。'
}

const HEADER = '[better-debug] 观察到的重复动作（只是观察，不是结论）：'
const RECOVERY = '恢复条件：拿到一条新的测量结果或一条外部事实后，继续动手即可。'
const SKILL_HINT = '完整五条：skill `stuck-gate`。'

/**
 * 信号数组 → 注入文本。
 *
 * 占位符只认三种，且都是**数字**——文案里出现任何需要模型自己推断的东西，
 * 就等于替它下了诊断：
 *   {n}   该信号自己的计数（A/B/C 是次数，F 是「几种」，O 是翻转次数，P 是轮数）
 *   {m}   同一族的**总次数**（只有 F 用；缺省回退成 n，让老调用点也能渲染）
 *   {n+1} P 专用：第几个还没打的补丁。**必须**在 {n} 之前替换，否则会被拆成 "3+1"。
 * @param {Array<{kind: keyof typeof SIGNAL_TEXT, n: number, m?: number, detail?: string}>} signals
 */
export function messageText(signals) {
  const list = Array.isArray(signals) ? signals : []
  const reasons = list.map((signal) => {
    const template = SIGNAL_TEXT[signal.kind]
    if (template === void 0) return ''
    const observed = template
      .replace(/\{n\+1\}/g, String(Number(signal.n) + 1))
      .replace(/\{n\}/g, String(signal.n))
      .replace(/\{m\}/g, String(signal.m ?? signal.n))
    return `- ${observed}${signal.detail ? ` ${signal.detail}` : ''}`
  }).filter((line) => line.length > 0)

  // 多个信号同时命中时最多给两条动作，再多模型就开始跳过正文了。
  const actions = []
  for (const signal of list) {
    let action = SIGNAL_ACTION[signal.kind]
    if (action === void 0) continue
    action = action.replace(/\{n\+1\}/g, String(Number(signal.n) + 1))
    if (!actions.includes(action) && actions.length < 2) actions.push(action)
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

/**
 * M（元闸门）的独立文案。
 *
 * 为什么**不**复用 `messageText`：M 说的不是「你又重复了哪个动作」，而是
 * 「这个插件自己的提醒已经连续 n 次没换来任何转向」——这是一句关于**干预本身**
 * 的判断，结构上要求模型先写三段话再动手。把它塞进「观察 + 动作 + 恢复条件」
 * 那个模板里，就会被读成第四条普通提醒，而它要表达的恰好是「普通提醒已经用完」。
 *
 * `n` 是**连续**无效注入次数（futile），不是本 turn 的注入总数：中间只要出现过
 * 一次真正的转向（验证 / 搜索）或一次成功测量，计数就归零。所以文案说的是
 * 「连续 N 次提醒没有换来转向」，而不是「提醒过 N 次」——后者与证据不符。
 */
export function metaMessageText(n) {
  const count = Number.isFinite(Number(n)) ? Number(n) : 0
  return [
    `[better-debug] 元观察：这个 turn 里已经连续 ${count} 次提醒没有换来转向。`,
    '这不是「再试一次」能解决的问题了。下一步之前先写三段话（总共不超过 12 行）：',
    '1) 你已经试过的方案清单，以及它们共享的那个假设；',
    '2) 一个机制上不同的方案——换数据结构、换库、换责任层、或先造最小复现再重写，四选一，说明它为什么绕开了之前所有的墙；',
    '3) 如果写不出第 2 条，说明缺的是现场而不是尝试：列出你需要用户补充的一份具体产物（日志 / 最小复现 / 环境信息）。',
    '写完之前不要发起任何修改类工具调用。'
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
 *
 * `M` 走 `metaMessageText`：它不在 `messageText` 的模板里，用错函数会算出一个
 * 与真实注入差好几倍的字符数（面板的 token 统计就跟着错），所以这里显式分叉。
 */
export function charsFor(signals) {
  const list = Array.isArray(signals) ? signals : []
  if (list.length === 0) return 0
  if (list.length === 1 && list[0] === 'M') return metaMessageText(0).length
  return messageText(list.map((kind) => ({ kind, n: 0 }))).length
}
