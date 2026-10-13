import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ProfileChoice } from "./config.ts";
import { type ProfileDiagnostic, ProfileFailure, toDiagnostic } from "./diagnostic.ts";
import {
  decodeUtf8,
  fileOperation,
  lstatIfPresent,
  readRegularFileWithin,
  resolveRootDirectory,
} from "./file-read.ts";
import { profileIdProblem } from "./profiles.ts";
import {
  type JsonObject,
  MAX_JSON_DOCUMENT_BYTES,
  parseStrictJsonObject,
  requireKnownFields,
  requireSchemaVersion,
} from "./strict-json.ts";

export const SELECTION_FILE_NAME = "selection.json";

// The selection state has its own format version, independent of the profile format.
const SELECTION_SCHEMA_VERSION = 1;
const SELECTION_FIELDS = ["schemaVersion", "profileId", "disabled"] as const;
const UNSET_CHOICE: ProfileChoice = { kind: "unset" };

// What a subcommand can record. "unset" is only ever the absence of a state file.
export type SelectionChoice = Exclude<ProfileChoice, { readonly kind: "unset" }>;

export type SelectionLoad =
  | { readonly status: "loaded"; readonly choice: ProfileChoice }
  | { readonly status: "failed"; readonly diagnostic: ProfileDiagnostic };

export type SelectionSave =
  | { readonly status: "saved" }
  | { readonly status: "failed"; readonly diagnostic: ProfileDiagnostic };

// A missing state directory or file means no choice. Any other problem is reported and nothing
// is repaired or reset.
export async function readSelection(stateDirectory: string): Promise<SelectionLoad> {
  try {
    return { status: "loaded", choice: await readChoice(stateDirectory) };
  } catch (error) {
    return { status: "failed", diagnostic: failureDiagnostic(error) };
  }
}

// Refuses to replace a state it cannot read. An unreadable, invalid or future-version file stays
// exactly as it is and the failure is reported. The read result itself is not needed here.
export async function saveSelection(
  stateDirectory: string,
  choice: SelectionChoice,
): Promise<SelectionSave> {
  try {
    await readChoice(stateDirectory);
    await writeStateFile(stateDirectory, serializeChoice(choice));
    return { status: "saved" };
  } catch (error) {
    return { status: "failed", diagnostic: failureDiagnostic(error) };
  }
}

function failureDiagnostic(error: unknown): ProfileDiagnostic {
  if (error instanceof ProfileFailure) return toDiagnostic(error, null, null);
  throw error;
}

async function readChoice(stateDirectory: string): Promise<ProfileChoice> {
  const realDirectory = await resolveRootDirectory(stateDirectory);
  if (realDirectory === null) return UNSET_CHOICE;
  const filePath = path.join(realDirectory, SELECTION_FILE_NAME);
  if ((await lstatIfPresent(filePath)) === null) return UNSET_CHOICE;

  const bytes = await readRegularFileWithin(realDirectory, filePath, MAX_JSON_DOCUMENT_BYTES);
  const object = parseStrictJsonObject(decodeUtf8(bytes), "selection");
  requireKnownFields(object, SELECTION_FIELDS, "selection");
  requireSchemaVersion(object, "selection", SELECTION_SCHEMA_VERSION);
  return readChoiceFields(object);
}

// A disabled state carries no profile: "off" clears the pending choice, so both together would
// describe a state the subcommands never write.
function readChoiceFields(object: JsonObject): ProfileChoice {
  const profileId = readProfileIdField(object);
  const disabled = readDisabledField(object);
  if (disabled && profileId !== null) {
    throw new ProfileFailure("selection", "conflicting-selection");
  }
  if (disabled) return { kind: "off" };
  if (profileId === null) return UNSET_CHOICE;
  return { kind: "profile", profileId };
}

function readProfileIdField(object: JsonObject): string | null {
  if (!Object.hasOwn(object, "profileId")) throw new ProfileFailure("selection", "missing-field");
  const value = object.profileId;
  if (value === null) return null;
  if (typeof value !== "string") throw new ProfileFailure("selection", "invalid-field");
  const problem = profileIdProblem(value);
  if (problem !== null) throw new ProfileFailure("selection", problem);
  return value;
}

function readDisabledField(object: JsonObject): boolean {
  if (!Object.hasOwn(object, "disabled")) throw new ProfileFailure("selection", "missing-field");
  if (typeof object.disabled !== "boolean") {
    throw new ProfileFailure("selection", "invalid-field");
  }
  return object.disabled;
}

function serializeChoice(choice: SelectionChoice): string {
  const fields =
    choice.kind === "off"
      ? { profileId: null, disabled: true }
      : { profileId: choice.profileId, disabled: false };
  return `${JSON.stringify({ schemaVersion: SELECTION_SCHEMA_VERSION, ...fields }, null, 2)}\n`;
}

// The new content goes to a temporary file in the same directory, then replaces the state with a
// rename. The previous file is never deleted first, so an interrupted write keeps one of the two.
async function writeStateFile(stateDirectory: string, text: string): Promise<void> {
  await fileOperation(() => fs.mkdir(stateDirectory, { recursive: true }));
  const filePath = path.join(stateDirectory, SELECTION_FILE_NAME);
  const temporaryPath = path.join(stateDirectory, `${SELECTION_FILE_NAME}.${randomUUID()}.tmp`);
  try {
    await writeSyncedFile(temporaryPath, text);
    await fileOperation(() => fs.rename(temporaryPath, filePath));
  } catch (error) {
    // The write or rename failure is the one reported. A failed cleanup must not replace it.
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeSyncedFile(filePath: string, text: string): Promise<void> {
  const handle = await fileOperation(() => fs.open(filePath, "wx"));
  try {
    await fileOperation(() => handle.writeFile(text));
    await fileOperation(() => handle.sync());
  } finally {
    await fileOperation(() => handle.close());
  }
}
