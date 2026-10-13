import os from "node:os";
import {
  profileLibraryDirectory,
  resolveAgentDirectory,
  selectionStateDirectory,
} from "./agent-dir.ts";
import type { ProfileEnvironment } from "./config.ts";
import type { PiCommandContext, PiExtensionApi } from "./extension-types.ts";
import { renderMessage } from "./messages.ts";
import {
  completeSubcommands,
  executeSelectorCommand,
  listProfiles,
  type ParsedSelectorText,
  parseSelectorText,
  selectProfile,
  type SelectorFailure,
  type SelectorOptions,
  type SelectorResult,
  turnOff,
} from "./selector.ts";
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

export default function prefillExtension(pi: PiExtensionApi): void {
  pi.registerCommand(COMMAND_NAME, {
    description: "Choose, disable or inspect the local prefill profile",
    getArgumentCompletions: completeSubcommands,
    handler: (argumentText, context) =>
      handlePrefillCommand(
        argumentText,
        context,
        resolveSelectorOptions(process.env, os.homedir()),
        (customType, data) => pi.appendEntry(customType, data),
      ),
  });
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
    await handleInteractive(parsed, context, options);
    return;
  }
  publish(context, appendEntry, await executeSelectorCommand(parsed, options));
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
): Promise<void> {
  const isBareList =
    parsed.kind === "parsed" && parsed.command === "list" && parsed.argument === "";
  if (isBareList) {
    await chooseProfile(context, options);
    return;
  }
  const result = await executeSelectorCommand(parsed, options);
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
