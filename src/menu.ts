import { readOffEnvironment } from "./config.ts";
import type { PiCommandContext } from "./extension-types.ts";
import { renderMessage } from "./messages.ts";
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

interface MenuItem {
  readonly label: string;
  readonly run: () => Promise<void>;
}

// The menu is the entry point of a bare `/prefill` in the TUI. It always offers every action,
// including when the library is empty, so the operator can see what the extension does and how
// to add a profile. It only reads the library: nothing here writes to it.
export async function openMenu(
  context: PiCommandContext,
  options: SelectorOptions,
  describeApplication: ApplicationDescriber,
): Promise<void> {
  const listing = await listProfiles(options);
  const profiles = listing.kind === "list" ? listing.profiles : [];
  const invalidCount = listing.kind === "list" ? listing.invalidCandidates.length : 0;

  const items = new Map<string, MenuItem>();
  const add = (label: string, run: () => Promise<void>) => items.set(label, { label, run });
  const notifyResult = (result: SelectorResult) =>
    context.ui.notify(renderSelectorText(result), noticeTypeFor(result));

  const count =
    profiles.length === 0
      ? renderMessage("menu.count.none")
      : renderMessage("menu.count.some", { count: profiles.length });
  add(renderMessage("menu.item.choose", { count }), async () => {
    if (profiles.length === 0) {
      context.ui.notify(renderMessage("menu.empty"), "info");
      return;
    }
    const chosen = await pickProfile(context, profiles, renderMessage("list.title"));
    if (chosen === undefined) return;
    if ("back" in chosen) return openMenu(context, options, describeApplication);
    notifyResult(await selectProfile(chosen.profileId, options));
  });
  add(renderMessage("menu.item.preview"), async () => {
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
  add(renderMessage("menu.item.status"), async () => {
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
  add(renderMessage("menu.item.off"), async () => notifyResult(await turnOff(options)));
  add(renderMessage("menu.item.reload"), async () =>
    notifyResult(
      await executeSelectorCommand({ kind: "parsed", command: "reload", argument: "" }, options),
    ),
  );
  add(renderMessage("menu.item.howto"), async () =>
    context.ui.notify(
      renderMessage("menu.howto", { folder: escapePath(options.libraryRoot) }),
      "info",
    ),
  );
  add(renderMessage("menu.item.close"), async () => {});

  const title = [
    renderMessage("menu.title"),
    renderMessage("menu.summary"),
    "",
    ...(await describeState(options, listing, profiles.length, invalidCount)),
  ].join("\n");
  const picked = await context.ui.select(title, [...items.keys()]);
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
  const labels = new Map<string, string>();
  for (const profile of profiles) {
    labels.set(
      `${profile.id}: ${escapeLabel(profile.name)} — ${escapeLabel(profile.description)}`,
      profile.id,
    );
  }
  const back = renderMessage("menu.item.back");
  const picked = await context.ui.select(title, [...labels.keys(), back]);
  if (picked === undefined) return undefined;
  if (picked === back) return { back: true };
  const profileId = labels.get(picked);
  return profileId === undefined ? undefined : { profileId };
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
