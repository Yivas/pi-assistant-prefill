import type { PiCommandContext } from "./extension-types.ts";
import { renderMessage } from "./messages.ts";
import { type ProfileEditPart, type ProfileWriteResult, writeProfile } from "./profile-writer.ts";
import { isProfileId, loadProfileCatalog, type ProfileSnapshot } from "./profiles.ts";
import { selectMenuItem } from "./search-list.ts";

function canEdit(context: PiCommandContext): boolean {
  if (context.mode === "tui" && context.ui.input && context.ui.editor) return true;
  context.ui.notify(renderMessage("writer.unavailable"), "warning");
  return false;
}

function notifyWrite(context: PiCommandContext, result: ProfileWriteResult, edited: boolean): void {
  if (result.status === "saved") {
    context.ui.notify(renderMessage(edited ? "writer.edited" : "writer.created"), "info");
  } else {
    context.ui.notify(
      renderMessage("writer.failed", {
        detail: renderMessage(`writer.failure.${result.reason}`),
        diagnostic: result.diagnostic ? ` (${result.diagnostic})` : "",
      }),
      "error",
    );
  }
}

export async function createProfile(context: PiCommandContext, libraryRoot: string): Promise<void> {
  if (!canEdit(context) || !context.ui.input || !context.ui.editor) return;
  try {
    const id = await context.ui.input(renderMessage("writer.id"));
    if (id === undefined) return;
    if (!isProfileId(id)) {
      notifyWrite(context, { status: "failed", reason: "invalid-id" }, false);
      return;
    }
    const name = await context.ui.input(renderMessage("writer.name"));
    if (name === undefined) return;
    const description = await context.ui.input(renderMessage("writer.description"));
    if (description === undefined) return;
    const userText = await context.ui.editor(renderMessage("writer.user"));
    if (userText === undefined) return;
    const assistantText = await context.ui.editor(renderMessage("writer.assistant"));
    if (assistantText === undefined) return;
    notifyWrite(
      context,
      await writeProfile(libraryRoot, {
        kind: "create",
        profile: { id, name, description, userText, assistantText },
      }),
      false,
    );
  } catch {
    context.ui.notify(renderMessage("writer.dialogFailed"), "error");
  }
}

export async function editProfile(
  context: PiCommandContext,
  libraryRoot: string,
  id: string,
): Promise<void> {
  if (!canEdit(context) || !context.ui.editor) return;
  try {
    const catalog = await loadProfileCatalog(libraryRoot);
    const profile =
      catalog.status === "loaded" ? catalog.profiles.find((item) => item.id === id) : undefined;
    if (!profile) {
      notifyWrite(context, { status: "failed", reason: "catalog" }, true);
      return;
    }
    const parts: readonly ProfileEditPart[] = ["metadata", "user", "assistant"];
    const chosen = await selectMenuItem(context, {
      title: renderMessage("writer.edit.title"),
      items: parts.map((part) => ({
        value: part,
        label: renderMessage(`writer.edit.${part}`),
        description: renderMessage(`writer.edit.description.${part}`),
      })),
    });
    const part = parts.find((item) => item === chosen);
    if (!part) return;
    const updated = await editPart(context, profile, part);
    if (updated === undefined) return;
    notifyWrite(
      context,
      await writeProfile(libraryRoot, { kind: "edit", profile: updated, part }),
      true,
    );
  } catch {
    context.ui.notify(renderMessage("writer.dialogFailed"), "error");
  }
}

async function editPart(
  context: PiCommandContext,
  profile: ProfileSnapshot,
  part: ProfileEditPart,
): Promise<ProfileSnapshot | undefined> {
  if (!context.ui.editor) return undefined;
  if (part === "metadata") {
    const name = await context.ui.editor(renderMessage("writer.name"), profile.name);
    if (name === undefined) return undefined;
    const description = await context.ui.editor(
      renderMessage("writer.description"),
      profile.description,
    );
    if (description === undefined) return undefined;
    return { ...profile, name: name.trim(), description: description.trim() };
  }
  const key = part === "user" ? "userText" : "assistantText";
  const text = await context.ui.editor(renderMessage(`writer.${part}`), profile[key]);
  return text === undefined ? undefined : { ...profile, [key]: text };
}
