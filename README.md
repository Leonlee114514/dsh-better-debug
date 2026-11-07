# dsh-better-debug

把「卡住闸门」从自觉条款变成代码闸门。

`AGENTS.md` 里的五条闸门与 `stuck-gate` 技能都是**提示词层**的约束——模型得先想起
「我卡住了」，条款才开始生效。可卡住时的典型症状恰恰是**想不起来**：于是它写第 3 个
「再试一次」、吃第 4 遍同一个报错、改完代码不跑任何验证。这个插件不看模型说了什么，
只看它做了什么；一旦行为符合「原地打转」，就在**下一步之前**塞一句话进去。

## 三个信号

| 信号 | 触发条件 | 默认阈值 | 为什么是它 |
| --- | --- | --- | --- |
| **A** 同一文件反复改 | `fs/write-intent` 按绝对路径计数 | 第 **3** 次 | 单点反复摩擦是最典型的「没建出回路就在猜」 |
| **B** 同一报错反复吃 | `tool/result` 错误指纹去重计数，且本 turn 未搜过 | 第 **2** 次 | 同一个错两次说明第一次没读懂；且补了「该搜没搜」 |
| **C** 改完不验证 | 最后一次写入后已过 N 步，这期间既没验证也没搜 | **2** 步 | 「改完就跑下一个」是最常见的漏验证 |

错误指纹做了归一化：`0x1f3a2b9c` → `<hex>`、`C:\Users\...` → `<path>`、`42` → `<n>`，
所以「行号变了但异常类没变」仍算同一个错。

**搜索类工具**（命中即视为获取了外部先验，B 与 C 同时解除）：
`web_search` `research` `advanced_search` `multi_search` `platform_search`
`domain_search` `cache_search` `video_search`

**验证类工具**（A 与 C 解除）：
`ops_bash` `lsp_diagnostics`。

## 不做的事

- **不做「我猜是」措辞检测**：插件看不见模型的内心独白，这条留给 `stuck-gate` 技能自检。
- **不做收尾探针清零**：归 `dsh-turn-cleanup`。
- **不用 `reject`**：那会把整个 turn 变成 no-op。只往 `messages` 尾部追加一条 user 消息。
- **不对子会话生效**：`header.origin === 'subagent'` 或 `delegationDepth > 0` 一律跳过，
  它们的 cwd 可能是别人的工作区，计数也没有可比性。

## D 段例外

`AGENTS.md` 的 D 条：用户显式说「别搜了 / 直接改 / 快速试一下」时闸门不落。
插件用**本 turn 用户原话**实现这条——命中 `/别搜|不要搜|不用搜|先别搜|直接改|快速试|别折腾|先试试/`
就整 turn 静音。只认 `source.kind === 'user'` 的消息，插件自己注入的不算。

## 幂等

每条信号每个 turn 最多一次；且**上一次提醒之后必须出现新事实**（多写一次文件、多吃一个错）
才会再次开口。两个条件缺一不可——否则模型每多跑一步就被念一遍，turn 永远结束不了。

A/B 触发时会顺带把 C 标成已触发：A/B 已经说明了局面，再补一句「改完没验证」只是换个说法。

## 自带技能

插件包内含 `assets/stuck-gate/SKILL.md`，通过 `inject: ["skills"]` 注册成 **bundled 技能**
（`source: "bundled"`，`rank: 600`）——装完就出现在模型可见的技能目录里，不需要另外拷贝文件。

注入的那句提醒末尾写着「完整五条：skill `stuck-gate`」，指的是这一份。

**rank 关系**（数值小的优先）：

| rank | 来源 | 谁说话 |
| --- | --- | --- |
| 100–200 | 项目级 `.dsh/skills`、`.agents/skills` | 项目覆盖 |
| 300 | `custom` | |
| 400 | `~/.dsh/skills`（用户全局） | **用户自己放的会压过本插件** |
| 500 | `~/.agents/skills` | |
| 600 | 本插件 `assets/` | 默认文案 |

所以想改闸门措辞**不必改代码**：在 `~/.dsh/skills/stuck-gate/SKILL.md` 放一份就自动生效。
改插件里的那份则对所有安装者生效（改了 `assets/` 下的文件，`get()` 每次重读，无需重启）。

宿主若没有 `skills` 服务（老版本 DSH），注册会被跳过并记一行日志，**闸门本身照常工作**。

## 安装

```bash
# 1. 放进 local-pkgs（与你现有的 dsh-turn-cleanup 并列）
cp -r dsh-better-debug ~/.dsh/local-pkgs/

# 2. profile 里加 link 依赖
cd ~/.dsh/profiles/desktop
# package.json → dependencies 加一行：
#   "dsh-better-debug": "link:../../local-pkgs/dsh-better-debug"
# package.json → dsh.profile.bundles 数组末尾加：
#   "dsh-better-debug"

# 3. 让 bundle patch 挂上（如果 bundles 已含它，dsh 会自动 apply 包内的 cordis.patch.yml）
#    或者在自己的 profile cordis.patch.yml 里手写一行：
#      - id: better-debug
#        name: dsh-better-debug
#        inject: [skills]
#        config: { enabled: true }

# 4. 重启 DSH。inject 里多了 skills 属于结构性变更，HMR 未必能生效。
```

## 配置

```yaml
- id: better-debug
  name: dsh-better-debug
  inject: [skills]
  config:
    enabled: true
    repeatEditThreshold: 3      # A：同一文件改几次算打转
    repeatErrorThreshold: 2     # B：同一类报错几次算打转
    noVerifySteps: 2            # C：改完几步没验证算打转
    logFile: ""                 # 绝对路径；空 = 不落盘（ctx.logger 只进 stdout）
```

调紧（更容易触发）→ 数字调小；放松 → 调大。`enabled: false` 时连 listener 都不注册。

## 怎么验证它真的在工作

1. `logFile` 设成一个绝对路径，比如 `~/.dsh/logs/better-debug.log`（Windows 写 `C:/Users/<you>/.dsh/logs/better-debug.log`）。
2. 加载即有一行 `apply pid=… logFile=… A=3 B=2 C=2`——**这一行是唯一能证明「插件到底加载了」的证据**
   （`ctx.logger` 只进 Electron stdout，事后 grep 不到）。没有 `apply` 行就是没挂上。
3. 正常干活，日志出现这样一行即为命中：
   ```
   inject session=… turn=32 step=98 signals=A files=1 worstEdits=3 worstErrors=0 searched=false
   ```
   `signals` 是命中的信号（`A`/`B`/`C`，多条用 `+`）；`files` 是本 turn 碰过的**不同文件数**、
   `worstEdits` 是其中**最惨那个被改了几次**——判 A 用的是后者。两个数字混着看才不误导：
   `files=1 worstEdits=3` 才是「盯着一个文件改三遍」。
4. 自证指标：注入后**下一个** `tool/call` 的类别有没有变。
   `edit → edit` 说明它被无视了；`edit → lsp_diagnostics / web_search / 读新文件`
   说明提醒有效。持续低于 30% 就该改文案或阈值，而不是加更多信号。

## 本地验证

```bash
node --check lib/index.js
node test/sim.mjs
```

`test/sim.mjs` 用假 ctx 复刻 agent-loop 的调用顺序（`emitPlain` / `emitWaterfall` /
`emitSerial`），覆盖 **15 个用例**：A/B/C 各一条正例与反例、幂等、D 段静音、子会话跳过、
阈值可调、`enabled:false`、自带技能注册（含正文可取与已去私有化）、宿主无 `skills` 服务时不抛、
导出形状。**不依赖 DSH 运行时**，改动后先跑它。

## 已知边界

- 「同一文件」按**绝对路径**判定。删了重建同名文件也算同一处——这通常是对的（说明在同一个
  概念上打转），但如果只是反复改生成文件，把 `repeatEditThreshold` 调大或换个检查点。
- `useVerifying` 只看工具名，看不懂 `ops_bash` 里跑的是 `npm test` 还是 `ls`。
  宁可漏判也不误判成「已验证」。
- 只在**主会话**生效。多 agent 场景下每个 subagent 各自打转不会被拦——但它们的产物最终
  汇到 lead，lead 这边的计数仍然有效。

## License

MIT
