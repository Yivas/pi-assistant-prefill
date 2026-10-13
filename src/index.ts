import os from "node:os";
import {
  profileLibraryDirectory,
  resolveAgentDirectory,
  selectionStateDirectory,
} from "./agent-dir.ts";
import type { ProfileEnvironment } from "./config.ts";
import type {
  PiCommandContext,
  PiExtensionApi,
  PiReadonlySessionManager,
} from "./extension-types.ts";
import { renderMessage } from "./messages.ts";
import { PrefixProjection } from "./projection.ts";
import {
  completeSubcommands,
  executeSelectorCommand,
  listProfiles,
  type ParsedSelectorText,
  parseSelectorText,
  type SelectorFailure,
  type SelectorOptions,
  type SelectorResult,
  selectProfile,
  turnOff,
} from "./selector.ts";
import { type ApplicationStatus, INDETERMINATE_APPLICATION } from "./session-state.ts";
import {
  noticeTypeFor,
  profileOptionLabel,
  renderSelectorEntry,
  renderSelectorText,
} from "./status.ts";

export const COMMAND_NAME = "prefill";
export const SELECTOR_ENTRY_TYPE = "pi-assistant-prefill.selector";

// A failed resolution (for example an unsupported PI_CODING_AGENT_DIR) stops every subcommand,
// so the failure is reported through the same channel as any other failed result.
export type SelectorOptionsResolution =
  | { readonly kind: "resolved"; readonly options: SelectorOptions }
  | SelectorFailure;

// Reads the application state of the session branch. Without it, status reports the state as
// indeterminate, which is what the command does when no session is available.
export type ApplicationDescriber = (sessionManager: PiReadonlySessionManager) => ApplicationStatus;

export default function prefillExtension(pi: PiExtensionApi): void {
  const projection = new PrefixProjection({
    resolveOptions: () => resolveSelectorOptions(process.env, os.homedir()),
    appendEntry: (customType, data) => pi.appendEntry(customType, data),
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "Choose, disable or inspect the local prefill profile",
    getArgumentCompletions: completeSubcommands,
    handler: (argumentText, context) =>
      handlePrefillCommand(
        argumentText,
        context,
        resolveSelectorOptions(process.env, os.homedir()),
        (customType, data) => pi.appendEntry(customType, data),
        (sessionManager) => projection.describeApplication(sessionManager),
      ),
  });

  // The handlers never throw for an expected failure: they write a diagnostic entry instead. See
  // docs/projection.md for the lifecycle each event takes part in.
  pi.on("session_start", () => projection.reset());
  pi.on("session_tree", () => projection.reset());
  pi.on("agent_end", () => projection.endRun());
  pi.on("before_agent_start", (_event, context) => projection.beginTurn(context));
  pi.on("context", (event, context) => projection.projectContext(event, context));
  pi.on("turn_end", (event, context) => projection.endTurnBoundary(event, context));
  pi.on("cache_warming_decision", (event, context) =>
    projection.decideCacheWarming(event, context),
  );
}

export function resolveSelectorOptions(
  environment: ProfileEnvironment,
  homeDirectory: string,
): SelectorOptionsResolution {
  const agent = resolveAgentDirectory(environment, homeDirectory);
  if (agent.status === "failed") return { kind: "failed", diagnostic: agent.diagnostic };
  return {
    kind: "resolved",
    options: {
      libraryRoot: profileLibraryDirectory(agent.path),
      stateDirectory: selectionStateDirectory(agent.path),
      environment,
    },
  };
}

// Modes differ in their output channel. The handler never throws for an expected failure: the
// host would catch it, exit with status 0, and the failure would be invisible in RPC and JSON.
export async function handlePrefillCommand(
  argumentText: string,
  context: PiCommandContext,
  resolution: SelectorOptionsResolution,
  appendEntry: (customType: string, data: unknown) => void,
  describeApplication: ApplicationDescriber = () => INDETERMINATE_APPLICATION,
): Promise<void> {
  // Print mode has no result channel that can report a failure, so no operation runs.
  if (context.mode === "print") return;

  if (resolution.kind === "failed") {
    publish(context, appendEntry, resolution);
    return;
  }
  const { options } = resolution;
  const parsed = parseSelectorText(argumentText);
  if (context.mode === "tui") {
    await handleInteractive(parsed, context, options, describeApplication);
    return;
  }
  const result = await executeSelectorCommand(parsed, options);
  publish(context, appendEntry, withApplication(result, context, describeApplication));
}

// Only `status` reports the application state; every other result passes through unchanged.
function withApplication(
  result: SelectorResult,
  context: PiCommandContext,
  describeApplication: ApplicationDescriber,
): SelectorResult {
  if (result.kind !== "status") return result;
  return {
    kind: "status",
    status: { ...result.status, application: describeApplication(context.sessionManager) },
  };
}

// The tui has no entry channel, so it only gets the notice. rpc and json also record the result.
function publish(
  context: PiCommandContext,
  appendEntry: (customType: string, data: unknown) => void,
  result: SelectorResult,
): void {
  if (context.mode !== "tui") appendEntry(SELECTOR_ENTRY_TYPE, renderSelectorEntry(result));
  context.ui.notify(renderSelectorText(result), noticeTypeFor(result));
}

async function handleInteractive(
  parsed: ParsedSelectorText,
  context: PiCommandContext,
  options: SelectorOptions,
  describeApplication: ApplicationDescriber,
): Promise<void> {
  const isBareList =
    parsed.kind === "parsed" && parsed.command === "list" && parsed.argument === "";
  if (isBareList) {
    await chooseProfile(context, options);
    return;
  }
  const result = withApplication(
    await executeSelectorCommand(parsed, options),
    context,
    describeApplication,
  );
  context.ui.notify(renderSelectorText(result), noticeTypeFor(result));
}

// Each option maps to its action, so a picked label is never matched against the profile list
// again. Cancelling the dialog returns without any change. The host's select dialog does the
// filtering; this package adds no search of its own.
async function chooseProfile(context: PiCommandContext, options: SelectorOptions): Promise<void> {
  const listing = await listProfiles(options);
  if (listing.kind !== "list" || listing.profiles.length === 0) {
    context.ui.notify(renderSelectorText(listing), noticeTypeFor(listing));
    return;
  }

  const actions = new Map<string, () => Promise<SelectorResult>>();
  for (const profile of listing.profiles) {
    actions.set(profileOptionLabel(profile), () => selectProfile(profile.id, options));
  }
  actions.set(renderMessage("list.off"), () => turnOff(options));

  const picked = await context.ui.select(renderMessage("list.title"), [...actions.keys()]);
  const action = picked === undefined ? undefined : actions.get(picked);
  if (action === undefined) return;
  const result = await action();
  context.ui.notify(renderSelectorText(result), noticeTypeFor(result));
}
