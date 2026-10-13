// Helpers shared by the harness scripts that drive Pi: the synthetic profile, the environment Pi runs
// with, the loopback double, the step log and the readers of session files and captured requests.
// Only Node.js built-in modules are used. The scripts start Pi themselves; this module starts only
// the double.
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export const HARNESS = import.meta.dirname;
const SOURCE = resolve(HARNESS, "..", "..", "src", "index.ts");
export const MODEL = "claude-sonnet-4-6";
const SYNTHETIC_KEY = "synthetic-key-not-a-real-credential";
export const PROFILE_ID = "brief-example";
export const RECORD_PREFIX = "pi-assistant-prefill.";
const APPLICATION_ENTRY_TYPE = "pi-assistant-prefill.application";
export const SELECTOR_ENTRY_TYPE = "pi-assistant-prefill.selector";
export const EXAMPLE_USER_TEXT = "SYNTHETIC-USER-EXAMPLE: what is a list?";
export const EXAMPLE_ASSISTANT_TEXT =
  "SYNTHETIC-ASSISTANT-EXAMPLE: a list stores ordered items.\n\nFor example: items = [1, 2].";
// The double answers with this prefix and the number of its request, so each reply is distinct.
export const REPLY_PREFIX = "SYNTHETIC-REPLY from the local double";

const PROFILE_FILES = {
  "profile.json":
    '{"schemaVersion":1,"id":"brief-example","name":"Synthetic brief example","description":"Synthetic example for the boundary check"}',
  "user.md": EXAMPLE_USER_TEXT,
  "assistant.md": EXAMPLE_ASSISTANT_TEXT,
};
const BASE_ENVIRONMENT_NAMES = ["PATH", "SYSTEMROOT", "TEMP", "TMP"];
const PI_ARGUMENTS = ["-ne", "-e", SOURCE, "-nc", "-ns", "-np", "--no-mcp", "--offline", "-na"];
const WAIT_LIMIT_MS = 60_000;
const POLL_MS = 10;

// One line per step, `ok` or `FAIL`, written to the summary file as it happens.
export class Steps {
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
  // An observation that is not an expectation: it is written, but it never fails the run.
  note(detail) {
    console.log(`info ${detail}`);
    writeFileSync(this.summaryPath, `info ${detail}\n`, { flag: "a" });
  }
}

// The profile library of a synthetic agent directory: one valid profile and a configuration with no
// default. The reference copy used by the boundary checker is written with writeProfile too.
export function writeLibrary(agent) {
  writeProfile(join(agent, "prefills", PROFILE_ID));
  writeFileSync(
    join(agent, "prefills", "config.json"),
    '{"schemaVersion":1,"defaultProfileId":null}',
  );
}

export function writeProfile(directory) {
  mkdirSync(directory, { recursive: true });
  for (const [name, text] of Object.entries(PROFILE_FILES))
    writeFileSync(join(directory, name), text);
}

// Points the synthetic anthropic provider of this agent directory at a loopback port. The key is
// synthetic, and the endpoint is the only address the provider can reach.
export function writeProviderEndpoint(agent, port) {
  writeFileSync(
    join(agent, "models.json"),
    JSON.stringify({
      providers: {
        anthropic: { baseUrl: `http://127.0.0.1:${port}`, apiKey: SYNTHETIC_KEY },
      },
    }),
  );
}

export function selectionIsProfile(agent) {
  const selection = JSON.parse(
    readFileSync(join(agent, "pi-assistant-prefill", "selection.json"), "utf8"),
  );
  return (
    selection.schemaVersion === 1 &&
    selection.profileId === PROFILE_ID &&
    selection.disabled === false
  );
}

// Only the variables Windows and Node need to start. Provider keys of the caller are not passed on.
function baseEnvironment() {
  const environment = {};
  for (const name of BASE_ENVIRONMENT_NAMES) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

// The environment of a Pi process: the agent directory and the home directory point into the work
// directory, and no request leaves the loopback interface.
export function piEnvironment(agent, home) {
  return {
    ...baseEnvironment(),
    PI_CODING_AGENT_DIR: agent,
    HOME: home,
    USERPROFILE: home,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
}

// The flags every harness run gives Pi. The prefill extension is loaded from the repository source,
// and no other extension, skill, context file, prompt template or MCP server is loaded.
export function piArguments() {
  return [...PI_ARGUMENTS];
}

// Starts the loopback double on a free port. The caller points the provider at `port` with
// writeProviderEndpoint. With hold, the double records each request and never answers it. With
// inputTokens, the double reports that many input tokens in each usage (synthetic).
export async function startDouble({ captureDirectory, hold = false, inputTokens = null }) {
  const portFile = `${captureDirectory}.port`;
  const log = openSync(`${captureDirectory}.double.log`, "w");
  const args = [
    join(HARNESS, "anthropic-double.mjs"),
    "--capture-dir",
    captureDirectory,
    "--port-file",
    portFile,
  ];
  if (hold) args.push("--hold-responses");
  if (inputTokens !== null) args.push("--input-tokens", String(inputTokens));
  const child = spawn(process.execPath, args, {
    env: baseEnvironment(),
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  if (!(await waitUntil(() => /^\d+$/.test(readText(portFile))))) {
    throw new Error(`the double did not start (${captureDirectory})`);
  }
  return {
    port: Number(readText(portFile)),
    capture: captureDirectory,
    captured: () => capturedCount(captureDirectory),
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await once(child, "exit");
      }
      closeSync(log);
    },
  };
}

// Polls until the predicate holds. Returns false on timeout.
export async function waitUntil(predicate, limitMs = WAIT_LIMIT_MS) {
  const deadline = Date.now() + limitMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_MS));
  }
  return true;
}

export function readText(file) {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

export function snapshot(source, target) {
  if (existsSync(source)) copyFileSync(source, target);
}

// Names of the captured request bodies, in the order the double received them.
function capturedBodyNames(captureDirectory) {
  if (!existsSync(captureDirectory)) return [];
  return readdirSync(captureDirectory)
    .filter((name) => /^request-\d{3}\.body$/.test(name))
    .sort();
}

function capturedCount(captureDirectory) {
  return capturedBodyNames(captureDirectory).length;
}

// The file of the request with that position (1-based) in the capture.
export function capturedBodyFile(captureDirectory, position) {
  return join(captureDirectory, `request-${String(position).padStart(3, "0")}.body`);
}

export function capturedBody(captureDirectory, position) {
  return JSON.parse(readFileSync(capturedBodyFile(captureDirectory, position), "utf8"));
}

// How many times a text occurs in a parsed JSON value. The text is compared in its JSON form, so
// line breaks inside it match the escaped form they have in the body.
export function occurrencesIn(value, text) {
  const escaped = JSON.stringify(text).slice(1, -1);
  return JSON.stringify(value).split(escaped).length - 1;
}

// Complete JSON lines of a session file, and the number of lines that did not parse.
export function sessionLines(file) {
  if (!existsSync(file)) return { entries: [], unparsed: 0 };
  const entries = [];
  let unparsed = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line === "") continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      unparsed += 1;
    }
  }
  return { entries, unparsed };
}

// The application records of session entries, in order, as { phase, applicationId }.
export function applicationRecordsIn(entries) {
  return entries
    .filter((entry) => entry.type === "custom" && entry.customType === APPLICATION_ENTRY_TYPE)
    .map((entry) => ({ phase: entry.data.phase, applicationId: entry.data.applicationId }));
}

export function applicationRecordsOf(file) {
  return applicationRecordsIn(sessionLines(file).entries);
}

// The application state of the last `/prefill status` written to session entries, or null.
export function latestStatusApplication(entries) {
  const statuses = entries.filter(
    (entry) =>
      entry.type === "custom" &&
      entry.customType === SELECTOR_ENTRY_TYPE &&
      entry.data?.kind === "status",
  );
  return statuses.at(-1)?.data.application ?? null;
}

// The prefill records of a session as phases, in file order, for example "intent,projected".
// Diagnostics appear as `diagnostic:<reason>`.
export function phasesOf(file) {
  return sessionLines(file)
    .entries.filter(
      (entry) => entry.type === "custom" && entry.customType.startsWith(RECORD_PREFIX),
    )
    .map(
      (entry) =>
        entry.data?.phase ??
        `${entry.customType.slice(RECORD_PREFIX.length)}:${entry.data?.reason}`,
    )
    .join(",");
}

// The `--pi-entry` and `--work` options shared by the scripts that start Pi. Exits with status 2 and
// the usage line when `--pi-entry` is missing.
export function parseRunOptions(argv, usage) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) values[argv[index]] = argv[index + 1];
  if (typeof values["--pi-entry"] !== "string") {
    console.error(`usage: ${usage}`);
    process.exit(2);
  }
  return { piEntry: values["--pi-entry"], work: values["--work"] };
}

// Runs the boundary checker on one capture directory that holds exactly one request. Returns its exit
// status: 0 when the observed request matches the expectation, 1 when it does not, 2 on a read error.
// `messages`, when given, is the exact number of messages the request must hold.
export function runBoundaryCheck({ captures, profile, prompt, expect, messages = null }) {
  const result = spawnSync(
    process.execPath,
    [
      join(HARNESS, "check-boundary.mjs"),
      "--captures",
      captures,
      "--profile",
      profile,
      "--prompt",
      prompt,
      "--expect",
      expect,
      ...(messages === null ? [] : ["--messages", String(messages)]),
    ],
    { encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout };
}

// Checks one body of a longer run. The checker reads one request per directory, so the body is
// copied to its own directory first. The checker's output is kept next to the run as evidence.
export function checkBody({ root, label, bodyFile, profile, prompt, expect, messages = null }) {
  const captures = join(root, `check-${label}-captures`);
  mkdirSync(captures, { recursive: true });
  copyFileSync(bodyFile, join(captures, "request-001.body"));
  const result = runBoundaryCheck({ captures, profile, prompt, expect, messages });
  writeFileSync(join(root, `check-${label}.json`), result.stdout);
  return result.status;
}
