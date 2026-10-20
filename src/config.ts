import path from "node:path";
import {
  type ProfileDiagnostic,
  type ProfileDiagnosticCategory,
  type ProfileDiagnosticCode,
  ProfileFailure,
  toDiagnostic,
} from "./diagnostic.ts";
import {
  decodeUtf8,
  lstatIfPresent,
  readRegularFileWithin,
  resolveRootDirectory,
} from "./file-read.ts";
import {
  CONFIGURATION_FILE_NAME,
  hasControlCharacter,
  loadProfileCatalog,
  type ProfileSnapshot,
  profileIdProblem,
} from "./profiles.ts";
import {
  type JsonObject,
  MAX_JSON_DOCUMENT_BYTES,
  parseStrictJsonObject,
  requireKnownFields,
} from "./strict-json.ts";

export const PROFILE_OFF_ENVIRONMENT_VARIABLE = "PI_PREFILL_OFF";

// Version 1 carried only the default profile. Version 2 adds the bindings list and changes nothing
// else, so the reader takes both and the writer always saves the current version.
export const CONFIGURATION_SCHEMA_VERSION = 2;

// Provider and model identifiers are the exact strings of Pi's model registry, and the reader keeps
// them as written. The cap only keeps a hand-edited document from carrying a paragraph there.
export const MAX_REGISTRY_IDENTIFIER_LENGTH = 128;

const CONFIGURATION_FIELDS = ["schemaVersion", "defaultProfileId", "bindings"] as const;
const BINDING_FIELDS = ["id", "profileId", "provider", "model"] as const;
const BINDING_ID_PATTERN = /^b-[0-9a-f]{8}$/;

// One rule: a provider, or one model of a provider, resolves to a profile. `model` is null for the
// provider rule, which matches any model of that provider.
export interface ProfileBinding {
  readonly id: string;
  readonly profileId: string;
  readonly provider: string;
  readonly model: string | null;
}

export interface ProfileConfiguration {
  readonly defaultProfileId: string | null;
  readonly bindings: readonly ProfileBinding[];
}

export type ProfileConfigLoad =
  | {
      readonly status: "loaded";
      readonly defaultProfileId: string | null;
      readonly bindings: readonly ProfileBinding[];
    }
  | { readonly status: "failed"; readonly diagnostic: ProfileDiagnostic };

// The configuration file as stored. The loader parses the bytes; the writer also needs the canonical
// root and the exact bytes it read, to detect a change before it replaces them.
export interface ConfigurationDocument {
  readonly realRoot: string;
  readonly path: string;
  // Null when the file is absent, which is a configuration with no default and no bindings.
  readonly bytes: Buffer | null;
}

// `unset` means the caller made no decision for this resolution; it is not an off decision.
export type ProfileChoice =
  | { readonly kind: "unset" }
  | { readonly kind: "profile"; readonly profileId: string }
  | { readonly kind: "off" };

export type ProfileEnvironment = Readonly<Record<string, string | undefined>>;

// The model a resolution matches the bindings against. It is the selection of the session that is
// about to apply a profile, never a global default, so each branch judges its own model.
export interface ProfileModelKey {
  readonly provider: string;
  readonly id: string;
}

// `none` means there is no candidate. `off` means the example is deliberately not applied,
// and retainedProfileId keeps the chosen identifier when it is known and valid. A `binding`
// selection always carries the identifier of the rule that won.
export type ProfileResolution =
  | {
      readonly status: "selected";
      readonly source: "choice" | "default";
      readonly profile: ProfileSnapshot;
    }
  | {
      readonly status: "selected";
      readonly source: "binding";
      readonly profile: ProfileSnapshot;
      readonly bindingId: string;
    }
  | {
      readonly status: "off";
      readonly source: "choice" | "environment";
      readonly retainedProfileId: string | null;
    }
  | { readonly status: "none" }
  | { readonly status: "failed"; readonly diagnostic: ProfileDiagnostic };

export interface ResolveProfileOptions {
  readonly libraryRoot: string;
  readonly environment: ProfileEnvironment;
  readonly choice: ProfileChoice;
  // Null when the session has no selected model. No binding matches then, because a rule names a
  // provider and a model identifier, not whatever runs later.
  readonly model: ProfileModelKey | null;
}

// Reads <libraryRoot>/config.json with the rules of the rest of the library: a regular file whose
// final location is inside the canonical root. Returns null when the library root itself is absent.
export async function readConfigurationDocument(
  libraryRoot: string,
): Promise<ConfigurationDocument | null> {
  // A root that is not a directory must fail here as it does in the catalog. Checking the
  // configuration path alone would report it as absent on some platforms.
  const realRoot = await resolveRootDirectory(libraryRoot);
  if (realRoot === null) return null;
  const configurationPath = path.join(realRoot, CONFIGURATION_FILE_NAME);
  if ((await lstatIfPresent(configurationPath)) === null) {
    return { realRoot, path: configurationPath, bytes: null };
  }
  const bytes = await readRegularFileWithin(realRoot, configurationPath, MAX_JSON_DOCUMENT_BYTES);
  return { realRoot, path: configurationPath, bytes };
}

// An absent file means no default and no bindings; any other problem fails.
export async function loadProfileConfig(libraryRoot: string): Promise<ProfileConfigLoad> {
  try {
    const document = await readConfigurationDocument(libraryRoot);
    const bytes = document === null ? null : document.bytes;
    const configuration = bytes === null ? EMPTY_CONFIGURATION : parseProfileConfiguration(bytes);
    return {
      status: "loaded",
      defaultProfileId: configuration.defaultProfileId,
      bindings: configuration.bindings,
    };
  } catch (error) {
    if (error instanceof ProfileFailure) {
      return { status: "failed", diagnostic: toDiagnostic(error, null, null) };
    }
    throw error;
  }
}

// Precedence: environment off, explicit off, explicit profile, model binding, provider binding,
// configured default. A malformed configuration or an unusable catalog blocks every non-off
// resolution; nothing falls back silently.
export async function resolveProfile(options: ResolveProfileOptions): Promise<ProfileResolution> {
  const { libraryRoot, environment, choice, model } = options;
  const environmentState = readOffEnvironment(environment);
  const explicitIdProblem = choice.kind === "profile" ? profileIdProblem(choice.profileId) : null;

  if (environmentState === "forced") {
    return {
      status: "off",
      source: "environment",
      retainedProfileId:
        choice.kind === "profile" && explicitIdProblem === null ? choice.profileId : null,
    };
  }
  if (choice.kind === "off") return { status: "off", source: "choice", retainedProfileId: null };
  if (environmentState === "invalid") {
    return failed("configuration", "environment-invalid", null);
  }
  if (choice.kind === "profile" && explicitIdProblem !== null) {
    return failed("identity", explicitIdProblem, null);
  }

  const configuration = await loadProfileConfig(libraryRoot);
  if (configuration.status === "failed") return configuration;
  const catalog = await loadProfileCatalog(libraryRoot);
  if (catalog.status === "failed") return { status: "failed", diagnostic: catalog.diagnostic };

  if (choice.kind === "profile") {
    const profile = catalog.profiles.find((candidate) => candidate.id === choice.profileId);
    if (profile === undefined) return failed("catalog", "profile-unavailable", choice.profileId);
    return { status: "selected", source: "choice", profile };
  }

  const binding = matchingBinding(configuration.bindings, model);
  if (binding !== null) {
    const profile = catalog.profiles.find((candidate) => candidate.id === binding.profileId);
    if (profile === undefined) {
      // The rule is the decision, so a rule that points at no usable profile fails instead of
      // letting another rule or the default take its place.
      return failed("configuration", "binding-profile-unavailable", binding.profileId);
    }
    return { status: "selected", source: "binding", profile, bindingId: binding.id };
  }

  const defaultProfileId = configuration.defaultProfileId;
  if (defaultProfileId === null) return { status: "none" };
  const profile = catalog.profiles.find((candidate) => candidate.id === defaultProfileId);
  if (profile === undefined) {
    return failed("configuration", "default-profile-unavailable", defaultProfileId);
  }
  return { status: "selected", source: "default", profile };
}

export type OffEnvironmentState = "forced" | "invalid" | "inactive";

// Only "1" forces off. Unset, empty and "0" leave it inactive; anything else is an error that
// blocks new selections but still lets an explicit off decision through.
export function readOffEnvironment(environment: ProfileEnvironment): OffEnvironmentState {
  const value = environment[PROFILE_OFF_ENVIRONMENT_VARIABLE];
  if (value === undefined || value === "" || value === "0") return "inactive";
  return value === "1" ? "forced" : "invalid";
}

const EMPTY_BINDINGS: readonly ProfileBinding[] = Object.freeze([]);
const EMPTY_CONFIGURATION: ProfileConfiguration = {
  defaultProfileId: null,
  bindings: EMPTY_BINDINGS,
};

// Reads a configuration document. The writer validates the file it is about to replace with the
// same function, so a document that would be rejected is never overwritten.
export function parseProfileConfiguration(bytes: Buffer): ProfileConfiguration {
  const object = parseStrictJsonObject(decodeUtf8(bytes), "configuration");
  requireKnownFields(object, CONFIGURATION_FIELDS, "configuration");
  requireSupportedVersion(object);
  return { defaultProfileId: readDefaultField(object), bindings: readBindingsField(object) };
}

// A rule that names the same provider and model as another one would leave the winner to the order
// of the list, so the document is rejected instead of keeping the first match.
export function sameBindingRule(
  left: { readonly provider: string; readonly model: string | null },
  right: { readonly provider: string; readonly model: string | null },
): boolean {
  return left.provider === right.provider && left.model === right.model;
}

// The reason a provider or model identifier cannot be stored or shown, or null.
export function registryIdentifierProblem(
  value: unknown,
): "invalid-field" | "blank-field" | "control-character" | "too-large" | null {
  if (typeof value !== "string") return "invalid-field";
  if (value.trim() === "") return "blank-field";
  if (hasControlCharacter(value)) return "control-character";
  return value.length > MAX_REGISTRY_IDENTIFIER_LENGTH ? "too-large" : null;
}

export function isRegistryIdentifier(value: unknown): value is string {
  return registryIdentifierProblem(value) === null;
}

export function isBindingId(value: unknown): value is string {
  return typeof value === "string" && BINDING_ID_PATTERN.test(value);
}

// Version 1 has no bindings list. Any other version is rejected rather than read as this one.
function requireSupportedVersion(object: JsonObject): void {
  if (!Object.hasOwn(object, "schemaVersion")) {
    throw new ProfileFailure("configuration", "missing-field");
  }
  const version = object.schemaVersion;
  if (typeof version !== "number" || !Number.isSafeInteger(version)) {
    throw new ProfileFailure("configuration", "invalid-field");
  }
  if (version !== 1 && version !== CONFIGURATION_SCHEMA_VERSION) {
    throw new ProfileFailure("configuration", "unsupported-schema-version");
  }
}

function readDefaultField(object: JsonObject): string | null {
  if (!Object.hasOwn(object, "defaultProfileId")) return null;
  const value = object.defaultProfileId;
  if (value === null) return null;
  if (typeof value !== "string") throw new ProfileFailure("configuration", "invalid-field");
  const problem = profileIdProblem(value);
  if (problem !== null) throw new ProfileFailure("configuration", problem);
  return value;
}

function readBindingsField(object: JsonObject): readonly ProfileBinding[] {
  if (!Object.hasOwn(object, "bindings")) return EMPTY_BINDINGS;
  const value = object.bindings;
  if (!Array.isArray(value)) throw new ProfileFailure("configuration", "invalid-field");
  const bindings = value.map((entry) => readBinding(entry));
  assertDistinctRules(bindings);
  return Object.freeze(bindings);
}

// Every field of a rule is required: a binding without a model field would be ambiguous between the
// provider rule and a missing value.
function readBinding(value: unknown): ProfileBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProfileFailure("configuration", "invalid-field");
  }
  const object = value as JsonObject;
  requireKnownFields(object, BINDING_FIELDS, "configuration");
  return {
    id: readBindingIdField(object),
    profileId: readBindingProfileIdField(object),
    provider: readRegistryIdentifier(readRequiredField(object, "provider")),
    model: readBindingModelField(object),
  };
}

function readRequiredField(object: JsonObject, field: string): unknown {
  if (!Object.hasOwn(object, field)) throw new ProfileFailure("configuration", "missing-field");
  return object[field];
}

function readBindingIdField(object: JsonObject): string {
  const value = readRequiredField(object, "id");
  if (!isBindingId(value)) throw new ProfileFailure("configuration", "invalid-field");
  return value;
}

function readBindingProfileIdField(object: JsonObject): string {
  const value = readRequiredField(object, "profileId");
  if (typeof value !== "string") throw new ProfileFailure("configuration", "invalid-field");
  const problem = profileIdProblem(value);
  if (problem !== null) throw new ProfileFailure("configuration", problem);
  return value;
}

// The model field is the only one that carries null, for the provider rule.
function readBindingModelField(object: JsonObject): string | null {
  const value = readRequiredField(object, "model");
  return value === null ? null : readRegistryIdentifier(value);
}

function readRegistryIdentifier(value: unknown): string {
  if (!isRegistryIdentifier(value)) {
    throw new ProfileFailure("configuration", registryIdentifierProblem(value) ?? "invalid-field");
  }
  return value;
}

function assertDistinctRules(bindings: readonly ProfileBinding[]): void {
  for (const [index, binding] of bindings.entries()) {
    if (bindings.slice(0, index).some((earlier) => sameBindingRule(earlier, binding))) {
      throw new ProfileFailure("configuration", "duplicate-binding");
    }
  }
}

// The exact model rule wins over the provider rule. Both are looked up in the same document, so the
// order of the list does not decide anything.
function matchingBinding(
  bindings: readonly ProfileBinding[],
  model: ProfileModelKey | null,
): ProfileBinding | null {
  if (model === null) return null;
  const candidates = bindings.filter((binding) => binding.provider === model.provider);
  return (
    candidates.find((binding) => binding.model === model.id) ??
    candidates.find((binding) => binding.model === null) ??
    null
  );
}

function failed(
  category: ProfileDiagnosticCategory,
  code: ProfileDiagnosticCode,
  profileId: string | null,
): { readonly status: "failed"; readonly diagnostic: ProfileDiagnostic } {
  return {
    status: "failed",
    diagnostic: toDiagnostic(new ProfileFailure(category, code), profileId, null),
  };
}
