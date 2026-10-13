// Atomicity check of the selection state (selection.json) with the host process killed during a
// replacement. Each interruption is followed by a read from a new process, which is how a restart
// sees the state. Expected: the previous state in full or the new state in full, never a partial or
// missing file, and a leftover temporary file never read as the state.
// Manual check: it is not part of `npm run check` or `npm test`. Only Node.js built-in modules are
// used, plus the product's selection module through selection-child.mjs.
//
// Usage: node test/harness/selection-atomicity.mjs [--work <directory>] [--random-rounds <count>]
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HARNESS = import.meta.dirname;
const CHILD = join(HARNESS, "selection-child.mjs");
const STATE_FILE = "selection.json";
const OFF_STATE = '{\n  "schemaVersion": 1,\n  "profileId": null,\n  "disabled": true\n}\n';
const PROFILE_STATE =
  '{\n  "schemaVersion": 1,\n  "profileId": "brief-example",\n  "disabled": false\n}\n';
const POINT_TIMEOUT_MS = 20_000;
const POLL_MS = 5;
const LOOP_ITERATIONS = 400;

class Steps {
  failures = 0;
  constructor(summaryPath) {
    this.summaryPath = summaryPath;
    writeFileSync(summaryPath, "");
  }
  record(ok, detail) {
    const line = `${ok ? "ok  " : "FAIL"} ${detail}`;
    console.log(line);
    writeFileSync(this.summaryPath, `${line}\n`, { flag: "a" });
    if (!ok) this.failures += 1;
  }
}

function parseOptions(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) values[argv[index]] = argv[index + 1];
  const randomRounds =
    values["--random-rounds"] === undefined ? 25 : Number(values["--random-rounds"]);
  if (!Number.isInteger(randomRounds) || randomRounds < 1) {
    console.error("--random-rounds must be a positive integer");
    process.exit(2);
  }
  return { work: values["--work"], randomRounds };
}

// Runs one child to its end and returns its exit code and the JSON line it printed.
async function runChild(args) {
  const child = spawn(process.execPath, [CHILD, ...args], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  const [code] = await once(child, "exit");
  const lastLine = stdout.trim().split("\n").at(-1);
  return { code, value: lastLine ? JSON.parse(lastLine) : null };
}

// Starts a replacement that waits at a stop point, waits for that point, and kills the process.
async function killedAt(stateDirectory, controlDirectory, point) {
  mkdirSync(controlDirectory, { recursive: true });
  const child = spawn(
    process.execPath,
    [
      CHILD,
      "save",
      "--state-dir",
      stateDirectory,
      "--choice",
      "profile",
      "--stop-at",
      point,
      "--control",
      controlDirectory,
    ],
    { stdio: ["ignore", "ignore", "ignore"], windowsHide: true },
  );
  const reached = await waitFor(() => readText(join(controlDirectory, "reached")) === point);
  const aliveAtKill = child.exitCode === null && child.signalCode === null;
  if (aliveAtKill) child.kill("SIGKILL");
  await once(child, "exit");
  return { reached, aliveAtKill };
}

async function waitFor(predicate) {
  const deadline = Date.now() + POINT_TIMEOUT_MS;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_MS));
  }
  return true;
}

function readText(file) {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

// Files in a state directory other than selection.json, i.e. temporary files of writes.
function temporaryFiles(stateDirectory) {
  return readdirSync(stateDirectory).filter((name) => name !== STATE_FILE);
}

// A read from a new process: the status and the choice kind (off, profile or unset). Every raw
// result is also appended to reads.jsonl in the work directory.
let readLogFile = null;

async function readAfterRestart(stateDirectory) {
  const { code, value } = await runChild(["read", "--state-dir", stateDirectory]);
  appendFileSync(readLogFile, `${JSON.stringify({ stateDirectory, code, value })}\n`);
  return { code, status: value?.status ?? "no-output", kind: value?.choice?.kind ?? null };
}

async function interruptReplacement(steps, stateRoot, point) {
  const stateDirectory = join(stateRoot, point, "pi-assistant-prefill");
  const previous = await runChild(["save", "--state-dir", stateDirectory, "--choice", "off"]);
  steps.record(
    previous.value?.status === "saved",
    `${point}: previous valid state saved by the product`,
  );

  const killed = await killedAt(stateDirectory, join(stateRoot, point, "control"), point);
  steps.record(
    killed.reached && killed.aliveAtKill,
    `${point}: process killed while it waited at that point`,
  );

  const leftovers = temporaryFiles(stateDirectory);
  const leftover =
    leftovers.length === 1 ? readFileSync(join(stateDirectory, leftovers[0]), "utf8") : null;
  const read = await readAfterRestart(stateDirectory);
  if (point === "after-rename") {
    steps.record(
      read.status === "loaded" && read.kind === "profile" && leftovers.length === 0,
      `${point}: restart reads the new state in full and no temporary file is left`,
    );
  } else {
    const isPartial = point === "during-write";
    const leftoverMatches =
      leftover !== null &&
      (isPartial
        ? leftover.length < PROFILE_STATE.length && PROFILE_STATE.startsWith(leftover)
        : leftover === PROFILE_STATE);
    steps.record(
      read.status === "loaded" && read.kind === "off" && leftoverMatches,
      `${point}: restart reads the previous state in full; the temporary file holds ${isPartial ? "a partial new state" : "the complete new state"}`,
    );
  }

  const next = await runChild(["save", "--state-dir", stateDirectory, "--choice", "off"]);
  const afterNext = await readAfterRestart(stateDirectory);
  steps.record(
    next.value?.status === "saved" && afterNext.status === "loaded" && afterNext.kind === "off",
    `${point}: a later save succeeds and reads back (temporary files still present: ${temporaryFiles(stateDirectory).length})`,
  );
}

// Only a temporary file, with no state file: the reading is unset, not the temporary content.
async function orphanOnly(steps, stateRoot) {
  const stateDirectory = join(stateRoot, "orphan-only", "pi-assistant-prefill");
  mkdirSync(stateDirectory, { recursive: true });
  writeFileSync(
    join(stateDirectory, `${STATE_FILE}.0a1b2c3d-0000-4000-8000-000000000000.tmp`),
    PROFILE_STATE,
  );
  const read = await readAfterRestart(stateDirectory);
  steps.record(
    read.status === "loaded" && read.kind === "unset",
    `orphan only: a temporary file with no state reads as no choice (${read.status}, ${read.kind})`,
  );
}

// Temporary files with different and unreadable content beside a valid state.
async function orphanBesideState(steps, stateRoot) {
  const stateDirectory = join(stateRoot, "orphan-beside", "pi-assistant-prefill");
  mkdirSync(stateDirectory, { recursive: true });
  writeFileSync(join(stateDirectory, STATE_FILE), OFF_STATE);
  writeFileSync(
    join(stateDirectory, `${STATE_FILE}.0a1b2c3d-0000-4000-8000-000000000001.tmp`),
    "{ not json",
  );
  writeFileSync(
    join(stateDirectory, `${STATE_FILE}.0a1b2c3d-0000-4000-8000-000000000002.tmp`),
    PROFILE_STATE,
  );
  const read = await readAfterRestart(stateDirectory);
  steps.record(
    read.status === "loaded" && read.kind === "off",
    `orphan beside state: the reading uses selection.json only (${read.status}, ${read.kind})`,
  );
}

// One round: a valid previous state, a loop of replacements, a kill at a random time, a read.
async function randomInterruption(stateRoot, round, tally) {
  const stateDirectory = join(stateRoot, `random-${round}`, "pi-assistant-prefill");
  await runChild(["save", "--state-dir", stateDirectory, "--choice", "off"]);
  const loop = spawn(
    process.execPath,
    [CHILD, "loop", "--state-dir", stateDirectory, "--iterations", String(LOOP_ITERATIONS)],
    {
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    },
  );
  let finished = false;
  const exited = once(loop, "exit").then(() => {
    finished = true;
  });
  await new Promise((resolveDelay) =>
    setTimeout(resolveDelay, 10 + Math.floor(Math.random() * 240)),
  );
  const killedMidRun = !finished;
  if (killedMidRun) loop.kill("SIGKILL");
  await exited;

  const read = await readAfterRestart(stateDirectory);
  tally.rounds += 1;
  if (killedMidRun) tally.killedMidRun += 1;
  if (read.status !== "loaded") tally.unreadable.push(`round ${round}: ${read.status}`);
  tally.kinds[read.kind] = (tally.kinds[read.kind] ?? 0) + 1;
  tally.temporaryFiles += temporaryFiles(stateDirectory).length;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const work = options.work ?? mkdtempSync(join(tmpdir(), "pi-prefill-atomicity-"));
  console.log(`work directory: ${work}`);
  const stateRoot = join(work, "states");
  mkdirSync(stateRoot, { recursive: true });
  readLogFile = join(work, "reads.jsonl");
  writeFileSync(readLogFile, "");
  const steps = new Steps(join(work, "summary.txt"));

  for (const point of ["during-write", "before-rename", "after-rename"]) {
    await interruptReplacement(steps, stateRoot, point);
  }
  await orphanOnly(steps, stateRoot);
  await orphanBesideState(steps, stateRoot);

  const tally = { rounds: 0, killedMidRun: 0, unreadable: [], kinds: {}, temporaryFiles: 0 };
  for (let round = 0; round < options.randomRounds; round += 1) {
    await randomInterruption(stateRoot, round, tally);
  }
  steps.record(
    tally.unreadable.length === 0,
    `random rounds: every read after a kill is loaded (${tally.rounds} rounds, ${tally.unreadable.join("; ") || "none unreadable"})`,
  );
  steps.record(
    tally.killedMidRun === tally.rounds,
    `random rounds: killed while the loop was running (${tally.killedMidRun}/${tally.rounds})`,
  );
  steps.record(
    Object.keys(tally.kinds).every((kind) => kind === "off" || kind === "profile"),
    `random rounds: read choices ${JSON.stringify(tally.kinds)}`,
  );
  steps.record(
    tally.temporaryFiles <= tally.rounds,
    `random rounds: temporary files left by the killed writes: ${tally.temporaryFiles} (at most one per round)`,
  );

  console.log(
    steps.failures === 0
      ? "RESULT: every step ended as expected"
      : "RESULT: at least one step did not end as expected",
  );
  process.exit(steps.failures === 0 ? 0 : 1);
}

await main();
