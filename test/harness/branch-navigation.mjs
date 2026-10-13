// Branch-navigation check. Manual only: it is not part of `npm run check`.
// Usage: node test/harness/branch-navigation.mjs --pi-entry <cli.js> [--work <dir>]
//
// It runs a real Pi 1.1.0 session against the local double, applies the synthetic profile on the
// first branch, navigates to another position of the same session through Pi's own navigation API
// and back, and inspects every captured request:
//
//   A  the first branch, which is empty before the turn  -> the pair is projected
//   B  a branch that starts empty after navigating        -> a new application, and no entry of A
//   A  navigating back to the committed position          -> the pair is projected once again
//
// Navigating is done by a disposable probe command that calls the navigation API Pi's own
// interface uses; the script never emits the session event itself and never restarts between
// branches, which would prove nothing about navigation.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS = dirname(fileURLToPath(import.meta.url));
const REPOSITORY = resolve(HARNESS, "..", "..");
const USER_EXAMPLE = "SYNTHETIC-USER-EXAMPLE: what is a list?";
const ASSISTANT_EXAMPLE = "SYNTHETIC-ASSISTANT-EXAMPLE: ordered items.";
const PROBE = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.registerCommand("nav", {
    description: "Probe: navigate to a leaf id",
    handler: async (args: string, ctx: unknown) => {
      const context = ctx as { navigateTree(id: string): Promise<unknown> };
      const result = await context.navigateTree(args.trim());
      pi.appendEntry("probe.nav", { target: args.trim(), result });
    },
  });
}
`;

let failed = 0;
function record(status, name, detail) {
  console.log(`${status === "ok" ? "ok  " : "FAIL"} ${name}: ${detail}`);
  if (status !== "ok") failed = 1;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const cli = argument("--pi-entry");
if (cli === undefined) {
  console.error("missing --pi-entry <path to the installed Pi cli.js>");
  process.exit(2);
}
const work = argument("--work") ?? (await mkdtemp(join(tmpdir(), "prefill-branch-")));
await mkdir(join(work, "cap"), { recursive: true });
await mkdir(join(work, "home"), { recursive: true });
await mkdir(join(work, "agent", "prefills", "brief-example"), { recursive: true });
await mkdir(join(work, "agent", "pi-assistant-prefill"), { recursive: true });
await writeFile(
  join(work, "agent", "prefills", "brief-example", "profile.json"),
  '{"schemaVersion":1,"id":"brief-example","name":"Brief","description":"Synthetic"}',
);
await writeFile(join(work, "agent", "prefills", "brief-example", "user.md"), `${USER_EXAMPLE}\n`);
await writeFile(
  join(work, "agent", "prefills", "brief-example", "assistant.md"),
  `${ASSISTANT_EXAMPLE}\n`,
);
await writeFile(
  join(work, "agent", "pi-assistant-prefill", "selection.json"),
  '{"schemaVersion":1,"profileId":"brief-example","disabled":false}\n',
);
await writeFile(join(work, "probe.ts"), PROBE);

const double = spawn(
  process.execPath,
  [
    join(HARNESS, "anthropic-double.mjs"),
    "--capture-dir",
    join(work, "cap"),
    "--port-file",
    join(work, "cap.port"),
  ],
  { stdio: "ignore" },
);
for (let waited = 0; waited < 60; waited += 1) {
  try {
    await readFile(join(work, "cap.port"));
    break;
  } catch {
    await new Promise((wake) => setTimeout(wake, 200));
  }
}
const port = (await readFile(join(work, "cap.port"), "utf8")).trim();
await writeFile(
  join(work, "agent", "models.json"),
  JSON.stringify({
    providers: {
      anthropic: {
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: "synthetic-key-not-a-real-credential",
      },
    },
  }),
);

const child = spawn(
  process.execPath,
  [
    cli,
    "--mode",
    "rpc",
    "--session",
    join(work, "live.jsonl"),
    "-ne",
    "-e",
    join(REPOSITORY, "src", "index.ts"),
    "-e",
    join(work, "probe.ts"),
    "-nc",
    "-ns",
    "-np",
    "--no-mcp",
    "--offline",
    "-na",
    "--provider",
    "anthropic",
    "--model",
    "claude-sonnet-4-6",
  ],
  {
    cwd: work,
    env: {
      PATH: process.env.PATH ?? "",
      SYSTEMROOT: process.env.SYSTEMROOT ?? "",
      TEMP: process.env.TEMP ?? "",
      TMP: process.env.TMP ?? "",
      MSYS_NO_PATHCONV: "1",
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
      PI_CODING_AGENT_DIR: join(work, "agent"),
      HOME: join(work, "home"),
      USERPROFILE: join(work, "home"),
    },
    stdio: ["pipe", "pipe", "inherit"],
  },
);

const waiting = new Map();
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim() === "") continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const settle = waiting.get(message.id);
    if (message.type === "response" && settle !== undefined) {
      waiting.delete(message.id);
      settle(message);
    }
  }
});

let counter = 0;
function send(type, extra = {}) {
  counter += 1;
  const id = `b${counter}`;
  return new Promise((settle) => {
    waiting.set(id, settle);
    child.stdin.write(`${JSON.stringify({ id, type, ...extra })}\n`);
    setTimeout(() => {
      if (waiting.has(id)) {
        waiting.delete(id);
        settle({ timeout: true, id });
      }
    }, 60000);
  });
}
const pause = (ms) => new Promise((wake) => setTimeout(wake, ms));
const entries = async () => (await send("get_entries")).data?.entries ?? [];

await send("prompt", { message: "SYNTHETIC-REAL-PROMPT-1: summarize the previous answer." });
await pause(1500);
const branchA = await entries();
const firstUser = branchA.find(
  (entry) => entry.type === "message" && entry.message?.role === "user",
);
const committedLeaf = branchA.at(-1)?.id;
record("ok", "first branch", `${branchA.length} entries, first user ${firstUser?.id}`);

await send("prompt", { message: `/nav ${firstUser?.id}` });
await pause(1200);
await send("prompt", { message: "SYNTHETIC-REAL-PROMPT-2: summarize the previous answer." });
await pause(1500);
const branchB = await entries();
record("ok", "second branch", `${branchB.length} entries after the turn on the other branch`);

await send("prompt", { message: `/nav ${committedLeaf}` });
await pause(1200);
await send("prompt", { message: "SYNTHETIC-REAL-PROMPT-3: summarize the previous answer." });
await pause(1500);
child.stdin.end();
await pause(1000);
double.kill();

const captured = (await readdir(join(work, "cap"))).filter((file) => file.endsWith(".body")).sort();
const bodies = [];
for (const file of captured) {
  const body = JSON.parse(await readFile(join(work, "cap", file), "utf8"));
  const texts = (body.messages ?? []).flatMap((message) =>
    (message.content ?? []).filter((block) => block.type === "text").map((block) => block.text),
  );
  bodies.push({ file, texts });
}

record("ok", "captured requests", `${bodies.length} requests reached the double`);
if (bodies.length !== 3) {
  record("fail", "captured requests", `expected 3, got ${bodies.length}`);
} else {
  // The profile text is used verbatim, so a body that ends with a newline keeps it.
  const hasPair = (texts) =>
    (texts[0] ?? "").trim() === USER_EXAMPLE && (texts[1] ?? "").trim() === ASSISTANT_EXAMPLE;
  const [first, second, third] = bodies;
  record(
    hasPair(first.texts) && first.texts.length === 3 ? "ok" : "fail",
    "branch A applies the example",
    `roles and texts: ${JSON.stringify(first.texts.length)} messages`,
  );
  record(
    hasPair(second.texts) &&
      !second.texts.some((text) => text.includes("PROMPT-1")) &&
      second.texts.length === 3
      ? "ok"
      : "fail",
    "the other branch starts clean",
    "no entry of the first branch travels into it; it takes its own application",
  );
  record(
    hasPair(third.texts) &&
      third.texts.some((text) => text.includes("PROMPT-1")) &&
      third.texts.length === 5
      ? "ok"
      : "fail",
    "returning to the first branch recovers it once",
    `messages: ${third.texts.length}, pair once: ${third.texts.filter((text) => text.trim() === USER_EXAMPLE).length === 1}`,
  );
}

console.log(failed === 0 ? "RESULT: every step ended as expected" : "RESULT: some steps failed");
console.log(`work directory: ${work}`);
process.exit(failed);
