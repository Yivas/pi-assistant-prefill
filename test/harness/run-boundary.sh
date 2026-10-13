#!/usr/bin/env bash
# Outbound-boundary check of the first projected request, run against the installed Pi 1.1.0 with
# the prefill extension. Manual only: it is not part of `npm run check` or `npm test`.
# Usage: test/harness/run-boundary.sh [repository-root]
#
# Everything is written under a work directory created with mktemp -d, or under
# PREFILL_HARNESS_WORK when it is set. Pi runs with PI_CODING_AGENT_DIR pointing into that
# directory, with a synthetic provider key and a local double on 127.0.0.1. No real credential is
# read or sent, and no network beyond loopback is used. The script exits 0 only when every step
# ends as expected.
set -u
export MSYS_NO_PATHCONV=1

# Windows programs need a native path under Git Bash. Other systems use the path unchanged.
native_path() { # path
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

HARNESS="$(native_path "$(cd "$(dirname "$0")" && pwd)")"
REPOSITORY="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
WORK="$(native_path "${PREFILL_HARNESS_WORK:-$(mktemp -d)}")"
RUN="$WORK/run"
HOME_DIR="$WORK/home"
SOURCE="$(native_path "$REPOSITORY/src/index.ts")"
SYNTHETIC_KEY="synthetic-key-not-a-real-credential"
MODEL="claude-sonnet-4-6"
PROMPT_FIRST="SYNTHETIC-REAL-PROMPT: summarize the previous answer."
PROMPT_SECOND="SYNTHETIC-REAL-PROMPT-2: summarize the previous answer again."
PRISTINE_AGENT="$RUN/pristine-agent"
PRISTINE_LIBRARY="$PRISTINE_AGENT/prefills/brief-example"
DOUBLE_PID=""
FAILED=0

record() { # status name detail
  printf '%-4s %s: %s\n' "$1" "$2" "$3" | tee -a "$RUN/summary.txt"
  [ "$1" = "ok" ] || FAILED=1
}

# Runs Pi with the isolated agent directory. Pi gets a minimal environment, so no provider key from
# the caller reaches it. Every argument after the agent directory goes to Pi.
pi_cli() {
  local agent="$1"
  shift
  # MSYS_NO_PATHCONV must reach Pi as well: without it Git Bash rewrites "/prefill" into a Windows
  # path, and Pi then sends that text to the model as an ordinary prompt.
  env -i PATH="$PATH" SYSTEMROOT="${SYSTEMROOT:-}" TEMP="${TEMP:-}" TMP="${TMP:-}" MSYS_NO_PATHCONV=1 \
    PI_CODING_AGENT_DIR="$agent" HOME="$HOME_DIR" USERPROFILE="$HOME_DIR" \
    NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
    pi --mode json -p -ne -e "$SOURCE" -nc -ns -np --no-mcp --offline -na "$@"
}

# Starts the double, waits for its port, and points the synthetic provider at it. The provider entry
# only overrides the endpoint and the key of the built-in anthropic provider inside this agent directory.
start_double() { # capture-dir agent-dir
  local capture="$1" agent="$2" portFile="$1.port"
  node "$HARNESS/anthropic-double.mjs" --capture-dir "$capture" --port-file "$portFile" \
    > "$capture.double.log" 2>&1 &
  DOUBLE_PID=$!
  local waited=0
  until [ -s "$portFile" ] || [ "$waited" -ge 50 ]; do
    sleep 0.2
    waited=$((waited + 1))
  done
  [ -s "$portFile" ] || return 1
  printf '%s' "{\"providers\":{\"anthropic\":{\"baseUrl\":\"http://127.0.0.1:$(cat "$portFile")\",\"apiKey\":\"$SYNTHETIC_KEY\"}}}" > "$agent/models.json"
}

stop_double() {
  [ -n "$DOUBLE_PID" ] || return 0
  kill "$DOUBLE_PID" 2>/dev/null
  wait "$DOUBLE_PID" 2>/dev/null
  DOUBLE_PID=""
}

trap stop_double EXIT

tree_hash() { # directory: content hash of every file, by relative path
  (cd "$1" && find . -type f | LC_ALL=C sort | xargs sha256sum)
}

copy_agent() { # scenario -> prints agent directory
  local agent="$RUN/$1/agent"
  mkdir -p "$RUN/$1"
  cp -r "$PRISTINE_AGENT" "$agent"
  printf '%s' "$agent"
}

# /prefill use sends no request, but Pi refuses to start without a configured model. The endpoint of
# this placeholder is a loopback port with no listener, so nothing could be sent to it.
select_profile() { # agent scenario
  printf '%s' "{\"providers\":{\"anthropic\":{\"baseUrl\":\"http://127.0.0.1:9\",\"apiKey\":\"$SYNTHETIC_KEY\"}}}" > "$1/models.json"
  pi_cli "$1" --provider anthropic --model "$MODEL" --no-session "/prefill use brief-example" > "$2/use.jsonl" 2> "$2/use.err"
  if grep -q '"agent_start"' "$2/use.jsonl"; then
    record fail "$(basename "$2")" "/prefill use started an agent turn"
  else
    record ok "$(basename "$2")" "/prefill use started no agent turn"
  fi
}

# One turn through Pi against a fresh double. Output, captures and exit status stay in the scenario.
run_turn() { # agent scenario label prompt
  local agent="$1" scenario="$2" label="$3" prompt="$4"
  start_double "$scenario/capture-$label" "$agent" || return 1
  pi_cli "$agent" --session "$scenario/session.jsonl" --provider anthropic --model "$MODEL" "$prompt" \
    > "$scenario/$label.jsonl" 2> "$scenario/$label.err"
  local status=$?
  stop_double
  return $status
}

# The reference is always the pristine profile, so a control that changes its copy cannot hide a mismatch.
check_turn() { # scenario label prompt expect [messages]
  local count_args=()
  [ -n "${5:-}" ] && count_args=(--messages "$5")
  node "$HARNESS/check-boundary.mjs" --captures "$1/capture-$2" --profile "$PRISTINE_LIBRARY" \
    --prompt "$3" --expect "$4" "${count_args[@]}" > "$1/check-$2.json"
}

# The pairState the checker recorded for a check: complete, altered or absent.
pair_state() { # check-file
  node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).pairState ?? "")' "$1"
}

selection_is_profile() { # agent-dir: the recorded choice names brief-example and is not off
  node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.exit(s.schemaVersion === 1 && s.profileId === "brief-example" && s.disabled === false ? 0 : 1);' \
    "$1/pi-assistant-prefill/selection.json"
}

phases_of() { # scenario -> comma list of record types, with the phase or reason
  node "$HARNESS/summarize-session.mjs" "$1/session.jsonl" | node -e '
    const { records } = JSON.parse(require("fs").readFileSync(0, "utf8"));
    process.stdout.write(records.map((r) => (r.phase ?? `${r.type}:${r.reason}`)).join(","));'
}

replies_in() { # output file: count of the synthetic reply text
  grep -o 'SYNTHETIC-REPLY from the local double' "$1" | wc -l | tr -d ' '
}

echo "work directory: $WORK"
rm -rf "$RUN"
mkdir -p "$RUN" "$HOME_DIR"
: > "$RUN/summary.txt"

# Pristine synthetic library: one valid profile and a configuration without default.
mkdir -p "$PRISTINE_LIBRARY"
printf '%s' '{"schemaVersion":1,"id":"brief-example","name":"Synthetic brief example","description":"Synthetic example for the boundary check"}' > "$PRISTINE_LIBRARY/profile.json"
printf '%s' 'SYNTHETIC-USER-EXAMPLE: what is a list?' > "$PRISTINE_LIBRARY/user.md"
printf '%s' $'SYNTHETIC-ASSISTANT-EXAMPLE: a list stores ordered items.\n\nFor example: items = [1, 2].' > "$PRISTINE_LIBRARY/assistant.md"
printf '%s' '{"schemaVersion":1,"defaultProfileId":null}' > "$PRISTINE_AGENT/prefills/config.json"

# Scenario 1: the positive case. The request must begin with the profile pair.
POSITIVE="$RUN/positive"
AGENT="$(copy_agent positive)"
if [ -e "$AGENT/pi-assistant-prefill/selection.json" ]; then
  record fail positive "selection already present before /prefill use"
fi
LIBRARY_BEFORE="$(tree_hash "$AGENT/prefills")"
select_profile "$AGENT" "$POSITIVE"
if [ $? -eq 0 ] && selection_is_profile "$AGENT"; then
  record ok positive "/prefill use recorded brief-example"
else
  record fail positive "/prefill use did not record the selection"
fi
SELECTION_AFTER_USE="$(sha256sum "$AGENT/pi-assistant-prefill/selection.json")"

run_turn "$AGENT" "$POSITIVE" turn1 "$PROMPT_FIRST"
if [ $? -eq 0 ] && [ "$(replies_in "$POSITIVE/turn1.jsonl")" -gt 0 ]; then
  record ok positive "Pi completed one turn with the double's reply"
else
  record fail positive "turn did not complete through the double"
fi
check_turn "$POSITIVE" turn1 "$PROMPT_FIRST" pair 3
if [ $? -eq 0 ]; then record ok positive "captured request starts with the profile pair; last message is the prompt"; else record fail positive "captured request does not match the pair expectation"; fi
[ "$(tree_hash "$AGENT/prefills")" = "$LIBRARY_BEFORE" ] \
  && record ok positive "library and config.json unchanged by the turn and the use step" \
  || record fail positive "library or config.json changed"
[ "$(sha256sum "$AGENT/pi-assistant-prefill/selection.json")" = "$SELECTION_AFTER_USE" ] \
  && record ok positive "selection unchanged by the turn" \
  || record fail positive "selection changed during the turn"
[ "$(phases_of "$POSITIVE")" = "intent,projected,committed" ] \
  && record ok positive "session records intent, projected, committed" \
  || record fail positive "unexpected session records: $(phases_of "$POSITIVE")"

# Scenario 2: negative control, eligibility. The branch already holds a conversation when the
# selection is recorded, so the pair must not appear. The sanity turn without selection must not show it either.
NO_SELECTION="$RUN/neg-eligibility"
AGENT="$(copy_agent neg-eligibility)"
run_turn "$AGENT" "$NO_SELECTION" turn1 "$PROMPT_FIRST"
check_turn "$NO_SELECTION" turn1 "$PROMPT_FIRST" no-pair
[ $? -eq 0 ] && record ok neg-eligibility "no selection: no pair in the first request" \
  || record fail neg-eligibility "pair present without a selection"
select_profile "$AGENT" "$NO_SELECTION"
run_turn "$AGENT" "$NO_SELECTION" turn2 "$PROMPT_SECOND"
check_turn "$NO_SELECTION" turn2 "$PROMPT_SECOND" pair
if [ $? -eq 1 ] && [ "$(pair_state "$NO_SELECTION/check-turn2.json")" = "absent" ]; then
  record ok neg-eligibility "control fails as expected: pair absent in a branch with conversation"
else
  record fail neg-eligibility "control did not fail: the pair check accepted a branch with conversation"
fi

# Scenario 3: negative control, revision. The profile changes between two requests of one session.
# The change is made in this scenario's copy only, never in the positive library.
REVISION="$RUN/neg-revision"
AGENT="$(copy_agent neg-revision)"
select_profile "$AGENT" "$REVISION"
run_turn "$AGENT" "$REVISION" turn1 "$PROMPT_FIRST"
check_turn "$REVISION" turn1 "$PROMPT_FIRST" pair 3
[ $? -eq 0 ] && record ok neg-revision "first request carries the pair" \
  || record fail neg-revision "first request does not carry the pair"
printf '%s' 'SYNTHETIC-USER-EXAMPLE CHANGED: what is a list?' > "$AGENT/prefills/brief-example/user.md"
run_turn "$AGENT" "$REVISION" turn2 "$PROMPT_SECOND"
check_turn "$REVISION" turn2 "$PROMPT_SECOND" pair
if [ $? -eq 1 ] && [ "$(pair_state "$REVISION/check-turn2.json")" = "absent" ]; then
  record ok neg-revision "control fails as expected: pair absent after a revision change"
else
  record fail neg-revision "control did not fail: the pair check accepted a changed revision"
fi
[ "$(phases_of "$REVISION")" = "intent,projected,committed,diagnostic:revision-mismatch" ] \
  && record ok neg-revision "session records the revision-mismatch diagnostic" \
  || record fail neg-revision "unexpected session records: $(phases_of "$REVISION")"

# Checker self-test on the positive capture: each altered body must be rejected.
node "$HARNESS/selftest.mjs" "$POSITIVE/capture-turn1/request-001.body" "$PRISTINE_LIBRARY" "$PROMPT_FIRST" "$RUN/selftest" \
  > "$RUN/selftest.txt"
[ $? -eq 0 ] && record ok selftest "checker accepts the untouched body and rejects each altered one" \
  || record fail selftest "checker self-test mismatch (see $RUN/selftest.txt)"

if [ "$FAILED" -eq 0 ]; then
  echo "RESULT: every step ended as expected"
else
  echo "RESULT: at least one step did not end as expected"
fi
exit "$FAILED"
