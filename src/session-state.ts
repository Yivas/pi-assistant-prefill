import { isBindingId, isRegistryIdentifier } from "./config.ts";
import type { PiReadonlySessionManager, PiSessionEntry } from "./extension-types.ts";
import { isProfileId } from "./profiles.ts";

// Application state lives in custom session entries. Pi keeps them out of the model context, so
// writing them never changes what a request contains. Only the projection reads them back.
export const APPLICATION_ENTRY_TYPE = "pi-assistant-prefill.application";
export const DIAGNOSTIC_ENTRY_TYPE = "pi-assistant-prefill.diagnostic";

// Record data carries its own format version, independent of the profile and selection formats.
const RECORD_SCHEMA_VERSION = 1;
const APPLICATION_FIELDS = [
  "schemaVersion",
  "phase",
  "applicationId",
  "profileId",
  "revision",
  "combinedBytes",
  "source",
  "bindingId",
  "provider",
  "model",
] as const;
const DIAGNOSTIC_FIELDS = ["schemaVersion", "reason", "profileId", "detail"] as const;
const APPLICATION_PHASES = ["intent", "projected", "committed"] as const;
const APPLICATION_SOURCES = ["manual", "binding", "default"] as const;
// `destination-not-anthropic` is retired: no handler writes it, but sessions of 0.1.x still carry it,
// so it stays a readable reason instead of turning those branches into invalid ones.
const DIAGNOSTIC_REASONS = [
  "invalid-record",
  "selection-incompatible",
  "library-failed",
  "profile-unavailable",
  "revision-mismatch",
  "destination-not-anthropic",
] as const;

// Each phase must follow the previous one for the same application. The rank checks the order.
const PHASE_RANK: Readonly<Record<ApplicationPhase, number>> = {
  intent: 1,
  projected: 2,
  committed: 3,
};
const APPLICATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REVISION_PATTERN = /^[0-9a-f]{64}$/;

export type ApplicationPhase = (typeof APPLICATION_PHASES)[number];
export type ApplicationSource = (typeof APPLICATION_SOURCES)[number];
export type PrefixDiagnosticReason = (typeof DIAGNOSTIC_REASONS)[number];

// The profile text is not stored. The revision is a SHA-256 hex digest of the three profile files.
// The provenance fields were added after the first record format: null means the record predates
// them, so a branch written by an earlier version still reads as it did.
export interface ApplicationRecord {
  readonly applicationId: string;
  readonly profileId: string;
  readonly revision: string;
  readonly combinedBytes: number;
  readonly source: ApplicationSource | null;
  readonly bindingId: string | null;
  readonly provider: string | null;
  readonly model: string | null;
}

// Safe to store and show: identifiers, a reason and a category/code pair. Never text or paths.
export interface PrefixDiagnostic {
  readonly reason: PrefixDiagnosticReason;
  readonly profileId: string | null;
  readonly detail: string | null;
}

export type BranchPrefixState =
  | { readonly kind: "none" }
  | { readonly kind: "invalid" }
  | { readonly kind: "pending"; readonly application: ApplicationRecord }
  | { readonly kind: "committed"; readonly application: ApplicationRecord };

// What `/prefill status` shows about the branch. Metadata only: no profile text is part of it.
// `indeterminate` means the command did not receive a session to read.
export type ApplicationStatus =
  | { readonly kind: "indeterminate" }
  | { readonly kind: "none" }
  | { readonly kind: "invalid" }
  | {
      readonly kind: "pending" | "committed";
      readonly applicationId: string;
      readonly profileId: string;
      readonly revision: string;
      readonly combinedBytes: number;
      readonly source: ApplicationSource | null;
      readonly bindingId: string | null;
      readonly provider: string | null;
      readonly model: string | null;
      readonly refreshes: number;
    };

export const INDETERMINATE_APPLICATION: ApplicationStatus = { kind: "indeterminate" };

interface ApplicationEntry {
  readonly phase: ApplicationPhase;
  readonly application: ApplicationRecord;
}

type OpenApplication = ApplicationEntry;

const NO_APPLICATION: BranchPrefixState = { kind: "none" };
const INVALID_BRANCH: BranchPrefixState = { kind: "invalid" };

// Derives the state of one branch from its entries alone. Nothing is written, so re-deriving after
// a restart or a navigation yields the same state. Any record that does not match the format makes
// the whole branch invalid: a corrupt record is never read as a valid state. Diagnostic entries
// report an observation and do not change the state.
export function deriveBranchPrefixState(branch: readonly PiSessionEntry[]): BranchPrefixState {
  let open: OpenApplication | null = null;
  for (const entry of branch) {
    if (entry.type !== "custom") continue;
    if (entry.customType === APPLICATION_ENTRY_TYPE) {
      const record = readApplicationData(entry.data);
      if (record === null) return INVALID_BRANCH;
      open = advanceApplication(open, record);
      if (open === null) return INVALID_BRANCH;
    } else if (entry.customType === DIAGNOSTIC_ENTRY_TYPE) {
      if (readDiagnosticData(entry.data) === null) return INVALID_BRANCH;
    }
  }
  if (open === null) return NO_APPLICATION;
  return open.phase === "committed"
    ? { kind: "committed", application: open.application }
    : { kind: "pending", application: open.application };
}

// A branch holds at most one application. A record for another application, or one out of
// order, makes the branch invalid.
function advanceApplication(
  open: OpenApplication | null,
  record: ApplicationEntry,
): OpenApplication | null {
  if (open === null) {
    return record.phase === "intent"
      ? { phase: record.phase, application: record.application }
      : null;
  }
  const sameApplication = sameRecord(open.application, record.application);
  const followsPrevious = PHASE_RANK[record.phase] === PHASE_RANK[open.phase] + 1;
  if (!sameApplication || !followsPrevious) return null;
  return { phase: record.phase, application: open.application };
}

function sameRecord(left: ApplicationRecord, right: ApplicationRecord): boolean {
  return (
    left.applicationId === right.applicationId &&
    left.profileId === right.profileId &&
    left.revision === right.revision &&
    left.combinedBytes === right.combinedBytes &&
    left.source === right.source &&
    left.bindingId === right.bindingId &&
    left.provider === right.provider &&
    left.model === right.model
  );
}

// True when the branch already holds a message of the conversation. A new application may only
// start on a branch without one, because the example opens a conversation and cannot follow one.
// The rules mirror how Pi projects entries into model messages: system messages, custom entries
// and model or thinking changes are not conversation.
export function hasConversation(branch: readonly PiSessionEntry[]): boolean {
  return branch.some(isConversationalEntry);
}

function isConversationalEntry(entry: PiSessionEntry): boolean {
  switch (entry.type) {
    case "message":
      return entry.message !== undefined && entry.message.role !== "system";
    case "custom_message":
    case "compaction":
      return true;
    case "branch_summary":
      return entry.summary !== undefined && entry.summary !== "";
    default:
      return false;
  }
}

// The last diagnostic of the branch, used to avoid writing the same diagnostic on every request.
export function lastDiagnostic(branch: readonly PiSessionEntry[]): PrefixDiagnostic | null {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type === "custom" && entry.customType === DIAGNOSTIC_ENTRY_TYPE) {
      return readDiagnosticData(entry.data);
    }
  }
  return null;
}

export function sameDiagnostic(left: PrefixDiagnostic | null, right: PrefixDiagnostic): boolean {
  return (
    left !== null &&
    left.reason === right.reason &&
    left.profileId === right.profileId &&
    left.detail === right.detail
  );
}

export function applicationData(
  phase: ApplicationPhase,
  application: ApplicationRecord,
): Record<string, unknown> {
  return { schemaVersion: RECORD_SCHEMA_VERSION, phase, ...application };
}

export function diagnosticData(diagnostic: PrefixDiagnostic): Record<string, unknown> {
  return { schemaVersion: RECORD_SCHEMA_VERSION, ...diagnostic };
}

function readApplicationData(data: unknown): ApplicationEntry | null {
  if (!isRecordWithFields(data, APPLICATION_FIELDS)) return null;
  const { phase, applicationId, profileId, revision, combinedBytes } = data;
  if (data.schemaVersion !== RECORD_SCHEMA_VERSION) return null;
  if (!isApplicationPhase(phase)) return null;
  if (typeof applicationId !== "string" || !APPLICATION_ID_PATTERN.test(applicationId)) return null;
  if (typeof profileId !== "string" || !isProfileId(profileId)) return null;
  if (typeof revision !== "string" || !REVISION_PATTERN.test(revision)) return null;
  if (typeof combinedBytes !== "number" || !Number.isSafeInteger(combinedBytes)) return null;
  if (combinedBytes < 0) return null;
  const provenance = readProvenance(data);
  if (provenance === null) return null;
  return {
    phase,
    application: { applicationId, profileId, revision, combinedBytes, ...provenance },
  };
}

// The provenance fields were added after the first format. Absent and null both mean "not recorded";
// a present value outside the format makes the whole record invalid, as any other broken field does.
function readProvenance(data: Record<string, unknown>): Provenance | null {
  const source = readOptionalField(data.source, isApplicationSource);
  const bindingId = readOptionalField(data.bindingId, isBindingId);
  const provider = readOptionalField(data.provider, isRegistryIdentifier);
  const model = readOptionalField(data.model, isRegistryIdentifier);
  if (
    source === undefined ||
    bindingId === undefined ||
    provider === undefined ||
    model === undefined
  ) {
    return null;
  }
  return { source, bindingId, provider, model };
}

type Provenance = Pick<ApplicationRecord, "source" | "bindingId" | "provider" | "model">;

// Undefined means the value is present but outside the format. Null means it is not recorded.
function readOptionalField<T>(
  value: unknown,
  isValid: (candidate: unknown) => candidate is T,
): T | null | undefined {
  if (value === undefined || value === null) return null;
  return isValid(value) ? value : undefined;
}

function readDiagnosticData(data: unknown): PrefixDiagnostic | null {
  if (!isRecordWithFields(data, DIAGNOSTIC_FIELDS)) return null;
  const { reason, profileId, detail } = data;
  if (data.schemaVersion !== RECORD_SCHEMA_VERSION) return null;
  if (!isDiagnosticReason(reason)) return null;
  if (profileId !== null && (typeof profileId !== "string" || !isProfileId(profileId))) return null;
  if (detail !== null && typeof detail !== "string") return null;
  return { reason, profileId, detail };
}

function isRecordWithFields(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.keys(value).every((key) => fields.includes(key));
}

function isApplicationPhase(value: unknown): value is ApplicationPhase {
  return (APPLICATION_PHASES as readonly unknown[]).includes(value);
}

function isApplicationSource(value: unknown): value is ApplicationSource {
  return (APPLICATION_SOURCES as readonly unknown[]).includes(value);
}

function isDiagnosticReason(value: unknown): value is PrefixDiagnosticReason {
  return (DIAGNOSTIC_REASONS as readonly unknown[]).includes(value);
}

// Caches the state of the current leaf. A branch is append-only, so the state of a leaf cannot
// change while it stays the leaf. Moving to another leaf derives the state again. The owner calls
// reset on session_start and session_tree, because a replaced session can reuse no earlier state.
export class CurrentLeafState {
  private cached: { readonly leafId: string | null; readonly state: BranchPrefixState } | null =
    null;

  reset(): void {
    this.cached = null;
  }

  of(sessionManager: PiReadonlySessionManager): BranchPrefixState {
    const leafId = sessionManager.getLeafId();
    const cached = this.cached;
    if (cached !== null && cached.leafId === leafId) return cached.state;
    const state = deriveBranchPrefixState(sessionManager.getBranch());
    this.cached = { leafId, state };
    return state;
  }
}
