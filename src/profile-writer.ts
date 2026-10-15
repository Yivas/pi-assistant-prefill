import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isInsideDirectory, lstatIfPresent } from "./file-read.ts";
import { isProfileId, loadProfileCatalog, type ProfileSnapshot } from "./profiles.ts";
import { MAX_JSON_DOCUMENT_BYTES } from "./strict-json.ts";

export type ProfileEditPart = "metadata" | "user" | "assistant";

type WriteRequest =
  | { readonly kind: "create"; readonly profile: ProfileSnapshot }
  | { readonly kind: "edit"; readonly profile: ProfileSnapshot; readonly part: ProfileEditPart };

type WriteFailure =
  | "invalid-id"
  | "invalid-label"
  | "empty-body"
  | "too-large"
  | "exists"
  | "unsafe-path"
  | "io"
  | "catalog";

export type ProfileWriteResult =
  | { readonly status: "saved" }
  | { readonly status: "failed"; readonly reason: WriteFailure; readonly diagnostic?: string };

class WriteError extends Error {
  readonly reason: WriteFailure;

  constructor(reason: WriteFailure) {
    super(reason);
    this.reason = reason;
  }
}

function serialize(
  profile: ProfileSnapshot,
): Record<ProfileEditPart, { name: string; text: string }> {
  if (!isProfileId(profile.id)) throw new WriteError("invalid-id");
  for (const label of [profile.name, profile.description]) {
    const hasControl = Array.from(label).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || (code >= 0x7f && code <= 0x9f);
    });
    if (!label.trim() || hasControl) {
      throw new WriteError("invalid-label");
    }
  }
  if (!profile.userText.trim() || !profile.assistantText.trim()) throw new WriteError("empty-body");
  const manifest = `${JSON.stringify(
    {
      schemaVersion: 1,
      id: profile.id,
      name: profile.name,
      description: profile.description,
    },
    null,
    2,
  )}\n`;
  if (
    Buffer.byteLength(manifest) > MAX_JSON_DOCUMENT_BYTES ||
    Buffer.byteLength(profile.userText) > 65536 ||
    Buffer.byteLength(profile.assistantText) > 65536
  ) {
    throw new WriteError("too-large");
  }
  return {
    metadata: { name: "profile.json", text: manifest },
    user: { name: "user.md", text: profile.userText },
    assistant: { name: "assistant.md", text: profile.assistantText },
  };
}

// Only the TUI editor calls this writer. Validate everything before creating any directory;
// each replacement is atomic, but creating all three files is not a transaction.
export async function writeProfile(
  libraryRoot: string,
  request: WriteRequest,
): Promise<ProfileWriteResult> {
  try {
    const files = serialize(request.profile);
    await fs.mkdir(libraryRoot, { recursive: true });
    const realRoot = await fs.realpath(libraryRoot);
    const directory = path.join(realRoot, request.profile.id);
    if (request.kind === "create") {
      try {
        await fs.mkdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new WriteError("exists");
        throw error;
      }
    }
    const identity = await fs.lstat(directory);
    const checkDirectory = async () => {
      const current = await fs.lstat(directory);
      const realDirectory = await fs.realpath(directory);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        realDirectory !== directory ||
        !isInsideDirectory(realRoot, realDirectory) ||
        (await fs.realpath(libraryRoot)) !== realRoot
      ) {
        throw new WriteError("unsafe-path");
      }
    };
    await checkDirectory();
    const parts: readonly ProfileEditPart[] =
      request.kind === "create" ? ["metadata", "user", "assistant"] : [request.part];
    for (const part of parts) {
      const file = files[part];
      await atomicWrite(directory, file.name, file.text, checkDirectory);
    }
    const catalog = await loadProfileCatalog(libraryRoot);
    if (catalog.status === "failed") {
      return {
        status: "failed",
        reason: "catalog",
        diagnostic: `${catalog.diagnostic.category}/${catalog.diagnostic.code}`,
      };
    }
    if (!catalog.profiles.some((profile) => profile.id === request.profile.id)) {
      const diagnostic = catalog.diagnostics.find(
        (entry) => entry.profileId === request.profile.id,
      );
      return {
        status: "failed",
        reason: "catalog",
        diagnostic: diagnostic
          ? `${diagnostic.category}/${diagnostic.code}`
          : catalog.diagnostics.map((entry) => `${entry.category}/${entry.code}`).join(", ") ||
            "profile-unavailable",
      };
    }
    return { status: "saved" };
  } catch (error) {
    return { status: "failed", reason: error instanceof WriteError ? error.reason : "io" };
  }
}

async function atomicWrite(
  directory: string,
  name: string,
  text: string,
  checkDirectory: () => Promise<void>,
): Promise<void> {
  const target = path.join(directory, name);
  const temporary = path.join(directory, `.${name}.${randomUUID()}.tmp`);
  let created = false;
  try {
    await checkDirectory();
    checkTarget(await lstatIfPresent(target));
    const handle = await fs.open(temporary, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await checkDirectory();
    checkTarget(await lstatIfPresent(target));
    await fs.rename(temporary, target);
    created = false;
  } finally {
    if (created) {
      // Do not follow a replaced directory even to clean up a temporary file.
      await checkDirectory()
        .then(() => fs.rm(temporary, { force: true }))
        .catch(() => undefined);
    }
  }
}

function checkTarget(stats: Stats | null): void {
  if (stats && (!stats.isFile() || stats.isSymbolicLink())) throw new WriteError("unsafe-path");
}
