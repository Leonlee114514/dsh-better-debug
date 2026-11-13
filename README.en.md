# dsh-better-debug

Turn a "stuck gate" from prompt text into a **code gate** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The five checks in `AGENTS.md` — and any `stuck-gate` skill — live in the **prompt layer**: the model has to *notice* it is stuck before the rules start applying. The characteristic symptom of being stuck is precisely that it does not notice. So it writes a third "let me try once more", eats the same error for the fourth time, or edits code and runs nothing.

This plugin does not read the model's mind. It watches what the model **does**, and when the behaviour matches "going in circles", it inserts one short user message **before the next step**.

```
[better-debug] 检测到你在原地打转：
- 同一个文件你连续改了 3 次，中间夹不进任何验证或新信息。
下一步别急着再改，先做其中一件、拿到新事实再往下走：
1) 建一条几秒能跑完、能给出数字或事实的回路（失败测试 / 复现命令 / 词数段数统计 / checklist 断言 / lsp_diagnostics）…
2) 用报错原文整句或需求关键词 + 版本搜一次，10 分钟盒，GitHub closed issue 也看。
3) 拿到新证据后，一次只动一个变量；数字朝目标收敛且每步有测量 = 有进展，不算打转。
完整五条：skill `stuck-gate`。
```

## Three signals

| Signal | Trigger | Default | Why |
| --- | --- | --- | --- |
| **A** same file, edited **without any check in between** | `fs/write-intent` per absolute path; **any verify clears the streak** | 3rd time | Grinding on one point with no new facts is the clearest "guessing without a loop" |
| **B** same error, eaten again | `tool/result` error fingerprint dedupe, and no search this turn | 2nd time | Twice means the first read didn't stick — also catches "should have searched, didn't" |
| **C** edited, never verified | N steps since the last write with no verify and no search | 2 steps | "Change and move on" is the most common missing check |

Error fingerprints are normalised — `0x1f3a2b9c` → `<hex>`, `C:\Users\...` → `<path>`, `42` → `<n>` — so an error whose line number moved but whose class didn't still counts as the same error.

**Search tools** (a hit clears both B and C): `web_search` `research` `advanced_search` `multi_search` `platform_search` `domain_search` `cache_search` `video_search`

**Verify tools** (clears A's blind-edit streak and C): `ops_bash` `lsp_diagnostics` `verify` `run_tests`

> The reset is deliberate: a word count converging 725 → 664 → 601 → 591 with a measurement
> after every edit is *loop-driven iteration*, not circling. The old cumulative counter
> mis-fired on exactly that. `decayEditsOnVerify: false` restores the old behaviour.

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

## Trigger preconditions (v0.1.2)

The gate governs **before the next attempt**, not after delivery. Three checks run first:

1. **done-state**: a `present` call happened this turn and no new write followed → **no injection**;
   a `suppress … reason=done` line is written. The next `fs/write-intent` re-arms the gate.
   Switch: `doneOnPresent: false`.
2. **Converging with progress**: see the streak reset above. Switch: `decayEditsOnVerify: false`.
3. **Task kind**: writing / word-count calibration has no error or failing test; its loop is a
   command that prints numbers (word/paragraph counts, checklist assertions). The injected
   wording is task-neutral and the wrap-up degrades to number re-check + cleanup.

Limit: code can only see the `present` **action**. A plain-text final answer with no `present`
is covered by the done-state self-check inside the `stuck-gate` skill. The two layers complement
each other; the plugin does not read the model's mind.

## Response protocol (prompt layer, `stuck-gate` skill)

Once the gate fires, run every tool action (verify, search, cleanup, context compression)
**silently in one batch**, emit no final-sounding prose in between, and give **one** conclusion
at the very end. No "conclusion → string of tool calls → another conclusion" inversion.
`[better-debug]` is a reminder, not a message that needs a textual reply.

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

## Gain panel

A log file is readable only to the person who wrote it. The panel turns it into something you can look at: **Settings → better-debug**, an iframe view that refreshes every 5 seconds, read-only, with no effect on plugin behaviour.

Three headline cards:

| Card | Source | What it tells you |
| --- | --- | --- |
| Gate firings | every `inject` line | how many times the reminder spoke, grouped by `A/B/C` and by combination tag |
| Sessions covered | distinct `session=` across `inject` lines | how many sessions and turns were affected, and how many characters were injected in total |
| Model changed course | `class=` on `outcome` lines | **the only objective effect metric**: after the reminder, did the next `tool/call` go verify/search, or keep editing |

It also makes one thing visible: **with no `outcome` lines, "changed course" is empty**. The panel will not invent a percentage for you.

### The instrumentation the panel needed

After an injection, the plugin waits for the **first** subsequent `tool/call` and writes:

```
outcome session=… turn=39 after=C first=ops_bash class=verify steps=1
```

- `after` is the signal tag of the injection that triggered it;
- `first` is what the model actually did next, with `class` binned as `verify` / `search` / `edit` / `other`;
- `steps` is how many steps it took to act (`0` = it switched on the very next step).

Only the first one is recorded: a late verification must not whitewash the earlier circling.

`inject` lines also gained `chars=` (the character count of the injected text); the "cost per injection" figure on the panel is derived from it. Older logs lack the field; the parser backfills from the signal combination (`A=254` / `B=268` / `C=256` / `A+B=307` chars).

### Three self-imposed rules

1. **Every number is counted.** Firings, sessions, distribution read line by line from the log; injection cost comes from `chars=`.
2. **"Changed course" only counts observations.** The denominator is injections that were actually followed by a tool call, not all injections.
3. **No estimate of "tokens saved".** That figure would require assuming the model *would* have failed and gone around again — it is invented data. The plugin records what is observable and leaves the judgement to the reader.

### Turning the panel off

`config: { panel: false }`. The route is not mounted, `/better-debug` returns 404, the gate is unaffected.

The route is mounted with `ctx.inject(['webServer'], …)` — **dynamic injection**, deliberately not added to `export const inject`. That would be a structural change: it breaks hot reload, and it would stop the gate from installing at all on a host without `webServer`. On such a host the log gets one `panel unavailable: …` line and everything else keeps working.

## Install

**Quick install (from the Release tarball; pnpm treats it as an ordinary package):**

```bash
dsh plugin add https://github.com/Leonlee114514/dsh-better-debug/releases/download/v0.1.2/dsh-better-debug-0.1.2.tgz
```

(This package is **not** published to the npm registry, so `dsh plugin add dsh-better-debug`
returns 404. Use the tarball URL above, or link it by hand — see below.)

**Manual link (use this if you want to edit the code):**

```bash
# 1. put it somewhere you keep long-term. Not a temp dir, not inside node_modules.
#    (~/dsh-plugins/dsh-better-debug below is just an example — use your own path)
mkdir -p ~/dsh-plugins
cp -r dsh-better-debug ~/dsh-plugins/

# 2. link dependency in the profile
cd ~/.dsh/profiles/desktop
# package.json → dependencies (path is relative to .dsh/profiles/desktop):
#   "dsh-better-debug": "link:../../../dsh-plugins/dsh-better-debug"
# an absolute path works too:
#   "dsh-better-debug": "link:D:/code/dsh-better-debug"
# package.json → dsh.profile.bundles, at the end:
#   "dsh-better-debug"

# 3. let the bundle patch mount it, or write your own row:
#      - id: better-debug
#        name: dsh-better-debug
#        inject: [skills]
#        config: { enabled: true }

# 4. restart DSH. Adding `skills` to inject is a structural change; HMR may not pick it up.
```

The panel needs no extra inject: it mounts its route by dynamic injection, so `export const inject` keeps declaring only `skills`. Open **Settings → better-debug**, or go straight to `http://<web-origin>/better-debug`.

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
    decayEditsOnVerify: true    # A: a verify resets the blind-edit streak (false = old behaviour)
    doneOnPresent: true         # sleep after present; next write re-arms (false = old behaviour)
    logFile: ""                 # absolute path; empty = no file (ctx.logger only reaches stdout)
    panel: true                 # mount the read-only /better-debug panel; false = no route
```

Tighter (fires more often) → smaller numbers. Looser → bigger. With `enabled: false` no listener is registered at all.

## How to tell it is actually running

1. Point `logFile` at an absolute path, e.g. `~/.dsh/logs/better-debug.log`.
2. On load you get `apply pid=… logFile=… A=3 B=2 C=2 panel=true`. **That line is the only proof the plugin is mounted** — `ctx.logger` only reaches the Electron stdout and cannot be grepped afterwards. No `apply` line means it never loaded.
3. Work normally; a hit looks like:
   ```
   inject session=… turn=32 step=98 signals=A chars=254 files=1 worstEdits=3 worstStreak=3 worstErrors=0 searched=false
   ```
   `signals` lists the fired signals (`A`/`B`/`C`, joined by `+`). `files` is the number of **distinct** files touched; `worstEdits` is the cumulative count; **`worstStreak` is what A actually keys off** (blind edits since the last verify). Read all three: `files=1 worstEdits=3 worstStreak=1` means checks were interleaved, so the gate should stay quiet. A `suppress … reason=done` line means the gate was awake but deliberately silent in delivery state. An `outcome` line follows (see the panel section).
4. Self-check metric: does the **next** `tool/call` after an injection change category? `edit → edit` means it was ignored; `edit → lsp_diagnostics / web_search / reading a new file` means the reminder landed. Persistently under 30% means the wording or the thresholds need work — not that you need more signals. **The plugin now records this itself** (`outcome` lines); the panel reports it as the "changed course" rate.

## Local verification

```bash
node --check lib/index.js && node --check lib/panel.js && node --check client.js
node test/sim.mjs      # 19 cases: gate behaviour
node test/panel.mjs    # 19 cases: log parsing, aggregation, injection cost, instrumentation
npm run verify         # all of the above
```

`test/sim.mjs` replays the agent-loop call order with a fake ctx (`emitPlain` / `emitWaterfall` / `emitSerial`) and covers **19 cases**: positive and negative for each of A/B/C, idempotence, the quiet exception, subagent skip, adjustable thresholds, `enabled: false`, bundled-skill registration (including that the body is readable and de-privatised), a host without a `skills` service, the export shape, plus four v0.1.2 regressions — interleaved checks stay quiet / switching decay off still fires / `present` stays quiet / switching done-state off still fires (the last two make both switches reversible). It needs **no DSH runtime**, so run it after every change.

`test/panel.mjs` covers **19 cases**: field splitting with quotes and escapes, parsing of all three line types, `worstStreak` surviving log → parse → aggregate → panel (A's actual criterion stays visible), `suppress` lines parsed and excluded from injections (delivery-state silence is observable), the `chars=` backfill, distribution and session de-duplication, thresholds taken from the last `apply`, `estimate` carrying only the measured injection cost, empty logs and junk lines not throwing, plus one end-to-end run — a real `apply()` walks one turn, then the log is read back to assert both the `inject` and `outcome` lines were written and that aggregation counts it as "changed course". Also runtime-free.

## Known limits

- "Same file" is judged by **absolute path**. Deleting and recreating a file of the same name still counts as the same spot. That is usually right (you are circling one concept), but if you are legitimately regenerating a file, raise `repeatEditThreshold` or move the checkpoint.
- Verification is detected **by tool name only** — it cannot tell whether `ops_bash` ran `npm test` or `ls`. It deliberately under-reports rather than risk marking something "verified" that wasn't.
- **Main sessions only.** In a multi-agent setup, each subagent circling on its own is not intercepted — but their output converges on the lead, so the lead's counters still work.
- The panel is a **read-only view over the log**, not monitoring: it writes nothing and never changes a gate decision. With an empty `logFile` it shows "no logFile configured" and every statistic is 0.
- The panel's `changedRate` denominator is injections that were **observed** to be followed by a tool call. An injection followed by an immediate turn end is excluded, so the percentage swings hard on small samples — read the order of magnitude, not a KPI.

## License

MIT
