// Synthetic Anthropic Messages endpoint for the outbound-boundary check.
// It records the raw body of every POST /v1/messages without headers, then answers with a fixed
// text: as a server-sent event stream when the request asks for one, otherwise as one JSON message.
// With --hold-responses it records the request and never answers it, so the host stays inside the
// request until it is stopped. With --input-tokens N it reports N input tokens in the usage of every
// answer; the default is 1. That number is synthetic: it only feeds Pi's own cost and size logic.
// It listens on 127.0.0.1 only and never forwards a request anywhere.
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const REPLY_PREFIX = "SYNTHETIC-REPLY from the local double";
const MESSAGES_PATH = "/v1/messages";
const DEFAULT_INPUT_TOKENS = 1;

const captureDirectory = argumentValue("--capture-dir");
const portFile = argumentValue("--port-file");
const holdResponses = process.argv.includes("--hold-responses");
const inputTokens = optionalNonNegativeInteger("--input-tokens", DEFAULT_INPUT_TOKENS);
mkdirSync(captureDirectory, { recursive: true });

let requestCount = 0;

const server = createServer((request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  if (request.method !== "POST" || pathname !== MESSAGES_PATH) {
    appendLog(`${request.method} ${pathname} 404 (not recorded)`);
    response.writeHead(404, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ type: "error", error: { type: "not_found_error", message: "synthetic" } }),
    );
    return;
  }
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const rawBody = Buffer.concat(chunks);
    requestCount += 1;
    const sequence = String(requestCount).padStart(3, "0");
    writeFileSync(join(captureDirectory, `request-${sequence}.body`), rawBody);
    const parsed = JSON.parse(rawBody.toString("utf8"));
    appendLog(
      `${sequence} POST ${MESSAGES_PATH} bytes=${rawBody.length} stream=${parsed.stream === true}`,
    );
    if (holdResponses) return;
    if (parsed.stream === true) {
      writeStream(response, parsed.model, replyText(sequence));
    } else {
      writeJson(response, parsed.model, replyText(sequence));
    }
  });
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  writeFileSync(portFile, String(port));
  appendLog(`listening 127.0.0.1:${port}`);
});

process.on("SIGTERM", () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
});

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) throw new Error(`missing ${name}`);
  return process.argv[index + 1];
}

function optionalNonNegativeInteger(name, fallback) {
  if (!process.argv.includes(name)) return fallback;
  const value = Number(argumentValue(name));
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function appendLog(line) {
  appendFileSync(join(captureDirectory, "requests.log"), `${line}\n`);
}

function message(model) {
  return {
    id: "msg_synthetic_0001",
    type: "message",
    role: "assistant",
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

// The reply names its request, so each reply is distinct: a summary that Pi reports can be traced to
// the summary request that produced it.
function replyText(sequence) {
  return `${REPLY_PREFIX} (request ${sequence}).`;
}

function writeJson(response, model, text) {
  const body = {
    ...message(model),
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
  };
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function writeStream(response, model, text) {
  const events = [
    ["message_start", { type: "message_start", message: message(model) }],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const [name, data] of events) {
    response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  response.end();
}
