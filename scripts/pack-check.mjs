#!/usr/bin/env node
/**
 * 发布契约自检：files 白名单必须覆盖 scripts 里引用的每一个路径。
 *
 * 为什么需要它：0.3.5 之前 files 不含 test/，而 7 条 scripts 全部引用 test/ ——
 * 从 npm 装回来的包里 npm test 直接 MODULE_NOT_FOUND，7/7 全死，且没有任何
 * 自动化会发现（CI 跑在克隆仓库里，test/ 一定在）。这类「只在发布形态下才坏」
 * 的问题必须在打包时拦，装完再发现就已经晚了。
 *
 * 判定方式刻意保守：只认字面路径，不猜。脚本里出现 test/sim.mjs 就要求 files
 * 里有一项能覆盖它（同名前缀目录，或完全相同的文件名）。
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** files 里的一项是否覆盖给定相对路径。 */
function covered(entry, target) {
  const clean = entry.replace(/^[./]+/, '').replace(/\/+$/, '')
  if (clean.length === 0) return false
  if (target === clean) return true
  return target.startsWith(clean + '/')
}

const entries = Array.isArray(pkg.files) ? pkg.files : []
const referenced = new Set()
for (const command of Object.values(pkg.scripts ?? {})) {
  if (typeof command !== 'string') continue
  for (const token of command.split(/[\s&|;]+/)) {
    const clean = token.replace(/^['"]|['"]$/g, '')
    if (!clean.includes('/')) continue
    if (clean.startsWith('-')) continue
    if (!existsSync(join(ROOT, clean))) continue
    referenced.add(relative(ROOT, join(ROOT, clean)).replace(/\\/g, '/'))
  }
}


// ── 静态必需项（P1-G）───────────────────────────────────────────────────────
// 上面那一段只覆盖「scripts 里出现过的路径」，而插件真正离不开的三样东西
// 一次都不出现在 script 里：
//   dsh.bundle.patch  → DSH 靠它 insert 插件；漏了则装进去根本没有 apply 行，
//                        面板/闸门全静默不工作，npm test 却全绿。
//   exports['./client'] → dsh-client-modules 会抛
//                        'declares dsh.client but exports no "./client" bundle'。
//   assets/            → skill 正文，registerBundledSkill 读不到就只能记 skill failed。
//   web/index.html     → 面板静态页，缺了路由返回 404，前端渲染 .bd-fail。
const REQUIRED = [
  ['dsh.bundle.patch', pkg.dsh?.bundle?.patch],
  ['exports["./client"]', pkg.exports?.['./client']],
  ['assets/stuck-gate/SKILL.md', 'assets/stuck-gate/SKILL.md'],
  ['web/index.html', 'web/index.html'],
]

const requiredMissing = []
for (const [label, raw] of REQUIRED) {
  if (typeof raw !== 'string' || raw.length === 0) {
    requiredMissing.push(label + '（package.json 里没有声明）')
    continue
  }
  const clean = raw.replace(/^\.\//, '')
  if (!existsSync(join(ROOT, clean))) {
    requiredMissing.push(label + ' → ' + clean + '（文件不存在）')
    continue
  }
  if (!entries.some((entry) => covered(entry, clean))) requiredMissing.push(label + ' → ' + clean + '（files 没覆盖）')
}

if (requiredMissing.length > 0) {
  console.error('[pack-check] 插件必需项没有被打进包里：')
  for (const item of requiredMissing) console.error('  - ' + item)
  console.error('[pack-check] 这些不在任何 npm script 里，只能靠这张静态清单拦。')
  process.exit(1)
}
const missing = [...referenced].filter((path) => !entries.some((entry) => covered(entry, path)))
if (missing.length > 0) {
  console.error('[pack-check] files 白名单漏了 scripts 引用的路径：')
  for (const path of missing) console.error('  - ' + path)
  console.error('[pack-check] 装回来的包会缺这些文件，对应 npm script 会直接失败。')
  process.exit(1)
}
console.log('[pack-check] ok — ' + referenced.size + ' 个脚本路径 + ' + REQUIRED.length + ' 个静态必需项都被 files 覆盖')
