import type { Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { ProfileFailure } from "./diagnostic.ts";

// Expected filesystem errors become diagnostics without raw messages or paths.
// Unexpected errors propagate so programming failures are not hidden.
export async function fileOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw mapFileError(error);
  }
}

export async function lstatIfPresent(filePath: string): Promise<Stats | null> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw mapFileError(error);
  }
}

// The library root, resolved from metadata only: the root itself, or when it is missing, its
// nearest existing ancestor. A missing root below an existing directory is empty (null). Below a
// regular file, a special entry or a link to one, it is a catalog failure, as is a root that is
// itself a non-directory. A dangling link on the path is a broken-link identity failure, never
// an absent root. No profile, configuration or content is read here.
export async function resolveRootDirectory(libraryRoot: string): Promise<string | null> {
  const resolvedRoot = path.resolve(libraryRoot);
  const existing = await nearestExistingEntry(resolvedRoot);
  const isDirectory = await isDirectoryEntry(existing);
  if (existing.path !== resolvedRoot) {
    if (isDirectory) return null;
    throw new ProfileFailure("catalog", "root-not-directory");
  }
  if (!isDirectory) throw new ProfileFailure("catalog", "root-not-directory");
  return resolveLogicalPath(resolvedRoot);
}

interface ExistingEntry {
  readonly path: string;
  readonly stats: Stats;
}

// Walks up while lstat reports ENOENT or ENOTDIR. POSIX reports ENOTDIR for a path below a
// regular file, Windows reports ENOENT for the same case, so both are treated as absent here.
async function nearestExistingEntry(entryPath: string): Promise<ExistingEntry> {
  let candidate = entryPath;
  for (;;) {
    try {
      return { path: candidate, stats: await fs.lstat(candidate) };
    } catch (error) {
      const code = errorCode(error);
      const parent = path.dirname(candidate);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === candidate) {
        throw mapFileError(error);
      }
      candidate = parent;
    }
  }
}

async function isDirectoryEntry(entry: ExistingEntry): Promise<boolean> {
  if (!entry.stats.isSymbolicLink()) return entry.stats.isDirectory();
  const realPath = await resolveLogicalPath(entry.path);
  return (await fileOperation(() => fs.stat(realPath))).isDirectory();
}

// Resolves links to their final location. A dangling link is an identity error, distinct
// from a missing path, so callers can say which one they found.
export async function resolveLogicalPath(logicalPath: string): Promise<string> {
  try {
    return await fs.realpath(logicalPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT" && (await isSymbolicLink(logicalPath))) {
      throw new ProfileFailure("identity", "broken-link");
    }
    throw mapFileError(error);
  }
}

// Strictly inside: compares path components, so a sibling named like the root is outside.
export function isInsideDirectory(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  if (relative === "") return false;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Reads a regular file whose final location is inside realRoot. The read is bounded to
// maxBytes and fails if the file changes between the checks. Same-user races are not covered.
export async function readRegularFileWithin(
  realRoot: string,
  logicalPath: string,
  maxBytes: number,
): Promise<Buffer> {
  const realPath = await resolveContainedPath(realRoot, logicalPath);
  const before = await fileOperation(() => fs.stat(realPath));
  if (!before.isFile()) throw new ProfileFailure("file", "not-regular-file");
  if (before.size > maxBytes) throw new ProfileFailure("size", "too-large");

  const bytes = await readOpenedFile(realPath, before, maxBytes);
  assertSameFile(before, await fileOperation(() => fs.stat(realPath)));
  if ((await resolveLogicalPath(logicalPath)) !== realPath) {
    throw new ProfileFailure("file", "changed-during-read");
  }
  return bytes;
}

// The UTF-8 BOM is consumed by the decoder, so the returned text starts after it.
// Text is never trimmed or normalized.
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw new ProfileFailure("text", "invalid-utf8");
  }
}

async function resolveContainedPath(realRoot: string, logicalPath: string): Promise<string> {
  const realPath = await resolveLogicalPath(logicalPath);
  if (!isInsideDirectory(realRoot, realPath)) throw new ProfileFailure("identity", "outside-root");
  return realPath;
}

async function readOpenedFile(realPath: string, before: Stats, maxBytes: number): Promise<Buffer> {
  const handle = await fileOperation(() => fs.open(realPath, "r"));
  let bytes: Buffer;
  try {
    assertSameFile(before, await fileOperation(() => handle.stat()));
    bytes = await readAtMost(handle, maxBytes);
    assertSameFile(before, await fileOperation(() => handle.stat()));
  } catch (readError) {
    await closeAfterFailure(handle);
    throw readError;
  }
  await fileOperation(() => handle.close());
  return bytes;
}

// The read failure is the reason reported to the caller. A close failure at this point is
// secondary: a failed close attempt must not replace the original filesystem diagnostic.
// A close error does not prove the handle was released.
// Anything else (a programming error) is rethrown so it is not hidden.
async function closeAfterFailure(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch (closeError) {
    if (!(mapFileError(closeError) instanceof ProfileFailure)) throw closeError;
  }
}

// Reads one byte past the limit, so a file exactly at the limit is accepted and one byte more is rejected.
async function readAtMost(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let total = 0;
  while (total <= maxBytes) {
    const { bytesRead } = await fileOperation(() =>
      handle.read(buffer, total, buffer.length - total, total),
    );
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  if (total > maxBytes) throw new ProfileFailure("size", "too-large");
  return buffer.subarray(0, total);
}

function assertSameFile(expected: Stats, actual: Stats): void {
  const sameFile =
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.size === actual.size &&
    expected.mtimeMs === actual.mtimeMs;
  if (!sameFile) throw new ProfileFailure("file", "changed-during-read");
}

async function isSymbolicLink(filePath: string): Promise<boolean> {
  const stats = await lstatIfPresent(filePath);
  return stats?.isSymbolicLink() ?? false;
}

function mapFileError(error: unknown): unknown {
  if (error instanceof ProfileFailure) return error;
  switch (errorCode(error)) {
    case undefined:
      return error;
    case "ENOENT":
      return new ProfileFailure("file", "missing-file");
    case "ENOTDIR":
      return new ProfileFailure("identity", "not-directory");
    case "EACCES":
    case "EPERM":
      return new ProfileFailure("file", "permission-denied");
    case "ELOOP":
      return new ProfileFailure("identity", "cyclic-link");
    default:
      return new ProfileFailure("file", "io-error");
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    return typeof error.code === "string" ? error.code : undefined;
  }
  return undefined;
}
