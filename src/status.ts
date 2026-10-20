import type { OffEnvironmentState } from "./config.ts";
import type { ProfileDiagnostic } from "./diagnostic.ts";
import type { PiNoticeType } from "./extension-types.ts";
import { renderMessage } from "./messages.ts";
import type { ProfileSnapshot } from "./profiles.ts";
import type { ProfileSummary, SelectorResult, SelectorStatus } from "./selector.ts";
import { combinedContentBytes, OPERATIONAL_SIZE_LIMIT_BYTES } from "./selector.ts";
import type { ApplicationSource, ApplicationStatus } from "./session-state.ts";

// Presentation escapes: line and paragraph separators and the Unicode bidirectional controls
// would break lines or reorder text on screen, so they are shown as \uXXXX notation.
const PRESENTATION_CHARACTER = /^[\u2028\u2029\p{Bidi_Control}]$/u;

// Preview bodies keep LF and TAB. Every other C0 control, DEL and C1 control is escaped too, so
// an ESC or an OSC sequence in a body is shown as text and never reaches the terminal.
export function escapeLabel(text: string): string {
  return escapeCharacters(text, isPresentationCharacter);
}

export function escapeBody(text: string): string {
  return escapeCharacters(
    text,
    (character) => isPresentationCharacter(character) || isBodyControl(character),
  );
}

function isPresentationCharacter(character: string): boolean {
  return PRESENTATION_CHARACTER.test(character);
}

function isBodyControl(character: string): boolean {
  const code = character.charCodeAt(0);
  const isC0Control = code < 0x20 && code !== 0x09 && code !== 0x0a;
  const isDeleteOrC1 = code >= 0x7f && code <= 0x9f;
  return isC0Control || isDeleteOrC1;
}

// The backslash is escaped too, so every backslash in the output starts an escape and the mapping
// can be read back without ambiguity: a body that literally contains \u001B differs from an ESC.
function escapeCharacters(text: string, needsEscape: (character: string) => boolean): string {
  return Array.from(text, (character) => {
    if (character === "\\") return "\\\\";
    return needsEscape(character) ? unicodeNotation(character) : character;
  }).join("");
}

function unicodeNotation(character: string): string {
  const hex = character.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0");
  return `\\u${hex}`;
}

export function profileOptionLabel(profile: ProfileSummary): string {
  return renderMessage("list.item", { id: profile.id, name: escapeLabel(profile.name) });
}

export function noticeTypeFor(result: SelectorResult): PiNoticeType {
  if (result.kind === "failed") return "error";
  if (result.kind === "selected" && result.exceedsOperationalLimit) return "warning";
  return "info";
}

export function renderSelectorText(result: SelectorResult): string {
  switch (result.kind) {
    case "failed":
      return renderMessage("failed", { detail: describeDiagnostic(result.diagnostic) });
    case "list":
      return renderList(result.profiles, result.invalidCandidates);
    case "selected":
      return renderSelected(result.profileId, result.exceedsOperationalLimit, result.combinedBytes);
    case "off":
      return renderMessage("off");
    case "status":
      return renderStatus(result.status);
    case "preview":
      return renderPreview(result.profile);
    case "reloaded":
      return renderReloaded(result);
  }
}

// Entries are stored in the session, so they carry the same escaped text the operator sees and
// never a raw profile body.
export type SelectorEntry =
  | { readonly kind: "failed"; readonly diagnostic: ProfileDiagnostic }
  | {
      readonly kind: "list";
      readonly profiles: readonly EscapedProfileSummary[];
      readonly invalidCandidates: readonly ProfileDiagnostic[];
    }
  | {
      readonly kind: "selected";
      readonly profileId: string;
      readonly combinedBytes: number;
      readonly exceedsOperationalLimit: boolean;
    }
  | { readonly kind: "off" }
  | {
      readonly kind: "status";
      readonly pendingProfileId: string | null;
      readonly explicitOff: boolean;
      readonly environment: OffEnvironmentState;
      readonly application: ApplicationStatus;
    }
  | { readonly kind: "preview"; readonly profile: EscapedProfile; readonly combinedBytes: number }
  | {
      readonly kind: "reloaded";
      readonly catalog: ReloadedCatalogEntry;
      readonly configuration: ReloadedConfigurationEntry;
    };

interface EscapedProfileSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

interface EscapedProfile extends EscapedProfileSummary {
  readonly userText: string;
  readonly assistantText: string;
}

type ReloadedCatalogEntry =
  | {
      readonly status: "loaded";
      readonly profileCount: number;
      readonly invalidCandidates: readonly ProfileDiagnostic[];
    }
  | { readonly status: "failed"; readonly diagnostic: ProfileDiagnostic };

type ReloadedConfigurationEntry =
  | { readonly status: "loaded"; readonly defaultProfileId: string | null }
  | { readonly status: "failed"; readonly diagnostic: ProfileDiagnostic };

export function renderSelectorEntry(result: SelectorResult): SelectorEntry {
  switch (result.kind) {
    case "failed":
      return { kind: "failed", diagnostic: result.diagnostic };
    case "list":
      return {
        kind: "list",
        profiles: result.profiles.map(escapeSummary),
        invalidCandidates: result.invalidCandidates,
      };
    case "selected":
      return {
        kind: "selected",
        profileId: result.profileId,
        combinedBytes: result.combinedBytes,
        exceedsOperationalLimit: result.exceedsOperationalLimit,
      };
    case "off":
      return { kind: "off" };
    case "status":
      return { kind: "status", ...result.status };
    case "preview":
      return {
        kind: "preview",
        profile: escapeProfile(result.profile),
        combinedBytes: combinedContentBytes(result.profile),
      };
    case "reloaded":
      return {
        kind: "reloaded",
        catalog:
          result.catalog.status === "loaded"
            ? {
                status: "loaded",
                profileCount: result.catalog.profiles.length,
                invalidCandidates: result.catalog.diagnostics,
              }
            : { status: "failed", diagnostic: result.catalog.diagnostic },
        configuration:
          result.configuration.status === "loaded"
            ? { status: "loaded", defaultProfileId: result.configuration.defaultProfileId }
            : { status: "failed", diagnostic: result.configuration.diagnostic },
      };
  }
}

function escapeSummary(profile: ProfileSummary): EscapedProfileSummary {
  return {
    id: profile.id,
    name: escapeLabel(profile.name),
    description: escapeLabel(profile.description),
  };
}

function escapeProfile(profile: ProfileSnapshot): EscapedProfile {
  return {
    ...escapeSummary(profile),
    userText: escapeBody(profile.userText),
    assistantText: escapeBody(profile.assistantText),
  };
}

function renderList(
  profiles: readonly ProfileSummary[],
  invalidCandidates: readonly ProfileDiagnostic[],
): string {
  const lines =
    profiles.length === 0
      ? [renderMessage("list.empty")]
      : profiles.map((profile) => profileOptionLabel(profile));
  if (invalidCandidates.length > 0) {
    lines.push(renderMessage("list.invalid", { count: invalidCandidates.length }));
  }
  return lines.join("\n");
}

function renderSelected(
  profileId: string,
  exceedsOperationalLimit: boolean,
  combinedBytes: number,
): string {
  const lines = [renderMessage("selected", { profileId })];
  if (exceedsOperationalLimit) {
    lines.push(
      renderMessage("selected.oversize", {
        bytes: combinedBytes,
        limitKiB: OPERATIONAL_SIZE_LIMIT_BYTES / 1024,
      }),
    );
  }
  return lines.join("\n");
}

function renderStatus(status: SelectorStatus): string {
  const lines = [
    status.pendingProfileId === null
      ? renderMessage("status.noPending")
      : renderMessage("status.pending", { profileId: status.pendingProfileId }),
    renderMessage(status.explicitOff ? "status.explicitOff" : "status.notExplicitOff"),
  ];
  if (status.environment === "forced") lines.push(renderMessage("status.environmentForced"));
  if (status.environment === "invalid") lines.push(renderMessage("status.environmentInvalid"));
  lines.push(...renderApplication(status.application));
  return lines.join("\n");
}

// Metadata only: identifiers, the recorded revision, the size and the warm refresh count. The profile
// text is not part of the status, so no body can reach a notice or a session entry.
function renderApplication(application: ApplicationStatus): string[] {
  switch (application.kind) {
    case "indeterminate":
      return [renderMessage("status.applicationIndeterminate")];
    case "none":
      return [renderMessage("status.applicationNone")];
    case "invalid":
      return [renderMessage("status.applicationInvalid")];
    case "pending":
    case "committed": {
      const key =
        application.kind === "pending"
          ? "status.applicationPending"
          : "status.applicationCommitted";
      const lines = [
        renderMessage(key, {
          profileId: application.profileId,
          applicationId: application.applicationId,
          revision: application.revision,
          bytes: application.combinedBytes,
          refreshes: application.refreshes,
        }),
      ];
      lines.push(renderProvenance(application));
      if (application.provider !== null && application.model !== null) {
        lines.push(
          renderMessage("status.applicationModel", {
            provider: escapeLabel(application.provider),
            model: escapeLabel(application.model),
          }),
        );
      }
      return lines;
    }
  }
}

// The provenance is the one stored in the record, not a resolution of the current configuration: a
// binding that was removed since then still reads as the rule that chose this profile.
function renderProvenance(application: {
  readonly source: ApplicationSource | null;
  readonly bindingId: string | null;
}): string {
  switch (application.source) {
    case "manual":
      return renderMessage("status.applicationProvenance.manual");
    case "binding":
      return application.bindingId === null
        ? renderMessage("status.applicationProvenance.bindingUnknown")
        : renderMessage("status.applicationProvenance.binding", {
            bindingId: application.bindingId,
          });
    case "default":
      return renderMessage("status.applicationProvenance.default");
    case null:
      return renderMessage("status.applicationProvenance.unknown");
  }
}

function renderPreview(profile: ProfileSnapshot): string {
  return [
    renderMessage("preview.profile", { id: profile.id }),
    renderMessage("preview.name", { name: escapeLabel(profile.name) }),
    renderMessage("preview.description", { description: escapeLabel(profile.description) }),
    renderMessage("preview.combined", { bytes: combinedContentBytes(profile) }),
    renderMessage("preview.userText", { bytes: Buffer.byteLength(profile.userText) }),
    escapeBody(profile.userText),
    renderMessage("preview.assistantText", { bytes: Buffer.byteLength(profile.assistantText) }),
    escapeBody(profile.assistantText),
  ].join("\n");
}

function renderReloaded(result: Extract<SelectorResult, { kind: "reloaded" }>): string {
  const lines: string[] = [];
  if (result.catalog.status === "loaded") {
    lines.push(
      renderMessage("reload.catalog", {
        profileCount: result.catalog.profiles.length,
        invalidCount: result.catalog.diagnostics.length,
      }),
    );
  } else {
    lines.push(
      renderMessage("reload.catalogFailed", {
        detail: describeDiagnostic(result.catalog.diagnostic),
      }),
    );
  }
  if (result.configuration.status === "loaded") {
    const { defaultProfileId } = result.configuration;
    lines.push(
      defaultProfileId === null
        ? renderMessage("reload.configNone")
        : renderMessage("reload.configDefault", { profileId: defaultProfileId }),
    );
  } else {
    lines.push(
      renderMessage("reload.configFailed", {
        detail: describeDiagnostic(result.configuration.diagnostic),
      }),
    );
  }
  lines.push(renderMessage("reload.applied"));
  return lines.join("\n");
}

// Codes are stable identifiers from the library. Only command-level failures get a sentence.
function describeDiagnostic(diagnostic: ProfileDiagnostic): string {
  if (diagnostic.category === "command") return renderMessage(`command.${diagnostic.code}`);
  if (
    diagnostic.code === "environment-invalid" ||
    diagnostic.code === "agent-directory-unsupported"
  ) {
    return renderMessage(`detail.${diagnostic.code}`);
  }
  const code = `${diagnostic.category}/${diagnostic.code}`;
  if (diagnostic.profileId !== null) {
    return `${code}${renderMessage("diagnostic.profile", { profileId: diagnostic.profileId })}`;
  }
  if (diagnostic.candidateOrdinal !== null) {
    return `${code}${renderMessage("diagnostic.candidate", { ordinal: diagnostic.candidateOrdinal })}`;
  }
  return code;
}
