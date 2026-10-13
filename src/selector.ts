import {
  loadProfileConfig,
  type OffEnvironmentState,
  type ProfileConfigLoad,
  type ProfileEnvironment,
  readOffEnvironment,
} from "./config.ts";
import type { PiArgumentCompletion } from "./extension-types.ts";
import { type ProfileDiagnostic, ProfileFailure, toDiagnostic } from "./diagnostic.ts";
import {
  isProfileId,
  loadProfileCatalog,
  type ProfileCatalogLoad,
  type ProfileSnapshot,
} from "./profiles.ts";
import { readSelection, type SelectionChoice, saveSelection } from "./selection.ts";
import { type ApplicationStatus, INDETERMINATE_APPLICATION } from "./session-state.ts";

export const SELECTOR_COMMANDS = ["list", "use", "off", "status", "preview", "reload"] as const;
export type SelectorCommand = (typeof SELECTOR_COMMANDS)[number];

// Operational threshold, not a limit of Pi or of any model: a selection above it is still
// recorded, and the notice reports the size so the operator can decide to shorten the profile.
export const OPERATIONAL_SIZE_LIMIT_BYTES = 16 * 1024;

export interface SelectorOptions {
  readonly libraryRoot: string;
  readonly stateDirectory: string;
  readonly environment: ProfileEnvironment;
}

export interface ProfileSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

// The application state is read from the session branch by the command handler. The selector
// itself has no session, so it reports the state as indeterminate.
export interface SelectorStatus {
  readonly pendingProfileId: string | null;
  readonly explicitOff: boolean;
  readonly environment: OffEnvironmentState;
  readonly application: ApplicationStatus;
}

export interface SelectorFailure {
  readonly kind: "failed";
  readonly diagnostic: ProfileDiagnostic;
}

export type SelectorResult =
  | SelectorFailure
  | {
      readonly kind: "list";
      readonly profiles: readonly ProfileSummary[];
      readonly invalidCandidates: readonly ProfileDiagnostic[];
    }
  | {
      readonly kind: "selected";
      readonly profileId: string;
      readonly combinedBytes: number;
      readonly exceedsOperationalLimit: boolean;
    }
  | { readonly kind: "off" }
  | { readonly kind: "status"; readonly status: SelectorStatus }
  | { readonly kind: "preview"; readonly profile: ProfileSnapshot }
  | {
      readonly kind: "reloaded";
      readonly catalog: ProfileCatalogLoad;
      readonly configuration: ProfileConfigLoad;
    };

export type ParsedSelectorText =
  | { readonly kind: "parsed"; readonly command: SelectorCommand; readonly argument: string }
  | SelectorFailure;

// Only ASCII whitespace separates tokens. Quotes and escapes have no meaning, so an argument
// keeps every character after the subcommand's separator run.
const EDGE_WHITESPACE = /^[ \t\n\r\f]+|[ \t\n\r\f]+$/g;
const LEADING_WHITESPACE = /^[ \t\n\r\f]+/;
const ASCII_WHITESPACE = /[ \t\n\r\f]/;

export function parseSelectorText(text: string): ParsedSelectorText {
  const trimmed = text.replace(EDGE_WHITESPACE, "");
  if (trimmed === "") return { kind: "parsed", command: "list", argument: "" };

  const separator = trimmed.search(ASCII_WHITESPACE);
  const word = separator === -1 ? trimmed : trimmed.slice(0, separator);
  const argument = separator === -1 ? "" : trimmed.slice(separator).replace(LEADING_WHITESPACE, "");
  if (!isSelectorCommand(word)) return commandFailure("unknown-subcommand");
  return { kind: "parsed", command: word, argument };
}

function isSelectorCommand(word: string): word is SelectorCommand {
  return (SELECTOR_COMMANDS as readonly string[]).includes(word);
}

// Subcommand completion only: profile identifiers need the catalog, and the completion callback
// is synchronous.
export function completeSubcommands(argumentPrefix: string): PiArgumentCompletion[] | null {
  const prefix = argumentPrefix.replace(LEADING_WHITESPACE, "");
  if (ASCII_WHITESPACE.test(prefix)) return null;
  const matches = SELECTOR_COMMANDS.filter((command) => command.startsWith(prefix)).map(
    (command) => ({ value: command, label: command }),
  );
  return matches.length > 0 ? matches : null;
}

export async function executeSelectorCommand(
  parsed: ParsedSelectorText,
  options: SelectorOptions,
): Promise<SelectorResult> {
  if (parsed.kind === "failed") return parsed;
  const { command, argument } = parsed;
  if (command === "use" || command === "preview") {
    if (!isProfileId(argument)) return commandFailure("invalid-id");
    return command === "use" ? selectProfile(argument, options) : previewProfile(argument, options);
  }
  if (argument !== "") return commandFailure("unexpected-argument");
  switch (command) {
    case "list":
      return listProfiles(options);
    case "off":
      return turnOff(options);
    case "status":
      return readStatus(options);
    case "reload":
      return reloadCatalog(options);
  }
}

export async function listProfiles(options: SelectorOptions): Promise<SelectorResult> {
  const catalog = await loadProfileCatalog(options.libraryRoot);
  if (catalog.status === "failed") return { kind: "failed", diagnostic: catalog.diagnostic };
  return {
    kind: "list",
    profiles: catalog.profiles.map(summarize),
    invalidCandidates: catalog.diagnostics,
  };
}

// The catalog is checked before the write, so only a valid identifier of a usable profile is
// recorded. The write itself refuses to replace an unreadable state.
// An unsupported PI_PREFILL_OFF value blocks new selections, as in resolveProfile. An explicit
// off still works, so it is the only write allowed in that state.
export async function selectProfile(
  profileId: string,
  options: SelectorOptions,
): Promise<SelectorResult> {
  if (readOffEnvironment(options.environment) === "invalid") {
    const failure = new ProfileFailure("configuration", "environment-invalid");
    return { kind: "failed", diagnostic: toDiagnostic(failure, null, null) };
  }
  const catalog = await loadProfileCatalog(options.libraryRoot);
  if (catalog.status === "failed") return { kind: "failed", diagnostic: catalog.diagnostic };
  const profile = catalog.profiles.find((candidate) => candidate.id === profileId);
  if (profile === undefined) return unavailableProfile(profileId);

  const saved = await saveSelection(options.stateDirectory, { kind: "profile", profileId });
  if (saved.status === "failed") return { kind: "failed", diagnostic: saved.diagnostic };
  const combinedBytes = combinedContentBytes(profile);
  return {
    kind: "selected",
    profileId,
    combinedBytes,
    exceedsOperationalLimit: combinedBytes > OPERATIONAL_SIZE_LIMIT_BYTES,
  };
}

export async function turnOff(options: SelectorOptions): Promise<SelectorResult> {
  const choice: SelectionChoice = { kind: "off" };
  const saved = await saveSelection(options.stateDirectory, choice);
  if (saved.status === "failed") return { kind: "failed", diagnostic: saved.diagnostic };
  return { kind: "off" };
}

async function readStatus(options: SelectorOptions): Promise<SelectorResult> {
  const selection = await readSelection(options.stateDirectory);
  if (selection.status === "failed") return { kind: "failed", diagnostic: selection.diagnostic };
  const { choice } = selection;
  return {
    kind: "status",
    status: {
      pendingProfileId: choice.kind === "profile" ? choice.profileId : null,
      explicitOff: choice.kind === "off",
      environment: readOffEnvironment(options.environment),
      application: INDETERMINATE_APPLICATION,
    },
  };
}

async function previewProfile(
  profileId: string,
  options: SelectorOptions,
): Promise<SelectorResult> {
  const catalog = await loadProfileCatalog(options.libraryRoot);
  if (catalog.status === "failed") return { kind: "failed", diagnostic: catalog.diagnostic };
  const profile = catalog.profiles.find((candidate) => candidate.id === profileId);
  if (profile === undefined) return unavailableProfile(profileId);
  return { kind: "preview", profile };
}

// Reads the catalog and the library configuration again. Nothing is applied or written.
async function reloadCatalog(options: SelectorOptions): Promise<SelectorResult> {
  const catalog = await loadProfileCatalog(options.libraryRoot);
  const configuration = await loadProfileConfig(options.libraryRoot);
  return { kind: "reloaded", catalog, configuration };
}

export function combinedContentBytes(profile: ProfileSnapshot): number {
  return Buffer.byteLength(profile.userText) + Buffer.byteLength(profile.assistantText);
}

function summarize(profile: ProfileSnapshot): ProfileSummary {
  return { id: profile.id, name: profile.name, description: profile.description };
}

function commandFailure(
  code: "unknown-subcommand" | "unexpected-argument" | "invalid-id",
): SelectorFailure {
  return {
    kind: "failed",
    diagnostic: toDiagnostic(new ProfileFailure("command", code), null, null),
  };
}

function unavailableProfile(profileId: string): SelectorFailure {
  const failure = new ProfileFailure("catalog", "profile-unavailable");
  return { kind: "failed", diagnostic: toDiagnostic(failure, profileId, null) };
}
