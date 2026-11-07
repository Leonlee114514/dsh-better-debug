# dsh-better-debug

Turn a "stuck gate" from prompt text into a **code gate** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The five checks in `AGENTS.md` — and any `stuck-gate` skill — live in the **prompt layer**: the model has to *notice* it is stuck before the rules start applying. The characteristic symptom of being stuck is precisely that it does not notice. So it writes a third "let me try once more", eats the same error for the fourth time, or edits code and runs nothing.

This plugin does not read the model's mind. It watches what the model **does**, and when the behaviour matches "going in circles", it inserts one short user message **before the next step**.

```
[better-debug] 检测到你在原地打转：
- 同一个文件你已经在改第 3 次了，症状大概没变。
下一步别改代码，先做其中一件，做到再往下走：
1) 建一条几秒能跑完、现在就是红的回路（失败测试 / 一条复现命令 / lsp_diagnostics）…
2) 用报错原文整句 + 版本搜一次，10 分钟盒，GitHub closed issue 也看。
3) 拿到新证据后，一次只动一个变量。
完整五条：skill `stuck-gate`。
```

## Three signals

| Signal | Trigger | Default | Why |
| --- | --- | --- | --- |
| **A** same file, edited again | `fs/write-intent` counted per absolute path | 3rd time | Grinding on one point is the clearest "guessing without a loop" |
| **B** same error, eaten again | `tool/result` error fingerprint dedupe, and no search this turn | 2nd time | Twice means the first read didn't stick — also catches "should have searched, didn't" |
| **C** edited, never verified | N steps since the last write with no verify and no search | 2 steps | "Change and move on" is the most common missing check |

Error fingerprints are normalised — `0x1f3a2b9c` → `<hex>`, `C:\Users\...` → `<path>`, `42` → `<n>` — so an error whose line number moved but whose class didn't still counts as the same error.

**Search tools** (a hit clears both B and C): `web_search` `research` `advanced_search` `multi_search` `platform_search` `domain_search` `cache_search` `video_search`

**Verify tools** (clears A and C): `ops_bash` `lsp_diagnostics`

## What it deliberately does not do

- **No "I guess it's…" phrasing detection.** The plugin cannot see the model's inner monologue. That check stays in the `stuck-gate` skill, where self-detection belongs.
- **No probe cleanup at turn end.** That belongs to a turn-cleanup plugin.
- **Never `reject`.** Rejecting turns the whole turn into a no-op. The plugin only appends one user message to the tail of `messages`.
- **Never fires in subagent sessions.** `header.origin === 'subagent'` or `delegationDepth > 0` is skipped: their cwd may be someone else's workspace and their counters are not comparable.

## The "don't search, just fix it" exception

When the user explicitly says *don't search, just make the change, just try it quickly*, the gate must stand down. The plugin implements this by scanning this turn's **user** messages for `别搜|不要搜|不用搜|先别搜|直接改|快速试|别折腾|先试试` and going silent for the whole turn. Only `source.kind === 'user'` counts — the plugin's own injected message is ignored.

## Idempotence

Each signal fires at most once per turn, **and** a new fact (another write, another error) must have appeared since the last reminder. Both conditions are required; without the second one the model would be nagged on every step and the turn would never end.

When A or B fires, C is marked as already fired too: A/B already describe the situation, and adding "and you didn't verify" is just a restatement.

## Bundled skill

The package ships `assets/stuck-gate/SKILL.md` and registers it as a **bundled skill** through `inject: ["skills"]` (`source: "bundled"`, `rank: 600`). It appears in the model-visible skill catalog as soon as the plugin is installed — no copying files around. That is what the tail of the reminder points at.

Rank table (lower wins):

| rank | source | who speaks |
| --- | --- | --- |
| 100–200 | project `.dsh/skills`, `.agents/skills` | project override |
| 300 | `custom` | |
| 400 | `~/.dsh/skills` (user global) | **your own copy overrides the bundled one** |
| 500 | `~/.agents/skills` | |
| 600 | this plugin's `assets/` | the default wording |

So you can rewrite the gate's wording **without touching code**: drop a `~/.dsh/skills/stuck-gate/SKILL.md` and it wins. Editing the copy inside `assets/` applies to everyone who installs the plugin, and takes effect without a restart (`get()` re-reads the file).

On a host without a `skills` service the registration is skipped and logged; the gate itself keeps working.

## Install

```bash
dsh plugin add dsh-better-debug
```

Or by hand:

```bash
# 1. into local-pkgs
cp -r dsh-better-debug ~/.dsh/local-pkgs/

# 2. link dependency in the profile
cd ~/.dsh/profiles/desktop
# package.json → dependencies:
#   "dsh-better-debug": "link:../../local-pkgs/dsh-better-debug"
# package.json → dsh.profile.bundles, at the end:
#   "dsh-better-debug"

# 3. let the bundle patch mount it, or write your own row:
#      - id: better-debug
#        name: dsh-better-debug
#        inject: [skills]
#        config: { enabled: true }

# 4. restart DSH. Adding `skills` to inject is a structural change; HMR may not pick it up.
```

## Configuration

```yaml
- id: better-debug
  name: dsh-better-debug
  inject: [skills]
  config:
    enabled: true
    repeatEditThreshold: 3      # A: how many edits to the same file counts as circling
    repeatErrorThreshold: 2     # B: how many identical errors count as circling
    noVerifySteps: 2            # C: how many steps without a check counts as circling
    logFile: ""                 # absolute path; empty = no file (ctx.logger only reaches stdout)
```

Tighter (fires more often) → smaller numbers. Looser → bigger. With `enabled: false` no listener is registered at all.

## How to tell it is actually running

1. Point `logFile` at an absolute path, e.g. `~/.dsh/logs/better-debug.log`.
2. On load you get `apply pid=… logFile=… A=3 B=2 C=2`. **That line is the only proof the plugin is mounted** — `ctx.logger` only reaches the Electron stdout and cannot be grepped afterwards. No `apply` line means it never loaded.
3. Work normally; a hit looks like:
   ```
   inject session=… turn=32 step=98 signals=A files=1 worstEdits=3 worstErrors=0 searched=false
   ```
   `signals` lists the fired signals (`A`/`B`/`C`, joined by `+`). `files` is the number of **distinct** files touched this turn; `worstEdits` is how many times the worst one was edited — A keys off the latter. Read them together: `files=1 worstEdits=3` is "staring at one file and rewriting it three times", whereas `files=3 worstEdits=1` is ordinary wide-ranging work.
4. Self-check metric: does the **next** `tool/call` after an injection change category? `edit → edit` means it was ignored; `edit → lsp_diagnostics / web_search / reading a new file` means the reminder landed. Persistently under 30% means the wording or the thresholds need work — not that you need more signals.

## Local verification

```bash
node --check lib/index.js
node test/sim.mjs
```

`test/sim.mjs` replays the agent-loop call order with a fake ctx (`emitPlain` / `emitWaterfall` / `emitSerial`) and covers **15 cases**: positive and negative for each of A/B/C, idempotence, the quiet exception, subagent skip, adjustable thresholds, `enabled: false`, bundled-skill registration (including that the body is readable and de-privatised), a host without a `skills` service, and the export shape. It needs **no DSH runtime**, so run it after every change.

## Known limits

- "Same file" is judged by **absolute path**. Deleting and recreating a file of the same name still counts as the same spot. That is usually right (you are circling one concept), but if you are legitimately regenerating a file, raise `repeatEditThreshold` or move the checkpoint.
- Verification is detected **by tool name only** — it cannot tell whether `ops_bash` ran `npm test` or `ls`. It deliberately under-reports rather than risk marking something "verified" that wasn't.
- **Main sessions only.** In a multi-agent setup, each subagent circling on its own is not intercepted — but their output converges on the lead, so the lead's counters still work.

## License

MIT
