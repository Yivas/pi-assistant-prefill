// A long-lived Pi process driven through its RPC mode. The checks that need the process to stay alive
// use it: a manual compaction, and the cache warming timer, which is a timer and is lost when the
// process exits. Pi reads JSONL commands on stdin and writes responses and session events on stdout.
// Every stdout record is kept in `events` and appended to a file, so the evidence is what Pi wrote.
// Only Node.js built-in modules are used.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, closeSync, openSync } from "node:fs";
import { MODEL, piArguments, piEnvironment } from "./pi-process.mjs";

const COMMAND_LIMIT_MS = 120_000;
const RUN_LIMIT_MS = 300_000;
const POLL_MS = 20;

// `extraArguments` and `environment` extend the Pi command line and environment of this process only.
export function startRpc({
  piEntry,
  agent,
  home,
  session,
  streamFile,
  extraArguments = [],
  environment = {},
}) {
  const stderr = openSync(`${streamFile}.err`, "w");
  const child = spawn(
    process.execPath,
    [
      piEntry,
      "--mode",
      "rpc",
      ...piArguments(),
      "--session",
      session,
      "--provider",
      "anthropic",
      "--model",
      MODEL,
      ...extraArguments,
    ],
    {
      env: { ...piEnvironment(agent, home), ...environment },
      stdio: ["pipe", "pipe", stderr],
      windowsHide: true,
    },
  );

  const events = [];
  let unparsed = 0;
  let pending = "";
  let commandCount = 0;
  // Records are split on LF only, as the RPC framing requires. A line that does not parse is counted.
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    pending += chunk;
    let end = pending.indexOf("\n");
    while (end !== -1) {
      receive(pending.slice(0, end).replace(/\r$/, ""));
      pending = pending.slice(end + 1);
      end = pending.indexOf("\n");
    }
  });

  function receive(line) {
    if (line === "") return;
    appendFileSync(streamFile, `${line}\n`);
    try {
      events.push(JSON.parse(line));
    } catch {
      unparsed += 1;
    }
  }

  // Resolves with the first record after position `from` that matches, or rejects on timeout.
  async function waitFor(predicate, from, limitMs) {
    const deadline = Date.now() + limitMs;
    for (;;) {
      const found = events.slice(from).find(predicate);
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`no matching record within ${limitMs} ms`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_MS));
    }
  }

  // Sends one command and resolves with its response, which repeats the command id.
  async function send(type, fields = {}, limitMs = COMMAND_LIMIT_MS) {
    commandCount += 1;
    const id = `${type}-${commandCount}`;
    const from = events.length;
    child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    return waitFor((record) => record.type === "response" && record.id === id, from, limitMs);
  }

  return {
    events,
    unparsedRecords: () => unparsed,
    waitFor,
    send,
    // Sends a prompt and resolves when the run it starts has ended. The response must be accepted.
    async runTurn(message) {
      const from = events.length;
      const response = await send("prompt", { message });
      if (!response.success) throw new Error(`prompt rejected: ${JSON.stringify(response)}`);
      await waitFor((record) => record.type === "agent_end", from, RUN_LIMIT_MS);
      return response;
    },
    // Ends the process. Its timers, such as the cache warming timer, end with it.
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end();
        child.kill();
        await once(child, "exit");
      }
      closeSync(stderr);
    },
  };
}
