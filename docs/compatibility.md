# Compatibility and verification status

This page records what has actually been checked, with what, and what remains unproven. It is written so a reader can tell a demonstrated behaviour from an untested assumption.

## Environment

| Item | Value |
| --- | --- |
| Pi | 1.1.0, installed from npm |
| Node.js | 24.9.0 |
| Platform | Windows 10.0.26300, Git Bash for the shell scripts |
| Providers | None. All checks use the manual harness with a local double, or no provider at all |
| Credentials | None. No real key is read, written or sent |

No other Pi version, Node version, platform or model provider has been checked. Nothing here shows how a real model provider responds.

## How each kind of evidence was produced

- **Automated suite.** `npm run check` runs formatting, lint, type checking and the tests. It uses a simulated host and temporary directories, and never starts Pi.
- **Manual harness.** `test/harness/` starts the installed Pi against a local HTTP double that speaks the Anthropic messages protocol, with a synthetic key and an isolated agent directory. It is not part of `npm run check`. See [verification-harness.md](verification-harness.md).
- **Isolated manual runs.** Pi started with `-ne -e <extension> -nc -ns -np --no-mcp --offline -na`, `PI_CODING_AGENT_DIR` in a temporary directory, and no provider configured.

## Matrix

| Case | Status | Evidence |
| --- | --- | --- |
| New eligible session | Passed | Harness boundary check: the captured request carries the profile pair first and the real prompt last |
| Second and later requests of the same branch | Passed | Harness boundary check over two turns; the pair appears once per request |
| Resume, branch navigation and reload | Passed | Interruption harness restarts a session and reads back its state; unit tests cover branch state derived per branch |
| Disable by variable and by command, before and after applying | Passed | Unit tests for the variable precedence and the command; that disabling does not retract what was already sent is a documented statement, not a test |
| Future selection while another profile is applied | Passed | Unit tests: the applied profile stays, the new choice waits |
| Edit or delete the applied profile and reload the catalog | Passed | Harness negative control: the pair disappears and a `revision-mismatch` diagnostic is written |
| New session in the same process | Passed | Unit tests for state keyed by branch, not by process or session |
| Unsupported destination and virtual selection | Passed | Unit tests: incompatible state, no projection, reason reported. The dispatched destination still cannot be read before sending |
| Model or provider change before and after applying | Passed | Unit tests for both orders. A real cross-provider change was not exercised |
| Invalid input (absent, empty, future version, oversized, escape sequences) | Passed | Existing profile and configuration tests |
| Retry and abort | Passed | Interruption harness kills the process on both sides of the commitment and checks the session afterwards |
| Literal text | Passed | Profile tests keep bodies literal; presentation escaping has its own tests |
| Coexistence with Prompt Profiles 0.9.1 | Passed at command level | Both extensions loaded in one isolated Pi; `get_commands` lists `sp` and `prefill` with no error. Visual coexistence in the terminal UI was not checked |
| Coexistence with real authentication (OAuth) | Not run | No credential is used anywhere in this project. Recipe below |
| Interface modes | Passed for RPC, JSON and text; partial for the terminal UI | The command was exercised in the three non-interactive modes. In the terminal UI the dialog, cancellation and selection were checked; resizing to 80x24 and 120x35 and switching themes were not |
| Cache and compaction | Passed | Harness compaction check: a real compaction runs, the pair survives once, the records survive |
| Cache warming | Passed, with a limit | Harness warming check: a real warm decision, the `cache_warm` entry and a refresh request. The economics are synthetic, so it shows the mechanism and not the cost; the pending-stop branch is only observable in a unit test |
| Privacy | Passed | Status and debug output carry sizes, identifiers and counts, never profile texts; session export reconstructs the records from embedded data |
| Context files | Passed, and the control matters | With `--no-context-files` a marker in an ancestor `AGENTS.md` does not reach the request. Without that flag it does reach it even with project trust not granted, so the flag is the control, not trust |
| Real provider response | Not run | No provider call was made. Recipe below |

## Not demonstrated

- Any behaviour against a real model provider, including whether it accepts the request and how caching behaves.
- Automatic compaction triggered by a threshold; the compaction checks trigger it explicitly.
- Cache warming with real cost, cache hits, or the branch that stops a refresh while an application is pending.
- Other platforms, Node versions or Pi versions.
- The statically rendered export page and the interactive-only JSONL export.
- Terminal UI resizing and themes.

## Recipe for a real provider check

This step spends the operator's quota and uses the host's own authentication. It needs explicit approval, an exact model and provider, disabled tools, a cost and time limit, a maximum number of requests, and an isolated session.

```sh
PI_CODING_AGENT_DIR=<temporary directory> \
  pi -ne -e <repository>/src/index.ts -nc -ns -np --no-mcp -na \
  --provider <provider> --model <model> \
  --session <temporary session> "<one short benign prompt>"
```

Expected, and to be recorded as a sanitized conclusion only: the session starts, one request is sent, the answer arrives, and the recorded state says the application was committed. No contention about the provider's acceptance of the pair may be claimed from the local harness: it only proves what the double received.
