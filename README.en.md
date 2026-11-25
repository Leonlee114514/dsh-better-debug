# dsh-better-debug

A stuck-loop detector for coding agents, built as a DeepSeek Harness / Cordis plugin.
It subscribes to the agent's event stream, detects unproductive iteration from
**reproducible behavioral evidence**, and injects a structured observation plus a recovery
suggestion before the next model request. It does not read the model's prose, does not call
an LLM, and does not modify the agent loop.

## A minimal example

The sequence below is entirely realistic: every edit is followed by verification, and no two
consecutive failures look alike — yet the model is bouncing between two edits that keep
breaking each other.

```
edit A → npm test (red: assertion B fails)
edit B → npm test (green)
edit A → npm test (red: assertion B fails)   ← a previously-green failure recurs
edit B → npm test (green)
edit A → npm test (red: assertion B fails)   ← flip 2
edit B → npm test (green)
edit A → npm test (red: assertion B fails)   ← flip 3, signal O fires
```

Before the next step, the plugin appends one user message to the conversation:

```
[better-debug] Observed repeated actions (observation only, not a verdict):
- The same check has flipped between passing and failing 3 times, with an edit between each flip.
Do one of these first, and continue only once you have a new fact:
1) Your edits are pushing the problem back and forth: pin one currently-red case, make the minimal change that turns it green, and set the rest aside; if two edits keep breaking each other, they share a wrong assumption — write that assumption down before editing again.
Recovery: resume once you have a new measurement or an external fact.
Full five checks: skill `stuck-gate`.
```

(The actual injection is in Chinese; the wording above is a faithful gloss. Signal semantics
are identical.) At the same time, a single greppable log line is written for audit:

```
inject session=… turn=1 step=19 signals=O inj=e7db4417 chars=235 tokens=204 files=2 worstEdits=5 worstStreak=0 worstErrors=0 searched=false measured=yes:ops_bash:fail
```

## Problem and approach

Rules like "when stuck, stop and build a feedback loop" usually live in system prompts or
skill files. They are **self-awareness clauses**: the model must notice it is stuck before
they can apply. But the behavioral signature of being stuck includes the failure of exactly
that self-monitoring — the model keeps writing its Nth "one more try".

This plugin moves the **event-provable** part of those rules from the prompt layer into code,
under three principles:

1. **Behavior, not language.** Every criterion is an event count, a path match, or a string
   normalization. No assistant-text parsing, no semantic or LLM judgment. Every decision can
   be replayed from the same event sequence.
2. **Observations, not diagnoses.** Injections open with "observation only, not a verdict",
   state countable facts (how many times, how many kinds, how many rounds), offer at most two
   recovery actions, and always state the recovery condition.
3. **Asymmetric error cost: prefer missed detections.** Interrupting a healthy iteration
   costs more than staying silent once, so every signal ships with explicit counterexamples
   (below, and in the test suite).

## The signal model

Seven signals in three layers. The tactical layer detects **repeated actions**; the strategy
layer detects **changing actions with an unchanged direction**; the meta layer detects
**the intervention itself failing**.

| Layer | Signal | Behavioral evidence | Default trigger |
| --- | --- | --- | --- |
| Tactical | **A** blind edits | `fs/write-intent` count per absolute path, cleared per directory when a measurement result arrives | **3** in a row |
| Tactical | **B** repeated error | Episode keyed by `tool\|target\|error fingerprint`, **including `isError:false` measurement failures**; a search records the episode count as a baseline, so repeats must re-accumulate to the threshold | **2**nd occurrence |
| Tactical | **C** edit without verification | N steps after a write with no measurement arms the gate; the **next write** fires it | **2** steps |
| Strategy | **F** error family | Distinct fingerprints and total count under one `tool\|target`; a search only immunizes the fingerprints that existed before it | **3** fingerprints and **4** total |
| Strategy | **O** oscillation | Within one measurement loop, a **previously-green failure item recurs** (the last 4 failure sets are kept; the current set counts as a recurrence if it **intersects** any of them; only failure items, never log noise such as warnings), with a write between the two results; muting is per loop | **3**rd flip |
| Strategy | **P** patch chain | Consecutive "measurement failed → write → measurement still fails" **without the failure surface shrinking** (smaller set = converging, identical set = no progress, a different file = the next site); cleared by a successful measurement | **3** rounds |
| Meta | **M** intervention failure | An injection whose window closes with no measurement/search is counted into `futile` | **2** futile injections |

All signals share one primitive — **measurement**, not "some tool was called".

### Two-phase measurement

Measurement intent is classified at `tool/call`; the result is only booked at `tool/result`.
An `ls` between edits therefore cannot launder blind edits, and a test run in an unrelated
directory does not clear the target file's counter.

| Category | Tools | Criterion |
| --- | --- | --- |
| Hard measurement | `lsp_diagnostics` `verify` `run_tests` `run_test` | Always a measurement |
| Soft measurement | `ops_bash` `bash` `shell` `pwsh` | Command matches `measureCommands`, or description matches `measureIntent` and the command is not `ls/dir/cat/type/head/tail` |
| Search | `web_search` `research` `advanced_search` `multi_search` `platform_search` `domain_search` `cache_search` `video_search` | Treated as an external prior |
| Methodology | `skill` | Counted as a genuine turn |
| Edit | `edit` `write` `ops_write` `str_replace` `apply_patch` `notebook_edit` | Advances the write counter |

**A failing test is still a valid measurement**: it supplies a new fact. `[exit code: 1]`
clears blind-edit counters just the same; only the log records `ok=false`.

The built-in command list covers `npm/pnpm/yarn/bun` with `test|verify|check|lint|typecheck|build`,
`node --test`, `pytest`, `vitest`, `jest`, `mocha`, `go test`, `cargo test`, `dotnet test`,
`tsc`, `eslint`, `ruff check`, `mypy`, and `git diff --stat`; override it with
`measureCommands`. Build artifacts and lockfiles are excluded via `excludePaths`.

### Fingerprints, episodes, and families

- **Target**: the first path in the error text. Only trailing line/column numbers are
  stripped (`a.mjs:12:29` → `a.mjs`); other digits are kept (`a1.js` and `a2.js` are
  different targets). `file://` prefixes are removed first.
- **Fingerprint (B / F)**: the first 6 lines / 300 characters, with hex numbers, paths, and
  digits normalized, hashed to the first 16 hex digits of sha256. "Same exception, new line
  number" stays in one episode. Folding digits here is deliberate: B asks whether the same
  operation keeps failing with the same wording, and `expected 2` / `expected 3` are that
  wording.
- **Failure-item identity (P / O)**: a separate one. It cuts only the path and the locator
  right after it and **keeps every digit in the message**. The two must stay apart: B asks
  "did the wording change", while P asks "did the failure surface turn into a different
  problem" - folding `case-1` / `case-2` makes P read two different assertions as one error,
  and failing to strip the locator makes P/O read one edit at one site as a new problem.
- **B's key** is `tool|target|fingerprint`; **F's key** is `tool|target` (no fingerprint).
  F measures fingerprint **diversity**: `fingerprints.size ≥ 3 ∧ count ≥ 4`. With the
  fingerprint in its key, every new error would open its own episode and F would degenerate
  into a slower B.

### O: why "a previously-green failure recurs"

The naive definition of oscillation (results flipping between ok and fail) flags healthy TDD:
each round's red is a new, not-yet-implemented case, and the color changes are progress.
O therefore requires that a failure **was seen before, then turned green, and now recurs**,
with a write in between (flaky re-runs without writes do not count).

Comparing only against the *previous* failure still misses the most common oscillation —
editing A breaks B, editing B breaks A, fingerprints alternate A/B/A/B, and every failure
looks "new". The criterion therefore uses a **recent-failure set** (FIFO, capacity
`RECENT_FAIL_LIMIT = 4`): new fingerprints are enqueued without resetting the flip counter.

| Pattern | Verdict |
| --- | --- |
| Alternating oscillation (A/B breaking each other) | Both fingerprints stay in the set; counting starts from the third failure and fires at the threshold |
| Healthy TDD (a new failure each round) | New fingerprints are never in the set; nothing is counted |
| Pure flaky re-runs (no writes) | The write condition fails; not counted |

O's re-arming is tied to loop stability: it may fire again only after **two consecutive
successes** in the same loop (which also clears the flip counter). Re-arming on every single
success would repeat the same observation on every other step of an ongoing oscillation.

### M: the meta gate

Every injection registers a pending. If its window (`changedWindow`, default 6 steps) closes
with no measurement or search, the pending is voided and `futile += 1`; any genuine turn or
successful measurement resets the counter. At `metaAfterFutile` (default 2), M fires.

M differs mechanically in four ways:

- **Highest priority**, evaluated before the other six signals;
- **Outside** the `maxInjectsPerTurn` budget — the situation that needs M most is exactly
  the one where the budget is already spent;
- **At most once per turn**, and no other signal rides along in the same step;
- **An independent template**: the model must first write down the approaches already tried,
  the assumption they share, and one mechanically different alternative (or the concrete
  artifact it needs from the user), before issuing any further edit-class tool call.

## Priority and mutual exclusion

Signals never restate the same situation twice in one step:

- **P over F**: when both match, only P is delivered (a patch chain is closer to the strategy
  layer than an error family); F is marked as fired;
- **F/P suppress B** ("this error repeated" is the weaker observation); B is marked as fired;
- **A/B mark C as fired** instead of appending "you edited without verifying";
- **M** is always delivered alone.

## Idempotence and re-arming

- No repetition without new evidence: if neither the write counter nor the error counter has
  advanced since the last injection, the gate stays silent.
- Each signal re-arms on its own definition of "the situation changed":

| Signal | Re-arm condition |
| --- | --- |
| A | A measurement result arrives (clears related directories only) |
| B | A search occurs after the episode (the threshold must be re-accumulated afterwards — never a lifetime exemption) |
| C | A measurement result arrives (disarms the gate) |
| F | A search (only for fingerprints predating it), or a successful measurement |
| O | Two consecutive successes in the same loop (re-arms that loop only) |
| P | A successful measurement, the failure surface starting to shrink, or the failure set being identical (clears the chain instead of pausing it) |
| M | Once per turn; genuine turns reset `futile` |

- Tactical and strategy signals share the per-turn budget `maxInjectsPerTurn` (default 3).

## Preconditions and exceptions

1. **Done-state**: after a successful `present` result the gate sleeps until the next write;
   a failed `present` does not sleep. Sleep is logged as `suppress … reason=done`, so
   "awake but silent" is distinguishable from "not mounted". Disable with `doneOnPresent: false`.
2. **Explicit user instruction**: if the user's own message this turn matches
   `/别搜|不要搜|不用搜|先别搜|直接改|快速试|别折腾|先试试/` ("don't search / just edit /
   try it quickly"), the gate stays mute for the whole turn. Only `source.kind === 'user'`
   messages count; the plugin's own injections do not.
3. **No subagent sessions**: `origin === 'subagent'` or `delegationDepth > 0` is skipped.
4. **Never `reject`**: interception only appends a user message; a turn is never voided.

## Injection wording

Ordinary signals use a fixed skeleton (observation → at most two actions → recovery condition
→ skill pointer); M uses its own template. `lib/text.js` is the single source of every
string, shared by the runtime injector and the panel's legacy-log backfill, so character and
token estimates cannot drift from the real text.

M's full template (English gloss):

```
[better-debug] Meta observation: 2 consecutive reminders this turn produced no change of course.
This is no longer a problem "one more try" can solve. Before the next step, write three short paragraphs (12 lines at most):
1) The approaches you have already tried, and the assumption they all share;
2) One mechanically different approach — a different data structure, a different library, a different layer of responsibility, or a minimal reproduction followed by a rewrite; pick one and explain why it bypasses every wall you hit;
3) If you cannot write (2), then what is missing is evidence, not attempts: name one concrete artifact you need from the user (logs / minimal reproduction / environment details).
Do not issue any edit-class tool call until this is written.
```

## Scope and known limits

**The plugin is designed and calibrated for coding tasks.** F needs paths and fingerprints
in error text, O/P need re-runnable verification commands, and M presumes a feedback loop can
be built. In writing, design, or data-analysis tasks, "verification" is a judgment rather
than a command, and these signals are unreliable. The plugin **does not classify task type**;
the boundary is set by configuration (`metaGate: false` disables M; raising the F/O/P
thresholds effectively disables them).

Further limits:

- "Same file" means the same absolute path; deleting and recreating a file still counts;
- Measurement detection is heuristic regex. The error directions are asymmetric:
  treating a non-measurement as a measurement causes misses, the reverse causes false alarms;
- Done-state recognizes only a successful `present` call; pure-text finals are covered by the
  `stuck-gate` skill's self-check. Set `doneOnPresent: false` for tasks that never call it;
- All state lives **within a turn** and resets at `turn/start`; nothing persists across turns;
- No-op writes are not detected: `fs/write-intent` carries no content, so no diff is available;
- P's "failure surface" is counted as a **set of failure items** (`target|identity`), and
  shrinking requires the current set to be a strict subset of the previous one. Identity comes
  from the message with the path and the locator that follows it cut away, so a line or column
  drift is not a new failure, while `case-1` / `case-2`, error codes and expected values stay
  semantic. Two shapes remain indistinguishable: within one file, "10 errors down to 6" and
  "the first 6 errors, unchanged" both read as shrinkage when the items fully overlap;
  `expected 2 got 1` and `got 1.5` are two distinct identities (digits are kept), never merged;
- P prefers to under-report: an error that moves to a **different file** always counts as
  progress (fixing separate files must not be called a patch chain). The cost is that a real
  chain pushing the error from A into B also goes unmentioned;
- F needs an extractable path. Without one (plain-text errors, only `[exit code: 1]`) the
  failure keeps B's bookkeeping but never joins an error family — better silent than merging
  errors from unrelated projects into one target;
- A line is classified before it may join the set: only `error` counts as a failure, while
  `warning` columns (ESLint's `src/a.js:1:1  warning  'x' is defined...`), aggregate summaries
  (`10 problems`) and log noise never do. The classification looks only at the leading
  severity column, never at the body - a real `AssertionError: warning total mismatch` still
  counts, otherwise the fix would trade a false positive for a miss;
- A target's boundary is decided by what the path looks like, not by the first space: a
  root-level bare filename like `a.ts` and a spaced absolute path like
  `C:/work/My Project/src/a.ts` must both be recognised whole, while an error message that
  immediately follows a path (`C:/work/a.ts: error: cannot open`) must not be swallowed into
  the target;
- B now counts two kinds of repetition: `isError:true` tool errors, and `isError:false`
  **measurement failures** (`npm test` exiting non-zero). The latter never entered error
  bookkeeping before, so "one identical failure, unchanged, eight rounds in a row" produced
  no reminder at all on 0.3.1. With that gap closed, B takes over while P stays silent;
- Repeat episodes only accumulate on **consecutive** failures: `fail → green → same fail` is
  an oscillation (O's job) and must not be reported as "the same error repeated N times",
  otherwise both signals fire at once;
- O decides "the same failure" by failure-item set, not by whole-output text: the same
  assertion failing with a fresh `Warning: renderer notice-N` line every time is still the
  same failure, and two genuinely different failures that differ only in unrelated log
  formatting are not merged;
- End-of-turn probe cleanup belongs to `dsh-turn-cleanup`, not this plugin.

## Installation

From the npm registry:

```bash
dsh plugin add dsh-better-debug
```

From the release tarball (byte-identical to the npm package):

```bash
dsh plugin add https://github.com/Leonlee114514/dsh-better-debug/releases/download/v0.3.4/dsh-better-debug-0.3.4.tgz
```

Manual link (for local development):

```bash
# 1. Keep the copy somewhere permanent (not a temp dir, not node_modules)
mkdir -p ~/dsh-plugins
cp -r dsh-better-debug ~/dsh-plugins/

# 2. In your profile (e.g. ~/.dsh/profiles/desktop):
#    package.json → dependencies:
#      "dsh-better-debug": "link:../../../dsh-plugins/dsh-better-debug"
#    package.json → append to dsh.profile.bundles:
#      "dsh-better-debug"

# 3. If you write the patch by hand, add to your own profile's cordis.patch.yml:
#      - id: better-debug
#        name: dsh-better-debug
#    Do not add inject: [skills]; the bundled patch deliberately carries no config (see below).

# 4. Restart DSH.
```

> Do not use both mounting styles at once. The bundled `cordis.patch.yml` already contains
> `- id: better-debug`; a duplicate id is rejected by cordis, and two different ids pointing
> at the same package mount the plugin twice — every reminder and log line doubled.

### Two deliberate packaging decisions

**No static inject.** cordis marks a fiber INACTIVE and skips `apply()` entirely when any
declared service is missing — no error, no log; the plugin looks installed but never runs.
Hence `export const inject = []`, and the optional services (`skills` / `webServer`) are
subscribed dynamically via `ctx.inject([...], cb)`: present services enable their features,
absent ones merely disable an optional feature while the gate keeps working.

**No config in the bundle patch.** The marketplace hot-mounter replays only pure insert
lines; a `config:` key marks the whole patch as a blocker, so clicking "enable" would do
nothing. All defaults live in `normalizeConfig()`; overrides belong in **your own profile's**
patch.

## Configuration

Add a `config:` block for the same id in **your own profile's** `cordis.patch.yml`:

```yaml
- id: better-debug
  name: dsh-better-debug
  config:
    enabled: true
    repeatEditThreshold: 3        # A: consecutive blind edits per file
    repeatErrorThreshold: 2       # B: repeats of one error episode
    noVerifySteps: 2              # C: steps without measurement before arming
    maxInjectsPerTurn: 3          # per-turn budget for ordinary signals (M exempt)
    changedWindow: 6              # post-injection observation window, in steps
    repeatFamilyThreshold: 4      # F: total errors in a family (3–20)
    familyMinFingerprints: 3      # F: distinct fingerprints in a family (2–10)
    oscillationThreshold: 3       # O: flips before firing (2–10)
    patchChainThreshold: 3        # P: consecutive fail→write rounds (2–10)
    metaAfterFutile: 2            # M: consecutive futile injections (1–5)
    metaGate: true                # master switch for M
    decayEditsOnVerify: true      # clear blind-edit counters on measurement
    doneOnPresent: true           # sleep after a successful present
    measureCommands: ""           # override the measurement-command regex
    measureIntent: ""             # override the measurement-intent regex
    excludePaths: ""              # override the blind-edit exclusion regex
    logFile: "~/.dsh/logs/better-debug.log"
    panel: true                   # read-only panel route
```

Out-of-range numbers are clamped; an invalid regex falls back to the built-in default with
a warning; `enabled: false` registers no listeners at all.

`logFile` accepts four forms:

| Value | Behavior |
| --- | --- |
| unset | `$DSH_HOME/logs/better-debug.log` (or `~/.dsh/logs/better-debug.log` when `DSH_HOME` is unset) |
| `"~/my.log"` | Home directory expanded |
| absolute path | Used as-is |
| `""` or `false` | Disk logging explicitly disabled (the panel will have no data) |

## Logging and the panel

The log is the only acceptance surface: `ctx.logger` goes to the host process's stdout and
cannot be searched later, so every significant event has a file line. A successful load
always writes:

```
apply pid=… logFile=… A=3 B=2 C=2 budget=3 window=6 panel=true F=4/3 O=3 P=3 M=2/1
```

**No `apply` line means the plugin is not mounted.** The other line types:

```
inject   session=… turn=… step=… signals=A inj=78ed6bc3 chars=… tokens=… files=… worstEdits=… worstStreak=… worstErrors=… searched=… measured=…
outcome  session=… inj=… after=A first=ops_bash class=verify steps=1 before=write
measure  session=… tool=ops_bash ok=false exit=1 cleared=1
change   session=… inj=… after=A tool=ops_bash class=verify steps=1
futile   session=… inj=… after=A count=1 window=6
arm      session=… turn=… gap=2
suppress session=… reason=done
```

Reading notes: `worstStreak` is A's actual criterion (consecutive blind edits since the last
measurement); `worstEdits` is only the per-turn total. `outcome` records just the first
subsequent action — **whether a loop was really built is shown by `measure` lines**, and
`change` lines carry the turn latency in `steps=`. M's inject line adds `futile=N`.

The panel lives at **Settings → better-debug** (or `http://<web-origin>/better-debug`):
read-only, refreshing every 5 seconds, with trigger distribution, covered sessions,
first-action-after-injection, measurement stats, in-window turn rate with median steps,
and strategy-layer thresholds plus the futile counter. Two wording rules are deliberate:

- "First action after injection" is **descriptive**, not causal; the old "change rate"
  framing was dropped because it implied the reminder caused the change.
- Pre-instrumentation logs have no denominator, so the turn rate reads "this log predates
  v0.2 instrumentation" instead of 0%; missing strategy-layer fields render as `—`, never
  as fabricated defaults. The panel does not estimate "tokens saved": demonstrating benefit
  requires a control group or historical replay, and it does neither.

`panel: false` removes the route without affecting the gate.

## The bundled skill

`assets/stuck-gate/SKILL.md` is registered as a bundled skill (rank 600); the "full five
checks" pointer at the end of each injection refers to it. The skill owns the prompt-layer
method (build a loop, search, minimize, falsifiable hypotheses, change layer) and is
independent of the plugin: the plugin covers the moment you forget, the skill covers what
to do once you remember.

A same-named file at `~/.dsh/skills/stuck-gate/SKILL.md` (rank 400) overrides the bundled
wording — lower rank wins, no code change needed. On hosts without a `skills` service,
registration is skipped with a log line and the gate is unaffected.

## Local verification

```bash
node test/sim.mjs           # 102 cases: gate semantics and portability
node test/panel.mjs         # 62 cases: parsing, aggregation, generation tracking, themes, instrumentation
npm run test:posix          # rerun both suites under POSIX path semantics
npm run test:linux          # rerun under Linux platform semantics (case-sensitive)
npm run test:slow           # 400 ms disk latency: wait-for-condition, not wait-for-time (63 cases)
npm run verify              # everything, including syntax checks
```

Tests replay the agent loop's call order against a fake ctx and **do not require the DSH
runtime**. Every signal has positive and negative cases: two-phase measurement, episode
attribution, C's two-stage arming, re-arming, done-state, F's family rule and B suppression,
O's alternating oscillation / healthy TDD / flaky runs, P's chain counting and re-run
exclusion, M's triggering, independence, and kill switch.

A fourth class of fence covers **over-fitted criteria** — the first three are caught by real
CI, this one is not, because the criterion itself is wrong rather than the environment:

- **P's three healthy shapes**: a converging sweep (10→9→8→7), the identical error unchanged,
  and fixing separate files one by one (the site moves). 0.3.0 only compared write sequence
  numbers and flagged all three;
- **`errorTargetOf` dialect matrix**: tsc parenthesized locations, cargo, pytest, go, mypy,
  webpack, C# backslash paths, and Windows backslash-relative paths — 13 spellings in total,
  plus noise like `7/8 and/or TCP/IP` that must not read as a path;
- **O's muting granularity**: another loop turning green must not un-mute this one;
- **F's immunity range**: after a search, brand-new fingerprints on the same target still fire.

All seven negative cases are red on 0.3.0 (`66/73`) and green after the fix (`73/73`) — a
test has to prove the old code wrong before it is allowed to prove the new one right.

### Fifth fence: the assertion itself can state the wrong spec

A deep review of 0.3.1 found a subtler failure mode: **the test can enshrine a wrong
requirement**. The clearest case was the "identical error, unchanged, three times" negative
case: 0.3.1 asserted *total injections must be zero*. Once P correctly stayed silent, the
whole shape went completely silent — eight consecutive rounds, zero injections. The correct
spec is "P must not speak, but something must take over".

The suite now keeps two kinds of assertions apart, each claiming only its own ground:

- **Signal semantics** — assert whether the target signal is present
  (`!has(injected, '修出了下一个失败')`) and let any other signal take over;
- **End-to-end coverage** — assert a stuck shape **cannot go fully silent**, and that the
  same situation **cannot repeat** (the four `B search baseline` cases: any single one is
  satisfiable by a wrong implementation, only all four pin the semantics down).

Six state-machine fixes correspond to it (0.3.1 → 0.3.2): M moved ahead of the generic
idempotence early-return (otherwise the one moment it is most needed — "reminded, then no
writes and no new errors" — is exactly what the idempotence check swallows); failed
measurements get their own repeat episodes (`isError:false` measurement failures never
reached `s.errors`); B's search immunity became a count baseline (the old `firstClock`
exempted an episode forever after one search); P's `unchanged` clears the chain instead of
pausing it; `movedSite` compares against every target seen this turn (it used to compare
only with the previous round, so `A→B→A→B` looked like a fresh site every round); O uses
failure-item set identity (a whole-output fingerprint is rewritten by an unrelated warning).

A fourth review then found **four new defects** in 0.3.2, two of which were created by the
criteria above:

- **Failure identity treated source positions as semantic** (defect 1): the fingerprint was
  taken over the whole `path + location + message` line with every number kept, so
  `src/a.ts(12,9)` and `src/a.ts(13,9)` became different failures. The opposite mistake was
  already proven in 0.3.0/0.3.1 — normalizing every number collapsed `case-1` into `case-2`.
  The parser now cuts the path **and the locator that immediately follows it**, then
  fingerprints the rest, so positions are noise and numbers in the message stay semantic;
- **Python frames were treated as the failure itself** (defect 2): only JS `^at\s` was
  excluded, so `File "…", line 10, in test_case` joined the set while
  `AssertionError: case-one` was dropped by the "if any line carries a path, use only those"
  rule. Two different assertions sharing a frame therefore became the same failure (false
  "repeated error"), and healthy TDD was read as oscillation. The fix has two halves: frames
  contribute the target only, and the exception message must be merged in even when path-
  bearing lines exist. That exposed a third face: the echoed source line under a frame
  (`    assert case == expected`) is byte-identical across runs and becomes a shared item,
  so it is recognised structurally and skipped;
- **O compared whole-set equality instead of item intersection** (defect 3): real sessions
  rarely replay an identical failure set; far more common is the old failure plus one new
  one, which made every set hash differ and stayed silent for ten rounds;
- **Failed measurements did not advance the idempotence state** (defect 4): the generic gate
  compares only `writeSeq` / `errorSeq`, and "`npm test` failed again" moves neither, so the
  second reminder in `fail → remind → fail to threshold` was swallowed as "nothing changed".
  A monotonic `failSeq` now moves on every recorded measurement failure.

Five new case groups (`50`–`53`) cover it: a locator drift must not change identity;
`case-1` / `case-2` must not merge; different Python assertions sharing a frame must not
merge; the exception message must stay in the set; the echoed source line must not become a
shared item; `{A}→{A,B}→{A,C}` must still read as A recurring; and a second B must fire after
a search once the threshold is reached again. Against 0.3.2 these cases are red 6 of 89;
after the fixes, `89/89`.

### Fifth round: stop adding regexes, start classifying diagnostic lines

A third review then took the parse layer apart again and found that the previous two rounds
had been adding one regex per observed shape. What was missing was a classification: is this
line an `error`, a `warning`, a `frame`, `source`, an `aggregate` summary, or `log` noise?
Patching shapes one by one produced a parser that recognises a compiler at the target layer
but not at the identity layer - case 46 asserted that `errorTargetOf` understood webpack
locations, and never asserted that `failureSetOf` produced the same identity after the line
number drifted. All five defects come from that gap:

- **A bare filename in the repository root was not recognised** (defect 1): the path rule
  required `directory + filename`, so `a.ts(12,9)` yielded no target, leaving the locator
  unstripped - one line shift produced a brand-new failure;
- **Absolute paths were truncated at the first space** (defect 2): the path regex stops at the
  first blank, so `C:/work/My Project/src/a.ts` yielded `c:/work/my` and left the remainder in
  the message;
- **Webpack's space-separated location range was not stripped** (defect 3): it writes
  `./src/index.js 5:0-20` - a space, then a line:column-range, neither bracketed nor leading
  with a colon;
- **Any line carrying a path joined the set** (defect 4): `src/a.js:1:1  warning  'first' is
  defined...` became a failure item. With the error unchanged and only the warning's variable
  name moving, the set changed every round: B could not recognise the repeat and P reported
  the warning churn as "another failure repaired";
- **pytest's `> assert ...` echo became a shared item** (defect 5): two different assertions
  share that line, so O's item-intersection test read healthy TDD as "the old failure is
  back".

The fix is not five more regexes: classify first, then decide whether the line may enter the
set. Frames contribute a target only, the `E` line is the diagnostic itself, `>` / `<` and
indented lines inside a frame block are echoes, and `warning` columns and aggregate lines never
enter. Each rule ships with a counter-example - in particular, a real failure whose message
contains the word `warning` must still enter, so the fix cannot trade a false positive for a
miss.

Case group `54` covers it (13 assertions: bare filename, spaced path, webpack locator, ESLint
warning both ways, pytest echo and the `E` line). Against 0.3.3 these are red 9 of 102; after
the fixes, `102/102`. All three probe rounds (`deep-review-probes`, `-v032-`, `-v033-`) match
expectations line for line.

The three extra suites are regression fences for three classes of "green locally, red in
production":

- **Path dialects**: `node:path`'s `isAbsolute` is platform-dependent and once silently
  dropped every write on POSIX hosts. `test:posix` swaps in `node:path/posix` via a resolve
  hook and reruns the suites verbatim.
- **Case sensitivity**: `test:linux` overrides `process.platform`, and assertions compare
  with `samePath`/`sameDirs` per platform instead of hard-coding the developer machine's
  case folding.
- **Disk timing**: the plugin intentionally fires `void record(...)` without awaiting;
  `test:slow` slows `appendFile` by 400 ms so any fixed-sleep log reader fails reliably.
  Readers always wait for conditions.

CI runs `npm run verify` on ubuntu / windows / macos × node 20 / 22 / 24.

## Rationale and related work

The plugin implements no planning algorithm. Its conceptual layers follow the literature;
all criteria remain reproducible event heuristics:

- **Plan repair versus replanning**: Nebel & Koehler (IJCAI 1995) showed that reusing a plan
  is, in the worst case, no cheaper than planning from scratch; Fox et al. (ICAPS 2006)
  introduced plan stability and compared the two strategies empirically. The P signal
  (patch chain) mirrors the maintenance rule "after N repairs, rebuild", formalized as
  patch debt and commitment hysteresis in arXiv:2611.19663; M mirrors the switch of
  revision instrument once the current one stops paying.
- **Metacognitive monitoring**: self-monitoring degrades exactly under the conditions that
  need it most, which motivates external monitoring. The plugin acts as an external
  metacognitive layer in the harness: detection never depends on the model's self-awareness,
  and intervention lands before the next action rather than in a post-mortem.

## License

MIT
