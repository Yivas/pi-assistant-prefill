export type ProfileDiagnosticCategory =
  | "configuration"
  | "selection"
  | "command"
  | "catalog"
  | "identity"
  | "file"
  | "manifest"
  | "text"
  | "size";

export type ProfileDiagnosticCode =
  | "root-not-directory"
  | "candidate-limit-exceeded"
  | "profile-unavailable"
  | "default-profile-unavailable"
  | "binding-profile-unavailable"
  | "duplicate-binding"
  | "environment-invalid"
  | "agent-directory-unsupported"
  | "invalid-id"
  | "reserved-id"
  | "canonical-name-mismatch"
  | "shared-canonical-directory"
  | "id-mismatch"
  | "outside-root"
  | "not-directory"
  | "broken-link"
  | "cyclic-link"
  | "missing-file"
  | "not-regular-file"
  | "permission-denied"
  | "changed-during-read"
  | "io-error"
  | "invalid-json"
  | "duplicate-key"
  | "not-object"
  | "unknown-field"
  | "missing-field"
  | "invalid-field"
  | "unsupported-schema-version"
  | "conflicting-selection"
  | "unknown-subcommand"
  | "unexpected-argument"
  | "control-character"
  | "blank-field"
  | "invalid-utf8"
  | "empty-body"
  | "too-large";

// Safe to show: it carries a validated identifier or a candidate ordinal, never names, paths or text.
export interface ProfileDiagnostic {
  readonly category: ProfileDiagnosticCategory;
  readonly code: ProfileDiagnosticCode;
  readonly profileId: string | null;
  readonly candidateOrdinal: number | null;
}

// Internal failure raised while validating; it becomes a ProfileDiagnostic at the candidate or call boundary.
export class ProfileFailure extends Error {
  readonly category: ProfileDiagnosticCategory;
  readonly code: ProfileDiagnosticCode;

  constructor(category: ProfileDiagnosticCategory, code: ProfileDiagnosticCode) {
    super(code);
    this.name = "ProfileFailure";
    this.category = category;
    this.code = code;
  }
}

export function toDiagnostic(
  failure: ProfileFailure,
  profileId: string | null,
  candidateOrdinal: number | null,
): ProfileDiagnostic {
  return Object.freeze({
    category: failure.category,
    code: failure.code,
    profileId,
    candidateOrdinal,
  });
}
