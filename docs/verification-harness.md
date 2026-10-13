# Verification harness

The scripts in `test/harness/` run manual checks against the installed Pi 1.1.0 with a local double of the Anthropic Messages endpoint. They are not part of `npm run check` or `npm test`, no CI job runs them, and they need no dependency beyond Node.js and, for the boundary script, bash. The results in [projection.md](projection.md) that depend on a real Pi run refer to these checks. The automated suite still does not start Pi; the unit tests of the projection cover the behaviour that the checks cannot reach end to end (see [Unit tests](#unit-tests)).

## Checks

| Script | Verifies | Duration |
| --- | --- | --- |
| `run-boundary.sh` | The first request of a new application starts with the profile's user and assistant texts and ends with the real prompt, with exactly three messages. Two negative controls fail as they must, and the checker's self-test rejects altered bodies and names the state of the pair it saw. | about 1 min |
| `interruption.mjs` | The host is killed after the projection is recorded (response held) and right after the commitment record is written. Pi starts again on the same session; the persisted records, the state `/prefill status` reports and the next request are compared with [projection.md](projection.md). The kill is verified. | a few min |
| `selection-atomicity.mjs` | A replacement of `selection.json` is interrupted while writing, before and after the rename; twenty-five more replacements are killed at random times. A leftover temporary file is not read as the state. | a few s |
| `compaction.mjs` | A manual compaction of a session with a committed application. The summary Pi reports is traced to the summary request that wrote it, and the request after the compaction must carry that summary. | about 1 min |
| `cache-warming.mjs` | Pi's cache warming timer: the decision, the one-token refresh request, the `cache_warm` entry, the count shown by `/prefill status`, and the normal request after it. | about 5 min |
| `export-session.mjs` | The session export through the two routes that need no terminal (`pi --export` and RPC `export_html`), compared with the session file and with the export contract on the embedded data. | about 30 s |

Each script writes a `summary.txt` in its work directory: one line per step, `ok` or `FAIL`, and `info` lines for observations that are not expectations. `interruption.mjs` writes `<scenario>/summary.txt`, `run-boundary.sh` writes `run/summary.txt` (its checker self-test writes `run/selftest.txt`), and the other Node scripts write `summary.txt` in their scenario directory.

## How to run

Requirements: Node.js 24 (the verified version is 24.9.0), Pi 1.1.0 installed globally, and bash with `sha256sum` for the boundary script. Run them from the repository root. `<cli.js>` is the `dist/bundle/cli.js` of the global Pi package (`$(npm root -g)/@earendil-works/pi-coding-agent/dist/bundle/cli.js`).

```sh
bash test/harness/run-boundary.sh
node test/harness/selection-atomicity.mjs
node test/harness/interruption.mjs --pi-entry <cli.js>
node test/harness/compaction.mjs --pi-entry <cli.js>
node test/harness/cache-warming.mjs --pi-entry <cli.js>
node test/harness/export-session.mjs --pi-entry <cli.js>
```

`run-boundary.sh` starts Pi through the `pi` command on the path. The Node scripts start Pi's bundled entry point, which is what the `pi` command runs, so they need that path explicitly.

Each run creates a new work directory with `mktemp -d` or `os.tmpdir()` and prints its path first. `PREFILL_HARNESS_WORK` (boundary script) or `--work` (Node scripts) selects another one. The work directory keeps session files, captured request bodies, RPC streams, process output and summaries. Session files record the working directory of the run, so keep work directories out of the repository and out of published material. The scripts do not delete them.

The exit status is 0 when every step ended as expected and 1 otherwise.

### Environment and credentials

Pi runs with `PI_CODING_AGENT_DIR` and `HOME` pointing into the work directory and with a minimal environment: only the variables Windows and Node need to start. Provider keys of the caller are not passed on. The agent directory gets a synthetic key for the built-in `anthropic` provider, and its endpoint is the loopback double. No external host is contacted. The harness does not read or change credential storage, provider configuration or request headers.

`/prefill use` and `/prefill status` are commands and do not call the model. Pi still needs a configured model to start, so those steps point the same provider at a loopback port with no listener.

### The double

`anthropic-double.mjs` answers `POST /v1/messages` with a text that names its request, `SYNTHETIC-REPLY from the local double (request NNN).`, as a stream or as one JSON message. Each reply is therefore distinct, and a summary written by the double can be traced to its request. The double records every request body, without headers, in the capture directory. `--hold-responses` records a request and never answers it. `--input-tokens N` makes the double report N input tokens in every usage; the default is 1. That number is synthetic: it feeds Pi's own cost and size logic and nothing else. The double is not a provider.

## Checks in detail

### Boundary (`run-boundary.sh`, `check-boundary.mjs`)

The checker reads one request and reports `pairState`, which says what starts the request: `complete` when both example texts are at their places, `altered` when exactly one is, and `absent` when neither is. A pair whose two texts both changed reads as `absent`, because the checker cannot tell it from another conversation. With `--messages N` the request must hold exactly N messages, so a duplicated pair or a message between the pair and the prompt fails. The positive capture of the first turn has three messages.

The negative controls now check the state, not only the exit status: the eligibility control and the revision control must report `absent`. The self-test (`selftest.mjs`) runs nine cases, among them a duplicated pair, a message between the pair and the prompt, an altered user text and a removed pair, and it checks each case's exit status and `pairState`.

### Compaction (`compaction.mjs`)

How it runs: Pi starts in RPC mode (`--mode rpc`) on a session file. The script sends `/prefill use`, five prompts of about 24 KB each, then the RPC command `compact`, then one more prompt, then `/prefill status`. Pi's default settings apply; the script does not change the keep budget.

Signal that the mechanism ran: the events `compaction_start` and `compaction_end` with `reason: manual` come from Pi's own `compact` command, and the session file holds one `compaction` entry whose `firstKeptEntryId` and `summary` equal the ones Pi reported. The summary Pi reports names the request that wrote it (`request NNN`). That number must be one of this compaction's summary requests, which the double received with no pair in them.

Signal that the summary travelled: the request after the compaction carries the whole summary text exactly once, after the pair. A control takes that summary out of a copy of the same request and requires the same check to fail.

What was observed (the recorded run): one summary request, which covers the first turn only; the summary names request 6; the request after the compaction carries the pair once in each role, then the summary, then the kept turns; the first turn is not sent again; `/prefill status` reports the same committed application; the session file never holds the pair. The application records (`intent`, `projected`, `committed`) are still in the session after the compaction.

What it does not show:
- The compaction was requested by hand. Automatic compaction, which runs when the context passes a threshold, was not exercised. The usage the double reports is synthetic, so the token figures in the output are not a measure of a real context.
- The summary is the double's text, which names its request. Its quality, and whether a real model reads the pair as an example, are not checked.
- The cut point lands on one of our records. Pi's cut search skips entries that carry no messages, and the `committed` record of an application has none. The record is then the first kept entry, and Pi makes the summary a split-turn summary (`No prior history. ... (split turn)`). The request after the compaction is still correct; see [projection.md](projection.md#limits). This is a documented limit, not a check that failed.
- Other cut positions, and a compaction of a session with several applications, were not run.

### Cache warming (`cache-warming.mjs`)

How it runs: Pi runs in RPC mode with `cacheWarming: "idle"` in the agent's `settings.json`, because the default `streaming` stops when the run settles. The double reports 300,000 input tokens. The script sends one prompt, waits until Pi records a `cache_warm` usage entry (about 270 s, which is 90 % of the 300 s short cache lifetime of `claude-sonnet-4-6` in Pi 1.1.0's catalog), sends `/prefill status`, then one more prompt. The observer extension `cache-decision-observer.mjs` is loaded with `-e` and writes every `cache_warming_decision` event Pi emits; it returns no action, so no decision changes.

Signal that the mechanism ran: the observer log holds one decision with `action: "warm"` at the moment the `cache_warm` entry is written; the second request the double received is Pi's refresh (`max_tokens: 1`, streamed) and repeats the request of the cache entry (three messages: pair, then the first prompt); `/prefill status` reports `refreshes: 1`. The number of decisions, refresh requests and `cache_warm` entries agree. The normal request after the refresh holds the pair once in each role, with five messages.

What was observed: the decision reached the extension system and carried Pi's own economics (`missCost` 1.035, `warmCost` 0.090015, `continuationProbability` 0.15). The refresh arrived about 270 s after the request. After the normal request that followed, the count stayed at one.

What it does not show:
- The economics are synthetic. For `claude-sonnet-4-6` with the catalog prices, Pi warms only when the last answer reports about 229,900 prompt tokens or more; the double reports 300,000 so that the decision is `warm`. This proves the mechanism, not what a real provider would charge or whether a real cache entry would be hit.
- The double is not a provider. It does not show that a cache entry was created or read.
- The branch "pending application → stop the refresh" is not distinguishable end to end on this host. Pi stops the refresh by itself when there is no usage on the branch, so the outcome is the same whether or not the extension answers `stop`. It is covered by a unit test instead (see [Unit tests](#unit-tests)).

### Export (`export-session.mjs`)

How it runs: a session with known state (`/prefill use`, two turns, `/prefill status`) is exported with `pi --export <session> <html>` and with the RPC command `export_html`. The HTML embeds the session entries as base64 JSON in `<script id="session-data">`. The script decodes that data and compares it with the session file.

Signal that the mechanism ran: both exports exit with status 0 and write a file that embeds the session data; the decoded entries equal the session file's entries, in order, with the same header and leaf; and the export left the session file unchanged (its digest is the same before and after).

Contract checked on the embedded data:
- the two real user turns are present, in order, with their texts (an exact list, so a missing or extra turn fails);
- the two assistant replies are present, each starting with the reply prefix, and they are distinct;
- the pair of the profile is in no entry; a control entry proves that the detector finds the pair when it is present;
- the application records reconstruct `intent,projected,committed` for one identifier, and the last status entry points at it;
- the selection record names the profile;
- no record holds profile text.

What was observed: all steps passed.

What it does not show:
- The rendered page is not checked. The static HTML holds no transcript: the page paints the transcript from the embedded block with JavaScript. The rendered view is a manual step below.
- The JSONL export is not covered; it is available only from the interactive terminal UI (see below).

### Branch navigation (`branch-navigation.mjs`)

How it runs: a real session against the local double. The script applies the profile on the first branch, navigates to another position of the same session through a disposable probe command that calls the navigation API Pi's own interface uses, and then navigates back. It never emits the session event itself and never restarts between branches.

```sh
node test/harness/branch-navigation.mjs --pi-entry <cli.js> [--work <dir>]
```

What it shows: three requests reach the double. The first branch carries the profile pair and the real prompt. The branch reached by navigating starts clean: no entry of the first branch travels into it, and it takes its own application on its own empty branch. Navigating back to the committed position recovers that branch once, with its own earlier turn and a single pair.

What it does not show: the terminal UI's tree picker keys. Navigation was driven through the public API the interface uses, in a real Pi process with the extension loaded, not by pressing keys in the tree view.

### Pending stop and pending block (unit tests)

`test/projection.test.ts` covers two consequences of a pending application, the state of a branch that was aborted after the projection and holds an intent and a projection but no commitment:
- «stops a refresh while no commitment exists»: `decideCacheWarming` returns `{ action: "stop" }`. The test first asserts that `describeApplication` reports `pending`.
- «keeps a branch with a pending application from starting a new one»: a later run on that branch sends no example and writes no record, and `/prefill status` keeps reporting the pending state. The branch stays pending: nothing clears it by time or by a restart. The status text says that no new application starts on the branch while it stays pending.

## Unit tests

Some behaviour is checked by unit tests only, because the checks cannot reach it end to end:
- the pending stop and the pending block (above);
- the eligibility judged at the start of the turn, separately from the freshness check: «judges a branch with a conversation as not eligible, even when the request holds only the prompt». Removing that defence makes the test fail, which was checked by a temporary mutation of the source;
- a model of another provider that speaks the Anthropic messages API is treated as not Anthropic (`selection-incompatible`);
- a departure from Anthropic is reported for a response to a request refused for the selection, as well as for a projected request.

## Manual steps

### Rendered export

The rendered page is not part of the automated check. Run these steps by hand:

1. Run `node test/harness/export-session.mjs --pi-entry <cli.js> --work <work>`. It leaves the command-line export at `<work>/export/cli-export.html`.
2. Open that file in a browser and wait until the page has painted the transcript.
3. Expected: two user messages, `SYNTHETIC-REAL-PROMPT: summarize the previous answer.` and `SYNTHETIC-REAL-PROMPT-2: summarize the previous answer again.`, each followed by an assistant message that starts with `SYNTHETIC-REPLY from the local double (request`.
4. Use the browser's find command (Ctrl+F) for `SYNTHETIC-USER-EXAMPLE` and for `SYNTHETIC-ASSISTANT-EXAMPLE`. Expected: 0 matches for each.
5. Observation, not an expectation: write down how the page shows the application and selection records (`pi-assistant-prefill.application`, `pi-assistant-prefill.selector`), or whether it hides them.

Not run for the recorded results below.

### JSONL export (interactive only, executed)

The command `/export <file>.jsonl` exists only in the interactive mode. Neither `pi --export` nor RPC runs it, and the automated suite does not run it. It was executed by hand on Windows through a pseudo-terminal, and these are the steps:

1. Start a session with the local double: point the isolated `models.json` at a running `anthropic-double.mjs`, set `PI_CODING_AGENT_DIR`, `HOME` and `USERPROFILE` inside a temporary directory, and start Pi in the terminal UI with the extension loaded:

   ```sh
   node <cli.js> --tui-mode regular -ne -e <repo>/src/index.ts -nc -ns -np --no-mcp --offline -na      --provider anthropic --model claude-sonnet-4-6 --session <work>/live.jsonl
   ```

2. Send one prompt, for example `SYNTHETIC-REAL-PROMPT: summarize the previous answer.`, and wait for the answer.
3. Type `/export <work>/session.jsonl` and press Enter. Expected notice: `Session exported to: <work>/session.jsonl`. Then type `/quit`.

Observed: the export file held nine entries, the same content as the live session file. The profile pair was absent, as the contract requires, and the three application records were present with the phases `intent`, `projected` and `committed` under `pi-assistant-prefill.application`. `serializeSessionBranch` rewrites the `parentId` values as a chain, so compare entry identifiers, types and our records, not `parentId`, against the live file.

### Terminal UI rendering

The dialog, its cancellation and the selection were checked in a real terminal UI on Windows through a pseudo-terminal: the dialog listed the profile and the disable entry with the host's navigation hints, Escape left no state, and Enter wrote the selection. Rendering was also checked under the `dark` and `light` themes, and the narrow layout held at the 80 columns the pseudo-terminal provides, with no line wider than the terminal.

Not verified: an explicit 120x35 layout, because the available pseudo-terminal cannot be resized, and colour fidelity, which the captured output does not preserve.

### Rendered export

The rendered page is not part of the automated check. Run these steps by hand:

1. Run `node test/harness/export-session.mjs --pi-entry <cli.js> --work <work>`. It leaves the command-line export at `<work>/export/cli-export.html`.
2. Open that file in a browser and wait until the page has painted the transcript.
3. Expected: two user messages, `SYNTHETIC-REAL-PROMPT: summarize the previous answer.` and `SYNTHETIC-REAL-PROMPT-2: summarize the previous answer again.`, each followed by an assistant message that starts with `SYNTHETIC-REPLY from the local double (request`.
4. Use the browser's find command (Ctrl+F) for `SYNTHETIC-USER-EXAMPLE` and for `SYNTHETIC-ASSISTANT-EXAMPLE`. Expected: 0 matches for each.
5. Observation, not an expectation: write down how the page shows the application and selection records (`pi-assistant-prefill.application`, `pi-assistant-prefill.selector`), or whether it hides them.

Not run for the recorded results below.

### JSONL export (interactive only)

The command `/export <file>.jsonl` exists only in the interactive mode. Neither `pi --export` nor RPC runs it, and the harness does not run it. Run these steps by hand, in a terminal:

1. Prepare the session and the agent directory with the export check. It leaves a known-state session and an agent directory with the synthetic profile and the synthetic endpoint:

   ```sh
   node test/harness/export-session.mjs --pi-entry <cli.js> --work <work>
   ```

   Expected: `RESULT: every step ended as expected`. The directories used below are `<work>/export/agent`, `<work>/export/home` and `<work>/export/session-known-state.jsonl`.

2. Copy the session. Do not open the known-state file itself, so that the check cannot change it:

   ```sh
   mkdir -p <work>/manual
   cp <work>/export/session-known-state.jsonl <work>/manual/session.jsonl
   ```

3. Start the interactive Pi with the synthetic agent directory. Set `PI_CODING_AGENT_DIR=<work>/export/agent`, `HOME=<work>/export/home` and `USERPROFILE=<work>/export/home`, then run:

   ```sh
   node <cli.js> -ne -e <repo>/src/index.ts -nc -ns -np --no-mcp --offline -na --session <work>/manual/session.jsonl --provider anthropic --model claude-sonnet-4-6
   ```

   Do not send a prompt. The endpoint in the agent directory points at a port with no listener.

4. In the terminal UI type `/export <work>/manual/export.jsonl` and press Enter. Expected notice: `Session exported to: <work>/manual/export.jsonl`. Then type `/quit`.

5. Check the file:
   - The first line is the header, with `"type":"session"`. The other lines are entries. There are 12 entries, as in the known-state session.
   - The ids of the entries, in order, equal the ids of `<work>/manual/session.jsonl` (its non-header lines). Compare ids and types; do not compare `parentId`. The export rewrites every `parentId` along the branch: `serializeSessionBranch` sets each entry's `parentId` to the id of the entry before it. The values therefore differ from the session file whenever the tree is not linear, and the comparison is not meaningful for them.
   - The application records are `intent`, `projected` and `committed` for one `applicationId`.
   - `grep -c "SYNTHETIC-USER-EXAMPLE" <work>/manual/export.jsonl` and the same for `SYNTHETIC-ASSISTANT-EXAMPLE` both print `0`.

A pass of these steps shows the JSONL route only for this session and this Pi version; it was not run for the recorded results below.

## What the checks do not show

- The double is not Anthropic. It answers with fixed text that names its request, so no check shows compatibility with a real provider, a real endpoint, a real credential or the authentication path, or that a model used the example.
- Boundary: it shows only what Pi sent to a loopback endpoint.
- Interruption: the kill points are the two above. No kill was placed between the persisted assistant message and the `committed` record, nor during other extensions' writes. On Windows, Pi's self-sent SIGKILL is seen by the parent as exit code 1, not as a signal; the after-commit check therefore relies on the marker written before the kill and on the process being gone.
- Atomicity: the stop points are process boundaries (before and after the rename call), not instants inside it. Power loss, operating-system crashes and the durability of the directory entry are not tested. Temporary files left by a killed write stay in the state directory; they are not read as the state.
- Compaction, cache warming and export: see the sections above.
- Pi 1.1.0 on Windows with Git Bash and Node.js 24.9.0 is the only environment run. Other Pi versions, platforms and shells were not checked.
- Each script ran once per recorded run. A pass does not give a rate or a statistical bound.

## Recorded results

Recorded on 2026-10-13 (local time) on Windows 10.0.26300, Git Bash, Node.js 24.9.0 and Pi 1.1.0, on the final code of this unit:

| Script or command | Steps | Result |
| --- | --- | --- |
| `npm run check` | 279 tests | Exit 0; 279 pass, 0 fail. |
| `run-boundary.sh` | 15 (the self-test step runs 9 cases) | All `ok`; exit 0. The eligibility and revision controls name `absent`. |
| `interruption.mjs` | 35 | All `ok`; exit 0. `before-commit` has 18 steps (the alive check applies only to a held response) and `after-commit` has 17. Both kills are verified. |
| `compaction.mjs` | 18 | All `ok`; exit 0. The summary is the reply of summary request 6; the next request carries it once, after the pair; the control fails when it is removed. |
| `cache-warming.mjs` | 19 | All `ok`; exit 0. The `cache_warm` entry was recorded 270 s after the first turn ended; one decision with action `warm`; `refreshes: 1`. |
| `export-session.mjs` | 16 | All `ok`; exit 0. The embedded data holds the two turns, the distinct replies and no pair. |
| `selection-atomicity.mjs` | 18 | Not run in this unit; the result of the previous recording stands: all `ok`. |
| JSONL export and rendered export (manual) | - | Not run. The steps are above. |
