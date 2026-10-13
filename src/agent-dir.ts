import path from "node:path";
import type { ProfileEnvironment } from "./config.ts";
import { type ProfileDiagnostic, ProfileFailure, toDiagnostic } from "./diagnostic.ts";

export const AGENT_DIRECTORY_ENVIRONMENT_VARIABLE = "PI_CODING_AGENT_DIR";

export type AgentDirectoryResolution =
  | { readonly status: "resolved"; readonly path: string }
  | { readonly status: "failed"; readonly diagnostic: ProfileDiagnostic };

// Pi 1.1.0 also normalizes file:// URLs and other forms. This package accepts a subset and
// rejects everything else with a diagnostic, so its result never silently differs from Pi's:
// an unset or empty value gives <home>/.pi/agent; "~", "~/" and "~\" expand to the home
// directory; an absolute path is used as it is, except a /c/... form on Windows; anything else
// fails. The package phase must replace this rule with Pi's public getAgentDir().
const MSYS_DRIVE_PREFIX = /^\/[A-Za-z](\/|$)/;

export function resolveAgentDirectory(
  environment: ProfileEnvironment,
  homeDirectory: string,
  platform: NodeJS.Platform = process.platform,
): AgentDirectoryResolution {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const override = environment[AGENT_DIRECTORY_ENVIRONMENT_VARIABLE];
  if (override === undefined || override === "") {
    return { status: "resolved", path: pathApi.join(homeDirectory, ".pi", "agent") };
  }
  if (override === "~" || override.startsWith("~/") || override.startsWith("~\\")) {
    return { status: "resolved", path: pathApi.join(homeDirectory, override.slice(1)) };
  }
  const isAbsoluteForm =
    pathApi.isAbsolute(override) && !(platform === "win32" && MSYS_DRIVE_PREFIX.test(override));
  if (isAbsoluteForm) return { status: "resolved", path: override };

  const failure = new ProfileFailure("configuration", "agent-directory-unsupported");
  return { status: "failed", diagnostic: toDiagnostic(failure, null, null) };
}

export function profileLibraryDirectory(agentDirectory: string): string {
  return path.join(agentDirectory, "prefills");
}

// The plugin's own state sits beside the library, never inside it, so selection writes cannot
// change a profile or prefills/config.json.
export function selectionStateDirectory(agentDirectory: string): string {
  return path.join(agentDirectory, "pi-assistant-prefill");
}
