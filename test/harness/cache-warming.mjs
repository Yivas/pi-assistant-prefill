// Cache warming check. Pi's own timer re-sends the request of a cache entry shortly before the entry
// expires, and first asks the extensions for a decision (cache_warming_decision). The check runs one
// committed application in an idle Pi process over RPC, then follows the path that Pi takes:
// decision -> one-token refresh request -> cache_warm usage entry -> /prefill status -> normal request.
// It compares what each step recorded, so a decision that never reaches the double, or a refresh that
// is not recorded, fails the check. Manual check: it is not part of `npm run check` or `npm test`.
//
// Economics. With claude-sonnet-4-6 in Pi 1.1.0's catalog (input 3, output 15, cache read 0.30 and cache
// write 3.75 dollars per million tokens; short cache lifetime 300 s; idle continuation probability
// 0.15; minimum expected saving 0.05 dollars), Pi warms only when the last answer reports about 229,900
// prompt tokens or more. The double reports INPUT_TOKENS, which is synthetic. This check therefore
// shows the mechanism, not what a real provider would charge. The refresh is due 270 s after the
// request started, so the check takes about five minutes.
//
// Usage: node test/harness/cache-warming.mjs --pi-entry <Pi's dist/bundle/cli.js> [--work <directory>]
// Exit status 0 means every step ended as expected.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  HARNESS,
  latestStatusApplication,
  occurrencesIn,
  parseRunOptions,
  PROFILE_ID,
  selectionIsProfile,
  Steps,
  sessionLines,
  snapshot,
  startDouble,
  writeLibrary,
  writeProfile,
  writeProviderEndpoint,
} from "./pi-process.mjs";
import { startRpc } from "./rpc-process.mjs";

const INPUT_TOKENS = 300_000;
const REFRESH_SECONDS = 270;
const MINIMUM_SECONDS_FROM_TIMER = 240;
const WARM_WAIT_MS = 330_000;
const PROMPT_FIRST = "SYNTHETIC-REAL-PROMPT: summarize the previous answer.";
const PROMPT_SECOND = "SYNTHETIC-REAL-PROMPT-2: summarize the previous answer again.";
const OBSERVER = join(HARNESS, "cache-decision-observer.mjs");
const USAGE =
  "node test/harness/cache-warming.mjs --pi-entry <Pi's dist/bundle/cli.js> [--work <directory>]";

// Runs the scenario inside `root`. Returns the number of failed steps.
async function runWarming(root, piEntry) {
  const agent = join(root, "agent");
  const home = join(root, "home");
  const session = join(root, "session.jsonl");
  const reference = join(root, "reference", PROFILE_ID);
  const capture = join(root, "capture");
  const decisionLog = join(root, "decisions.jsonl");
  const steps = new Steps(join(root, "summary.txt"));
  mkdirSync(home, { recursive: true });
  writeLibrary(agent);
  writeProfile(reference);
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ cacheWarming: "idle" }));
  writeFileSync(decisionLog, "");

  const double = await startDouble({ captureDirectory: capture, inputTokens: INPUT_TOKENS });
  writeProviderEndpoint(agent, double.port);
  const rpc = startRpc({
    piEntry,
    agent,
    home,
    session,
    streamFile: join(root, "rpc-stream.jsonl"),
    extraArguments: ["-e", OBSERVER],
    environment: { PREFILL_HARNESS_DECISION_LOG: decisionLog },
  });
  try {
    await exercise({ root, agent, session, reference, capture, double, rpc, decisionLog, steps });
  } catch (error) {
    steps.record(false, `the check stopped early: ${error.message}`);
  } finally {
    await rpc.stop();
    await double.stop();
  }
  return steps.failures;
}

async function exercise({
  root,
  agent,
  session,
  reference,
  capture,
  double,
  rpc,
  decisionLog,
  steps,
}) {
  const use = await rpc.send("prompt", { message: `/prefill use ${PROFILE_ID}` });
  steps.record(
    use.success && use.data?.disposition === "handled" && selectionIsProfile(agent),
    "/prefill use recorded brief-example",
  );

  const turnStart = Date.now();
  await rpc.runTurn(PROMPT_FIRST);
  const turnEnd = Date.now();
  steps.record(double.captured() === 1, "the first request reached the double");
  const firstFile = join(root, "session-after-first-turn.jsonl");
  snapshot(session, firstFile);
  const intentId = applicationRecordsOf(firstFile).find(
    (record) => record.phase === "intent",
  )?.applicationId;
  steps.record(
    applicationRecordsOf(firstFile)
      .map((record) => record.phase)
      .join(",") === "intent,projected,committed",
    "the first answer committed the application",
  );
  const firstAnswer = sessionLines(firstFile).entries.find(
    (entry) => entry.type === "message" && entry.message?.role === "assistant",
  );
  steps.record(
    firstAnswer?.message.usage.input === INPUT_TOKENS,
    `the first answer reports ${INPUT_TOKENS} input tokens, the value the economics read`,
  );

  const warmFrom = rpc.events.length;
  const warmEntry = await rpc
    .waitFor(
      (record) =>
        record.type === "entry_appended" &&
        record.entry?.type === "usage" &&
        record.entry.kind === "cache_warm",
      warmFrom,
      WARM_WAIT_MS,
    )
    .catch(() => null);
  const secondsFromTurnEnd = Math.round((Date.now() - turnEnd) / 1000);
  steps.record(
    warmEntry !== null,
    `a cache_warm usage entry was recorded within ${WARM_WAIT_MS / 1000} s (${secondsFromTurnEnd} s after the first turn ended)`,
  );
  if (warmEntry === null) return;
  steps.record(
    Date.now() - turnStart >= MINIMUM_SECONDS_FROM_TIMER * 1000,
    `the refresh came from the timer, not from the first turn: at least ${MINIMUM_SECONDS_FROM_TIMER} s after the request started (refresh delay ${REFRESH_SECONDS} s)`,
  );

  const decisions = readDecisions(decisionLog);
  const warmDecisions = decisions.filter((decision) => decision.action === "warm");
  steps.record(
    decisions.length === 1 && warmDecisions.length === 1,
    `the decision reached the extension system: ${decisions.length} decision(s), ${warmDecisions.length} with action warm`,
  );
  const [decision] = warmDecisions;
  if (decision !== undefined) {
    console.log(
      `  decision: missCost ${decision.missCost}, warmCost ${decision.warmCost}, continuationProbability ${decision.continuationProbability}`,
    );
  }

  steps.record(double.captured() === 2, "the refresh reached the double as the second request");
  const refreshBody = capturedBody(capture, 2);
  steps.record(
    refreshBody.max_tokens === 1 && refreshBody.stream === true,
    "the second request is the one-token refresh",
  );
  steps.record(
    checkBody({
      root,
      label: "refresh",
      bodyFile: capturedBodyFile(capture, 2),
      profile: reference,
      prompt: PROMPT_FIRST,
      expect: "pair",
      messages: 3,
    }) === 0,
    "the refresh repeats the request of the cache entry: pair once in front, first prompt last",
  );

  const afterWarmFile = join(root, "session-after-warm.jsonl");
  snapshot(session, afterWarmFile);
  const usageEntries = sessionLines(afterWarmFile).entries.filter(
    (entry) => entry.type === "usage",
  );
  steps.record(
    usageEntries.length === 1 && usageEntries[0].kind === "cache_warm",
    "the session holds one cache_warm usage entry",
  );

  await rpc.send("prompt", { message: "/prefill status" });
  const statusFile = join(root, "session-after-status.jsonl");
  snapshot(session, statusFile);
  const reported = latestStatusApplication(sessionLines(statusFile).entries);
  steps.record(
    reported?.kind === "committed" &&
      reported.applicationId === intentId &&
      reported.refreshes === warmDecisions.length,
    `/prefill status reports the committed application with ${warmDecisions.length} refresh decision(s)`,
  );
  steps.record(
    warmDecisions.length === usageEntries.length && usageEntries.length === double.captured() - 1,
    "decisions, refresh requests and cache_warm entries agree: one each",
  );

  await rpc.runTurn(PROMPT_SECOND);
  steps.record(double.captured() === 3, "the normal request after the refresh reached the double");
  steps.record(
    checkBody({
      root,
      label: "normal",
      bodyFile: capturedBodyFile(capture, 3),
      profile: reference,
      prompt: PROMPT_SECOND,
      expect: "pair",
      messages: 5,
    }) === 0,
    "the normal request after the refresh carries the pair once and ends with the real prompt",
  );
  const normal = capturedBody(capture, 3);
  steps.record(
    occurrencesIn(normal, EXAMPLE_USER_TEXT) === 1 &&
      occurrencesIn(normal, EXAMPLE_ASSISTANT_TEXT) === 1,
    "the normal request holds the pair once in each role",
  );

  await rpc.send("prompt", { message: "/prefill status" });
  const endFile = join(root, "session-end.jsonl");
  snapshot(session, endFile);
  const endStatus = latestStatusApplication(sessionLines(endFile).entries);
  steps.record(
    endStatus?.refreshes === 1 && readDecisions(decisionLog).length === 1,
    "after the normal request the count is still one: the next refresh is 270 s after it",
  );
  steps.record(
    applicationRecordsIn(sessionLines(endFile).entries)
      .map((record) => record.phase)
      .join(",") === "intent,projected,committed",
    "the session still holds the three application records",
  );
  steps.record(
    sessionLines(endFile).unparsed === 0 && rpc.unparsedRecords() === 0,
    "every RPC record and session line parsed",
  );
}

function readDecisions(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

const options = parseRunOptions(process.argv.slice(2), USAGE);
const work = options.work ?? mkdtempSync(join(tmpdir(), "pi-prefill-warming-"));
console.log(`work directory: ${work}`);
const root = join(work, "cache-warming");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const failures = await runWarming(root, options.piEntry);
console.log(
  failures === 0
    ? "RESULT: every step ended as expected"
    : "RESULT: at least one step did not end as expected",
);
process.exit(failures === 0 ? 0 : 1);
