import fs from "node:fs/promises";
import path from "node:path";
import { type ProfileDiagnostic, ProfileFailure, toDiagnostic } from "./diagnostic.ts";
import {
  decodeUtf8,
  fileOperation,
  isInsideDirectory,
  readRegularFileWithin,
  resolveLogicalPath,
  resolveRootDirectory,
} from "./file-read.ts";
import {
  type JsonObject,
  MAX_JSON_DOCUMENT_BYTES,
  parseStrictJsonObject,
  requireKnownFields,
  requireSchemaVersion,
} from "./strict-json.ts";

// Excluded from the candidates whatever its type, so a link named like it is not a profile.
export const CONFIGURATION_FILE_NAME = "config.json";

const MAX_PROFILE_CANDIDATES = 100;
const MAX_TEXT_BYTES = 65536;
const MANIFEST_FILE_NAME = "profile.json";
const USER_TEXT_FILE_NAME = "user.md";
const ASSISTANT_TEXT_FILE_NAME = "assistant.md";
const MANIFEST_FIELDS = ["schemaVersion", "id", "name", "description"] as const;

const PROFILE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROFILE_ID_MAX_LENGTH = 64;
const RESERVED_PROFILE_IDS: ReadonlySet<string> = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...numberedNames("com"),
  ...numberedNames("lpt"),
]);

function numberedNames(prefix: string): string[] {
  return Array.from({ length: 9 }, (_, index) => `${prefix}${index + 1}`);
}

export interface ProfileSnapshot {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly userText: string;
  readonly assistantText: string;
}

// `loaded` may still carry per-profile diagnostics; `failed` means no profile is usable.
export type ProfileCatalogLoad =
  | {
      readonly status: "loaded";
      readonly profiles: readonly ProfileSnapshot[];
      readonly diagnostics: readonly ProfileDiagnostic[];
    }
  | { readonly status: "failed"; readonly diagnostic: ProfileDiagnostic };

// Returns the reason an identifier is unusable, or null. Reserved names are Windows device names.
export function profileIdProblem(value: string): "invalid-id" | "reserved-id" | null {
  if (value.length > PROFILE_ID_MAX_LENGTH || !PROFILE_ID_PATTERN.test(value)) return "invalid-id";
  return RESERVED_PROFILE_IDS.has(value) ? "reserved-id" : null;
}

export function isProfileId(value: unknown): value is string {
  return typeof value === "string" && profileIdProblem(value) === null;
}

// Loads every valid profile under libraryRoot. A missing root is an empty catalog; invalid
// profiles are reported and left out without affecting the valid ones.
export async function loadProfileCatalog(libraryRoot: string): Promise<ProfileCatalogLoad> {
  try {
    return await loadCatalog(libraryRoot);
  } catch (error) {
    if (error instanceof ProfileFailure) {
      return { status: "failed", diagnostic: toDiagnostic(error, null, null) };
    }
    throw error;
  }
}

async function loadCatalog(libraryRoot: string): Promise<ProfileCatalogLoad> {
  const realRoot = await resolveRootDirectory(libraryRoot);
  if (realRoot === null) return { status: "loaded", profiles: [], diagnostics: [] };

  const names = await listCandidateNames(realRoot);
  if (names.length > MAX_PROFILE_CANDIDATES) {
    throw new ProfileFailure("catalog", "candidate-limit-exceeded");
  }

  const candidates: CandidateDirectory[] = [];
  for (const [index, name] of names.entries()) {
    candidates.push({
      name,
      ordinal: index + 1,
      directory: await resolveCandidateDirectory(realRoot, name),
    });
  }
  const sharedDirectories = findSharedDirectories(candidates);

  const profiles: ProfileSnapshot[] = [];
  const diagnostics: ProfileDiagnostic[] = [];
  for (const candidate of candidates) {
    const outcome = await loadCandidate(candidate, { realRoot, sharedDirectories });
    if (outcome.status === "valid") {
      profiles.push(outcome.profile);
    } else {
      diagnostics.push(outcome.diagnostic);
    }
  }
  return {
    status: "loaded",
    profiles: Object.freeze(profiles),
    diagnostics: Object.freeze(diagnostics),
  };
}

// Regular files are not candidates. Everything else, including links and special entries, is,
// so the 100-candidate limit counts them before any of them is validated.
async function listCandidateNames(realRoot: string): Promise<string[]> {
  const entries = await fileOperation(() => fs.readdir(realRoot, { withFileTypes: true }));
  return entries
    .filter((entry) => !entry.isFile() && entry.name !== CONFIGURATION_FILE_NAME)
    .map((entry) => entry.name)
    .sort();
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface CandidateDirectory {
  readonly name: string;
  readonly ordinal: number;
  readonly directory: CandidateLocation;
}

type CandidateLocation =
  | { readonly kind: "resolved"; readonly canonicalPath: string; readonly identity: FileIdentity }
  | { readonly kind: "failed"; readonly failure: ProfileFailure };

async function resolveCandidateDirectory(
  realRoot: string,
  name: string,
): Promise<CandidateLocation> {
  try {
    const canonicalPath = await resolveLogicalPath(path.join(realRoot, name));
    if (!isInsideDirectory(realRoot, canonicalPath)) {
      throw new ProfileFailure("identity", "outside-root");
    }
    const stats = await fileOperation(() => fs.stat(canonicalPath));
    if (!stats.isDirectory()) throw new ProfileFailure("identity", "not-directory");
    return { kind: "resolved", canonicalPath, identity: { dev: stats.dev, ino: stats.ino } };
  } catch (error) {
    if (error instanceof ProfileFailure) return { kind: "failed", failure: error };
    throw error;
  }
}

// Two candidates that resolve to one directory are ambiguous, so both are invalid.
function findSharedDirectories(candidates: readonly CandidateDirectory[]): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const { directory } of candidates) {
    if (directory.kind !== "resolved") continue;
    counts.set(directory.canonicalPath, (counts.get(directory.canonicalPath) ?? 0) + 1);
  }
  return new Set(
    [...counts].filter(([, count]) => count > 1).map(([canonicalPath]) => canonicalPath),
  );
}

interface CatalogScope {
  readonly realRoot: string;
  readonly sharedDirectories: ReadonlySet<string>;
}

type CandidateOutcome =
  | { readonly status: "valid"; readonly profile: ProfileSnapshot }
  | { readonly status: "invalid"; readonly diagnostic: ProfileDiagnostic };

async function loadCandidate(
  candidate: CandidateDirectory,
  scope: CatalogScope,
): Promise<CandidateOutcome> {
  const { name, ordinal, directory } = candidate;
  if (directory.kind === "failed") return invalidCandidate(directory.failure, null, ordinal);

  const { canonicalPath } = directory;
  if (scope.sharedDirectories.has(canonicalPath)) {
    return invalidCandidate(
      new ProfileFailure("identity", "shared-canonical-directory"),
      null,
      ordinal,
    );
  }
  const nameProblem = profileIdProblem(name);
  if (nameProblem !== null) {
    return invalidCandidate(new ProfileFailure("identity", nameProblem), null, ordinal);
  }
  if (path.basename(canonicalPath) !== name) {
    return invalidCandidate(
      new ProfileFailure("identity", "canonical-name-mismatch"),
      null,
      ordinal,
    );
  }

  // Set once the manifest validates; from then on diagnostics carry the identifier, not the ordinal.
  let validatedId: string | null = null;
  try {
    const manifestFile = await readProfileFile(
      scope.realRoot,
      canonicalPath,
      MANIFEST_FILE_NAME,
      MAX_JSON_DOCUMENT_BYTES,
    );
    const manifest = parseManifest(manifestFile.bytes, name);
    validatedId = manifest.id;
    const userFile = await readProfileFile(
      scope.realRoot,
      canonicalPath,
      USER_TEXT_FILE_NAME,
      MAX_TEXT_BYTES,
    );
    const userText = bodyText(userFile.bytes);
    const assistantFile = await readProfileFile(
      scope.realRoot,
      canonicalPath,
      ASSISTANT_TEXT_FILE_NAME,
      MAX_TEXT_BYTES,
    );
    const assistantText = bodyText(assistantFile.bytes);
    await assertProfileUnchanged(scope, name, directory, [manifestFile, userFile, assistantFile]);
    return {
      status: "valid",
      profile: Object.freeze({
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        userText,
        assistantText,
      }),
    };
  } catch (error) {
    if (error instanceof ProfileFailure) {
      return invalidCandidate(error, validatedId, validatedId === null ? ordinal : null);
    }
    throw error;
  }
}

function invalidCandidate(
  failure: ProfileFailure,
  profileId: string | null,
  candidateOrdinal: number | null,
): CandidateOutcome {
  return { status: "invalid", diagnostic: toDiagnostic(failure, profileId, candidateOrdinal) };
}

interface ProfileManifest {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

function parseManifest(bytes: Buffer, directoryName: string): ProfileManifest {
  const object = parseStrictJsonObject(decodeUtf8(bytes), "manifest");
  requireKnownFields(object, MANIFEST_FIELDS, "manifest");
  requireSchemaVersion(object, "manifest");

  const id = readRequiredString(object, "id");
  const idProblem = profileIdProblem(id);
  if (idProblem !== null) throw new ProfileFailure("identity", idProblem);
  if (id !== directoryName) throw new ProfileFailure("identity", "id-mismatch");

  return {
    id,
    name: readLabel(object, "name"),
    description: readLabel(object, "description"),
  };
}

function readRequiredString(object: JsonObject, field: string): string {
  if (!Object.hasOwn(object, field)) throw new ProfileFailure("manifest", "missing-field");
  const value = object[field];
  if (typeof value !== "string") throw new ProfileFailure("manifest", "invalid-field");
  return value;
}

// Labels are shown in interfaces, so they cannot carry C0/C1 controls. Blank means only
// ECMAScript white space and line terminators; the value itself is not trimmed.
function readLabel(object: JsonObject, field: string): string {
  const value = readRequiredString(object, field);
  if (hasControlCharacter(value)) throw new ProfileFailure("manifest", "control-character");
  if (/^\s*$/.test(value)) throw new ProfileFailure("manifest", "blank-field");
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function bodyText(bytes: Buffer): string {
  const text = decodeUtf8(bytes);
  if (/^\s*$/.test(text)) throw new ProfileFailure("text", "empty-body");
  return text;
}

interface ProfileFile {
  readonly fileName: string;
  readonly maxBytes: number;
  readonly bytes: Buffer;
}

async function readProfileFile(
  realRoot: string,
  directory: string,
  fileName: string,
  maxBytes: number,
): Promise<ProfileFile> {
  const bytes = await readRegularFileWithin(realRoot, path.join(directory, fileName), maxBytes);
  return { fileName, maxBytes, bytes };
}

// Runs after the last file was read. Each file is read again through readRegularFileWithin and
// its bytes are compared with the first read; a difference fails the candidate. The directory must
// resolve to the same canonical path and keep the device and inode recorded at resolution. The
// check reports differences it observes between the first and the second read. A change made after
// this check, or reverted before it, is not reported, and the reads are not a transaction against
// another process running as the same user.
async function assertProfileUnchanged(
  scope: CatalogScope,
  name: string,
  directory: { readonly canonicalPath: string; readonly identity: FileIdentity },
  files: readonly ProfileFile[],
): Promise<void> {
  const current = await resolveLogicalPath(path.join(scope.realRoot, name));
  if (current !== directory.canonicalPath) throw new ProfileFailure("file", "changed-during-read");
  const stats = await fileOperation(() => fs.stat(directory.canonicalPath));
  if (stats.dev !== directory.identity.dev || stats.ino !== directory.identity.ino) {
    throw new ProfileFailure("file", "changed-during-read");
  }
  for (const file of files) {
    const bytes = await readRegularFileWithin(
      scope.realRoot,
      path.join(directory.canonicalPath, file.fileName),
      file.maxBytes,
    );
    if (!bytes.equals(file.bytes)) throw new ProfileFailure("file", "changed-during-read");
  }
}
