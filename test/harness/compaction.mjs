// Compaction check. A session with a committed prefill application is compacted by Pi's own manual
// command (`compact` over RPC), which runs Pi's summary and cut logic and sends the summary requests
// to the loopback double. The check keeps the session and the captured requests before and after the
// compaction, then compares the next request with docs/projection.md: the pair is sent once, in front
// of the conversation; the summary requests never carry it; and the application records stay in the
// session. Manual check: it is not part of `npm run check` or `npm test`.
//
// Usage: node test/harness/compaction.mjs --pi-entry <Pi's dist/bundle/cli.js> [--work <directory>]
// Exit status 0 means every step ended as expected.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applicationRecordsIn,
  applicationRecordsOf,
  capturedBody,
  capturedBodyFile,
  checkBody,
  EXAMPLE_ASSISTANT_TEXT,
  EXAMPLE_USER_TEXT,
  latestStatusApplication,
  occurrencesIn,
  PROFILE_ID,
  parseRunOptions,
  Steps,
  selectionIsProfile,
  sessionLines,
  snapshot,
  startDouble,
  writeLibrary,
  writeProfile,
  writeProviderEndpoint,
} from "./pi-process.mjs";
import { startRpc } from "./rpc-process.mjs";

const TURN_COUNT = 5;
// About 24 KB per prompt, so the last turns fill the default keep budget and the first turn is summarized.
const FILLER = "Synthetic filler that only takes up the context budget of the compaction. ";
const FILLER_REPEATS = 300;
const NEXT_PROMPT = "SYNTHETIC-REAL-PROMPT-NEXT: summarize the previous answer.";
const USAGE =
  "node test/harness/compaction.mjs --pi-entry <Pi's dist/bundle/cli.js> [--work <directory>]";

function turnMarker(number) {
  return `SYNTHETIC-REAL-PROMPT-${number}:`;
}

function turnPrompt(number) {
  return `${turnMarker(number)} ${FILLER.repeat(FILLER_REPEATS)}`;
}

// Runs the scenario inside `root`. Returns the number of failed steps.
async function runCompaction(root, piEntry) {
  const agent = join(root, "agent");
  const home = join(root, "home");
  const session = join(root, "session.jsonl");
  const reference = join(root, "reference", PROFILE_ID);
  const capture = join(root, "capture");
  const steps = new Steps(join(root, "summary.txt"));
  mkdirSync(home, { recursive: true });
  writeLibrary(agent);
  writeProfile(reference);

  const double = await startDouble({ captureDirectory: capture });
  writeProviderEndpoint(agent, double.port);
  const rpc = startRpc({
    piEntry,
    agent,
    home,
    session,
    streamFile: join(root, "rpc-stream.jsonl"),
  });
  try {
    await exercise({ root, agent, session, reference, capture, double, rpc, steps });
  } catch (error) {
    steps.record(false, `the check stopped early: ${error.message}`);
  } finally {
    await rpc.stop();
    await double.stop();
  }
  return steps.failures;
}

async function exercise({ root, agent, session, reference, capture, double, rpc, steps }) {
  const use = await rpc.send("prompt", { message: `/prefill use ${PROFILE_ID}` });
  steps.record(
    use.success && use.data?.disposition === "handled" && selectionIsProfile(agent),
    "/prefill use recorded brief-example",
  );

  for (let number = 1; number <= TURN_COUNT; number += 1) await rpc.runTurn(turnPrompt(number));
  steps.record(
    double.captured() === TURN_COUNT,
    `${TURN_COUNT} turns completed through the double`,
  );
  const beforeFile = join(root, "session-before-compact.jsonl");
  snapshot(session, beforeFile);
  const capturesBefore = double.captured();
  const beforeRecords = applicationRecordsOf(beforeFile);
  steps.record(
    beforeRecords.map((record) => record.phase).join(",") === "intent,projected,committed",
    "before compaction: intent, projected and committed in the session",
  );

  const from = rpc.events.length;
  const compact = await rpc.send("compact");
  const started = rpc.events.slice(from).find((record) => record.type === "compaction_start");
  const ended = rpc.events.slice(from).find((record) => record.type === "compaction_end");
  const result = ended?.result;
  steps.record(
    compact.success &&
      started?.reason === "manual" &&
      ended?.reason === "manual" &&
      result !== undefined,
    "manual compaction ran through Pi (compaction_start and compaction_end)",
  );

  const afterFile = join(root, "session-after-compact.jsonl");
  snapshot(session, afterFile);
  const compactions = sessionLines(afterFile).entries.filter(
    (entry) => entry.type === "compaction",
  );
  steps.record(
    compactions.length === 1 &&
      compactions[0].firstKeptEntryId === result?.firstKeptEntryId &&
      compactions[0].summary === result?.summary,
    `session holds one compaction entry (cut ${result?.firstKeptEntryId}, tokens before ${result?.tokensBefore})`,
  );
  steps.record(
    applicationRecordsOf(afterFile)
      .map((record) => record.phase)
      .join(",") === "intent,projected,committed",
    "after compaction: the application records are still in the session",
  );

  const summaryRequests = positionsBetween(capturesBefore + 1, double.captured());
  const summaryBodies = summaryRequests.map((position) => capturedBody(capture, position));
  steps.record(
    summaryRequests.length >= 1 &&
      summaryBodies.every(
        (body) =>
          occurrencesIn(body, EXAMPLE_USER_TEXT) === 0 &&
          occurrencesIn(body, EXAMPLE_ASSISTANT_TEXT) === 0,
      ),
    `the ${summaryRequests.length} summary request(s) sent by the compaction carry no pair`,
  );
  steps.record(
    summaryBodies.length > 0 && occurrencesIn(summaryBodies[0], turnMarker(1)) >= 1,
    "the first summary request holds the first turn, which is what the compaction summarizes",
  );

  const nextPosition = double.captured() + 1;
  await rpc.runTurn(NEXT_PROMPT);
  steps.record(
    double.captured() === nextPosition,
    "the request after compaction reached the double",
  );
  const next = capturedBody(capture, nextPosition);
  const userCount = occurrencesIn(next, EXAMPLE_USER_TEXT);
  const assistantCount = occurrencesIn(next, EXAMPLE_ASSISTANT_TEXT);
  steps.record(
    userCount === 1 && assistantCount === 1,
    `the request after compaction carries the pair once (user ${userCount}, assistant ${assistantCount})`,
  );
  steps.record(
    checkBody({
      root,
      label: "after-compact",
      bodyFile: capturedBodyFile(capture, nextPosition),
      profile: reference,
      prompt: NEXT_PROMPT,
      expect: "pair",
    }) === 0,
    "the request after compaction starts with the pair and ends with the real prompt",
  );
  // The double numbers each reply after its request, so the summary Pi reported names the summary
  // request that wrote it. That number must be one of this compaction's summary requests.
  const summaryNumbers = [...result.summary.matchAll(/request (\d{3})/g)].map((match) =>
    Number(match[1]),
  );
  steps.record(
    summaryNumbers.length > 0 && summaryNumbers.every((number) => summaryRequests.includes(number)),
    `the summary Pi reported is the reply to summary request ${summaryNumbers.join(", ")} of this compaction`,
  );
  steps.record(
    carriesSummary(next, result.summary),
    "the request after compaction carries the summary Pi reported, after the pair",
  );
  // Control: with that summary taken out of the same request, the same check must fail.
  steps.record(
    !carriesSummary(withoutText(next, result.summary), result.summary),
    "control: the summary check fails when the summary is removed from the request",
  );
  steps.record(
    occurrencesIn(next, turnMarker(1)) === 0 && occurrencesIn(next, turnMarker(TURN_COUNT)) === 1,
    `the compacted first turn is not sent again; the last turn (${TURN_COUNT}) is kept`,
  );
  console.log(
    `roles of the request after compaction: ${next.messages.map((m) => m.role).join(",")}`,
  );

  // The status reads the session after the compaction and after the request: it must still report
  // the same committed application.
  const status = await rpc.send("prompt", { message: "/prefill status" });
  const finalFile = join(root, "session-after-status.jsonl");
  snapshot(session, finalFile);
  const finalEntries = sessionLines(finalFile).entries;
  const committedId = applicationRecordsIn(finalEntries).find(
    (record) => record.phase === "intent",
  )?.applicationId;
  const reported = latestStatusApplication(finalEntries);
  steps.record(
    status.success && reported?.kind === "committed" && reported.applicationId === committedId,
    "/prefill status after compaction reports the same committed application",
  );
  steps.record(
    occurrencesIn(finalEntries, EXAMPLE_USER_TEXT) === 0 &&
      occurrencesIn(finalEntries, EXAMPLE_ASSISTANT_TEXT) === 0,
    "the session file never holds the pair",
  );
  steps.record(
    rpc.unparsedRecords() === 0 && sessionLines(finalFile).unparsed === 0,
    "every RPC record and session line parsed",
  );
}

// Whether the request holds the whole summary as one text. The summary is wrapped once in the request.
function carriesSummary(body, summary) {
  return occurrencesIn(body, summary) === 1;
}

// A copy of the body with every occurrence of a text removed.
function withoutText(body, text) {
  const escaped = JSON.stringify(text).slice(1, -1);
  return JSON.parse(JSON.stringify(body).split(escaped).join(""));
}

function positionsBetween(first, last) {
  const positions = [];
  for (let position = first; position <= last; position += 1) positions.push(position);
  return positions;
}

const options = parseRunOptions(process.argv.slice(2), USAGE);
const work = options.work ?? mkdtempSync(join(tmpdir(), "pi-prefill-compaction-"));
console.log(`work directory: ${work}`);
const root = join(work, "compaction");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const failures = await runCompaction(root, options.piEntry);
console.log(
  failures === 0
    ? "RESULT: every step ended as expected"
    : "RESULT: at least one step did not end as expected",
);
process.exit(failures === 0 ? 0 : 1);
