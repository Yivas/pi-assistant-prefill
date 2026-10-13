// Interruption check around the commitment of a prefill application. Pi runs against the local
// double with a synthetic key, the host process is killed at a chosen point, and Pi is started
// again on the same session file. The check keeps the persisted session, the state that
// /prefill status reports for it, and the next request, and compares them with docs/projection.md.
// Manual check: it is not part of `npm run check` or `npm test`.
//
// Usage: node test/harness/interruption.mjs --pi-entry <Pi's dist/bundle/cli.js> [--work <directory>]
//
// Only Node.js built-in modules are used. Pi runs with PI_CODING_AGENT_DIR and HOME pointing into the
// work directory and with a minimal environment, so no inherited provider key reaches it.
// Exit status 0 means every expectation held.
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  HARNESS,
  MODEL,
  parseRunOptions,
  phasesOf,
  piArguments,
  piEnvironment,
  PROFILE_ID,
  readText,
  runBoundaryCheck,
  SELECTOR_ENTRY_TYPE,
  selectionIsProfile,
  Steps,
  sessionLines,
  snapshot,
  startDouble,
  waitUntil,
  writeLibrary,
  writeProfile,
  writeProviderEndpoint,
} from "./pi-process.mjs";

const PROMPT_FIRST = "SYNTHETIC-REAL-PROMPT: summarize the previous answer.";
const PROMPT_SECOND = "SYNTHETIC-REAL-PROMPT-2: summarize the previous answer again.";
const USAGE =
  "node test/harness/interruption.mjs --pi-entry <Pi's dist/bundle/cli.js> [--work <directory>]";

// What the session must hold, what /prefill status must report and what the next request must show,
// as docs/projection.md describes them.
// before-commit: the host is killed while the projected request waits for its response. The branch
// keeps an intent and a projection without a commitment, and a later run does not resume them.
// after-commit: the host ends right after the commitment record is written. A later run keeps the pair.
const SCENARIOS = {
  "before-commit": {
    holdFirstResponse: true,
    phases: "intent,projected",
    statusKind: "pending",
    nextRequest: "no-pair",
    nextMessages: 2,
  },
  "after-commit": {
    holdFirstResponse: false,
    phases: "intent,projected,committed",
    statusKind: "committed",
    nextRequest: "pair",
    nextMessages: 5,
  },
};

// One scenario, from profile selection to the second request. Returns the number of failed steps.
async function runScenario(name, scenario, work, piEntry) {
  const root = join(work, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const agent = join(root, "agent");
  const home = join(root, "home");
  const session = join(root, "session.jsonl");
  const reference = join(root, "reference", PROFILE_ID);
  const steps = new Steps(join(root, "summary.txt"));
  writeLibrary(agent);
  writeProfile(reference);
  mkdirSync(home, { recursive: true });
  const piContext = { piEntry, agent, home };

  // /prefill use sends no request, but Pi refuses to start without a configured model. The
  // placeholder endpoint is a loopback port with no listener, so nothing could be sent to it.
  writeProviderEndpoint(agent, 9);
  const use = await runPi({
    ...piContext,
    output: join(root, "use"),
    args: [
      "--provider",
      "anthropic",
      "--model",
      MODEL,
      "--no-session",
      `/prefill use ${PROFILE_ID}`,
    ],
  });
  steps.record(use.code === 0 && selectionIsProfile(agent), "/prefill use recorded brief-example");
  steps.record(!hasEvent(join(root, "use"), "agent_start"), "/prefill use started no agent turn");

  const first = await startLabeledDouble(root, "first", agent, {
    hold: scenario.holdFirstResponse,
  });
  const turnOutput = join(root, "turn1");
  const turn = startPi({
    ...piContext,
    output: turnOutput,
    args: turnArguments(session, PROMPT_FIRST),
    killOnCommit: !scenario.holdFirstResponse,
  });
  const reached = await waitUntil(() =>
    scenario.holdFirstResponse
      ? first.captured() >= 1 && phasesOf(session).includes("projected")
      : turn.finished() !== null,
  );
  steps.record(
    reached,
    `kill point reached (${scenario.holdFirstResponse ? "projected, response held" : "committed record written"})`,
  );
  if (scenario.holdFirstResponse) {
    const aliveAtKill = turn.finished() === null;
    steps.record(aliveAtKill, "host process was alive when the driver killed it");
    if (aliveAtKill) turn.child.kill("SIGKILL");
  }
  await turn.exited;
  await first.stop();
  steps.record(processIsGone(turn.child.pid), "the host process no longer exists after the kill");
  if (scenario.holdFirstResponse) {
    steps.record(
      turn.finished()?.signal === "SIGKILL",
      "the driver sent SIGKILL to the host process",
    );
  } else {
    steps.record(
      existsSync(`${turnOutput}.killed`),
      "the commitment write sent SIGKILL to the host (marker written before the kill)",
    );
  }
  steps.record(turn.finished() !== null, `host process ended (exit code ${turn.finished()?.code})`);
  steps.record(!hasEvent(turnOutput, "turn_end"), "host ended before turn_end was emitted");
  snapshot(session, join(root, "session-before-restart.jsonl"));
  steps.record(
    phasesOf(session) === scenario.phases,
    `session records before restart: ${scenario.phases}`,
  );

  const firstRequest = checkRequest(
    root,
    "first-request",
    first.capture,
    reference,
    "pair",
    PROMPT_FIRST,
    3,
  );
  steps.record(
    firstRequest.status === 0,
    "first request, sent before the kill, starts with the pair",
  );

  const statusBefore = await statusKindOf(root, "before-restart", { ...piContext, session });
  steps.record(
    !hasEvent(join(root, "status-before-restart"), "agent_start"),
    "/prefill status started no agent turn",
  );
  steps.record(
    statusBefore === scenario.statusKind,
    `/prefill status before restart reports ${scenario.statusKind}`,
  );

  const second = await startLabeledDouble(root, "second", agent, { hold: false });
  const restart = await runPi({
    ...piContext,
    output: join(root, "turn2"),
    args: turnArguments(session, PROMPT_SECOND),
  });
  await second.stop();
  steps.record(
    restart.code === 0 && replyCount(join(root, "turn2.jsonl")) > 0,
    "restart: Pi completed a turn on the same session",
  );
  snapshot(session, join(root, "session-after-restart.jsonl"));

  const nextRequest = checkRequest(
    root,
    "next-request",
    second.capture,
    reference,
    scenario.nextRequest,
    PROMPT_SECOND,
    scenario.nextMessages,
  );
  steps.record(nextRequest.status === 0, `next request after restart: ${scenario.nextRequest}`);
  steps.record(
    phasesOf(session) === scenario.phases,
    `session records after restart: ${scenario.phases}`,
  );
  steps.record(sessionLines(session).unparsed === 0, "session file holds only complete JSON lines");

  const statusAfter = await statusKindOf(root, "after-restart", { ...piContext, session });
  steps.record(
    !hasEvent(join(root, "status-after-restart"), "agent_start"),
    "/prefill status (after restart) started no agent turn",
  );
  steps.record(
    statusAfter === scenario.statusKind,
    `/prefill status after restart reports ${scenario.statusKind}`,
  );
  return steps.failures;
}

function turnArguments(session, prompt) {
  return ["--session", session, "--provider", "anthropic", "--model", MODEL, prompt];
}

// Starts Pi in JSON print mode with the prefill extension loaded from the repository source.
// Output goes to files, so the evidence stays exactly as Pi wrote it. With killOnCommit, the
// preload kill-on-commit.mjs is loaded before Pi's entry point.
function startPi({ piEntry, agent, home, output, args, killOnCommit = false }) {
  const stdout = openSync(`${output}.jsonl`, "w");
  const stderr = openSync(`${output}.err`, "w");
  const preload = killOnCommit
    ? ["--import", pathToFileURL(join(HARNESS, "kill-on-commit.mjs")).href]
    : [];
  const child = spawn(
    process.execPath,
    [...preload, piEntry, "--mode", "json", "-p", ...piArguments(), ...args],
    {
      env: killOnCommit
        ? { ...piEnvironment(agent, home), PREFILL_HARNESS_KILL_MARKER: `${output}.killed` }
        : piEnvironment(agent, home),
      stdio: ["ignore", stdout, stderr],
      windowsHide: true,
    },
  );
  let finished = null;
  const exited = once(child, "exit").then(([code, signal]) => {
    finished = { code, signal };
    closeSync(stdout);
    closeSync(stderr);
    return finished;
  });
  return { child, exited, finished: () => finished };
}

async function runPi(options) {
  return startPi(options).exited;
}

// Starts the double of this scenario step and points the synthetic provider at it.
async function startLabeledDouble(root, label, agent, { hold }) {
  const double = await startDouble({ captureDirectory: join(root, `capture-${label}`), hold });
  writeProviderEndpoint(agent, double.port);
  return double;
}

// True when Pi's JSON output for a run contains an event of that type.
function hasEvent(outputFile, type) {
  return readText(`${outputFile}.jsonl`)
    .split("\n")
    .some((line) => {
      try {
        return JSON.parse(line).type === type;
      } catch {
        return false;
      }
    });
}

function replyCount(outputFile) {
  return (readText(outputFile).match(/SYNTHETIC-REPLY from the local double/g) ?? []).length;
}

// Runs /prefill status on a copy of the session, so the status command never changes the session
// the scenario continues from. Returns the application state the command recorded: "pending",
// "committed" or "none". The rendered text is shown only in the terminal UI, so the recorded
// status entry is the observable result.
async function statusKindOf(root, label, { piEntry, agent, home, session }) {
  const copy = join(root, `status-${label}.session.jsonl`);
  snapshot(session, copy);
  await runPi({
    piEntry,
    agent,
    home,
    output: join(root, `status-${label}`),
    args: ["--session", copy, "/prefill status"],
  });
  const statusEntries = sessionLines(copy).entries.filter(
    (entry) => entry.type === "custom" && entry.customType === SELECTOR_ENTRY_TYPE,
  );
  const latest = statusEntries.at(-1)?.data;
  return latest?.application?.kind ?? "none";
}

// True when no process has the pid. Signal 0 only tests for the process; a missing one throws ESRCH.
function processIsGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

// Compares the captured request with the reference profile. The checker exits 0 when the observed
// request matches the expectation, 1 when it does not, and 2 when the capture cannot be read.
function checkRequest(root, label, captureDirectory, reference, expectation, prompt, messages) {
  const result = runBoundaryCheck({
    captures: captureDirectory,
    profile: reference,
    prompt,
    expect: expectation,
    messages,
  });
  writeFileSync(join(root, `check-${label}.json`), result.stdout);
  return { status: result.status };
}

const options = parseRunOptions(process.argv.slice(2), USAGE);
const work = options.work ?? mkdtempSync(join(tmpdir(), "pi-prefill-interruption-"));
console.log(`work directory: ${work}`);

let failures = 0;
for (const [name, scenario] of Object.entries(SCENARIOS)) {
  failures += await runScenario(name, scenario, work, options.piEntry);
}
console.log(
  failures === 0
    ? "RESULT: every step ended as expected"
    : "RESULT: at least one step did not end as expected",
);
process.exit(failures === 0 ? 0 : 1);
