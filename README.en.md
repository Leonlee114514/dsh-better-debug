# dsh-better-debug

A **stuck-loop detector** for coding agents (DeepSeek Harness / Cordis).

It subscribes to the agent event stream, decides from reproducible behavioural evidence whether the model
is iterating without making progress, and appends one structured observation-and-recovery message to the
message sequence before the next model request.

- **No LLM calls** — every verdict is event counting, path matching and string normalisation. The same event
  sequence always yields the same conclusion.
- **No agent-loop changes** — it only appends a user message to `messages`. It never `reject`s and never
  intercepts a tool call.
- **No model-output parsing** — the only user input it reads is the user message itself, and only to match
  mute phrases such as "just do it". Nothing is stored, written to disk or sent anywhere; the log keeps a
  single boolean.

In one line: it moves the "when stuck, stop and build a feedback loop" clause out of the prompt layer and
into code.

What it detects is not "the model cannot write code" but a few named cognitive failures: **over-commitment / blind commitment** (persisting with a method that has stopped working), the **Einstellung effect** (a mental set formed by success), and the absence of an **intention reconsideration** moment. See [Rationale and related work](#rationale-and-related-work) for the literature behind each and the signal it maps to.

## What it solves

"When stuck, establish a feedback loop first" normally lives in a system prompt or a skill file, which makes
it a **self-discipline clause**: the model has to notice it is stuck before the clause can do anything. And
the behavioural signature of being stuck includes exactly that failure of self-monitoring — the model keeps
writing the N-th "let me try once more".

The plugin takes over the part that **events can prove**, under three principles:

1. **Behaviour only, never language.** Verdicts use event counts, path matching and string normalisation, so
   every conclusion can be reproduced from the same event sequence.
2. **Observations, not diagnoses.** Injected text opens with "this is an observation, not a conclusion",
   states countable facts (how many times, how many kinds, how many rounds) and at most two recovery
   actions, each with its own release condition.
3. **Asymmetric evidence cost — prefer missing a signal to interrupting.** Cutting a healthy iteration short
   costs more than staying silent once, so every signal ships with its counter-examples.

## A minimal example

Every edit is verified, every failure is different, yet the model keeps bouncing between two mutually
destructive edits:

```
edit A → npm test (red: assertion B fails)
edit B → npm test (green)
edit A → npm test (red: assertion B fails)   ← the same failure recurs after being green
edit B → npm test (green)
edit A → npm test (red: assertion B fails)   ← flip #2
edit B → npm test (green)
edit A → npm test (red: assertion B fails)   ← flip #3, O fires
```

Before the next step the plugin appends one message:

```
[better-debug] Observed repeated action (an observation, not a conclusion):
- The same verification has flipped between passing and failing 3 times, with edits between every flip.
Before the next step, do one of these and get a new fact first:
1) The edits are pushing the problem back and forth: pin one currently-red case, make only the minimal change that turns it green, and set the other edits aside; if two edits break each other, they share a wrong assumption — write that assumption down before touching anything.
Release condition: once you have a new measurement or an external fact, continue as usual.
All five steps: skill `stuck-gate`.
```

And one greppable log line:

```
inject session=… turn=1 step=19 signals=O inj=e7db4417 chars=235 tokens=204 files=2 worstEdits=5 worstStreak=0 worstErrors=0 searched=false measured=yes:ops_bash:fail
```

## The signal model

Seven signals in three layers: the tactical layer detects **repeated actions**, the strategy layer detects
**changed actions with an unchanged direction**, and the meta layer detects **the intervention itself failing**.

| Layer | Signal | Behavioural evidence | Default trigger |
| --- | --- | --- | --- |
| Tactical | **A** blind edits | `fs/write-intent` count per absolute path; cleared per directory when a measurement returns | 3 in a row |
| Tactical | **B** repeated error | episode count per `tool\|target\|fingerprint`, including `isError:false` measurement failures; a search records the current count as a baseline | 2nd time |
| Tactical | **C** edit-then-write without verifying | blind writes since the last measurement (cross-file, step numbers irrelevant); arms at N, fires on the **next write** | 3 writes |
| Strategy | **F** error family | distinct fingerprints and total count per `tool\|target`; a search immunises the fingerprints seen before it | 3 fingerprints and 4 hits |
| Strategy | **O** verification oscillation · *experimental* | a **previously-green failing item recurs** in the same loop, with an edit between the two results | 3rd flip |
| Strategy | **P** patch chain · *experimental* | consecutive "measurement fails → edit → still fails" with **no shrinkage of the failure surface** | 3 rounds |
| Meta | **M** intervention failure | no measurement or search inside the window after an injection; the pending entry is voided and counted as `futile` | 2 futile injections |

What all signals share is **measurement**, not "some tool was called".

### Two-phase measurement

Intent is decided at `tool/call` from the arguments; the result is only booked at `tool/result`. So
`edit → ls → edit → edit` is not laundered by the `ls` in between, and running the test suite in an
unrelated directory does not clear the blind-edit count of the target file.

| Class | Tools | Rule |
| --- | --- | --- |
| Hard measurement | `verify` `run_tests` `run_test` (plus `lsp_diagnostics` when `dsh-lsp-actions` is installed) | always a measurement |
| Soft measurement | `ops_bash` `bash` `shell` `pwsh` | the command matches `measureCommands`, or the description matches `measureIntent` and the command is not `ls/dir/cat/type/head/tail` |
| Search | `web_search` `research` `advanced_search` `multi_search` `platform_search` `domain_search` `cache_search` `video_search` | treated as an external prior |
| Methodology | `skill` | counted as a valid turn |
| Edit | `edit` `write` `ops_write` `str_replace` `apply_patch` `notebook_edit` | advances the write sequence |

**A failing test is still a valid measurement**: it produces a new fact. `[exit code: 1]` clears the blind-edit
count just like a pass; it is only recorded as `ok=false` in the log and the panel.

Built-in measurement commands cover `test|verify|check|lint|typecheck|build` for `npm/pnpm/yarn/bun`,
`node --test`, `pytest`, `vitest`, `jest`, `mocha`, `go test`, `cargo test`, `dotnet test`, `tsc`,
`eslint`, `ruff check`, `mypy` and `git diff --stat`; override them with `measureCommands`. Generated
artifacts and lockfiles are excluded via `excludePaths`.

### Two kinds of "identity"

The same error text has to answer two different questions, so there are two normalisations:

| Purpose | Normalisation | Question answered |
| --- | --- | --- |
| Fingerprint (B / F) | first 6 lines, first 300 chars; hex, paths and numbers normalised; first 16 hex chars of a sha256 | is this operation failing with the same sentence again |
| Failing item (P / O) | only "path + the line/column immediately after it" is stripped; digits in the message stay | has the failure surface moved to a different problem |

They must stay separate: normalise `case-1` / `case-2` and P counts two different assertions as one error; keep line
numbers and P / O treat one edit of one place as a new problem.

B is keyed by `tool|target|fingerprint`, F by `tool|target` — F measures the **diversity** of fingerprints. If F
also carried the fingerprint, every new error would open its own episode and F would degrade into a duller B.

### O and P are experimental

A / B / C / F / M have all been observed firing in real sessions; **O (oscillation) and P (patch chain) are
marked experimental**: across 1113 real log lines on the author's machine each fired **0** times (A 17,
B 36, C 159, F 1, M 8 over the same period). Their verdicts depend on the shape of the failure *set*, and
in real engineering work two healthy behaviours imitate that shape: an ordinary red-green-red TDD rhythm
reads as oscillation, and fixing independent files one by one reads as a patch chain.

- Default thresholds stay (`oscillationThreshold: 3` / `patchChainThreshold: 3`) rather than defaulting to off —
  turning them off means those two verdicts can never collect real samples and can never be falsified.
- Treat them as experimental: when one fires, take it as "worth a look", not "do this". A / B / C usually
  mean "this step really is a repeat"; O / P may mean "your rhythm merely looks like one".
- To switch them off completely: `oscillationThreshold: 10` + `patchChainThreshold: 10` (10 is the ceiling for both).

### M: the meta gate

Every injection registers a pending entry. If no measurement or search appears inside the window
(`changedWindow`, default 6 steps) the entry is voided and `futile += 1`; any valid turn or successful measurement
resets it. `futile` reaching `metaAfterFutile` (default 2) fires M.

M differs mechanically from the other six:

- **Highest priority** — evaluated before the other signals;
- **does not consume** the `maxInjectsPerTurn` budget — the situation that most needs M is exactly the one where
  the budget is spent;
- **at most once per turn**, and the step that fires it carries no other signal;
- **its own wording**: it asks the model to write down what has already been tried, the shared assumption,
  and one mechanically different approach (or the concrete artifact it needs from the user), before any
  mutating tool call.

## Priority and mutual exclusion

One step never stacks two statements of the same thing:

- **P and F** firing together emits only P (a patch chain is closer to the strategy layer) and marks F as
  fired;
- **F / P firing suppresses B** ("this error repeated" is the weaker observation) and marks B as fired;
- **when A / B fire**, C is marked as fired instead of adding "you edited without verifying";
- **M** is always its own message.

## Idempotence and re-arming

The same situation is not reported twice: if neither the write sequence nor the error sequence changed
since the last injection, the gate stays silent. Each signal re-arms on its own definition of "the
situation changed":

| Signal | Re-arms when |
| --- | --- |
| A | a measurement returns (clears the relevant directories only) |
| B | a search happens after that episode (it must re-accumulate to the threshold — not a lifetime immunity) |
| C | a measurement returns (pass or fail — disarms and zeroes the blind-write count); only a **successful** one re-arms, because a failing measurement brings no new fact and the situation is unchanged |
| F | a search (immunises only fingerprints seen before it), or one successful measurement |
| O | two consecutive successes on the same loop (re-arms that loop only) |
| P | one successful measurement, or the failure surface starts shrinking, or nothing changed at all |
| M | once per turn; a valid turn clears `futile` |

Ordinary signals share the per-turn budget `maxInjectsPerTurn` (default 3).

## Preconditions and exceptions

1. **Delivery state**: after `present` returns successfully the gate sleeps until the next write; a failed
   `present` does not sleep. While sleeping it writes `suppress … reason=done` so "awake but silent" and "not
   mounted" stay distinguishable. `doneOnPresent: false` disables this.
2. **Explicit user instruction**: if the user's own words this turn match the regex below, the whole turn is
   muted. Only messages with `source.kind === 'user'` are matched; the plugin's own injections are not.

   ```js
   /别搜|不要搜|不用搜|先别搜|直接改|快速试|别折腾|先试试|
    don'?t\s+(?:search|bother\s+searching)|no\s+need\s+to\s+search|
    skip\s+(?:the\s+)?search(?:ing)?|stop\s+searching|
    just\s+(?:do\s+it|edit|fix\s+it|make\s+the\s+change|change\s+it)|quick\s+try/i
   ```

   Bilingual (Chinese and English). Every alternative requires the imperative mood: descriptive uses such
   as "let me search first, then edit" do **not** mute — muting by mistake costs the whole turn its
   protection, which is more expensive than missing one.
3. **Sub-sessions are skipped**: `origin === 'subagent'` or `delegationDepth > 0` always bypasses the gate.
4. **Never `reject`**: interception is only an appended user message, so the turn never becomes a no-op.

## Injection wording

Ordinary signals follow a fixed skeleton (observation → at most two actions → release condition → skill
pointer); M uses its own template. The single source of wording is `lib/text.js`, shared by the runtime
injection and the panel back-fill, so character / token counts can never drift from the real text.

The full M template:

```
[better-debug] Meta-observation: 2 consecutive reminders this turn produced no change of direction.
This is no longer a "try once more" problem. Before the next step, write three short paragraphs (12 lines max):
1) the approaches you have already tried, and the assumption they share;
2) one mechanically different approach — change the data structure, the library, the layer of responsibility, or build a minimal reproduction and rewrite — pick one and say why it avoids every wall you hit before;
3) if you cannot write (2), what you are missing is evidence, not attempts: list the one concrete artifact you need from the user (log / minimal reproduction / environment info).
Make no mutating tool call before this is written.
```

## Scope and known limits

**Designed and calibrated for coding work.** F depends on paths and fingerprints inside error text, O / P
depend on a repeatable verification command, M depends on "a feedback loop that can be built". In writing,
design or data analysis "verification" is not a command, so these signals are unreliable. The plugin
**does not classify task types**; the boundary is set by configuration (`metaGate: false` turns M off; raising the F /
O / P thresholds is equivalent to disabling them).

- "Same file" means the same absolute path; deleting and recreating a file with the same name still counts
  as one place;
- measurement detection is a heuristic regex, and its error directions are asymmetric: a non-measurement
  taken for a measurement causes misses, a measurement taken for a non-measurement causes false alarms;
- the delivery state only recognises a successful `present`; a plain-text final answer relies on the
  `stuck-gate` skill's self-check;
- all state lives inside a turn, resets on `turn/start`, and is never persisted across turns;
- no-op writes are not detected: `fs/write-intent` carries no content, so the plugin layer cannot see a diff;
- P counts the failure surface as a set of failing items and requires the current set to be a proper subset
  of the previous one. Moving to a **different file** always counts as progress (fixing different files in
  parallel should not be called spinning), at the cost of staying silent on a genuine "fix A, push the error
  into B" chain;
- F needs an extractable path. With no target (plain-text errors, nothing but `[exit code: 1]`) only B keeps
  the record and the error family does not form;
- a repeated episode accumulates only across **consecutive** failures: `fail → green → same fail` is oscillation
  (O's job) and should not be described as "the same error repeated N times".

## Installation

### Desktop app (DeepSeek Harness)

The `desktop` profile is managed exclusively by the Electron application; running
`dsh plugin --profile desktop …` from a shell is rejected outright
(`error: profile "desktop" is managed exclusively by the Electron application`). Install it inside the
app: Settings → Built-in plugins → Discover, search for `dsh-better-debug`, then restart the app.

### Other profiles (web / headless / your own)

`dsh plugin` forwards the remaining arguments verbatim to pnpm inside that profile's directory, and
`--profile` is a required option:

```bash
# npm registry
dsh plugin --profile web add dsh-better-debug

# pin a version
dsh plugin --profile web add dsh-better-debug@0.3.5
```

Local tarball (same content as the npm package, decided by the `files` allowlist; a relative path is
resolved against the **current working directory**):

```bash
# run from the repository root; the artifact lands at ./dsh-better-debug-<version>.tgz
npm pack
dsh plugin --profile web add ./dsh-better-debug-0.3.5.tgz
```

`dsh-plugin-manager` appends the package name to that profile's `dsh.profile.bundles` on its own — no
manual edit needed; if the package declares no `dsh.bundle` it degrades to a plain dependency with a
warning. Restart DSH to take effect.

### Manual link (for local modification)

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

> Do not use both mounting paths at once. The bundled `cordis.patch.yml` already contains
> `- id: better-debug`; a duplicate id is rejected by cordis, and two different ids pointing at the same
> package mount the plugin twice, doubling reminders and log lines.

### Two deliberate packaging decisions

**The two halves declare inject differently. Do not copy one into the other.**

Host half (`lib/index.js`): `export const inject = []`. When any declared service is missing, cordis sets the
epoch to INACTIVE and skips `apply()` — no error, no log, the plugin looks installed but never runs. So optional
services (`skills` / `webServer`) are subscribed dynamically via `ctx.inject([...], cb)`: if the service exists
the feature turns on, if it is missing only that optional feature is lost and the gate keeps working.

Client half (`client.js`): `export const inject = ["slots"]` is mandatory. In the browser the plugin receives a
dynamic facade built by `dsh-cordis-client-runner`; its get trap only lets through a handful of cordis verbs plus
**services declared in this plugin's own inject array**. `inject` itself is not on that list, so reading it throws
`dynamic ctx does not expose "inject"`. Guarding with `typeof ctx?.inject === 'function'` does not help — the
property read is what throws, so `typeof` never runs. The old code therefore blew up before registering the slot:
the panel vanished silently and left no log line. Declarative inject is the safe form on the client, because a
missing service parks the fiber on waitingFor instead of skipping `apply()`.

**The bundle patch carries no config.** Market hot-mounting replays pure insert lines only; a patch that
contains `config:` is flagged as a blocker and the user's "enable" click does nothing. All defaults live in
`normalizeConfig()`; overrides go into your own profile patch.

## Configuration

Add a `config:` block for the same id in your profile's `cordis.patch.yml`:

```yaml
- id: better-debug
  name: dsh-better-debug
  config:
    enabled: true
    repeatEditThreshold: 3        # A: blind edits to one file before firing (2–20)
    repeatErrorThreshold: 2       # B: repeats of one episode before firing (2–20)
    noVerifyWrites: 3             # C: blind writes without a measurement before arming (1–20)
    maxInjectsPerTurn: 3          # per-turn budget for ordinary reminders (1–10; M is exempt)
    changedWindow: 6              # observation window after an injection (1–30 steps)
    repeatFamilyThreshold: 4      # F: total hits in an error family (3–20)
    familyMinFingerprints: 3      # F: distinct fingerprints in the family (2–10)
    oscillationThreshold: 3       # O: which flip fires (2–10) · experimental
    patchChainThreshold: 3        # P: consecutive fail-then-write rounds (2–10) · experimental
    metaAfterFutile: 2            # M: consecutive futile injections (1–5)
    metaGate: true                # master switch for M
    decayEditsOnVerify: true      # clear blind-edit counts on a measurement (C:/, /c/, /mnt/c/ count as one dir)
    doneOnPresent: true           # sleep after a successful present
    measureCommands: ""           # override the measurement-command regex; empty = built-in list
    measureIntent: ""             # override the measurement-intent regex
    excludePaths: ""              # override the blind-edit exclusion regex
    logFile: "~/.dsh/logs/better-debug.log"
    logMaxBytes: 2097152          # per-file cap (64 KiB–64 MiB); rotates at the cap
    logKeep: 2                    # how many rotated files to keep (1–9)
    panel: true                   # read-only panel route
```

Out-of-range numbers are rounded and clamped to the nearest bound; an invalid regex in any of the three
regex keys falls back to the built-in default and logs a warning; `enabled: false` registers no listener at all.

The four forms of `logFile`:

| Value | Behaviour |
| --- | --- |
| omitted | `$DSH_HOME/logs/better-debug.log` (`~/.dsh/logs/better-debug.log` when `DSH_HOME` is unset) |
| `"~/my.log"` | expands the home directory |
| absolute path | used as-is |
| `""` or `false` | logging off (the panel will have no data) |

At `logMaxBytes` the writer moves the current file to `better-debug.log.1`, shifts older ones along, and drops
the oldest beyond `logKeep`. The reader does not re-read the whole file per request: it remembers `ino` /
`size` / `mtime` and parses only newly appended complete lines, restarting from scratch when the file shrinks, is
replaced, or `mtime` goes backwards. `bytes` in the API response is always the total file size.

## Logging and the panel

The log is the only acceptance surface: `ctx.logger` goes to the host process stdout and cannot be searched
afterwards, so every key event has a persisted line type. A successful load always writes:

```
apply pid=… logFile=… A=3 B=2 C=2 budget=3 window=6 panel=true F=4/3 O=3 P=3 M=2/1 logMax=2097152 logKeep=2
```

**No `apply` line means the plugin is not mounted.** The other line types:

```
inject   session=… turn=… step=… signals=A inj=78ed6bc3 chars=… tokens=… blind=… files=… worstEdits=… worstStreak=… worstErrors=… searched=… measured=…
outcome  session=… inj=… after=A first=ops_bash class=verify steps=1 before=write
measure  session=… tool=ops_bash ok=false exit=1 cleared=1
change   session=… inj=… after=A tool=ops_bash class=verify steps=1
futile   session=… inj=… after=A count=1 window=6
arm      session=… turn=… writes=3
suppress session=… reason=done
```

Reading notes: `worstStreak` is the A criterion (consecutive blind edits since the last measurement);
`worstEdits` is only the per-turn total; `outcome` records the first following action only, so **whether a loop
was really established shows in the `measure` line**; `steps=` on a `change` line is the turn latency; the inject
line for M carries an extra `futile=N`.

The panel lives at **Settings → better-debug** (or `http://<web-origin>/better-debug`). It is read-only,
self-refreshes every 5 seconds, and shows the trigger distribution, covered sessions, the first action after
a hint, the measurement loop, the in-window turn rate and median steps, the strategy-layer thresholds and the
futile counter. `panel: false` disables the route without affecting the gate.

**The route reuses the host's admission fence**: every request first passes
`ctx.get('connection').requestRejection(req)`, the same rule the official plugins use — the Host must be
loopback / the bind address (otherwise 403) and a browser session cookie or API credential must be present
(otherwise 401). The panel JSON contains session ids, raw error samples and the absolute log path, so when
the host is forwarded through a public relay this fence is the only boundary. The service is looked up
**per request** rather than cached at registration (cordis does not guarantee service readiness order); with
no `connection` service at all (headless profiles) it degrades to allow-all.

Two wording rules:

- "First action after a hint" is a **descriptive statistic**; it does not prove the reminder caused the
  change. Causally suggestive metric names have been removed.
- Logs older than the instrumentation have no denominator, so the turn rate reads "this log predates the
  v0.2 instrumentation" instead of 0%; when old logs lack strategy-layer fields the panel shows `—` rather
  than inventing defaults. The panel does not estimate "tokens saved" — proving a gain needs a control
  group or historical replay, neither of which is its job.

## The bundled skill

`assets/stuck-gate/SKILL.md` is registered as a bundled skill (rank 600); the "all five steps" pointer at the
end of each injection refers to it. It covers the prompt-layer five-step method (build a loop, search,
minimise, falsifiable hypotheses, change the layer) and is independent of the plugin: the plugin covers the
moment you forget, the skill covers what to do once you remember.

A user can override the wording with a same-named file at `~/.dsh/skills/stuck-gate/SKILL.md` (rank 400); the
lower rank wins, with no code change. When the host has no `skills` service the registration is skipped and
logged; the gate is unaffected.

## Local verification

```bash
node test/sim.mjs           # 298 cases: gate semantics, four runner corpora, portability
node test/panel.mjs         # 100 cases: log parsing, aggregation, generations, instrumentation, admission fence
node test/client.mjs        # 16 cases: client facade contract (inject declaration, slot registration)
node scripts/judge-health.mjs test/fixtures/better-debug.sample.log   # criterion health check (sample log should pass)
npm run test:posix          # re-runs sim + panel with POSIX path semantics
npm run test:linux          # re-runs with Linux platform semantics (case-sensitive)
npm run test:slow           # 400 ms write latency, proving "wait for a condition" not "wait a duration" (101 cases)
npm run verify              # everything (plus syntax check, dead code, publish contract)
npm run judge-health        # four numbers from a real log, exit 1 if any is out of range
```

`npm run judge-health` is for self-inspection: it turns "is signal C opening its mouth on behalf of the other
signals again" into four assertable numbers (C share ≤35%, arm cleared rate ≥60%, C turn rate ≥25%, C futile
rate ≤30%). The arm criterion pairs each `arm` line with the next `measure` of the same session and asks whether
that measurement actually cleared the writes; an `arm` with no following `measure` stays out of the denominator.
It reads `$DSH_HOME/logs/better-debug.log` by default; run it once after changing machine or model to see the
baseline before touching any threshold. Add `--since-apply` to judge only the lines written by the code that is
currently loaded — older lines were produced by earlier criteria axes and will skew every ratio.

`test/client.mjs` pins down the browser-side constraint that is hardest to reproduce: a client plugin receives
the dynamic facade built by `dsh-cordis-client-runner`, not a cordis Context. The test replays that get trap with an
`inject` property that throws, so it turns red the moment someone writes `ctx.inject([...], cb)` back into
`client.js` or resets `inject` to an empty array — no DSH install required, and it does not drift with host
versions.

The tests replay the agent-loop call order with a fake ctx and **do not depend on the DSH runtime**. Every
signal has both a positive and a negative case: the two measurement phases, episode attribution, the
two-stage C, re-arming, the delivery state, F family detection and B suppression, O's alternating
oscillation / healthy TDD / flaky, P's chain counting and rerun exclusion, M's trigger / independence /
switch, and the positive and negative case for each of the seven signals' config keys.

CI runs the syntax check, dead-code scan, publish-contract check and the full suite on Ubuntu / Windows /
macOS × Node 20 / 22 / 24, then unpacks the `npm pack` artifact and tests it again — shipping into a user's
path and running tests in the repository are two different things.

## Rationale and related work

The plugin implements no planning or reasoning algorithm; every verdict is a reproducible heuristic over the event stream. But the failure modes it looks for have clear theoretical sources — listed below as concept → literature → the signal it explains, so you can see why each signal is worth watching.

### over-commitment / blind commitment

An intention carries commitment. Cohen & Levesque (*Artificial Intelligence* 42, 1990) formalise intention as choice with commitment: commitment is why an intention drives action, and also why it is hard to retract. When commitment outlives the evidence that supported it and the original plan keeps advancing anyway, that is over-commitment; when it shows up as "no evidence, just momentum", it is blind commitment.

Three shapes in practice: the same location edited again and again with no verification run (A), the same error hit again and again (B), and edits made without measuring before moving on (C). None of them requires reading the model's mind — only the relative position of writes and verifications in the tool-call sequence.

Tewari (arXiv:2611.19663, 2026) turns "repair, replan, or abandon" into a threshold theory: the optimal policy depends on effective disruption depth — repair shallow damage, replan after deep damage, abandon when even a fresh plan is not worth its cost — and no single strategy dominates. That is why the plugin never presumes whether you should repair or rebuild: it only puts the evidence in front of the model.

### Einstellung effect

Luchins (*Psychological Monographs* 54(6), 1942) and the water-jar experiments: subjects who have solved a run of isomorphic problems keep applying the old method to a new problem that has a simpler solution. It is not a lack of ability; it is a set formed by success — being practised makes it more likely.

Two failure shapes: carrying a method that worked last time onto a differently shaped problem (F, error family — deduplicated fingerprints, checking whether different errors share a structure); and one verification set flipping between passing and failing (O, oscillation).

The criteria deliberately look at shape, not count: F deduplicates fingerprints before asking whether different errors share a structure, and O looks at the intersection of the same verification items across two measurements. The signature of Einstellung is "same old solution, new problem", not "failed a lot".

### intention reconsideration

An intention must be stable enough to guide action and revisable enough to survive a changing environment; the two pull against each other. Cariani (*Philosophical Studies* 182, 2024) gives a structured account of that tension: when to reconsider, what to reconsider, and who triggers it.

The plugin's position is that reconsideration should not be triggered by the model itself — it is the party bound by the commitment. So the intervention point is fixed at `agent/pre-step`, before the next action, turning "keep going" from a default into an explicit choice. M (the meta gate) handles the harder case: the reminder already fired and the model carried on unchanged — the problem is then not the next action but the reminder, so the gate escalates to questioning the approach instead of editing the next line.

### Plan repair vs. replanning

Nebel & Koehler (*Artificial Intelligence* 76, 1995) show that conservative plan reuse is not cheaper than planning from scratch in the worst case, and reuse itself can be harder; Fox et al. (ICAPS 2006) introduce plan stability and compare the two strategies empirically. P (patch chain, experimental) corresponds to the maintenance rule "after N repairs, switch to rebuilding", which arXiv:2611.19663 formalises as patch debt and commitment hysteresis.

### Metacognitive monitoring

Flavell (*American Psychologist* 34, 1979) defines cognitive monitoring as awareness and regulation of one's own cognitive processes. Self-monitoring failing under pressure is exactly the motive for external monitoring; the plugin acts as harness-level external metacognition — detection does not depend on the model's self-awareness, and the intervention comes before the next action rather than in a post-mortem.

### Where this literature actually sits in the code

The literature supplies the taxonomy of failure modes, not the thresholds. Every number among the 21 config keys comes from observable statistics over the event stream; none is derived from a paper. The literature answers one question only: why these things are worth watching.

## License

MIT
