// Negative controls for the checker itself. Each case changes the captured body of the first turn in
// one way and runs check-boundary.mjs on it. The checker must accept the untouched body and reject
// every changed one, and it must name the state of the pair it observed: "complete", "altered" or
// "absent". A checker that accepted a broken body would make the boundary check vacuous.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [captureBody, profileDirectory, prompt, workDirectory] = process.argv.slice(2);
const checker = join(import.meta.dirname, "check-boundary.mjs");
const original = JSON.parse(readFileSync(captureBody, "utf8"));
const [pairUser, pairAssistant, ...rest] = original.messages;
const extraUser = { role: "user", content: [{ type: "text", text: "SYNTHETIC-EXTRA message" }] };

function withMessages(messages) {
  return { ...original, messages };
}

function withFirstTextChanged(message) {
  const [block] = message.content;
  return {
    ...message,
    content: [{ ...block, text: `X${block.text.slice(1)}` }, ...message.content.slice(1)],
  };
}

// `messages` is the --messages count passed to the checker (null: not checked). `state` is the
// pairState the checker must name for this body.
const cases = [
  {
    name: "untouched body, expect pair",
    body: original,
    expect: "pair",
    messages: 3,
    exitCode: 0,
    state: "complete",
  },
  {
    name: "pair removed, expect pair",
    body: withMessages(rest),
    expect: "pair",
    messages: 3,
    exitCode: 1,
    state: "absent",
  },
  {
    name: "pair reversed, expect pair",
    body: withMessages([pairAssistant, pairUser, ...rest]),
    expect: "pair",
    messages: 3,
    exitCode: 1,
    state: "absent",
  },
  {
    name: "pair after the prompt, expect pair",
    body: withMessages([...rest, pairUser, pairAssistant]),
    expect: "pair",
    messages: 3,
    exitCode: 1,
    state: "absent",
  },
  {
    name: "user example text altered, expect pair",
    body: withMessages([withFirstTextChanged(pairUser), pairAssistant, ...rest]),
    expect: "pair",
    messages: 3,
    exitCode: 1,
    state: "altered",
  },
  {
    name: "pair duplicated at the start, expect pair",
    body: withMessages([pairUser, pairAssistant, pairUser, pairAssistant, ...rest]),
    expect: "pair",
    messages: 3,
    exitCode: 1,
    state: "complete",
  },
  {
    name: "extra message between the pair and the prompt, expect pair",
    body: withMessages([pairUser, pairAssistant, extraUser, ...rest]),
    expect: "pair",
    messages: 3,
    exitCode: 1,
    state: "complete",
  },
  {
    name: "pair present, expect no-pair",
    body: original,
    expect: "no-pair",
    messages: null,
    exitCode: 1,
    state: "complete",
  },
  {
    name: "pair removed, expect no-pair",
    body: withMessages(rest),
    expect: "no-pair",
    messages: null,
    exitCode: 0,
    state: "absent",
  },
];

rmSync(workDirectory, { recursive: true, force: true });
let mismatches = 0;
for (const [index, testCase] of cases.entries()) {
  const captures = join(workDirectory, `case-${index}`);
  mkdirSync(captures, { recursive: true });
  writeFileSync(join(captures, "request-001.body"), JSON.stringify(testCase.body));
  const args = [
    checker,
    "--captures",
    captures,
    "--profile",
    profileDirectory,
    "--prompt",
    prompt,
    "--expect",
    testCase.expect,
  ];
  if (testCase.messages !== null) args.push("--messages", String(testCase.messages));
  const run = spawnSync(process.execPath, args, { encoding: "utf8" });
  const observed = JSON.parse(run.stdout);
  const ok = run.status === testCase.exitCode && observed.pairState === testCase.state;
  if (!ok) mismatches += 1;
  process.stdout.write(
    `${ok ? "ok  " : "FAIL"} exit=${run.status} wanted=${testCase.exitCode} state=${observed.pairState} wanted=${testCase.state}  ${testCase.name}\n`,
  );
}
process.stdout.write(`selftest: ${cases.length - mismatches}/${cases.length} as expected\n`);
process.exit(mismatches === 0 ? 0 : 1);
