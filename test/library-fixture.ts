import childProcess from "node:child_process";
import dns from "node:dns";
import fs, {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { TestContext } from "node:test";

export interface LibraryFixture {
  readonly base: string;
  readonly root: string;
}

export interface ProfileFiles {
  readonly manifest: string | Buffer;
  readonly user: string | Buffer;
  readonly assistant: string | Buffer;
}

export const BRIEF_NAME = "Brief example";
export const BRIEF_DESCRIPTION = "A short explanation with one example";
export const BRIEF_USER_TEXT = "Explain what a variable is.";
export const BRIEF_ASSISTANT_TEXT = "A variable stores a value.\n\nFor example: age = 18.";

export function briefManifest(id: string): string {
  return `{"schemaVersion":1,"id":"${id}","name":"${BRIEF_NAME}","description":"${BRIEF_DESCRIPTION}"}`;
}

export function briefFiles(id: string): ProfileFiles {
  return {
    manifest: briefManifest(id),
    user: BRIEF_USER_TEXT,
    assistant: BRIEF_ASSISTANT_TEXT,
  };
}

// Creates a fresh temporary base directory per test; `prefills` is the library root.
export async function createLibraryFixture(t: TestContext): Promise<LibraryFixture> {
  const base = await mkdtemp(join(tmpdir(), "pi-prefill-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "prefills");
  await mkdir(root);
  return { base, root };
}

export async function writeProfile(
  root: string,
  directoryName: string,
  files: ProfileFiles = briefFiles(directoryName),
): Promise<string> {
  const directory = join(root, directoryName);
  await mkdir(directory);
  await writeFile(join(directory, "profile.json"), files.manifest);
  await writeFile(join(directory, "user.md"), files.user);
  await writeFile(join(directory, "assistant.md"), files.assistant);
  return directory;
}

export async function writeRootFile(
  root: string,
  name: string,
  content: string | Buffer,
): Promise<string> {
  const filePath = join(root, name);
  await writeFile(filePath, content);
  return filePath;
}

export async function linkDirectory(target: string, linkPath: string): Promise<void> {
  await symlink(target, linkPath, "dir");
}

export async function linkFile(target: string, linkPath: string): Promise<void> {
  await symlink(target, linkPath, "file");
}

// Byte-level view of a tree, used to show that loading and resolution never write.
export async function snapshotTree(directory: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  await collectTree(directory, directory, entries);
  return entries;
}

async function collectTree(
  base: string,
  directory: string,
  entries: Record<string, string>,
): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    const key = relative(base, entryPath);
    if (entry.isSymbolicLink()) {
      entries[key] = `link:${await readlink(entryPath)}`;
    } else if (entry.isDirectory()) {
      entries[key] = "directory";
      await collectTree(base, entryPath, entries);
    } else {
      entries[key] = `file:${(await readFile(entryPath)).toString("base64")}`;
    }
  }
}

// Records calls to network and process boundaries. Each call throws, so a caller that uses
// one of them fails the test; the returned list shows which boundary was reached.
export function externalCallRecorder(t: TestContext): string[] {
  const calls: string[] = [];
  const record = (name: string) => () => {
    calls.push(name);
    throw new Error(`external boundary used: ${name}`);
  };
  t.mock.method(dns, "lookup", record("dns.lookup"));
  t.mock.method(net, "connect", record("net.connect"));
  t.mock.method(net, "createConnection", record("net.createConnection"));
  t.mock.method(http, "request", record("http.request"));
  t.mock.method(childProcess, "spawn", record("child_process.spawn"));
  t.mock.method(childProcess, "exec", record("child_process.exec"));
  t.mock.method(childProcess, "execFile", record("child_process.execFile"));
  t.mock.method(childProcess, "fork", record("child_process.fork"));
  t.mock.method(globalThis, "fetch", record("fetch"));
  return calls;
}

// Same idea for the filesystem calls the library may make. Use it only where no read is expected:
// a call that reaches the disk is recorded and fails. Creating fixtures uses other functions.
export function fileSystemCallRecorder(t: TestContext): string[] {
  const calls: string[] = [];
  const record = (name: string) => () => {
    calls.push(name);
    throw new Error(`filesystem call used: ${name}`);
  };
  for (const name of ["lstat", "stat", "realpath", "readdir", "open"] as const) {
    t.mock.method(fs, name, record(`fs.${name}`));
  }
  return calls;
}
