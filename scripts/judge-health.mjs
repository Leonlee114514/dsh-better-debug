#!/usr/bin/env node
/**
 * 判据体检：一份真实日志 → 四个数 → 是否达标。
 *
 * 为什么需要它：C 信号在 20 天真实日志里占了 71%，命中率只有 6.3%，
 * arm 行的 writes= 只有一个取值 —— 这三条同时出现，说明判据本身错了轴，
 * 而不是「模型不听话」。但这类结论过去只能靠人工 grep + 心算，改完也无法
 * 回答「好了没有」。所以把四个判据固化成可执行的断言：任一不达标 exit 1。
 *
 * 四个数各自的含义与阈值来源（2026-11-26 之前那份 20 天日志的实测值）：
 *   C 占比     0.71  → 上限 0.35  C 是「盲改够了但还没测量」，一个健康闸门里
 *                                它不该是主信号；超过三分之一说明它在替别的
 *                                信号开口（错轴、或与 A 重叠却没互斥）。
 *   arm 清掉率 0.47  → 下限 0.60  上膛之后的第一次测量把写入清掉了，才算这一轮
 *                                真的「测过」。旧判据数 arm 行 writes= 的取值个数，
 *                                但 writes 恒等于阈值，那个数只反映同一 step 连写
 *                                了几份 —— 数的是步长不是行为，已废弃。
 *   C 命中率   0.063 → 下限 0.25  命中 = 注入后窗口内出现 change 行（真的去
 *                                验证/搜索了）。太低说明提醒没换来任何回路。
 *   C futile   0.156 → 上限 0.30  看过第一动作、窗口内没等到转向就被判无效。
 *                                太高说明这条提醒说了也没人搭理的居多。
 *
 * 阈值不是普适真理，是这台机器这段时间的基线。换机器/换模型后先跑一遍看数，
 * 再决定是否调整（每个阈值都在下面的 JUDGES 里单点可改）。
 *
 * ── 两个口径开关（0.3.6 新增）──────────────────────────────────────────────
 *
 * --since-apply  只统计最后一次 apply 之后的记录。
 *   升级插件后日志里必然混着旧版本产生的历史行，而判据的轴本身可能已经换过
 *   （0.3.5 把 C 从 gap= 换成 writes=，0.3.6 又给 C 加了 A 互斥）。拿旧行的数
 *   去判新判据必然 FAIL —— 那不是代码错了，是口径错了。默认不开启：全量看历史
 *   仍是第一眼该看的东西，但输出会提示两个窗口差多少，让人自己决定。
 *
 * 样本下限      每个判据带 minSamples，分母不足时 SKIP 而不是 FAIL。
 *   用 1 条注入算出来的 100% 命中率不是健康，是噪声。SKIP 的含义是「还没有
 *   数据」，与 PASS（看过且达标）严格区分，也与 FAIL（看过且越界）区分。
 *
 * 用法：
 *   node scripts/judge-health.mjs [日志路径] [--since-apply] [--json]
 *   node scripts/judge-health.mjs test/fixtures/better-debug.sample.log
 *
 * 默认日志路径与插件一致：$DSH_HOME/logs/better-debug.log（无 DSH_HOME 时用 ~/.dsh）。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseLog } from '../lib/panel.js'

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const sinceApply = argv.includes('--since-apply')
const positional = argv.filter((arg) => !arg.startsWith('-'))

function defaultLogFile() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'logs', 'better-debug.log')
}

const logFile = positional[0] ?? defaultLogFile()

let text
try {
  text = readFileSync(logFile, 'utf8')
} catch (error) {
  console.error('judge-health: 读不到日志 ' + logFile)
  console.error('  ' + (error?.message ?? error))
  console.error('  面板/插件还没写过日志时这是正常的：先跑一次 DSH 让它 apply 一遍。')
  process.exit(2)
}

const all = parseLog(text)

// 最后一次 apply 之后才是当前这份代码写出来的行。apply 自己也算窗口起点。
let lastApply = -1
for (let i = 0; i < all.length; i += 1) if (all[i].kind === 'apply') lastApply = i
const records = sinceApply ? all.slice(lastApply + 1) : all
const preApply = lastApply >= 0 ? lastApply + 1 : all.length

// ── 统计 ────────────────────────────────────────────────────────────────────
const injects = records.filter((r) => r.kind === 'inject')
const arms = records.filter((r) => r.kind === 'arm')
const futileInjs = new Set(records.filter((r) => r.kind === 'futile').map((r) => r.inj))
const changedInjs = new Set(records.filter((r) => r.kind === 'change').map((r) => r.inj))

const withC = injects.filter((r) => r.signals.includes('C'))
const bySignal = { A: 0, B: 0, C: 0, F: 0, O: 0, P: 0, M: 0 }
for (const record of injects) {
  for (const sig of record.signals) if (bySignal[sig] !== void 0) bySignal[sig] += 1
}

// arm → 同 session 的下一条 measure：这一对才回答「上膛之后到底测了没有、清没清掉」。
// 不配对（会话提前结束、arm 之后没跑任何命令）的 arm 不进分母 —— 它连「测过」都
// 没发生，算进去只会把比例稀释成噪声。
const pairs = []
const pendingArm = new Map()
for (const record of records) {
  if (record.kind === 'arm') pendingArm.set(record.session, record)
  else if (record.kind === 'measure' && pendingArm.has(record.session)) {
    pairs.push({ arm: pendingArm.get(record.session), measure: record })
    pendingArm.delete(record.session)
  }
}
const armCleared = pairs.filter((pair) => pair.measure.cleared > 0).length
const cTurned = withC.filter((r) => r.inj.length > 0 && changedInjs.has(r.inj)).length
const cFutile = withC.filter((r) => r.inj.length > 0 && futileInjs.has(r.inj)).length

// ── 判据 ────────────────────────────────────────────────────────────────────
// `better` 描述「往哪个方向算好」：ratio 类都是越低越好或越高越好，写成单点配置
// 而不是在下面 if 里散落比较方向，改阈值时只看这张表。
//
// `minSamples` 是分母下限。数值取的是「低于这个数就纯属噪声」的保守线：占比与
// 命中率的分母是注入条数，20 条才能把 5% 与 30% 分开；arm 清掉率的分母是
// arm→measure 配对，5 对才能区分「一次没清」与「系统性不清」；带 C 的注入通常
// 只占注入的一部分，5 条起算。
const JUDGES = [
  {
    id: 'c-share',
    label: 'C 占比',
    value: injects.length > 0 ? bySignal.C / injects.length : null,
    limit: 0.35,
    better: 'lower',
    samples: injects.length,
    minSamples: 20,
    sampleText: '注入 ' + injects.length + ' 条',
    detail: 'signals 含 C 的注入 ' + bySignal.C + ' / 总注入 ' + injects.length,
    why: 'C 不该是主信号；超过三分之一说明它在替别的信号开口'
  },
  {
    id: 'arm-cleared',
    label: 'arm 清掉率',
    value: pairs.length > 0 ? armCleared / pairs.length : null,
    limit: 0.6,
    better: 'higher',
    samples: pairs.length,
    minSamples: 5,
    sampleText: 'arm→measure 配对 ' + pairs.length + ' 对',
    detail: '上膛后清掉写入 ' + armCleared + ' / 配对 ' + pairs.length +
      '（arm ' + arms.length + ' 条，未配对的 ' + (arms.length - pairs.length) + ' 条不进分母）',
    why: '上膛之后的测量没清掉写入 = C 永远等不到解武装，会反复开口'
  },
  {
    id: 'c-turn-rate',
    label: 'C 命中率',
    value: withC.length > 0 ? cTurned / withC.length : null,
    limit: 0.25,
    better: 'higher',
    samples: withC.length,
    minSamples: 5,
    sampleText: '带 C 的注入 ' + withC.length + ' 条',
    detail: '窗口内转向 ' + cTurned + ' / 带 C 的注入 ' + withC.length,
    why: '命中 = 注入后真的去验证或搜索；太低说明提醒没换来回路'
  },
  {
    id: 'c-futile',
    label: 'C futile 率',
    value: withC.length > 0 ? cFutile / withC.length : null,
    limit: 0.3,
    better: 'lower',
    samples: withC.length,
    minSamples: 5,
    sampleText: '带 C 的注入 ' + withC.length + ' 条',
    detail: '窗口内被判无效 ' + cFutile + ' / 带 C 的注入 ' + withC.length,
    why: '看过第一动作却没等到转向就被移除 = 说了没人搭理的居多'
  }
]

function verdictOf(judge) {
  // 顺序有意义：分母不足时先判样本，再看数值。否则 1/1 = 100% 会被当成健康。
  if (judge.samples < judge.minSamples) return 'skip'
  if (judge.value === null) return 'skip'
  return judge.better === 'lower'
    ? judge.value <= judge.limit ? 'pass' : 'fail'
    : judge.value >= judge.limit ? 'pass' : 'fail'
}

function skipReasonOf(judge) {
  if (judge.samples < judge.minSamples) {
    return '样本不足：' + judge.samples + ' < ' + judge.minSamples + '（' + judge.sampleText + '）'
  }
  return '分母为 0，算不出比例'
}

const results = JUDGES.map((judge) => ({ ...judge, verdict: verdictOf(judge) }))
const failed = results.filter((r) => r.verdict === 'fail')
const skipped = results.filter((r) => r.verdict === 'skip')

// ── 输出 ────────────────────────────────────────────────────────────────────
const pct = (value) => value === null ? 'n/a' : (value * 100).toFixed(1) + '%'
const shown = (judge) => pct(judge.value)
const limitText = (judge) => (judge.better === 'lower' ? '≤ ' : '≥ ') + pct(judge.limit)

if (asJson) {
  console.log(JSON.stringify({
    logFile,
    sinceApply,
    records: records.length,
    skippedBeforeApply: sinceApply ? preApply : 0,
    injects: injects.length,
    arms: arms.length,
    armPairs: pairs.length,
    armCleared,
    bySignal,
    judges: results.map((r) => ({
      id: r.id,
      label: r.label,
      value: r.value,
      limit: r.limit,
      better: r.better,
      samples: r.samples,
      minSamples: r.minSamples,
      verdict: r.verdict,
      detail: r.detail,
      skipReason: r.verdict === 'skip' ? skipReasonOf(r) : void 0
    })),
    ok: failed.length === 0,
    complete: skipped.length === 0,
    // exitCode 与退出码同源，方便调用方在读 JSON 时不靠猜：0 健康 / 1 越界或无数据
    exitCode: failed.length === 0 && !(results.length > 0 && skipped.length === results.length) ? 0 : 1
  }, null, 2))
} else {
  console.log('judge-health: ' + logFile)
  console.log('  记录 ' + records.length + ' 条 · 注入 ' + injects.length + ' · arm ' + arms.length +
    (sinceApply ? '（只看最后一次 apply 之后）' : ''))
  if (!sinceApply && lastApply >= 0 && preApply < all.length) {
    console.log('  ⚠ 最后一次 apply 之前还有 ' + preApply + ' 条记录（旧版本写的）：' +
      '加 --since-apply 只判新代码。升级后第一次看日志请用它。')
  }
  if (sinceApply && records.length === 0) {
    console.log('  本次 apply 之后还没有任何记录 —— 先跑一段真实会话再判。')
  }
  console.log('')
  for (const r of results) {
    const mark = r.verdict === 'pass' ? 'PASS' : r.verdict === 'fail' ? 'FAIL' : 'SKIP'
    console.log('  [' + mark + '] ' + r.label.padEnd(16) + ' ' + shown(r).padStart(7) + '   ' + limitText(r))
    console.log('         ' + r.detail)
    if (r.verdict === 'fail') console.log('         ↳ ' + r.why)
    if (r.verdict === 'skip') console.log('         ↳ ' + skipReasonOf(r))
  }
  console.log('')
  if (failed.length > 0) {
    console.log('判据不健康：' + failed.map((r) => r.label).join(' / ') + ' 越界。')
  } else if (skipped.length === results.length) {
    console.log('没有可用数据：四个判据全部跳过。exit 1 —— 「没数据」不等于「健康」，先跑一段真实会话。')
  } else if (skipped.length > 0) {
    console.log('判据健康：' + (results.length - skipped.length) + ' 个在阈值内，' +
      skipped.length + ' 个因样本不足跳过（' + skipped.map((r) => r.label).join(' / ') + '）。')
  } else {
    console.log('判据健康：四个数都在阈值内。')
  }
}

// 退出码三态，不能只用「有没有失败项」两态：
//   0 = 至少一个判据真的判过，且没有越界；
//   1 = 有判据越界，或者四个判据一条数据都没有（全 SKIP）。
// 全 SKIP 过去也走 exit 0，于是「日志一行没写」和「四个数都在阈值内」给出同一个退出码；
// 本文件被 package.json 的 test:unit 用 && 串在最后，那等于把「没测」记成「测过了」。
// 只有部分判据 SKIP（其余的判过且在阈值内）仍然 exit 0：样本不足是常态，不是故障。
const noData = results.length > 0 && skipped.length === results.length
process.exit(failed.length === 0 && !noData ? 0 : 1)
