// Export check. A session with known state is exported through the two routes that do not need the
// terminal UI: the command line (`pi --export <session> <html>`) and the RPC command `export_html`. The
// HTML embeds the session entries as base64 JSON in <script id="session-data">, so the check decodes
// that data and compares it with the session file, entry for entry. The page paints the transcript from
// that block with JavaScript, so the static HTML holds no transcript to inspect: what a reader sees is a
// manual step (docs/verification-harness.md). The contract it checks on the embedded data:
//   - the export holds every entry of the session file, in the same order, and the same leaf;
//   - the pair of the profile is not a conversation turn: no entry holds its texts;
//   - the two real turns are present as user and assistant messages, with their texts;
//   - the application and selection records are reconstructible from the export: intent, projected and
//     committed for one application identifier, and the status entry that points at it;
//   - no record holds profile text;
//   - each reply is distinct and names its request, so the replies cannot be confused with each other.
// The JSONL export (`/export <file>.jsonl`) is not run here: the terminal UI is its only entry point
// (see docs/verification-harness.md, manual steps). Manual check: not part of `npm run check` or
// `npm test`.
//
// Usage: node test/harness/export-session.mjs --pi-entry <Pi's dist/bundle/cli.js> [--work <directory>]
// Exit status 0 means every step ended as expected.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  applicationRecordsIn,
  EXAMPLE_ASSISTANT_TEXT,
  EXAMPLE_USER_TEXT,
  latestStatusApplication,
  occurrencesIn,
  PROFILE_ID,
  parseRunOptions,
  piEnvironment,
  REPLY_PREFIX,
  RECORD_PREFIX,
  selectionIsProfile,
  SELECTOR_ENTRY_TYPE,
  Steps,
  sessionLines,
  snapshot,
  startDouble,
  writeLibrary,
  writeProviderEndpoint,
} from "./pi-process.mjs";
import { startRpc } from "./rpc-process.mjs";

const FIRST_PROMPT = "SYNTHETIC-REAL-PROMPT: summarize the previous answer.";
const SECOND_PROMPT = "SYNTHETIC-REAL-PROMPT-2: summarize the previous answer again.";
const SESSION_DATA_PATTERN = /<script id="session-data" type="application\/json">([^<]*)<\/script>/;
const USAGE =
  "node test/harness/export-session.mjs --pi-entry <Pi's dist/bundle/cli.js> [--work <directory>]";

async function runExport(root, piEntry) {
  const agent = join(root, "agent");
  const home = join(root, "home");
  const session = join(root, "session.jsonl");
  const knownState = join(root, "session-known-state.jsonl");
  const rpcHtml = join(root, "rpc-export.html");
  const cliHtml = join(root, "cli-export.html");
  const steps = new Steps(join(root, "summary.txt"));
  mkdirSync(home, { recursive: true });
  writeLibrary(agent);

  const double = await startDouble({ captureDirectory: join(root, "capture") });
  writeProviderEndpoint(agent, double.port);
  const rpc = startRpc({
    piEntry,
    agent,
    home,
    session,
    streamFile: join(root, "rpc-stream.jsonl"),
  });
  try {
    await buildKnownState({ agent, session, knownState, rpcHtml, rpc, steps });
  } catch (error) {
    steps.record(false, `the check stopped early: ${error.message}`);
  } finally {
    await rpc.stop();
    await double.stop();
  }
  if (!existsSync(knownState)) return steps.failures;

  const before = digestOf(knownState);
  const cliStatus = await runCommandLineExport({ piEntry, agent, home, knownState, cliHtml });
  steps.record(cliStatus === 0, `pi --export wrote the HTML and exited with status ${cliStatus}`);
  steps.record(digestOf(knownState) === before, "the export did not change the session file");

  const fileEntries = sessionLines(knownState).entries;
  const header = fileEntries[0];
  const sessionEntries = fileEntries.slice(1);
  const cliData = sessionDataOf(readFileSync(cliHtml, "utf8"));
  const rpcData = sessionDataOf(readFileSync(rpcHtml, "utf8"));
  steps.record(cliData !== null && rpcData !== null, "both HTML exports embed their session data");
  if (cliData === null || rpcData === null) return steps.failures;

  steps.record(
    isDeepStrictEqual(cliData.entries, sessionEntries) && isDeepStrictEqual(cliData.header, header),
    `the command-line export holds the ${sessionEntries.length} session entries, in order, unchanged`,
  );
  steps.record(
    isDeepStrictEqual(rpcData.entries, cliData.entries),
    "the RPC export and the command-line export hold the same entries",
  );
  steps.record(
    cliData.leafId === sessionEntries.at(-1).id,
    "the export names the last entry of the session as its leaf",
  );

  checkContract({ steps, entries: cliData.entries });
  return steps.failures;
}

// The session with known state: one application committed by two turns, its status, and the RPC export.
async function buildKnownState({ agent, session, knownState, rpcHtml, rpc, steps }) {
  const use = await rpc.send("prompt", { message: `/prefill use ${PROFILE_ID}` });
  steps.record(
    use.success && use.data?.disposition === "handled" && selectionIsProfile(agent),
    "/prefill use recorded brief-example",
  );
  await rpc.runTurn(FIRST_PROMPT);
  await rpc.runTurn(SECOND_PROMPT);
  await rpc.send("prompt", { message: "/prefill status" });
  const exported = await rpc.send("export_html", { outputPath: rpcHtml });
  steps.record(
    exported.success && exported.data?.path !== undefined,
    "the RPC export_html command wrote the session",
  );
  snapshot(session, knownState);
}

function checkContract({ steps, entries }) {
  const messages = entries.filter((entry) => entry.type === "message");
  const userTexts = messages
    .filter((entry) => entry.message.role === "user")
    .map((entry) => entry.message.content[0]?.text);
  const assistantTexts = messages
    .filter((entry) => entry.message.role === "assistant")
    .map((entry) => entry.message.content[0]?.text);
  steps.record(
    isDeepStrictEqual(userTexts, [FIRST_PROMPT, SECOND_PROMPT]),
    "the export holds the two real user turns, in order",
  );
  steps.record(
    assistantTexts.length === 2 &&
      assistantTexts.every((text) => text.startsWith(REPLY_PREFIX)) &&
      new Set(assistantTexts).size === 2,
    "the export holds the two real assistant turns, in order",
  );
  // Control: the detector must find the pair in an entry that holds it, or the absence above proves nothing.
  const controlEntry = {
    type: "message",
    message: { role: "user", content: [{ text: EXAMPLE_USER_TEXT }] },
  };
  steps.record(
    occurrencesIn([controlEntry], EXAMPLE_USER_TEXT) === 1,
    "control: the detector finds the pair in an entry that holds it",
  );
  steps.record(
    occurrencesIn(entries, EXAMPLE_USER_TEXT) === 0 &&
      occurrencesIn(entries, EXAMPLE_ASSISTANT_TEXT) === 0,
    "the pair of the profile is not in any exported entry",
  );

  const records = applicationRecordsIn(entries);
  const applicationIds = new Set(records.map((record) => record.applicationId));
  steps.record(
    records.map((record) => record.phase).join(",") === "intent,projected,committed" &&
      applicationIds.size === 1,
    "the application records reconstruct intent, projected, committed for one application",
  );
  const status = latestStatusApplication(entries);
  steps.record(
    status?.kind === "committed" && applicationIds.has(status.applicationId),
    "the last status entry reports that committed application",
  );
  const selections = entries.filter(
    (entry) => entry.type === "custom" && entry.customType === SELECTOR_ENTRY_TYPE,
  );
  steps.record(
    selections.some(
      (entry) => entry.data?.kind === "selected" && entry.data.profileId === PROFILE_ID,
    ),
    "the selection record names brief-example",
  );
  const recordEntries = entries.filter(
    (entry) => entry.type === "custom" && entry.customType.startsWith(RECORD_PREFIX),
  );
  steps.record(
    occurrencesIn(recordEntries, EXAMPLE_USER_TEXT) === 0 &&
      occurrencesIn(recordEntries, EXAMPLE_ASSISTANT_TEXT) === 0,
    "no record of the export holds profile text",
  );
}

// The entries and header embedded by the HTML export: base64 JSON in the session-data script.
function sessionDataOf(html) {
  const match = SESSION_DATA_PATTERN.exec(html);
  if (match === null) return null;
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
}

function digestOf(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function runCommandLineExport({ piEntry, agent, home, knownState, cliHtml }) {
  const child = spawn(process.execPath, [piEntry, "--export", knownState, cliHtml], {
    env: piEnvironment(agent, home),
    stdio: ["ignore", "ignore", "inherit"],
    windowsHide: true,
  });
  const [code] = await once(child, "exit");
  return code;
}

const options = parseRunOptions(process.argv.slice(2), USAGE);
const work = options.work ?? mkdtempSync(join(tmpdir(), "pi-prefill-export-"));
console.log(`work directory: ${work}`);
const root = join(work, "export");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const failures = await runExport(root, options.piEntry);
console.log(
  failures === 0
    ? "RESULT: every step ended as expected"
    : "RESULT: at least one step did not end as expected",
);
process.exit(failures === 0 ? 0 : 1);
