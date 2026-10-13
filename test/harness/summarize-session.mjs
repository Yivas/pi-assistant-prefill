// Prints the prefill records of a Pi session file and the roles of its messages. Profile text is not
// stored in records, so the output holds only phases, reasons and identifiers of the profile.
import { readFileSync } from "node:fs";

const PREFIX = "pi-assistant-prefill.";
const entries = readFileSync(process.argv[2], "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

const records = entries
  .filter((entry) => entry.type === "custom" && entry.customType.startsWith(PREFIX))
  .map((entry) => ({
    type: entry.customType.slice(PREFIX.length),
    phase: entry.data.phase ?? null,
    reason: entry.data.reason ?? null,
    profileId: entry.data.profileId ?? null,
  }));
const messageRoles = entries
  .filter((entry) => entry.type === "message")
  .map((entry) => entry.message.role);

process.stdout.write(`${JSON.stringify({ records, messageRoles }, null, 2)}\n`);
