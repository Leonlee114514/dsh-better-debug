// 把 `node:path` 的解析重定向到 posix 版本。
//
// 只改路径语义，不动 fs：用例里的路径全是假的，不落盘。
export async function resolve(specifier, context, next) {
  if (specifier === 'node:path') {
    return { url: new URL('./path.mjs', import.meta.url).href, shortCircuit: true }
  }
  return next(specifier, context)
}
