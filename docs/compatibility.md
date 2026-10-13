# Compatibility and verification status

This page records what has actually been checked, with what, and what remains unproven. It is written so a reader can tell a demonstrated behaviour from an untested assumption.

## Environment

| Item | Value |
| --- | --- |
| Pi | 1.1.0, installed from npm |
| Node.js | 24.9.0 |
| Platform | Windows 10.0.26300 with Git Bash for the manual checks. The automated suite also runs in GitHub Actions on `ubuntu-latest` and `windows-latest` |
| Providers | None. All checks use the manual harness with a local double, or no provider at all |
| Credentials | None. No real key is read, written or sent |

No other Pi version, Node version or model provider has been checked. The manual checks were run on Windows only; the automated suite also passes on Linux in continuous integration. Nothing here shows how a real model provider responds.

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
| Interface modes | Passed, with one layout gap | The command was exercised in RPC, JSON and text. In the terminal UI the dialog, cancellation and selection were checked, the narrow layout held at the 80 columns the pseudo-terminal provides, and the dialog rendered under the `dark` and `light` themes. An explicit 120x35 layout was not produced and colour fidelity was not judged |
| JSONL session export | Passed | Driven by hand in the terminal UI through a pseudo-terminal: the exported file held the same entries as the live session, the profile pair was absent and the application records were present |
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
- The statically rendered export page; the JSONL export itself was verified by hand.
- An explicit 120x35 terminal layout and colour fidelity.

## Published channel

The npm package `pi-assistant-prefill` is published at 0.1.0, and the tarball served by the registry is byte for byte the artifact frozen before publication (`sha256 b75ac3519fba22ab8cc51124d4c360725d4e6c9e932ed26fe68572f8f88b134c`). The GitHub release `v0.1.0` points at commit `be6415a`. Installing it was checked in an isolated agent directory; nothing about a provider was checked through that channel.

An earlier placeholder version, `0.0.0-stage`, was published while preparing the release and is no longer `latest`. It contains no extension and no licence field, and it is not the artifact described here.

## Recipe for a real provider check

This step spends the operator's quota and uses the host's own authentication. It needs explicit approval, an exact model and provider, disabled tools, a cost and time limit, a maximum number of requests, and an isolated session.

```sh
PI_CODING_AGENT_DIR=<temporary directory> \
  pi -ne -e <repository>/src/index.ts -nc -ns -np --no-mcp -na \
  --provider <provider> --model <model> \
  --session <temporary session> "<one short benign prompt>"
```

Limits to agree before that call, proposed as defaults:

- one request and no retries;
- tools disabled for the run;
- cache warming off, set only in the temporary agent directory and never in the operator's settings;
- one short benign prompt that asks for a short answer, so cost stays inside the agreed bound;
- a per-request timeout and a total limit for the run;
- the session and the agent directory inside a temporary directory, and the provider's own credentials used only through the host mechanism, never copied;
- only the sanitized conclusion is recorded: whether the session started, whether one answer arrived, and what the recorded state says. Error text, headers and payloads are not kept.

Expected: the session starts, one request is sent, the answer arrives, and the recorded state says the application was committed. The local harness cannot be used to claim that a provider accepted the pair: it only proves what the double received.
