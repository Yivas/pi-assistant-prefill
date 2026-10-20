import {
  isRegistryIdentifier,
  loadProfileConfig,
  type ProfileBinding,
  type ProfileConfigLoad,
  readOffEnvironment,
} from "./config.ts";
import {
  addProfileBinding,
  type ConfigWriteResult,
  removeProfileBinding,
} from "./config-writer.ts";
import type { PiCommandContext } from "./extension-types.ts";
import { renderMessage } from "./messages.ts";
import { createProfile, editProfile } from "./profile-editor.ts";
import { type MenuChoice, selectMenuItem } from "./search-list.ts";
import { clearSelection, readSelection } from "./selection.ts";
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
import { escapeBody, escapeLabel, noticeTypeFor, renderSelectorText } from "./status.ts";

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
  const configuration = await loadProfileConfig(options.libraryRoot);

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
  // Bindings need the model registry: their rules name the providers and models Pi knows about.
  if (context.mode === "tui" && context.modelRegistry !== undefined) {
    add("automatic", async () => setAutomaticChoice(context, options));
    add("bindings", async () => openBindingsMenu(context, options, profiles, describeApplication));
  }
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
    ...(await describeState(options, listing, profiles.length, invalidCount, configuration)),
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
  configuration: ProfileConfigLoad,
): Promise<string[]> {
  const lines: string[] = [];
  const selection = await readSelection(options.stateDirectory);
  const environment = readOffEnvironment(options.environment);
  const bindings = configuration.status === "loaded" ? configuration.bindings : null;
  if (environment === "forced") lines.push(renderMessage("menu.choice.environment"));
  if (environment === "invalid") lines.push(renderMessage("status.environmentInvalid"));
  if (selection.status === "failed") {
    lines.push(renderMessage("menu.choice.unreadable"));
  } else if (selection.choice.kind === "profile") {
    lines.push(renderMessage("menu.choice.pending", { profileId: selection.choice.profileId }));
  } else if (selection.choice.kind === "off") {
    lines.push(renderMessage("menu.choice.off"));
  } else {
    // No recorded choice: the bindings and the configured default decide, so the rules are shown
    // next to the choice they stand in for.
    lines.push(
      bindings === null
        ? renderMessage("menu.choice.automaticUnreadable")
        : renderMessage("menu.choice.automatic", { count: bindings.length }),
    );
  }
  if (bindings !== null) lines.push(...bindingRows(bindings));
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

// The rule hub. It stays open after an add or a remove, so both are reachable without walking back
// through the main menu, and it reads the configuration again on every pass.
async function openBindingsMenu(
  context: PiCommandContext,
  options: SelectorOptions,
  profiles: readonly ProfileSummary[],
  describeApplication: ApplicationDescriber,
): Promise<void> {
  for (;;) {
    const configuration = await loadProfileConfig(options.libraryRoot);
    if (configuration.status === "failed") {
      context.ui.notify(
        renderSelectorText({ kind: "failed", diagnostic: configuration.diagnostic }),
        "error",
      );
      await openMenu(context, options, describeApplication);
      return;
    }
    const { bindings } = configuration;
    const rows = bindingRows(bindings);
    const picked = await selectMenuItem(context, {
      title: renderMessage("menu.bindings.title"),
      ...(rows.length === 0 ? {} : { subtitle: rows.join("\n") }),
      items: [
        { value: "add", label: renderMessage("menu.bindings.add") },
        { value: "remove", label: renderMessage("menu.bindings.remove") },
        { value: "back", label: renderMessage("menu.item.back") },
      ],
    });
    if (picked === undefined) return;
    if (picked === "back") {
      await openMenu(context, options, describeApplication);
      return;
    }
    if (picked === "add") await addBinding(context, options, profiles);
    else await removeBinding(context, options, bindings);
  }
}

async function addBinding(
  context: PiCommandContext,
  options: SelectorOptions,
  profiles: readonly ProfileSummary[],
): Promise<void> {
  if (profiles.length === 0) {
    context.ui.notify(renderMessage("menu.empty"), "info");
    return;
  }
  const chosen = await pickProfile(context, profiles, renderMessage("menu.bindings.profileTitle"));
  if (chosen === undefined || "back" in chosen) return;
  const rule = await pickBindingRule(context);
  if (rule === undefined) return;
  notifyConfigWrite(
    context,
    await addProfileBinding(options.libraryRoot, { profileId: chosen.profileId, ...rule }),
    "menu.bindings.saved",
  );
}

async function removeBinding(
  context: PiCommandContext,
  options: SelectorOptions,
  bindings: readonly ProfileBinding[],
): Promise<void> {
  if (bindings.length === 0) {
    context.ui.notify(renderMessage("menu.bindings.empty"), "info");
    return;
  }
  const picked = await selectMenuItem(context, {
    title: renderMessage("menu.bindings.removeTitle"),
    items: bindings.map((binding) => ({ value: binding.id, label: bindingRow(binding) })),
  });
  if (picked === undefined) return;
  notifyConfigWrite(
    context,
    await removeProfileBinding(options.libraryRoot, picked),
    "menu.bindings.removed",
  );
}

// The provider, then either one of its models or the provider rule. A provider without working
// credentials is still offered and marked: the rule can be recorded before it is authenticated.
async function pickBindingRule(
  context: PiCommandContext,
): Promise<{ readonly provider: string; readonly model: string | null } | undefined> {
  const registry = context.modelRegistry;
  if (registry === undefined) return undefined;
  const models = registry.getAll();
  const authenticated = new Set(registry.getAvailable().map((entry) => entry.provider));
  // A registry entry the writer would reject is not offered, so nothing with a control character
  // reaches the terminal either.
  const providers = [...new Set(models.map((entry) => entry.provider))]
    .filter(isRegistryIdentifier)
    .sort();
  if (providers.length === 0) {
    context.ui.notify(renderMessage("menu.bindings.noProviders"), "info");
    return undefined;
  }
  const provider = await selectMenuItem(context, {
    title: renderMessage("menu.bindings.providerTitle"),
    items: providers.map((name) => ({
      value: name,
      label: authenticated.has(name)
        ? escapeBody(name)
        : `${escapeBody(name)} ${renderMessage("menu.bindings.noCredentials")}`,
    })),
  });
  if (provider === undefined) return undefined;
  const providerModels = [
    ...new Set(
      models
        .filter((entry) => entry.provider === provider)
        .map((entry) => entry.id)
        .filter(isRegistryIdentifier),
    ),
  ].sort();
  const model = await selectMenuItem(context, {
    title: renderMessage("menu.bindings.modelTitle", { provider: escapeBody(provider) }),
    items: [
      {
        value: ANY_MODEL,
        label: renderMessage("menu.bindings.anyModel", { provider: escapeBody(provider) }),
      },
      ...providerModels.map((id) => ({ value: id, label: escapeBody(id) })),
    ],
  });
  if (model === undefined) return undefined;
  return { provider, model: model === ANY_MODEL ? null : model };
}

// The sentinel is not a registry identifier: it carries a control character, which neither the
// writer nor the reader accepts, so it cannot collide with a provider's model.
const ANY_MODEL = "\u0000any-model";
// A long rule list would leave the menu with a single visible action, so the subtitle stops early.
const BINDING_SUBTITLE_LIMIT = 5;

function bindingRows(bindings: readonly ProfileBinding[]): string[] {
  const visible = bindings.slice(0, BINDING_SUBTITLE_LIMIT);
  const rows = visible.map(bindingRow);
  if (bindings.length > visible.length) {
    rows.push(renderMessage("menu.bindings.more", { count: bindings.length - visible.length }));
  }
  return rows;
}

function bindingRow(binding: ProfileBinding): string {
  const provider = escapeLabel(binding.provider);
  return binding.model === null
    ? renderMessage("menu.bindings.row.any", { provider, profileId: binding.profileId })
    : renderMessage("menu.bindings.row.model", {
        provider,
        model: escapeLabel(binding.model),
        profileId: binding.profileId,
      });
}

// "Automatic" is the absence of the state file: the library then resolves the bindings and the
// configured default. An unreadable state is reported and left as it is, as every other write does.
async function setAutomaticChoice(
  context: PiCommandContext,
  options: SelectorOptions,
): Promise<void> {
  const saved = await clearSelection(options.stateDirectory);
  if (saved.status === "failed") {
    context.ui.notify(
      renderSelectorText({ kind: "failed", diagnostic: saved.diagnostic }),
      "error",
    );
    return;
  }
  context.ui.notify(renderMessage("menu.automatic.recorded"), "info");
}

function notifyConfigWrite(
  context: PiCommandContext,
  result: ConfigWriteResult,
  savedKey: string,
): void {
  if (result.status === "saved") {
    context.ui.notify(renderMessage(savedKey), "info");
    return;
  }
  const reason = renderMessage(`menu.bindings.failure.${result.reason}`);
  context.ui.notify(
    renderMessage("menu.bindings.failed", {
      detail: result.detail === null ? reason : `${reason} (${result.detail})`,
    }),
    "error",
  );
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
