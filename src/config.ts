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
  loadProfileCatalog,
  type ProfileSnapshot,
  profileIdProblem,
} from "./profiles.ts";
import {
  type JsonObject,
  MAX_JSON_DOCUMENT_BYTES,
  parseStrictJsonObject,
  requireKnownFields,
  requireSchemaVersion,
} from "./strict-json.ts";

export const PROFILE_OFF_ENVIRONMENT_VARIABLE = "PI_PREFILL_OFF";

const CONFIGURATION_FIELDS = ["schemaVersion", "defaultProfileId"] as const;

export type ProfileConfigLoad =
  | { readonly status: "loaded"; readonly defaultProfileId: string | null }
  | { readonly status: "failed"; readonly diagnostic: ProfileDiagnostic };

// `unset` means the caller made no decision for this resolution; it is not an off decision.
export type ProfileChoice =
  | { readonly kind: "unset" }
  | { readonly kind: "profile"; readonly profileId: string }
  | { readonly kind: "off" };

export type ProfileEnvironment = Readonly<Record<string, string | undefined>>;

// `none` means there is no candidate. `off` means the example is deliberately not applied,
// and retainedProfileId keeps the chosen identifier when it is known and valid.
export type ProfileResolution =
  | {
      readonly status: "selected";
      readonly source: "choice" | "default";
      readonly profile: ProfileSnapshot;
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
}

// Reads <libraryRoot>/config.json. An absent file means no default; any other problem fails.
export async function loadProfileConfig(libraryRoot: string): Promise<ProfileConfigLoad> {
  try {
    return { status: "loaded", defaultProfileId: await readDefaultProfileId(libraryRoot) };
  } catch (error) {
    if (error instanceof ProfileFailure) {
      return { status: "failed", diagnostic: toDiagnostic(error, null, null) };
    }
    throw error;
  }
}

// Precedence: environment off, explicit choice, configured default. A malformed configuration
// or an unusable catalog blocks every non-off resolution; nothing falls back silently.
export async function resolveProfile(options: ResolveProfileOptions): Promise<ProfileResolution> {
  const { libraryRoot, environment, choice } = options;
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

// The configuration is absent (no default) or a regular file inside the canonical root.
// Its link is validated as configuration, not as a profile candidate.
async function readDefaultProfileId(libraryRoot: string): Promise<string | null> {
  // A root that is not a directory must fail here as it does in the catalog. Checking the
  // configuration path alone would report it as absent on some platforms.
  const realRoot = await resolveRootDirectory(libraryRoot);
  if (realRoot === null) return null;
  const configurationPath = path.join(realRoot, CONFIGURATION_FILE_NAME);
  if ((await lstatIfPresent(configurationPath)) === null) return null;
  const bytes = await readRegularFileWithin(realRoot, configurationPath, MAX_JSON_DOCUMENT_BYTES);
  const object = parseStrictJsonObject(decodeUtf8(bytes), "configuration");
  requireKnownFields(object, CONFIGURATION_FIELDS, "configuration");
  requireSchemaVersion(object, "configuration");
  return readDefaultField(object);
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
