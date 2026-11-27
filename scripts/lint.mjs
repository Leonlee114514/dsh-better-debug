#!/usr/bin/env node
/**
 * 零依赖死代码检查：找出「声明了但全文只出现一次」的模块级名字。
 *
 * 为什么不用 eslint / tsc：这个项目的卖点之一是装完零依赖，devDependencies
 * 也不该为了五条 no-unused-vars 就背进来（离线环境、内网 CI、老 Node 都会卡）。
 * 而真正想拦的问题只有一类 —— **写完了却没人用**，这在 2400 行单文件里靠
 * 编辑器提示很容易漏（第五轮评审就是这样找到 5 处死代码的）。
 *
 * 判定方式：模块级 `const/let/var/function/class` 声明的名字，在**原始文本**里按
 * 整词计数，只有 1 次（就是它自己）即判定为未被引用。
 *
 * 刻意不做词法分析（不剥注释、不剥字符串）。第一版剥了，结果 `replace(/'/g, ...)`
 * 这类正则里的引号被当成字符串起点，把后面几百行真代码抹成空白，于是满屏误报。
 * 代价是：注释或字符串里提到某个名字会抬高计数 —— 那是**漏报**方向，
 * 而漏报只是少发现一处死代码，误报会让人直接把这个脚本关掉。
 *
 * 明确的局限（写下来免得别人高估它）：
 *   · 只查模块级，不查函数内部；
 *   · 只查名字，不查类型/签名/控制流 —— 它不是类型检查器；
 *   · 导出的声明一律跳过（导出即对外契约，是否真有人用不是静态能回答的）；
 *   · 同名遮蔽会漏报（函数内的局部同名变量会抬高计数）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TARGETS = ['lib', 'scripts', 'test', 'client.js']

/** 收集要检查的文件（跳过 node_modules 与隐藏目录）。 */
function walk(path) {
  const abs = join(ROOT, path)
  let stat
  try {
    stat = statSync(abs)
  } catch {
    return []
  }
  if (stat.isFile()) return /\.(?:m?js)$/.test(abs) ? [abs] : []
  const out = []
  for (const name of readdirSync(abs)) {
    if (name.startsWith('.') || name === 'node_modules') continue
    out.push(...walk(join(path, name)))
  }
  return out
}

const DECL = /^(?:export\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/
const findings = []
for (const file of TARGETS.flatMap(walk)) {
  const raw = readFileSync(file, 'utf8')
  const lines = raw.split('\n')
  lines.forEach((line, index) => {
    // 只看顶格声明：模块级没有缩进。函数体内部的声明不在本脚本的能力范围内。
    if (/^\s/.test(line)) return
    const match = DECL.exec(line)
    if (match === null) return
    if (/^export\b/.test(line)) return
    const name = match[1]
    const word = new RegExp('(^|[^\\w$])' + name.replace(/\$/g, '\\$') + '([^\\w$]|$)', 'g')
    let count = 0
    for (const other of lines) {
      word.lastIndex = 0
      while (word.exec(other) !== null) count += 1
      if (count > 1) return
    }
    findings.push({ file: relative(ROOT, file).replace(/\\/g, '/'), line: index + 1, name, text: line.trim() })
  })
}

if (findings.length > 0) {
  console.error('[lint] 模块级声明但全文只出现一次（疑似死代码）：')
  for (const item of findings) console.error('  ' + item.file + ':' + item.line + '  ' + item.name + '  ' + item.text)
  process.exit(1)
}
console.log('[lint] ok — 没有未引用的模块级声明')
