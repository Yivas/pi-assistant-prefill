// Checks the outbound boundary of one captured request against the synthetic profile files.
// Expectation "pair": the request starts with the profile's user and assistant texts, each one a
// single text block, and its last message is the real prompt. Expectation "no-pair": the request
// does not start with that pair, and the last message is still the real prompt. With --messages N the
// request must also hold exactly N messages, so a duplicated pair or a message between the pair and
// the prompt fails. Without it, the count is not checked (used where history or a summary is expected).
// pairState says what starts the request: "complete" when both example texts are at their places,
// "altered" when exactly one of them is, and "absent" when neither is. A pair whose two texts both
// changed reads as "absent", because the checker cannot tell it from another conversation.
// Exit codes: 0 the observed request matches the expectation, 1 it does not, 2 the capture cannot be
// read. The JSON on stdout carries the observed state either way.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const options = parseOptions(process.argv.slice(2));
const result = check(options);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.error ? 2 : result.matches ? 0 : 1);

function parseOptions(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    values[argv[index]] = argv[index + 1];
  }
  const expect = values["--expect"];
  if (!["pair", "no-pair"].includes(expect)) throw new Error("--expect must be pair or no-pair");
  for (const name of ["--captures", "--profile", "--prompt"]) {
    if (typeof values[name] !== "string") throw new Error(`missing ${name}`);
  }
  const messages = values["--messages"] === undefined ? null : Number(values["--messages"]);
  if (messages !== null && !Number.isSafeInteger(messages)) {
    throw new Error("--messages must be an integer");
  }
  return {
    captures: values["--captures"],
    profile: values["--profile"],
    prompt: values["--prompt"],
    expect,
    messages,
  };
}

function check({ captures, profile, prompt, expect, messages: expectedMessages }) {
  const bodyNames = readdirSync(captures)
    .filter((name) => /^request-\d{3}\.body$/.test(name))
    .sort();
  if (bodyNames.length !== 1) {
    return { error: `expected one captured request, found ${bodyNames.length}`, matches: false };
  }
  const body = JSON.parse(readFileSync(join(captures, bodyNames[0]), "utf8"));
  const messages = body.messages;
  if (!Array.isArray(messages)) return { error: "body.messages is not an array", matches: false };

  const exampleUser = readFileSync(join(profile, "user.md"), "utf8");
  const exampleAssistant = readFileSync(join(profile, "assistant.md"), "utf8");
  const userMatches = singleTextOf(messages[0], "user") === exampleUser;
  const assistantMatches = singleTextOf(messages[1], "assistant") === exampleAssistant;
  const pairAtStart = userMatches && assistantMatches;
  const pairState = pairAtStart
    ? "complete"
    : userMatches || assistantMatches
      ? "altered"
      : "absent";
  const lastIsRealPrompt = singleTextOf(messages.at(-1), "user") === prompt;
  const countMatches = expectedMessages === null || messages.length === expectedMessages;
  const matches =
    lastIsRealPrompt && countMatches && (expect === "pair" ? pairAtStart : !pairAtStart);

  return {
    capture: bodyNames[0],
    expect,
    matches,
    pairAtStart,
    pairState,
    lastIsRealPrompt,
    expectedMessages,
    messageCount: messages.length,
    bodyKeys: Object.keys(body),
    systemField: describeSystem(body.system),
    messageShape: messages.map(describeMessage),
  };
}

// Text of a message that holds exactly one text block, or null for any other shape.
function singleTextOf(message, role) {
  if (message?.role !== role) return null;
  const blocks =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
  if (!Array.isArray(blocks) || blocks.length !== 1) return null;
  const [block] = blocks;
  return block?.type === "text" ? block.text : null;
}

function describeMessage(message) {
  const content = message.content;
  const blocks = typeof content === "string" ? ["string"] : content.map((block) => block.type);
  return { role: message.role, blocks, keys: Object.keys(message) };
}

function describeSystem(system) {
  if (system === undefined) return "absent";
  if (typeof system === "string") return "string";
  return Array.isArray(system) ? `array(${system.length})` : typeof system;
}
