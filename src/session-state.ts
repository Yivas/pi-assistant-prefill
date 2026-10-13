import type { PiReadonlySessionManager, PiSessionEntry } from "./extension-types.ts";
import { isProfileId } from "./profiles.ts";

// Application state lives in custom session entries. Pi keeps them out of the model context, so
// writing them never changes what a request contains. Only the projection reads them back.
export const APPLICATION_ENTRY_TYPE = "pi-assistant-prefill.application";
export const DIAGNOSTIC_ENTRY_TYPE = "pi-assistant-prefill.diagnostic";

// Provider and API that Pi 1.1.0 gives to physical Anthropic chat models (pi-ai catalog). A virtual
// model carries api "pi-virtual" instead, and Pi does not export that constant, so the check uses
// the positive pair and a virtual selection never matches it. This is a conservative rule: another
// provider that speaks the same protocol is treated as not Anthropic (see docs/projection.md).
export const ANTHROPIC_PROVIDER = "anthropic";
export const ANTHROPIC_API = "anthropic-messages";

// Record data carries its own format version, independent of the profile and selection formats.
const RECORD_SCHEMA_VERSION = 1;
const APPLICATION_FIELDS = [
  "schemaVersion",
  "phase",
  "applicationId",
  "profileId",
  "revision",
  "combinedBytes",
] as const;
const DIAGNOSTIC_FIELDS = ["schemaVersion", "reason", "profileId", "detail"] as const;
const APPLICATION_PHASES = ["intent", "projected", "committed"] as const;
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
export type PrefixDiagnosticReason = (typeof DIAGNOSTIC_REASONS)[number];

// The profile text is not stored. The revision is a SHA-256 hex digest of the three profile files.
export interface ApplicationRecord {
  readonly applicationId: string;
  readonly profileId: string;
  readonly revision: string;
  readonly combinedBytes: number;
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
      readonly suspended: boolean;
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
// the whole branch invalid: a corrupt record is never read as a valid state. Destination diagnostics
// report an observation and do not change the state; the suspension is read from the responses.
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
    left.combinedBytes === right.combinedBytes
  );
}

// True when the latest assistant response of the branch came from a destination other than
// physical Anthropic. Pi persists provider and api on every assistant message, so this is the
// observed destination, not the selection. The projection stays suspended while it is true.
export function latestDestinationIncompatible(branch: readonly PiSessionEntry[]): boolean {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type === "message" && entry.message?.role === "assistant") {
      return !isAnthropicDestination(entry.message);
    }
  }
  return false;
}

// True when the latest assistant response is not Anthropic and the response before it was Anthropic,
// or there was none. That is the moment a branch leaves physical Anthropic. A repeated response from
// the same destination is not a change, so it is not reported again.
export function destinationChangedToIncompatible(branch: readonly PiSessionEntry[]): boolean {
  const responses = branch.filter(
    (entry) => entry.type === "message" && entry.message?.role === "assistant",
  );
  const latest = responses.at(-1)?.message;
  const previous = responses.at(-2)?.message;
  if (latest === undefined || isAnthropicDestination(latest)) return false;
  return previous === undefined || isAnthropicDestination(previous);
}

export function isAnthropicDestination(value: {
  readonly provider?: string;
  readonly api?: string;
}): boolean {
  return value.provider === ANTHROPIC_PROVIDER && value.api === ANTHROPIC_API;
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
  return {
    phase,
    application: { applicationId, profileId, revision, combinedBytes },
  };
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
