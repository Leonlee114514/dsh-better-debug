# dsh-better-debug

Turn a "stuck gate" from prompt text into a **code gate** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The five checks in `AGENTS.md` — and any `stuck-gate` skill — live in the **prompt layer**: the model has to *notice* it is stuck before the rules start applying. The characteristic symptom of being stuck is precisely that it does not notice. So it writes a third "let me try once more", eats the same error for the fourth time, or edits code and runs nothing.

This plugin does not read the model's mind. It watches what the model **does**, and when the behaviour matches "going in circles", it inserts one short user message **before the next step**:

```
[better-debug] 观察到的重复动作（只是观察，不是结论）：
- 同一个文件连续改了 3 次，中间没有任何测量。
下一步（挑一条就够）：
1) 建一条几秒能跑完、能给出数字或事实的回路（失败测试 / 复现命令 / 一条断言 / lsp_diagnostics）；建不出来就停下要现场产物。
恢复条件：拿到一条新的测量结果或一条外部事实后，继续动手即可。
完整五条：skill `stuck-gate`。
```

(The injected text is Chinese to match the `AGENTS.md` it enforces; change `assets/stuck-gate/SKILL.md` and `lib/text.js` for other languages.)

## Three signals (v0.2 semantics)

| Signal | Trigger | Default | Why |
| --- | --- | --- | --- |
| **A** same file, edited **with no measurement in between** | `fs/write-intent` per absolute path; the streak clears only **after a real measurement returns a result**, and only for that directory | 3rd time | Grinding on one point with no new facts is "guessing without a loop" |
| **B** same **operation** failing again | `tool/result` counted per episode keyed on `tool \| target \| fingerprint`; immune only if that episode was followed by a search | 2nd time | Twice means the first read didn't stick; per-episode, so a search about something else no longer exempts it |
| **C** edited, then **acted again** with no loop | N steps after a write with no measurement → **arm only**; the reminder comes **before the next write** | 2 steps | "Change and move on" is the most common missing check — but reading code must not be interrupted |

All three rest on the concept of a **measurement**, not on "some tool was called".

### What counts as a measurement

"Tool was called" ≠ "measurement completed". That was v0.1's biggest hole: in `edit → ls → edit → edit`, the `ls` whitewashed the blind-edit streak, so real circling did not fire.

v0.2 splits it into two states: **measurement intent** (decided at `tool/call` from the arguments) and **measurement result** (booked when `tool/result` comes back). Only a returned result clears a streak, and only for the files related to that command's directory — running `npm test` in `C:/other` must not clear the streak on `C:/work/src/target.js`.

| Class | Tools | Criterion |
| --- | --- | --- |
| Hard measurement | `lsp_diagnostics` `verify` `run_tests` `run_test` | always a measurement |
| Soft measurement | `ops_bash` `bash` `shell` `pwsh` | command matches `measureCommands`, or the description matches `measureIntent` while the command does not start with `ls/dir/cat/type/head/tail` |
| Search | `web_search` `research` `advanced_search` `multi_search` `platform_search` `domain_search` `cache_search` `video_search` | a hit counts as new external facts |
| Method | `skill` | loading methodology is a real turn of action; counted separately, not folded into `other` |
| Edit | `edit` `write` `ops_write` `str_replace` `apply_patch` `notebook_edit` | |

**A failing test is still a valid measurement**: it tells you which line broke. `[exit code: 1]` clears the streak and counts as a loop just the same; the panel merely records `ok=false`.

`DEFAULT_MEASURE_COMMANDS` covers `npm/pnpm/yarn/bun` + `test|verify|check|lint|typecheck|build`, `node --test`, `pytest`, `vitest`, `jest`, `mocha`, `go test`, `cargo test`, `dotnet test`, `tsc`, `eslint`, `ruff check`, `mypy`, `git diff --stat`. For non-code tasks, override `measureCommands` with your own regex (word counts, section counts, anything that yields a number or a fact).

**Generated files do not count as blind edits**: `node_modules`, `dist`, `build`, `out`, `coverage`, `.git`, `.next`, `.cache`, lock files, `*.log` / `*.map` / `*.min.js` are excluded via `excludePaths`.

### Error episodes (B's key)

```
tool name | target | error fingerprint
```

- **target** is the first path-like token in the error text (`C:/work/a.js`), with numbers normalised to `<n>`;
- **fingerprint** is the first 16 hex chars of a sha256 over the normalised first 6 lines / 300 chars, with `0x1f3a2b9c`→`<hex>`, paths→`<path>`, `42`→`<n>`.

So an error whose line number moved but whose class did not is the same episode, while **two different files each failing ENOENT once are not**.

## What it deliberately does not do

- **No "I guess it's…" phrasing detection.** The plugin cannot see the model's inner monologue. That check stays in the `stuck-gate` skill, where self-detection belongs.
- **No no-op write detection.** `fs/write-intent` only carries a freshness token (`FsVersion` or `createIfAbsent`), never the content, so the plugin layer cannot diff.
- **No probe cleanup at turn end.** That belongs to a turn-cleanup plugin.
- **Never `reject`.** Rejecting turns the whole turn into a no-op. The plugin only appends one user message to the tail of `messages`.
- **Never fires in subagent sessions.** `header.origin === 'subagent'` or `delegationDepth > 0` is skipped: their cwd may be someone else's workspace and their counters are not comparable.

## The "don't search, just fix it" exception

When the user explicitly says *don't search, just make the change, just try it quickly*, the gate must stand down. The plugin implements this by scanning this turn's **user** messages for `别搜|不要搜|不用搜|先别搜|直接改|快速试|别折腾|先试试` and going silent for the whole turn. Only `source.kind === 'user'` counts — the plugin's own injected message is ignored.

## Idempotence and re-arming

Not "each signal once per turn" — that would leave the second phase of a long turn unattended. v0.2 is **once per stuck episode**:

- the same situation is not repeated (`lastFireMark`'s write and error sequence numbers both unchanged → stay quiet);
- **a valid measurement re-arms it**: `fired.A/C` reset to zero, so a new bout of blind editing later in the same turn can be flagged again;
- **a per-turn budget** `maxInjectsPerTurn` (default 3) keeps it from becoming a drumbeat.

When A or B fires, C is marked as already fired too: A/B already describe the situation, and adding "and you didn't verify" is just a restatement.

## Trigger preconditions

The gate governs **before the next attempt**, not after delivery. Three checks run first:

1. **done-state**: a `present` call that **succeeded** (`isError !== true`) happened this turn → **no injection**; a `suppress … reason=done` line is written. **A failed `present` does not sleep the gate** — the deliverable never went out, so the gate stays awake. The next `fs/write-intent` re-arms it. Switch: `doneOnPresent: false`.
2. **Loop-driven convergence**: see "what counts as a measurement" above. Switch: `decayEditsOnVerify: false`.
3. **Task type**: writing, word-count calibration and layout convergence have no errors and no failing tests; their loop is a command that yields a number. The injected text is task-neutral.

Boundary: the code layer can only recognise the `present` *action*. **Plain-text final answers (no `present`)** are covered only by the done-state self-check inside the `stuck-gate` skill — the two layers complement each other; don't expect the plugin to read minds.

## The injected text

Three rules:

1. **State the observation, don't diagnose.** The old first line ("检测到你在原地打转" — "you are going in circles") labelled the model. Now it reads "观察到的重复动作（只是观察，不是结论）" — "observed repeated actions (an observation, not a conclusion)".
2. **At most two actions.** More than that is the same as none.
3. **Always give a recovery condition.** "How to continue" is more useful than "you're wrong".

The single source for this text is `lib/text.js`, shared by `index.js` (injection) and `panel.js` (back-filling character counts for old logs), so the panel's length estimate cannot drift from the real text.

## Response protocol (prompt layer, `stuck-gate` skill)

After the gate fires, run verification / search / cleanup / context compression **silently, in one pass**, emit no final-answer phrasing during it, then give **one** conclusion. The inverted pattern — conclusion → a run of tool calls → another conclusion — is forbidden. `[better-debug]` is a reminder; it does not need a prose reply first.

## Bundled skill

The package ships `assets/stuck-gate/SKILL.md` and registers it as a **bundled skill** via `inject: ["skills"]` (`source: "bundled"`, `rank: 600`) — it appears in the model-visible skill catalogue after install, no file copying needed.

The reminder ends with "完整五条：skill `stuck-gate`", pointing at this one.

**Rank order** (lower wins):

| rank | source | who speaks |
| --- | --- | --- |
| 100–200 | project `.dsh/skills`, `.agents/skills` | project override |
| 300 | `custom` | |
| 400 | `~/.dsh/skills` (user global) | **your own copy beats the plugin's** |
| 500 | `~/.agents/skills` | |
| 600 | this plugin's `assets/` | default text |

So changing the gate wording needs no code change: drop a copy at `~/.dsh/skills/stuck-gate/SKILL.md` and it takes effect. Editing the copy inside the plugin applies to everyone (the file is re-read on every `get()`, no restart needed).

If the host has no `skills` service (older DSH), registration is skipped with one log line and **the gate itself keeps working**.

## The observation panel

Logs are only loved by the person who wrote them. The panel turns them into something you can read at a glance: **Settings → better-debug**, an iframe view, 5-second auto-refresh, read-only, it never changes plugin behaviour.

Four cards:

| Card | Source | What it can tell you |
| --- | --- | --- |
| Gate fires | every `inject` line | how many reminders were spoken, grouped by `A/B/C` and combinations |
| Sessions covered | distinct `session=` on `inject` lines | how many sessions, turns, characters and tokens of injected text |
| **First action after a reminder** | `class=` on `outcome` lines | what class the first `tool/call` after a reminder was. **Descriptive. Proves no causation.** |
| **Measurement loops (hard evidence)** | `measure` lines | how many real measurements happened, how many passed, how many failed, how many streaks were cleared |

Plus three distributions: signals, first-action class (six), and **whether it actually turned to obtain new facts within the window** (`change` lines, with a real median step count).

### Metric naming discipline

This is where v0.1's panel was most misleading; v0.2 splits it apart:

- The name **"reaction rate" is gone**. It computed "the first tool after a reminder was verify/search", which cannot prove the reminder caused the change, let alone that it helped find a defect — the model might have done that next anyway. It is now **"first action after a reminder"**, field `firstAction`.
- To know whether it turned to new facts within a window, read `turned` (computed only from `change` lines, with a genuine median). That median has samples only here — v0.1's `medianSteps` was always `null` because the outcome line was written on the very next step, so the step delta was always 0.
- **Old logs are never counted as "0% turned".** v0.1's `inject` lines carry no `inj=`, so they cannot have `change` / `measure` lines either; "0 turns" there means **not measured**, not "measured as zero". `turned.observed` is the denominator and counts only injections after the instrumentation landed; `rate` is `null` when `observed = 0`, and the panel says "this log predates the v0.2 instrumentation". In the real log all 55 injections are in the old format, so `observed = 0` — the panel now says exactly that instead of reporting 0% over 49 outcome lines.
- "What these numbers do not prove" is printed in the footer: proving a gain needs a control group or historical replay, and the panel does neither.
- **No estimate of "tokens saved".** The plugin's job is to record what is observable and leave judgement to the reader.

### Instrumentation added for the panel

Every injection gets an `inj=` (8-hex) id that later lines carry, so one reminder's whole life is traceable:

```
inject  session=… turn=39 step=88 signals=A inj=78ed6bc3 chars=309 tokens=271 files=1 worstEdits=3 worstStreak=3 worstErrors=0 searched=false measured=no
arm     session=… turn=39 gap=2
outcome session=… turn=39 inj=78ed6bc3 after=A first=ops_bash class=verify steps=1 before=write
measure session=… turn=39 tool=ops_bash ok=false exit=1 cleared=1
change  session=… turn=39 inj=78ed6bc3 after=A tool=ops_bash class=verify steps=1
suppress session=… turn=39 reason=done
```

- `outcome` records only the **first** subsequent `tool/call`: a late verification must not whitewash earlier circling. `before=` is the action preceding the reminder (writes count, so the common value is `write`).
- `change` is written only within `changedWindow` (default 6) steps of an injection; outside the window it is discarded.
- `measure` is written for every measurement result, with `ok` / `exit` / `cleared` (how many files' streaks were cleared).
- For old logs with no `chars=`, the parser recomputes the text length through `charsFor(signals)` from `lib/text.js`. v0.1's hard-coded table (`A=254` etc., off by ~50 characters) is deleted.

### Turning the panel off

`config: { panel: false }`. The route is not mounted, `/better-debug` returns 404, the gate is unaffected.

The route is mounted via `ctx.inject(['webServer'], …)` — a **dynamic injection**, not part of `export const inject`. Adding it there is a structural change that breaks hot reload and would stop the gate from installing on hosts without a `webServer`. When the host lacks one, the log gets `panel unavailable: …`; when mounting throws, `panel register failed: …` — and the panel displays it.

## Install

**Shortest path (npm registry — published):**

```bash
dsh plugin add dsh-better-debug
```

**Or from the Release tarball (pnpm treats it as a normal package):**

```bash
dsh plugin add https://github.com/Leonlee114514/dsh-better-debug/releases/download/v0.2.5/dsh-better-debug-0.2.5.tgz
```

(Both install the same package: the npm tarball is byte-identical to the Release asset.
Going through npm also lets the market's daily probe backfill the `npm` field into the
catalog entry, so a click installs straight from the registry.)

**Manual link (use this if you want to change the code):**

```bash
# 1. Put it somewhere permanent. Not a temp dir, not inside node_modules.
#    (~/dsh-plugins/dsh-better-debug is used below as an example.)
mkdir -p ~/dsh-plugins
cp -r dsh-better-debug ~/dsh-plugins/

# 2. Add the link dependency to your profile
cd ~/.dsh/profiles/desktop
# package.json → dependencies, one line (path relative to .dsh/profiles/desktop):
#   "dsh-better-debug": "link:../../../dsh-plugins/dsh-better-debug"
# An absolute path works too:
#   "dsh-better-debug": "link:D:/code/dsh-better-debug"
# package.json → dsh.profile.bundles, append:
#   "dsh-better-debug"

# 3. Let the bundle patch mount it (if bundles already lists it, dsh applies the
#    package's cordis.patch.yml automatically), or write your own row in the
#    profile's cordis.patch.yml:
#      - id: better-debug
#        name: dsh-better-debug
#    Note: do **not** add `inject: [skills]` — see "Why no static inject" below.
#    The package's own row also carries **no config** — see "Why the bundle patch
#    has no config".

# 4. Restart DSH.
```

> **Do not use both mounting paths.** The package's `cordis.patch.yml` already contains a `- id: better-debug` row. Writing the same id again in your profile makes cordis reject the duplicate. Two rows with **different** ids pointing at the same package name are worse: the plugin mounts twice, every reminder is injected twice, every log line is written twice.

### Why no static inject

`export const inject` is empty, and `cordis.patch.yml` declares no `inject:` — both on purpose.

cordis's `Fiber._refresh()` takes the whole fiber INACTIVE and **skips `apply()` entirely** when any declared service is unavailable: no error, no log line, the panel looks installed while not a single line of plugin code ever ran. The loader also merges the YAML entry's `inject:` into that dependency set (`cordis-plugin-loader`: `Inject.resolve(entry.options.inject, fiber.inject)`), so fixing the code alone is not enough — the config row would still wedge it.

`skills` is provided by `@deepseek-ai/dsh-skill`. A trimmed profile, another distribution, or simply not enabling that package leaves it absent — and the gate does not need it. Both optional services (`skills` / `webServer`) are therefore subscribed dynamically with `ctx.inject(['skills'], cb)`: present, they attach; absent, you lose one optional feature and the gate keeps working.

The panel follows the same rule: `client.js` skips registration when `slots` is absent. Open **Settings → better-debug**, or visit `http://<web-origin>/better-debug`.

### Why the bundle patch has no config

The package's `cordis.patch.yml` is two lines — `id` and `name` — with no configuration key at all. The reason is that DshMarket's hot mount replays **plain insert rows only**:

```js
// dshmarket/lib/hot.js
export function parseSimplePatch(patchText) {
  const scan = scanPatch(patchText)
  return scan.blocker === null ? scan.rows : null   // any other key → null
}
```

`scanPatch()` stops at `config:` and marks the whole patch `blocker: 'config'`, and the market then tells the user "the bundle patch has a config block; hot-mount replays plain insert rows only — a restart loads the bundle as written". In other words: with a config block, clicking **Enable** in the market does nothing until DSH restarts, which is exactly where a new user concludes the plugin is broken.

Every default already lives in `normalizeConfig()` in `lib/index.js`. The config block bought only self-documentation, at the price of a silent no-op for newcomers. So the defaults stay in code, and a config block belongs in your profile row — that row is not part of the package's hot mount.

## Configuration

All defaults live in `normalizeConfig()` in `lib/index.js`; it runs as installed. To change one, write the same id (`- id: better-debug`) into **your own profile's** `cordis.patch.yml` with a `config:` block — do not edit the package's copy (an upgrade overwrites it, and a config block there breaks the market's hot mount):

```yaml
- id: better-debug
  name: dsh-better-debug
  config:
    enabled: true
    repeatEditThreshold: 3        # A: consecutive edits to one file
    repeatErrorThreshold: 2       # B: repeats of one error episode
    noVerifySteps: 2              # C: steps without measurement before arming
    maxInjectsPerTurn: 3          # reminders per turn, maximum
    changedWindow: 6              # steps after an injection that count as "turned"
    decayEditsOnVerify: true      # a measurement clears the blind-edit streak (false = old behaviour)
    doneOnPresent: true           # a successful present sleeps the gate; next write re-arms (false = old behaviour)
    measureCommands: ""           # regex overriding "what command is a measurement"; empty = built-in list
    measureIntent: ""             # regex overriding "what description signals measurement intent"
    excludePaths: ""              # regex overriding "which paths never count as blind edits"
    logFile: "~/.dsh/logs/better-debug.log"  # `~` is expanded; omit the key to get this default
    panel: true                   # mount the read-only /better-debug panel; false = no route
```

Tighter (fires more) → smaller numbers; looser → larger. With `enabled: false` not even a listener is registered. A bad regex in the three regex keys **falls back to the built-in default** and logs a warning; it never kills the plugin.

`logFile` has four forms:

| Value | Where it goes |
| --- | --- |
| key omitted | `$DSH_HOME/logs/better-debug.log` (`~/.dsh/logs/better-debug.log` when `DSH_HOME` is unset) |
| `"~/my.log"` | expanded to `my.log` under your home dir (`~`, `~/x` and `~\x` all work) |
| `"C:/x.log"` / `"/var/log/x.log"` | used verbatim |
| `""` or `false` | **explicitly disables the file**. `ctx.logger` only reaches Electron stdout and cannot be grepped later, so the panel then has nothing to show |

Not writing a file was the v0.1 default, and the cost was new users installing it, opening the panel, seeing four empty cards and concluding the plugin was broken. It now writes out of the box.

## Verifying it really works

1. After installing and restarting, the log is already at `$DSH_HOME/logs/better-debug.log` — no configuration needed. Set `logFile` to move it.
2. Loading writes one `apply pid=… logFile=… A=3 B=2 C=2 budget=3 window=6 panel=true` line — **the only proof the plugin loaded at all** (`ctx.logger` only reaches Electron stdout and cannot be grepped later). No `apply` line means it is not mounted.
3. Work normally; a hit looks like:
   ```
   inject session=… turn=32 step=98 signals=A inj=78ed6bc3 chars=309 tokens=271 files=1 worstEdits=3 worstStreak=3 worstErrors=0 searched=false measured=no
   ```
   `signals` lists the fired signals (`A`/`B`/`C`, `+`-joined); `files` is the number of **distinct** files touched this turn; `worstEdits` is the cumulative count; **`worstStreak` is the criterion A actually uses** (consecutive blind edits since the last measurement). Read all three together: `files=1 worstEdits=3 worstStreak=1` means a measurement happened in between and it should not have fired. `suppress … reason=done` means the gate is awake but in delivery state and deliberately silent. `arm … gap=2` means C only armed — it is waiting for your next write.
4. Do **not** judge it by "was the next action a verify". Look at two things: whether `measure` lines appear at all (hard evidence that a measurement happened), and the `steps=` on `change` lines (how many steps later it turned to new facts). If there are `outcome` lines but no `measure` lines, the model merely switched tools without building a loop.

## Local verification

```bash
node --check lib/index.js && node --check lib/panel.js && node --check lib/text.js && node --check client.js
node test/sim.mjs           # 46 cases: gate semantics + portability
node test/panel.mjs         # 40 cases: log parsing, aggregation, generation scoping, instrumentation (41 under test:slow)
npm run test:posix          # re-runs both suites under POSIX path semantics
npm run test:linux          # re-runs both suites under Linux platform semantics (no case folding)
npm run test:slow           # slows log writes to 400ms, proving reads wait on a condition, not a duration
npm run verify              # all of the above (with syntax checks)
```

`test/sim.mjs` uses a fake ctx that replicates agent-loop call order (`emitPlain` / `emitWaterfall`) and covers **46 cases**.

Semantics (each with a positive and a negative):

- **Intent vs. result**: `edit → ls → edit → edit` still fires; a call with no result does not clear; a failing test is not a blind edit; a measurement in an unrelated directory does not clear the target file's streak.
- **B's episodes**: only the same target and fingerprint accumulate; two different files each failing ENOENT once do not fire; a search after that episode grants immunity (a search *before* it does not).
- **C's two stages**: after an edit, reading code alone does not interrupt; arming followed by another write does.
- **Re-arming**: A fires → a valid measurement restores → a new bout of blind edits may fire a second time; the per-turn budget applies.
- **Delivery state**: no injection after a successful `present`; **a failed `present` does not sleep the gate**.
- Observation-only wording, lock files excluded, the "just fix it" exception, subagent skip, adjustable thresholds, `decayEditsOnVerify: false` restoring old behaviour, `enabled: false`, bundled-skill registration and de-privatised content, no `skills` service not throwing, export shape, plus 13 classification/criterion/fingerprint unit assertions.

**No DSH runtime required** — run it first after any change.

### Why there are `test:posix` and `test:linux` passes

Every path in `test/sim.mjs` is written in Windows dialect (`C:/work/...`). The suite still
runs on a Linux box, but it exercises a *different* set of semantics — which was exactly a
real incident before v0.2:

`node:path`'s `isAbsolute` is platform-dependent: `isAbsolute('C:/work/a.js')` returns
`false` on Linux/macOS. The entry gate used it to filter write paths, so on those machines
**every write was silently dropped**, signals A and C stopped working entirely, and a Windows
dev machine stayed green. The fix is to stop asking the OS "does this root look like mine"
and only ask "does it start at a root" (`isAbsPath`).

`test/posix` uses a `node --import` resolve hook to swap `node:path` for `node:path/posix`
and then **re-runs both suites unchanged** — so a Windows dev machine reproduces Linux path
semantics. CI runs `npm run verify` on ubuntu / windows / macos × node 20 / 22 / 24, so this
cannot quietly regress. (24 is not padding: the desktop build runs Electron's bundled node 24.)

`test:linux` covers the other axis. `test:posix` swaps only `node:path` and **does not fake
`process.platform`**, so `CASE_INSENSITIVE` stays `true` in that pass. The case-folding branch
never executes on a Windows dev machine — until 2026-11-14, when real ubuntu CI turned the two new
v0.2.2 assertions red: they hard-coded lowercase expectations (`c:/users/u/...`,
`['/home/u/projb']`), while Linux keeps the case you wrote. The defect was not in the code under
test but **in assertions that had absorbed this machine's platform** — they were testing "passes on
Windows".

`test/linux/register.mjs` overrides `process.platform` to `linux` and touches nothing else (it is
a getter, so it needs `Object.defineProperty`; a plain assignment is silently ignored). With the
two axes separated, three of the four "path dialect × case sensitivity" combinations run on a
Windows dev machine and CI supplies the fourth. The assertions no longer hard-code a case:
`samePath` / `sameDirs` compare per platform, and expectations are written in their **original
case** (`C:/Users/u/...`, `/home/u/projB`).

### Why there is a `test:slow` pass

The third kind of "green here, red on a real machine" is not platform semantics but **timing**.
The plugin writes log lines with `void record(...)` — deliberately not awaited, because one log
line must not slow the agent down. The price is that "has it been written yet" is always a race
when a test reads the log back.

Real CI (`windows-latest` + node 24) went red exactly that way on 2026-11-14: the `inject`,
`outcome` and `change` lines had landed, `measure` was still queued, and the assertion reported
`no measure line` — which looks like broken instrumentation but is just an **early read**. The fix
is not raising `sleep` from 120ms to 500ms (that only rolls the dice again) but replacing "wait a
duration" with "wait for a condition": `readLogWhenReady()` re-reads every 10ms until the wanted
line kinds exist, and on timeout prints **which lines are missing**, so the failure points at the
real gap.

`test/slow` makes that timing deterministic: a `registerHooks` resolver swaps
`node:fs/promises` for a stand-in whose `appendFile` is 400ms slower (`BD_SLOW_MS` adjustable).
Any "wait a fixed duration" read goes red every time; a "wait for the condition" read stays green
no matter how slow. It is a regression guard, not a benchmark. On `node < 22.15` there is no
`registerHooks`, so this pass skips itself — the same two-channel strategy as `test:posix`.

The rest of the same family, all fixed in v0.2 / v0.2.1 / v0.2.2 / v0.2.3 / v0.2.4 / v0.2.5:

| Symptom | Root cause | Now |
| --- | --- | --- |
| The gate never fires on Linux/macOS | `isAbsolute` is platform-dependent | `isAbsPath` accepts both dialects |
| Panel shows four empty cards right after install | default `logFile: ""` wrote nothing | defaults to `$DSH_HOME/logs/better-debug.log` |
| Plugin silently not loaded — no error, no log line | static `inject: ['skills']` makes `apply()` never run when the service is missing | `inject = []`, dynamic `ctx.inject` |
| Clicking "enable" in the market does nothing | bundle patch carried a `config:` block | patch keeps only `id` + `name` |
| A too-old host is never rejected | the range lived in `dsh.engines.dsh`, but the host and the market read only top-level `engines.dsh` | moved to top-level `engines.dsh` |
| In a real project every error is reported as "the same operation failed again" | node's stack is `file:///C:/...`, and the path regex hits the `e:` inside the scheme, so every stack becomes `"e:///c"` | `stripFileUrl` removes the URL head first |
| `a1.js` and `a2.js` are treated as the same place | normalisation replaced every digit in the path with `<n>`; only line/column should go | only the trailing `(:\d+)+$` is stripped |
| Running tests in a sibling directory washed out this directory's blind-edit count | `measureDirs` treated `cd <dir>` as a file and took its parent (`cd ~/projB` → `~`) | `cd` is recognised; that segment is a directory |
| The panel kept showing "the plugin is currently disabled" while it was clearly running | the banner counted `disabled` / `panel failed` over the **whole log**, so one historical failure counted as "broken now" forever | the banner only reads the generation after the last `apply` (`log.current`); history is reported separately in the footer |
| New assertions were green on Windows and red on real Linux CI | they hard-coded the `CASE_INSENSITIVE` fold result; `test:posix` swaps `node:path` but not `platform`, so that branch never ran here | the `test:linux` pass overrides `process.platform`, and assertions compare through `samePath` per platform |
| The same suite is 40/40 here and 38/40 on `windows-latest` + node 24 | the test used a fixed `sleep` to wait for log writes; the plugin deliberately does `void record(...)` without awaiting, so on a slow disk `measure` was read before it landed | log reads now wait on a condition (`readLogWhenReady`), and `test:slow` slows writes by 400ms as a regression guard |

**Case folding is decided per platform** (`CASE_INSENSITIVE`): only on `win32` / `darwin`.
The cost of folding wrong is asymmetric — not folding when you should under-reports, folding
when you should not **over-reports** (crying wolf), and over-reporting is the one failure this
gate must not make. A case-sensitive APFS volume on macOS under-reports a little, which is
still the safe direction.

`test/panel.mjs` covers **40 cases** (41 under `test:slow`; the extra one asserts the slow shim is actually in use, so that pass can never be testing nothing): quoted and escaped field splitting; six line kinds (`inject` / `outcome` / `change` / `measure` / `arm` / `panel-failed`); zero drift between `charsFor` and the real text length across 6 signal combinations; `worstStreak` preserved along log→parse→aggregate→panel; `suppress` and `arm` lines parsed and not counted as fires; the aggregated `firstAction` / `turned` / `measures`; **assertions that v0.1's field names `changed` / `changedRate` / `outcomes` must not come back**; thresholds from the last `apply`; empty logs and bad lines not throwing; and an end-to-end run that really calls `apply()`, walks one turn, and reads the log back to assert `inject` carries `inj=`, `outcome` carries `before=write`, `measure ok=false exit=1`, and `change` is written and aggregated. Generation scoping has its own group: failures in the history with a clean generation after the last `apply` must leave `log.current` at zero and keep the banner quiet; a failure *after* the last `apply` must light it; a log with no `apply` line at all gives `markers=0`, and the panel says it only has a fragment rather than claiming health. **The page itself is asserted too** — the test reads `web/index.html` and checks the banner consumes `log.current` and no whole-log branch survived.

## Known boundaries

- "Same file" is decided by **absolute path**. Delete and recreate the same name and it still counts as the same place — usually correct (you are circling one concept), but if you keep rewriting generated files, exclude them via `excludePaths` or raise `repeatEditThreshold`.
- **The measurement criterion is heuristic**: whether `ops_bash` runs a real measurement is guessed from a `measureCommands` / `measureIntent` regex pair. The cost of guessing wrong is now asymmetric — treating a non-measurement as a measurement under-reports, treating a measurement as a non-measurement over-reports. The default list leans toward "over-report rather than under-report", because acting on a false reminder costs you little.
- `done-state` recognises a **successfully returned** `present` call, not "the model said a closing sentence". Plain-text final answers rely on the done-state self-check in the `stuck-gate` skill; if some task type never calls `present`, switch `doneOnPresent: false`.
- Only **main sessions** are covered. In multi-agent runs each subagent can circle without being stopped — but their output flows to the lead, and the lead's counters still apply.
- The panel is a **read-only log view**, not monitoring: it writes nothing and never changes gate decisions. Only when you explicitly set `logFile: ""` (no file) does it have nothing to show and report zeros.
- `firstAction`'s denominator is "injections that were observed". An injection followed by the turn ending (no further `tool/call`) is not counted, so the ratio swings a lot on small samples — read the magnitude, don't treat it as a KPI.

## License

MIT
