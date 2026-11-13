// `node:path` 的替身：全部按 posix 语义。
//
// 这样 `--import` 之后，插件在 Windows 上也会看到「`C:/work/a.js` 不是绝对路径」
// 这种 Linux/macOS 才有的判断结果。
export {
  isAbsolute,
  dirname,
  join,
  sep,
  basename,
  extname,
  normalize,
  relative,
  resolve,
  parse,
  format,
  toNamespacedPath
} from 'node:path/posix'

import * as posix from 'node:path/posix'

export const win32 = posix
export const posixApi = posix
export default posix
