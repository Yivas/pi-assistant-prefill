// Child process of selection-atomicity.mjs. It runs the product's saveSelection or readSelection in a
// process of its own, so the driver can stop it at a chosen point and read the state from a new
// process afterwards. Modes:
//   save --state-dir <dir> --choice off|profile [--stop-at <point> --control <dir>]
//   loop --state-dir <dir> --iterations <count>
//   read --state-dir <dir>
// A stop point makes the process wait where it is, after writing its point name to <control>/reached,
// so the driver can end it with SIGKILL. Points: during-write (half of the new bytes are on disk),
// before-rename (the new temporary file is complete and synced, the state still holds the old
// content) and after-rename (the rename has returned, nothing else has run).
import fs from "node:fs/promises";
import { join } from "node:path";
import { readSelection, saveSelection } from "../../src/selection.ts";

const HOLD_MS = 60_000;

const [mode, ...flags] = process.argv.slice(2);
const options = parseFlags(flags);
const stateDirectory = options["--state-dir"];

if (mode === "save") {
  if (options["--stop-at"] !== undefined) stopAt(options["--stop-at"], options["--control"]);
  const choice =
    options["--choice"] === "off"
      ? { kind: "off" }
      : { kind: "profile", profileId: "brief-example" };
  report(await saveSelection(stateDirectory, choice));
} else if (mode === "loop") {
  const iterations = Number(options["--iterations"]);
  for (let index = 0; index < iterations; index += 1) {
    const choice =
      index % 2 === 0 ? { kind: "off" } : { kind: "profile", profileId: "brief-example" };
    const result = await saveSelection(stateDirectory, choice);
    if (result.status !== "saved") report(result, 3);
  }
  report({ status: "completed", iterations });
} else if (mode === "read") {
  report(await readSelection(stateDirectory));
} else {
  console.error("usage: selection-child.mjs save|loop|read ...");
  process.exit(2);
}

function parseFlags(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) values[argv[index]] = argv[index + 1];
  return values;
}

function report(value, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exit(exitCode);
}

// Each stop point replaces one step of the product's write with a wait. The wrapped functions are
// the ones saveSelection calls through the default export of node:fs/promises.
function stopAt(point, controlDirectory) {
  const mark = () => fs.writeFile(join(controlDirectory, "reached"), point);
  const holdForever = () => new Promise(() => setInterval(() => {}, HOLD_MS));
  if (point === "before-rename") {
    fs.rename = async () => {
      await mark();
      return holdForever();
    };
    return;
  }
  if (point === "after-rename") {
    const realRename = fs.rename;
    fs.rename = async (from, to) => {
      await realRename(from, to);
      await mark();
      return holdForever();
    };
    return;
  }
  if (point === "during-write") {
    const realOpen = fs.open;
    fs.open = async (filePath, flags, ...rest) => {
      const handle = await realOpen(filePath, flags, ...rest);
      if (flags !== "wx") return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === "writeFile") {
            return async (text) => {
              const bytes = Buffer.from(text);
              await target.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
              await mark();
              return holdForever();
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    return;
  }
  console.error(`unknown stop point: ${point}`);
  process.exit(2);
}
