import assert from "node:assert/strict";
import fs, { type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { isProfileId, loadProfileCatalog } from "../src/profiles.ts";
import {
  BRIEF_ASSISTANT_TEXT,
  BRIEF_DESCRIPTION,
  BRIEF_NAME,
  BRIEF_USER_TEXT,
  briefFiles,
  briefManifest,
  createLibraryFixture,
  externalCallRecorder,
  linkDirectory,
  linkFile,
  snapshotTree,
  writeProfile,
  writeRootFile,
} from "./library-fixture.ts";

const VALID_BRIEF_PROFILE = {
  id: "brief-example",
  name: BRIEF_NAME,
  description: BRIEF_DESCRIPTION,
  userText: BRIEF_USER_TEXT,
  assistantText: BRIEF_ASSISTANT_TEXT,
};

// Stands in for a file handle at the OS boundary: reads fail with the given error code, and close
// still releases the real handle before it fails with its own code. The codes come from the test.
function faultyHandle(real: FileHandle, failures: { read?: string; close?: string }): FileHandle {
  const osError = (code: string) => Object.assign(new Error(code), { code });
  return {
    stat: () => real.stat(),
    read: async (buffer: Buffer, offset: number, length: number, position: number) => {
      if (failures.read !== undefined) throw osError(failures.read);
      return real.read(buffer, offset, length, position);
    },
    close: async () => {
      await real.close();
      if (failures.close !== undefined) throw osError(failures.close);
    },
  } as unknown as FileHandle;
}

// Replaces the file operations used by the library reader at the process boundary.
// Calls outside the target path go through the real implementation.
function interceptOpen(
  t: TestContext,
  targetName: string,
  intercept: (realOpen: typeof fs.open, filePath: string) => ReturnType<typeof fs.open>,
): void {
  const realOpen = fs.open.bind(fs);
  t.mock.method(fs, "open", (filePath: string, ...rest: []) => {
    if (!filePath.endsWith(targetName)) return realOpen(filePath, ...rest);
    return intercept(realOpen, filePath);
  });
}

describe("loadProfileCatalog: library root", () => {
  it("uses the canonical root to list a linked library", async (t) => {
    const { base, root } = await createLibraryFixture(t);
    await writeProfile(root, "brief-example");
    const linkedRoot = join(base, "linked-root");
    await linkDirectory(root, linkedRoot);
    const canonicalRoot = await fs.realpath(root);
    const listedRoots: string[] = [];
    const realReaddir = fs.readdir.bind(fs);
    t.mock.method(fs, "readdir", (directory: string) => {
      listedRoots.push(directory);
      return realReaddir(directory, { withFileTypes: true });
    });

    const catalog = await loadProfileCatalog(linkedRoot);

    assert.deepEqual(catalog, {
      status: "loaded",
      profiles: [VALID_BRIEF_PROFILE],
      diagnostics: [],
    });
    assert.deepEqual(listedRoots, [canonicalRoot]);
  });

  it("treats a missing library root as an empty catalog", async (t) => {
    const { base } = await createLibraryFixture(t);
    await fs.rm(join(base, "prefills"), { recursive: true });

    const catalog = await loadProfileCatalog(join(base, "prefills"));

    assert.deepEqual(catalog, { status: "loaded", profiles: [], diagnostics: [] });
  });

  it("reports a library root below a regular file as a catalog failure", async (t) => {
    const { base } = await createLibraryFixture(t);
    const filePath = await writeRootFile(base, "prefills-file", "not a directory");

    const catalog = await loadProfileCatalog(join(filePath, "prefills"));

    assert.deepEqual(catalog, {
      status: "failed",
      diagnostic: {
        category: "catalog",
        code: "root-not-directory",
        profileId: null,
        candidateOrdinal: null,
      },
    });
  });

  it("treats a missing library root below an existing directory as empty", async (t) => {
    const { base } = await createLibraryFixture(t);

    const catalog = await loadProfileCatalog(join(base, "absent", "prefills"));

    assert.deepEqual(catalog, { status: "loaded", profiles: [], diagnostics: [] });
  });

  it("reports a missing library root below a broken link as a broken link", async (t) => {
    const { base } = await createLibraryFixture(t);
    await linkDirectory(join(base, "missing-store"), join(base, "broken-store"));

    const catalog = await loadProfileCatalog(join(base, "broken-store", "prefills"));

    assert.deepEqual(catalog, {
      status: "failed",
      diagnostic: {
        category: "identity",
        code: "broken-link",
        profileId: null,
        candidateOrdinal: null,
      },
    });
  });

  it("fails when the library root is a regular file", async (t) => {
    const { base } = await createLibraryFixture(t);
    const filePath = join(base, "prefills-file");
    await fs.writeFile(filePath, "not a directory");

    const catalog = await loadProfileCatalog(filePath);

    assert.deepEqual(catalog, {
      status: "failed",
      diagnostic: {
        category: "catalog",
        code: "root-not-directory",
        profileId: null,
        candidateOrdinal: null,
      },
    });
  });

  it("fails when the library root is a dangling link", async (t) => {
    const { base } = await createLibraryFixture(t);
    const rootLink = join(base, "linked-root");
    await linkDirectory(join(base, "missing-store"), rootLink);

    const catalog = await loadProfileCatalog(rootLink);

    assert.deepEqual(catalog, {
      status: "failed",
      diagnostic: {
        category: "identity",
        code: "broken-link",
        profileId: null,
        candidateOrdinal: null,
      },
    });
  });

  it("accepts a library root that is a directory link", async (t) => {
    const { base } = await createLibraryFixture(t);
    const store = join(base, "store");
    await fs.mkdir(store);
    await writeProfile(store, "brief-example");
    const rootLink = join(base, "linked-root");
    await linkDirectory(store, rootLink);

    const catalog = await loadProfileCatalog(rootLink);

    assert.deepEqual(catalog, {
      status: "loaded",
      profiles: [VALID_BRIEF_PROFILE],
      diagnostics: [],
    });
  });

  it("ignores regular files at the library root", async (t) => {
    const { root } = await createLibraryFixture(t);
    await writeRootFile(root, "notes.txt", "outside any profile");
    await writeRootFile(root, "common.md", "shared text");

    const catalog = await loadProfileCatalog(root);

    assert.deepEqual(catalog, { status: "loaded", profiles: [], diagnostics: [] });
  });
});

describe("loadProfileCatalog: candidates", () => {
  it("loads a valid profile as an exact, frozen snapshot", async (t) => {
    const { root } = await createLibraryFixture(t);
    await writeProfile(root, "brief-example");

    const catalog = await loadProfileCatalog(root);

    assert.deepEqual(catalog, {
      status: "loaded",
      profiles: [VALID_BRIEF_PROFILE],
      diagnostics: [],
    });
    if (catalog.status !== "loaded") assert.fail("expected a loaded catalog");
    assert.equal(Object.isFrozen(catalog.profiles), true);
    assert.equal(Object.isFrozen(catalog.profiles[0]), true);
    assert.throws(() => {
      (catalog.profiles[0] as { name: string }).name = "changed";
    }, TypeError);
  });

  it("keeps valid profiles when another profile is invalid", async (t) => {
    const { root } = await createLibraryFixture(t);
    await writeProfile(root, "brief-example");
    await writeProfile(root, "broken-profile", {
      manifest: '{"schemaVersion":1,',
      user: BRIEF_USER_TEXT,
      assistant: BRIEF_ASSISTANT_TEXT,
    });

    const catalog = await loadProfileCatalog(root);

    assert.deepEqual(catalog, {
      status: "loaded",
      profiles: [VALID_BRIEF_PROFILE],
      diagnostics: [
        { category: "manifest", code: "invalid-json", profileId: null, candidateOrdinal: 2 },
      ],
    });
  });

  it("numbers candidates by UTF-16 code unit order of their names", async (t) => {
    const { root } = await createLibraryFixture(t);
    await fs.mkdir(join(root, "Zeta"));
    await fs.mkdir(join(root, "alpha"));

    const catalog = await loadProfileCatalog(root);

    assert.deepEqual(catalog, {
      status: "loaded",
      profiles: [],
      diagnostics: [
        { category: "identity", code: "invalid-id", profileId: null, candidateOrdinal: 1 },
        { category: "file", code: "missing-file", profileId: null, candidateOrdinal: 2 },
      ],
    });
  });

  it("examines exactly 100 candidates, including invalid ones", async (t) => {
    const { root } = await createLibraryFixture(t);
    for (let index = 0; index < 99; index += 1) {
      await fs.mkdir(join(root, `Bad-${String(index).padStart(2, "0")}`));
    }
    await writeProfile(root, "valid-profile");

    const catalog = await loadProfileCatalog(root);

    assert.equal(catalog.status, "loaded");
    if (catalog.status !== "loaded") assert.fail("expected a loaded catalog");
    assert.deepEqual(
      catalog.profiles.map((profile) => profile.id),
      ["valid-profile"],
    );
    assert.equal(catalog.diagnostics.length, 99);
    assert.equal(catalog.diagnostics[98]?.candidateOrdinal, 99);
  });

  it("blocks the whole catalog at candidate 101 instead of truncating it", async (t) => {
    const { root } = await createLibraryFixture(t);
    for (let index = 0; index < 100; index += 1) {
      await fs.mkdir(join(root, `Bad-${String(index).padStart(3, "0")}`));
    }
    await writeProfile(root, "valid-profile");

    const catalog = await loadProfileCatalog(root);

    assert.deepEqual(catalog, {
      status: "failed",
      diagnostic: {
        category: "catalog",
        code: "candidate-limit-exceeded",
        profileId: null,
        candidateOrdinal: null,
      },
    });
  });

  it("reports a profile directory without its user text as a file diagnostic", async (t) => {
    const { root } = await createLibraryFixture(t);
    const directory = await writeProfile(root, "brief-example");
    await fs.rm(join(directory, "user.md"));

    const catalog = await loadProfileCatalog(root);

    assert.deepEqual(catalog, {
      status: "loaded",
      profiles: [],
      diagnostics: [
        {
          category: "file",
          code: "missing-file",
          profileId: "brief-example",
          candidateOrdinal: null,
        },
      ],
    });
  });

  it("rejects a profile whose manifest id differs from its directory", async (t) => {
    const { root } = await createLibraryFixture(t);
    await writeProfile(root, "brief-example", briefFiles("other-example"));

    const catalog = await loadProfileCatalog(root);

    assert.deepEqual(catalog, {
      status: "loaded",
      profiles: [],
      diagnostics: [
        { category: "identity", code: "id-mismatch", profileId: null, candidateOrdinal: 1 },
      ],
    });
  });

  it("rejects a directory link whose canonical basename differs from its name", async (t) => {
    const { root } = await createLibraryFixture(t);
    const holder = join(root, "holder");
    await fs.mkdir(holder);
    await writeProfile(holder, "brief-example");
    await linkDirectory(join(holder, "brief-example"), join(root, "alias-profile"));

    const catalog = await loadProfileCatalog(root);

    assert.deepEqual(catalog, {
      status: "loaded",
      profiles: [],
      diagnostics: [
        {
          category: "identity",
          code: "canonical-name-mismatch",
          profileId: null,
          candidateOrdinal: 1,
        },
        { category: "file", code: "missing-file", profileId: null, candidateOrdinal: 2 },
      ],
    });
  });

  it("invalidates every candidate that shares one canonical directory", async (t) => {
    const { root } = await createLibraryFixture(t);
    const directory = await writeProfile(root, "brief-example");
    await linkDirectory(directory, join(root, "alias"));

    const catalog = await loadProfileCatalog(root);

    assert.deepEqual(catalog, {
      status: "loaded",
      profiles: [],
      diagnostics: [
        {
          category: "identity",
          code: "shared-canonical-directory",
          profileId: null,
          candidateOrdinal: 1,
        },
        {
          category: "identity",
          code: "shared-canonical-directory",
          profileId: null,
          candidateOrdinal: 2,
        },
      ],
    });
  });

  it("rejects a directory link that escapes the library root", async (t) => {
    const { base, root } = await createLibraryFixture(t);
    const outside = join(base, "outside-profile");
    await writeProfile(base, "outside-profile");
    await linkDirectory(outside, join(root, "escape"));

    const catalog = await loadProfileCatalog(root);

    assert.deepEqual(catalog, {
      status: "loaded",
      profiles: [],
      diagnostics: [
        { category: "identity", code: "outside-root", profileId: null, candidateOrdinal: 1 },
      ],
    });
  });

  it("rejects a broken directory link", async (t) => {
    const { base, root } = await createLibraryFixture(t);
    await linkDirectory(join(base, "missing-profile"), join(root, "broken-profile"));

    const catalog = await loadProfileCatalog(root);

    assert.deepEqual(catalog, {
      status: "loaded",
      profiles: [],
      diagnostics: [
        { category: "identity", code: "broken-link", profileId: null, candidateOrdinal: 1 },
      ],
    });
  });

  it("rejects a candidate link that points to a regular file", async (t) => {
    const { root } = await createLibraryFixture(t);
    const notes = await writeRootFile(root, "notes.txt", "not a profile");
    await linkFile(notes, join(root, "file-link"));

    const catalog = await loadProfileCatalog(root);

    assert.deepEqual(catalog, {
      status: "loaded",
      profiles: [],
      diagnostics: [
        { category: "identity", code: "not-directory", profileId: null, candidateOrdinal: 1 },
      ],
    });
  });

  it("rejects reserved Windows identifiers", () => {
    for (const reserved of ["con", "prn", "aux", "nul", "com1", "com9", "lpt1", "lpt9"]) {
      assert.equal(isProfileId(reserved), false, reserved);
    }
    assert.equal(isProfileId("com0"), true);
  });

  it("rejects identifiers outside the portable pattern and length", () => {
    for (const invalid of [
      "Brief",
      "brief_example",
      "brief.example",
      "-brief",
      "brief-",
      "brief--example",
      "../outside",
      "",
      "a".repeat(65),
    ]) {
      assert.equal(isProfileId(invalid), false, invalid);
    }
    assert.equal(isProfileId("a".repeat(64)), true);
    assert.equal(isProfileId("brief-example-2"), true);
  });
});

describe("loadProfileCatalog: profile files", () => {
  it("accepts a user text linked to a regular file inside the library root", async (t) => {
    const { root } = await createLibraryFixture(t);
    const directory = await writeProfile(root, "brief-example", {
      manifest: briefManifest("brief-example"),
      user: "unused",
      assistant: BRIEF_ASSISTANT_TEXT,
    });
    const shared = await writeRootFile(root, "common-user.md", "Shared introduction.");
    await fs.rm(join(directory, "user.md"));
    await linkFile(shared, join(directory, "user.md"));

    const catalog = await loadProfileCatalog(root);

    assert.deepEqual(catalog, {
      status: "loaded",
      profiles: [{ ...VALID_BRIEF_PROFILE, userText: "Shared introduction." }],
      diagnostics: [],
    });
  });

  it("rejects a text link that escapes the library root", async (t) => {
    const { base, root } = await createLibraryFixture(t);
    const directory = await writeProfile(root, "brief-example");
    const outside = await writeRootFile(base, "outside.md", "outside text");
    await fs.rm(join(directory, "user.md"));
    await linkFile(outside, join(directory, "user.md"));

    const catalog = await loadProfileCatalog(root);

    assert.deepEqual(catalog, {
      status: "loaded",
      profiles: [],
      diagnostics: [
        {
          category: "identity",
          code: "outside-root",
          profileId: "brief-example",
          candidateOrdinal: null,
        },
      ],
    });
  });

  it("rejects a broken text link", async (t) => {
    const { base, root } = await createLibraryFixture(t);
    const directory = await writeProfile(root, "brief-example");
    await fs.rm(join(directory, "assistant.md"));
    await linkFile(join(base, "missing.md"), join(directory, "assistant.md"));

    const catalog = await loadProfileCatalog(root);

    assert.deepEqual(catalog, {
      status: "loaded",
      profiles: [],
      diagnostics: [
        {
          category: "identity",
          code: "broken-link",
          profileId: "brief-example",
          candidateOrdinal: null,
        },
      ],
    });
  });

  it("rejects a cyclic text link", async (t) => {
    const { root } = await createLibraryFixture(t);
    const directory = await writeProfile(root, "brief-example");
    await fs.rm(join(directory, "user.md"));
    await fs.rm(join(directory, "assistant.md"));
    await linkFile(join(directory, "assistant.md"), join(directory, "user.md"));
    await linkFile(join(directory, "user.md"), join(directory, "assistant.md"));

    const catalog = await loadProfileCatalog(root);

    assert.deepEqual(catalog, {
      status: "loaded",
      profiles: [],
      diagnostics: [
        {
          category: "identity",
          code: "cyclic-link",
          profileId: "brief-example",
          candidateOrdinal: null,
        },
      ],
    });
  });

  it("rejects a text file that is a directory", async (t) => {
    const { root } = await createLibraryFixture(t);
    const directory = await writeProfile(root, "brief-example");
    await fs.rm(join(directory, "user.md"));
    await fs.mkdir(join(directory, "user.md"));

    const catalog = await loadProfileCatalog(root);

    assert.deepEqual(catalog, {
      status: "loaded",
      profiles: [],
      diagnostics: [
        {
          category: "file",
          code: "not-regular-file",
          profileId: "brief-example",
          candidateOrdinal: null,
        },
      ],
    });
  });

  it("rejects a snapshot when user.md changes size while assistant.md is read", async (t) => {
    const { root } = await createLibraryFixture(t);
    const directory = await writeProfile(root, "brief-example");
    const userPath = join(directory, "user.md");
    interceptOpen(t, "assistant.md", async (realOpen, filePath) => {
      await fs.writeFile(userPath, "Explain what a variable is, revised.");
      return realOpen(filePath, "r");
    });

    const catalog = await loadProfileCatalog(root);

    assert.deepEqual(catalog, {
      status: "loaded",
      profiles: [],
      diagnostics: [
        {
          category: "file",
          code: "changed-during-read",
          profileId: "brief-example",
          candidateOrdinal: null,
        },
      ],
    });
  });

  it("rejects a snapshot when user.md changes without changing its size", async (t) => {
    const { root } = await createLibraryFixture(t);
    const directory = await writeProfile(root, "brief-example");
    const userPath = join(directory, "user.md");
    interceptOpen(t, "assistant.md", async (realOpen, filePath) => {
      await fs.writeFile(userPath, "Explain what a variable is!");
      return realOpen(filePath, "r");
    });

    const catalog = await loadProfileCatalog(root);

    assert.deepEqual(catalog, {
      status: "loaded",
      profiles: [],
      diagnostics: [
        {
          category: "file",
          code: "changed-during-read",
          profileId: "brief-example",
          candidateOrdinal: null,
        },
      ],
    });
  });

  it("keeps the read failure when closing the handle also fails", async (t) => {
    const { root } = await createLibraryFixture(t);
    await writeProfile(root, "brief-example");
    interceptOpen(t, "user.md", async (realOpen, filePath) =>
      faultyHandle(await realOpen(filePath, "r"), { read: "EACCES", close: "EIO" }),
    );

    assert.deepEqual(await loadProfileCatalog(root), {
      status: "loaded",
      profiles: [],
      diagnostics: [
        {
          category: "file",
          code: "permission-denied",
          profileId: "brief-example",
          candidateOrdinal: null,
        },
      ],
    });
  });

  it("reports a close failure after a successful read", async (t) => {
    const { root } = await createLibraryFixture(t);
    await writeProfile(root, "brief-example");
    interceptOpen(t, "user.md", async (realOpen, filePath) =>
      faultyHandle(await realOpen(filePath, "r"), { close: "EIO" }),
    );

    assert.deepEqual(await loadProfileCatalog(root), {
      status: "loaded",
      profiles: [],
      diagnostics: [
        { category: "file", code: "io-error", profileId: "brief-example", candidateOrdinal: null },
      ],
    });
  });

  it("maps a denied read to a file diagnostic without a partial snapshot", async (t) => {
    const { root } = await createLibraryFixture(t);
    await writeProfile(root, "brief-example");
    interceptOpen(t, "assistant.md", () => {
      const error = Object.assign(new Error("denied"), { code: "EACCES" });
      return Promise.reject(error);
    });

    const catalog = await loadProfileCatalog(root);

    assert.deepEqual(catalog, {
      status: "loaded",
      profiles: [],
      diagnostics: [
        {
          category: "file",
          code: "permission-denied",
          profileId: "brief-example",
          candidateOrdinal: null,
        },
      ],
    });
  });

  it("rejects a file that changes between validation and read", async (t) => {
    const { root } = await createLibraryFixture(t);
    const directory = await writeProfile(root, "brief-example");
    const assistantPath = join(directory, "assistant.md");
    interceptOpen(t, "assistant.md", async (realOpen, filePath) => {
      await fs.appendFile(assistantPath, " Changed while loading.");
      return realOpen(filePath, "r");
    });

    const catalog = await loadProfileCatalog(root);

    assert.deepEqual(catalog, {
      status: "loaded",
      profiles: [],
      diagnostics: [
        {
          category: "file",
          code: "changed-during-read",
          profileId: "brief-example",
          candidateOrdinal: null,
        },
      ],
    });
  });
});

describe("loadProfileCatalog: manifest", () => {
  const manifestCases: ReadonlyArray<readonly [string, string, string]> = [
    [
      "unknown field",
      `{"schemaVersion":1,"id":"brief-example","name":"${BRIEF_NAME}","description":"${BRIEF_DESCRIPTION}","extra":true}`,
      "unknown-field",
    ],
    [
      "duplicate key",
      `{"schemaVersion":1,"id":"brief-example","id":"brief-example","name":"${BRIEF_NAME}","description":"${BRIEF_DESCRIPTION}"}`,
      "duplicate-key",
    ],
    [
      "duplicate key written with a unicode escape",
      `{"schemaVersion":1,"id":"brief-example","\\u0069d":"brief-example","name":"${BRIEF_NAME}","description":"${BRIEF_DESCRIPTION}"}`,
      "duplicate-key",
    ],
    [
      "duplicate key inside an unknown nested object",
      `{"schemaVersion":1,"id":"brief-example","name":"${BRIEF_NAME}","description":"${BRIEF_DESCRIPTION}","meta":{"a":1,"\\u0061":2}}`,
      "duplicate-key",
    ],
    [
      "__proto__ field",
      `{"schemaVersion":1,"id":"brief-example","name":"${BRIEF_NAME}","description":"${BRIEF_DESCRIPTION}","__proto__":{}}`,
      "unknown-field",
    ],
    [
      "future schema version",
      `{"schemaVersion":2,"id":"brief-example","name":"${BRIEF_NAME}","description":"${BRIEF_DESCRIPTION}"}`,
      "unsupported-schema-version",
    ],
    [
      "string schema version",
      `{"schemaVersion":"1","id":"brief-example","name":"${BRIEF_NAME}","description":"${BRIEF_DESCRIPTION}"}`,
      "invalid-field",
    ],
    [
      "missing description",
      `{"schemaVersion":1,"id":"brief-example","name":"${BRIEF_NAME}"}`,
      "missing-field",
    ],
    [
      "blank name made of spaces",
      `{"schemaVersion":1,"id":"brief-example","name":"   ","description":"${BRIEF_DESCRIPTION}"}`,
      "blank-field",
    ],
    [
      "name with a line feed escape",
      `{"schemaVersion":1,"id":"brief-example","name":"Brief\\nexample","description":"${BRIEF_DESCRIPTION}"}`,
      "control-character",
    ],
    [
      "description with an escape character",
      `{"schemaVersion":1,"id":"brief-example","name":"${BRIEF_NAME}","description":"A\\u001bB"}`,
      "control-character",
    ],
    [
      "description with a C1 control",
      `{"schemaVersion":1,"id":"brief-example","name":"${BRIEF_NAME}","description":"A\\u0085B"}`,
      "control-character",
    ],
    [
      "comment",
      `{"schemaVersion":1, // comment\n"id":"brief-example","name":"${BRIEF_NAME}","description":"${BRIEF_DESCRIPTION}"}`,
      "invalid-json",
    ],
    ["not an object", "[]", "not-object"],
  ];

  for (const [label, manifest, code] of manifestCases) {
    it(`rejects a manifest: ${label}`, async (t) => {
      const { root } = await createLibraryFixture(t);
      await writeProfile(root, "brief-example", { ...briefFiles("brief-example"), manifest });

      const catalog = await loadProfileCatalog(root);

      assert.deepEqual(catalog, {
        status: "loaded",
        profiles: [],
        diagnostics: [{ category: "manifest", code, profileId: null, candidateOrdinal: 1 }],
      });
    });
  }

  it("accepts a Unicode display name without changing it", async (t) => {
    const { root } = await createLibraryFixture(t);
    const name = "Ejemplo: café — 🙂";
    await writeProfile(root, "brief-example", {
      ...briefFiles("brief-example"),
      manifest: `{"schemaVersion":1,"id":"brief-example","name":"${name}","description":"${BRIEF_DESCRIPTION}"}`,
    });

    const catalog = await loadProfileCatalog(root);

    assert.deepEqual(catalog, {
      status: "loaded",
      profiles: [{ ...VALID_BRIEF_PROFILE, name }],
      diagnostics: [],
    });
  });

  it("accepts a UTF-8 byte order mark at the start of the manifest", async (t) => {
    const { root } = await createLibraryFixture(t);
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    await writeProfile(root, "brief-example", {
      ...briefFiles("brief-example"),
      manifest: Buffer.concat([bom, Buffer.from(briefManifest("brief-example"))]),
    });

    const catalog = await loadProfileCatalog(root);

    assert.deepEqual(catalog, {
      status: "loaded",
      profiles: [VALID_BRIEF_PROFILE],
      diagnostics: [],
    });
  });

  it("rejects a manifest with malformed UTF-8 as a text diagnostic", async (t) => {
    const { root } = await createLibraryFixture(t);
    await writeProfile(root, "brief-example", {
      ...briefFiles("brief-example"),
      manifest: Buffer.from([0x7b, 0xff, 0x7d]),
    });

    const catalog = await loadProfileCatalog(root);

    assert.deepEqual(catalog, {
      status: "loaded",
      profiles: [],
      diagnostics: [
        { category: "text", code: "invalid-utf8", profileId: null, candidateOrdinal: 1 },
      ],
    });
  });

  it("accepts a manifest of exactly 8192 bytes and rejects 8193", async (t) => {
    const { root } = await createLibraryFixture(t);
    const padding = (length: number) =>
      `{"schemaVersion":1,"id":"brief-example","name":"${BRIEF_NAME}","description":"${"A".repeat(length)}"}`;
    const emptyLength = Buffer.byteLength(padding(0));
    const exact = padding(8192 - emptyLength);
    assert.equal(Buffer.byteLength(exact), 8192);
    await writeProfile(root, "brief-example", { ...briefFiles("brief-example"), manifest: exact });

    const accepted = await loadProfileCatalog(root);
    assert.equal(accepted.status, "loaded");
    if (accepted.status !== "loaded") assert.fail("expected a loaded catalog");
    assert.equal(accepted.profiles[0]?.description, "A".repeat(8192 - emptyLength));

    await fs.writeFile(
      join(root, "brief-example", "profile.json"),
      padding(8192 - emptyLength + 1),
    );
    const rejected = await loadProfileCatalog(root);
    assert.deepEqual(rejected, {
      status: "loaded",
      profiles: [],
      diagnostics: [{ category: "size", code: "too-large", profileId: null, candidateOrdinal: 1 }],
    });
  });
});

describe("loadProfileCatalog: text bodies", () => {
  it("keeps body text literal: BOM excluded, CRLF kept, Markdown and interpolation untouched", async (t) => {
    const { root } = await createLibraryFixture(t);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is literal body data
    const user = "Run `npm test`.\r\n[docs](https://example.invalid/guide)\r\n${HOME} {{name}}";
    const assistant = "# Title\n\n```\nexample\n```\n";
    await writeProfile(root, "brief-example", {
      manifest: briefManifest("brief-example"),
      user: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(user)]),
      assistant,
    });

    const catalog = await loadProfileCatalog(root);

    assert.deepEqual(catalog, {
      status: "loaded",
      profiles: [{ ...VALID_BRIEF_PROFILE, userText: user, assistantText: assistant }],
      diagnostics: [],
    });
  });

  it("keeps terminal escape sequences in a body as plain data", async (t) => {
    const { root } = await createLibraryFixture(t);
    const assistant = "\u001b]8;;https://example.invalid\u0007link\u001b]8;;\u0007";
    await writeProfile(root, "brief-example", { ...briefFiles("brief-example"), assistant });

    const catalog = await loadProfileCatalog(root);

    assert.deepEqual(catalog, {
      status: "loaded",
      profiles: [{ ...VALID_BRIEF_PROFILE, assistantText: assistant }],
      diagnostics: [],
    });
  });

  it("rejects empty and whitespace-only bodies", async (t) => {
    const { root } = await createLibraryFixture(t);
    await writeProfile(root, "brief-example", {
      manifest: briefManifest("brief-example"),
      user: " \t\n\u00a0\u2028",
      assistant: BRIEF_ASSISTANT_TEXT,
    });

    const catalog = await loadProfileCatalog(root);

    assert.deepEqual(catalog, {
      status: "loaded",
      profiles: [],
      diagnostics: [
        {
          category: "text",
          code: "empty-body",
          profileId: "brief-example",
          candidateOrdinal: null,
        },
      ],
    });
  });

  it("rejects malformed UTF-8 in the user text", async (t) => {
    const { root } = await createLibraryFixture(t);
    await writeProfile(root, "brief-example", {
      ...briefFiles("brief-example"),
      user: Buffer.from([0x41, 0xff]),
    });

    assert.deepEqual(await loadProfileCatalog(root), {
      status: "loaded",
      profiles: [],
      diagnostics: [
        {
          category: "text",
          code: "invalid-utf8",
          profileId: "brief-example",
          candidateOrdinal: null,
        },
      ],
    });
  });

  it("rejects malformed UTF-8 in the assistant text", async (t) => {
    const { root } = await createLibraryFixture(t);
    await writeProfile(root, "brief-example", {
      ...briefFiles("brief-example"),
      assistant: Buffer.from([0x41, 0xc3, 0x28]),
    });

    assert.deepEqual(await loadProfileCatalog(root), {
      status: "loaded",
      profiles: [],
      diagnostics: [
        {
          category: "text",
          code: "invalid-utf8",
          profileId: "brief-example",
          candidateOrdinal: null,
        },
      ],
    });
  });

  it("accepts a user text of exactly 65536 bytes including its BOM and rejects 65537", async (t) => {
    const { root } = await createLibraryFixture(t);
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const exact = Buffer.concat([bom, Buffer.from("a".repeat(65536 - 3))]);
    await writeProfile(root, "brief-example", { ...briefFiles("brief-example"), user: exact });

    const accepted = await loadProfileCatalog(root);
    assert.equal(accepted.status, "loaded");
    if (accepted.status !== "loaded") assert.fail("expected a loaded catalog");
    assert.equal(accepted.profiles[0]?.userText.length, 65533);

    await fs.writeFile(
      join(root, "brief-example", "user.md"),
      Buffer.concat([bom, Buffer.from("a".repeat(65536 - 2))]),
    );
    assert.deepEqual(await loadProfileCatalog(root), {
      status: "loaded",
      profiles: [],
      diagnostics: [
        { category: "size", code: "too-large", profileId: "brief-example", candidateOrdinal: null },
      ],
    });
  });

  it("rejects a body that only contains a byte order mark", async (t) => {
    const { root } = await createLibraryFixture(t);
    await writeProfile(root, "brief-example", {
      manifest: briefManifest("brief-example"),
      user: BRIEF_USER_TEXT,
      assistant: Buffer.from([0xef, 0xbb, 0xbf]),
    });

    const catalog = await loadProfileCatalog(root);

    assert.deepEqual(catalog, {
      status: "loaded",
      profiles: [],
      diagnostics: [
        {
          category: "text",
          code: "empty-body",
          profileId: "brief-example",
          candidateOrdinal: null,
        },
      ],
    });
  });

  it("accepts a body of exactly 65536 bytes including its BOM and rejects 65537", async (t) => {
    const { root } = await createLibraryFixture(t);
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const exact = Buffer.concat([bom, Buffer.from("a".repeat(65536 - 3))]);
    await writeProfile(root, "brief-example", { ...briefFiles("brief-example"), assistant: exact });

    const accepted = await loadProfileCatalog(root);
    assert.equal(accepted.status, "loaded");
    if (accepted.status !== "loaded") assert.fail("expected a loaded catalog");
    assert.equal(accepted.profiles[0]?.assistantText.length, 65533);

    await fs.writeFile(
      join(root, "brief-example", "assistant.md"),
      Buffer.concat([bom, Buffer.from("a".repeat(65536 - 2))]),
    );
    const rejected = await loadProfileCatalog(root);
    assert.deepEqual(rejected, {
      status: "loaded",
      profiles: [],
      diagnostics: [
        { category: "size", code: "too-large", profileId: "brief-example", candidateOrdinal: null },
      ],
    });
  });
});

describe("profile manifest schema", () => {
  it("lists the four manifest fields and forbids any other property", async () => {
    const schema = JSON.parse(
      await fs.readFile(new URL("../schema/profile.schema.json", import.meta.url), "utf8"),
    );

    assert.deepEqual(schema.required, ["schemaVersion", "id", "name", "description"]);
    assert.deepEqual(Object.keys(schema.properties), [
      "schemaVersion",
      "id",
      "name",
      "description",
    ]);
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.schemaVersion.const, 1);
    assert.equal(schema.properties.id.maxLength, 64);
  });
});

describe("loadProfileCatalog: side effects", () => {
  it("loads without network, process or write activity and leaves bytes unchanged", async (t) => {
    const { root } = await createLibraryFixture(t);
    await writeProfile(root, "brief-example", {
      manifest: briefManifest("brief-example"),
      user: "Open [a link](https://example.invalid) and run `rm -rf /`.",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is literal body data
      assistant: "Interpolation stays literal: ${process.env.HOME} {% include x %}",
    });
    const before = await snapshotTree(root);
    const external = externalCallRecorder(t);

    const catalog = await loadProfileCatalog(root);

    assert.deepEqual(external, []);
    assert.deepEqual(catalog, {
      status: "loaded",
      profiles: [
        {
          ...VALID_BRIEF_PROFILE,
          userText: "Open [a link](https://example.invalid) and run `rm -rf /`.",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is literal body data
          assistantText: "Interpolation stays literal: ${process.env.HOME} {% include x %}",
        },
      ],
      diagnostics: [],
    });
    assert.deepEqual(await snapshotTree(root), before);
  });
});
