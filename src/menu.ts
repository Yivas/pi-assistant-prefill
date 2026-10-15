import { readOffEnvironment } from "./config.ts";
import type { PiCommandContext } from "./extension-types.ts";
import { renderMessage } from "./messages.ts";
import { createProfile, editProfile } from "./profile-editor.ts";
import { type MenuChoice, selectMenuItem } from "./search-list.ts";
import { readSelection } from "./selection.ts";
import {
  executeSelectorCommand,
  listProfiles,
  type ProfileSummary,
  type SelectorOptions,
  type SelectorResult,
  selectProfile,
  turnOff,
} from "./selector.ts";
import type { ApplicationStatus } from "./session-state.ts";
import { escapeLabel, noticeTypeFor, renderSelectorText } from "./status.ts";

// A sentinel object, not a string: "back" is a valid profile identifier.
type PickResult = { readonly back: true } | { readonly profileId: string };

type ApplicationDescriber = () => ApplicationStatus;

interface MenuItem extends MenuChoice {
  readonly run: () => Promise<void>;
}

// The menu keeps its read and selection actions even when the library is empty.
// Creation and editing also need the host's input and editor dialogs.
export async function openMenu(
  context: PiCommandContext,
  options: SelectorOptions,
  describeApplication: ApplicationDescriber,
): Promise<void> {
  const listing = await listProfiles(options);
  const profiles = listing.kind === "list" ? listing.profiles : [];
  const invalidCount = listing.kind === "list" ? listing.invalidCandidates.length : 0;

  const items = new Map<string, MenuItem>();
  const add = (key: string, run: () => Promise<void>, parameters = {}) => {
    const label = renderMessage(`menu.item.${key}`, parameters);
    items.set(label, {
      value: label,
      label,
      description: renderMessage(`menu.description.${key}`),
      run,
    });
  };
  const notifyResult = (result: SelectorResult) =>
    context.ui.notify(renderSelectorText(result), noticeTypeFor(result));

  const count =
    profiles.length === 0
      ? renderMessage("menu.count.none")
      : renderMessage("menu.count.some", { count: profiles.length });
  add(
    "choose",
    async () => {
      if (profiles.length === 0) {
        context.ui.notify(renderMessage("menu.empty"), "info");
        return;
      }
      const chosen = await pickProfile(context, profiles, renderMessage("list.title"));
      if (chosen === undefined) return;
      if ("back" in chosen) return openMenu(context, options, describeApplication);
      notifyResult(await selectProfile(chosen.profileId, options));
    },
    { count },
  );
  add("preview", async () => {
    if (profiles.length === 0) {
      context.ui.notify(renderMessage("menu.empty"), "info");
      return;
    }
    const chosen = await pickProfile(context, profiles, renderMessage("menu.preview.title"));
    if (chosen === undefined) return;
    if ("back" in chosen) return openMenu(context, options, describeApplication);
    notifyResult(
      await executeSelectorCommand(
        { kind: "parsed", command: "preview", argument: chosen.profileId },
        options,
      ),
    );
  });
  if (context.mode === "tui" && context.ui.input && context.ui.editor) {
    add("create", async () => createProfile(context, options.libraryRoot));
    add("edit", async () => {
      if (profiles.length === 0) {
        context.ui.notify(renderMessage("menu.empty"), "info");
        return;
      }
      const chosen = await pickProfile(context, profiles, renderMessage("menu.edit.title"));
      if (chosen === undefined) return;
      if ("back" in chosen) return openMenu(context, options, describeApplication);
      await editProfile(context, options.libraryRoot, chosen.profileId);
    });
  }
  add("status", async () => {
    const result = await executeSelectorCommand(
      { kind: "parsed", command: "status", argument: "" },
      options,
    );
    notifyResult(
      result.kind === "status"
        ? { kind: "status", status: { ...result.status, application: describeApplication() } }
        : result,
    );
  });
  add("off", async () => notifyResult(await turnOff(options)));
  add("reload", async () =>
    notifyResult(
      await executeSelectorCommand({ kind: "parsed", command: "reload", argument: "" }, options),
    ),
  );
  add("howto", async () =>
    context.ui.notify(
      renderMessage("menu.howto", { folder: escapePath(options.libraryRoot) }),
      "info",
    ),
  );
  add("close", async () => {});

  const subtitle = [
    renderMessage("menu.summary"),
    "",
    ...(await describeState(options, listing, profiles.length, invalidCount)),
  ].join("\n");
  const picked = await selectMenuItem(context, {
    title: renderMessage("menu.title"),
    subtitle,
    items: [...items.values()],
  });
  const item = picked === undefined ? undefined : items.get(picked);
  if (item !== undefined) await item.run();
}

async function describeState(
  options: SelectorOptions,
  listing: SelectorResult,
  validCount: number,
  invalidCount: number,
): Promise<string[]> {
  const lines: string[] = [];
  const selection = await readSelection(options.stateDirectory);
  const environment = readOffEnvironment(options.environment);
  if (environment === "forced") lines.push(renderMessage("menu.choice.environment"));
  if (environment === "invalid") lines.push(renderMessage("status.environmentInvalid"));
  if (selection.status === "failed") {
    lines.push(renderMessage("menu.choice.unreadable"));
  } else if (selection.choice.kind === "profile") {
    lines.push(renderMessage("menu.choice.pending", { profileId: selection.choice.profileId }));
  } else if (selection.choice.kind === "off") {
    lines.push(renderMessage("menu.choice.off"));
  } else {
    lines.push(renderMessage("menu.choice.none"));
  }
  lines.push(
    listing.kind === "list"
      ? renderMessage("menu.library", { count: validCount, invalid: invalidCount })
      : renderMessage("menu.library.unusable"),
  );
  lines.push(renderMessage("menu.folder", { folder: escapePath(options.libraryRoot) }));
  return lines;
}

// Returns the identifier, "back" for the back entry, or undefined when the dialog is cancelled.
async function pickProfile(
  context: PiCommandContext,
  profiles: readonly ProfileSummary[],
  title: string,
): Promise<PickResult | undefined> {
  const items: MenuChoice[] = profiles.map((profile) => {
    const label = `${profile.id}: ${escapeLabel(profile.name)}`;
    const description = escapeLabel(profile.description);
    return {
      value: profile.id,
      label,
      description,
      fallbackLabel: `${label} — ${description}`,
    };
  });
  // Empty is not a valid profile id, so it cannot collide with the back entry.
  items.push({ value: "", label: renderMessage("menu.item.back") });
  const picked = await selectMenuItem(context, { title, items });
  if (picked === undefined) return undefined;
  return picked === "" ? { back: true } : { profileId: picked };
}

// The library path comes from PI_CODING_AGENT_DIR, so control, line-separator and bidirectional
// characters are shown as \uXXXX before they reach the terminal. Backslashes stay as they are, so a
// Windows path stays readable; escapeBody would double them.
const PATH_PRESENTATION = /^[\u2028\u2029\p{Bidi_Control}]$/u;

function escapePath(path: string): string {
  return Array.from(path, (character) => {
    const code = character.charCodeAt(0);
    const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    if (!isControl && !PATH_PRESENTATION.test(character)) return character;
    return `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }).join("");
}
