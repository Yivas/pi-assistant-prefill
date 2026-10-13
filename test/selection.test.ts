import assert from "node:assert/strict";
import fs, { type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { readSelection, SELECTION_FILE_NAME, saveSelection } from "../src/selection.ts";
import { createLibraryFixture, linkFile } from "./library-fixture.ts";

const PROFILE_STATE =
  '{\n  "schemaVersion": 1,\n  "profileId": "brief-example",\n  "disabled": false\n}\n';
const OFF_STATE = '{\n  "schemaVersion": 1,\n  "profileId": null,\n  "disabled": true\n}\n';

// The state lives in <agent>/pi-assistant-prefill, so the fixture base plays the agent directory.
async function stateFixture(t: TestContext): Promise<{ base: string; stateDirectory: string }> {
  const { base } = await createLibraryFixture(t);
  return { base, stateDirectory: join(base, "pi-assistant-prefill") };
}

async function writeState(stateDirectory: string, text: string): Promise<string> {
  await fs.mkdir(stateDirectory, { recursive: true });
  const filePath = join(stateDirectory, SELECTION_FILE_NAME);
  await fs.writeFile(filePath, text);
  return filePath;
}

function stateFailure(code: string, category = "selection") {
  return {
    status: "failed",
    diagnostic: { category, code, profileId: null, candidateOrdinal: null },
  };
}

describe("readSelection", () => {
  it("reads an absent state as no choice", async (t) => {
    const { stateDirectory } = await stateFixture(t);

    assert.deepEqual(await readSelection(stateDirectory), {
      status: "loaded",
      choice: { kind: "unset" },
    });
  });

  it("reads back a profile recorded by saveSelection", async (t) => {
    const { stateDirectory } = await stateFixture(t);
    await saveSelection(stateDirectory, { kind: "profile", profileId: "brief-example" });

    assert.deepEqual(await readSelection(stateDirectory), {
      status: "loaded",
      choice: { kind: "profile", profileId: "brief-example" },
    });
  });

  it("reads a state without a profile and without disabling as no choice", async (t) => {
    const { stateDirectory } = await stateFixture(t);
    await writeState(stateDirectory, '{"schemaVersion":1,"profileId":null,"disabled":false}');

    assert.deepEqual(await readSelection(stateDirectory), {
      status: "loaded",
      choice: { kind: "unset" },
    });
  });

  it("rejects a state that both names a profile and disables", async (t) => {
    const { stateDirectory } = await stateFixture(t);
    await writeState(
      stateDirectory,
      '{"schemaVersion":1,"profileId":"brief-example","disabled":true}',
    );

    assert.deepEqual(await readSelection(stateDirectory), stateFailure("conflicting-selection"));
  });

  it("rejects an invalid or reserved profile identifier in the state", async (t) => {
    const { stateDirectory } = await stateFixture(t);
    await writeState(stateDirectory, '{"schemaVersion":1,"profileId":"Brief","disabled":false}');
    assert.deepEqual(await readSelection(stateDirectory), stateFailure("invalid-id"));

    await writeState(stateDirectory, '{"schemaVersion":1,"profileId":"con","disabled":false}');
    assert.deepEqual(await readSelection(stateDirectory), stateFailure("reserved-id"));
  });

  it("rejects malformed JSON, unknown fields and duplicate keys", async (t) => {
    const { stateDirectory } = await stateFixture(t);

    await writeState(stateDirectory, "{ not json");
    assert.deepEqual(await readSelection(stateDirectory), stateFailure("invalid-json"));

    await writeState(stateDirectory, '{"schemaVersion":1,"profileId":null,"disabled":false,"x":1}');
    assert.deepEqual(await readSelection(stateDirectory), stateFailure("unknown-field"));

    await writeState(
      stateDirectory,
      '{"schemaVersion":1,"profileId":null,"profileId":null,"disabled":false}',
    );
    assert.deepEqual(await readSelection(stateDirectory), stateFailure("duplicate-key"));
  });

  it("rejects a missing field and a non-boolean disabled flag", async (t) => {
    const { stateDirectory } = await stateFixture(t);

    await writeState(stateDirectory, '{"schemaVersion":1,"profileId":null}');
    assert.deepEqual(await readSelection(stateDirectory), stateFailure("missing-field"));

    await writeState(stateDirectory, '{"schemaVersion":1,"profileId":null,"disabled":"no"}');
    assert.deepEqual(await readSelection(stateDirectory), stateFailure("invalid-field"));
  });

  it("rejects a future schema version instead of reading it as the current one", async (t) => {
    const { stateDirectory } = await stateFixture(t);
    await writeState(stateDirectory, '{"schemaVersion":2,"profileId":null,"disabled":false}');

    assert.deepEqual(
      await readSelection(stateDirectory),
      stateFailure("unsupported-schema-version"),
    );
  });

  it("rejects a state path that is not a regular file", async (t) => {
    const { stateDirectory } = await stateFixture(t);
    await fs.mkdir(join(stateDirectory, SELECTION_FILE_NAME), { recursive: true });

    assert.deepEqual(await readSelection(stateDirectory), stateFailure("not-regular-file", "file"));
  });

  it("rejects a state link that points outside the state directory", async (t) => {
    const { base, stateDirectory } = await stateFixture(t);
    const outside = join(base, "outside.json");
    await fs.writeFile(outside, OFF_STATE);
    await fs.mkdir(stateDirectory, { recursive: true });
    await linkFile(outside, join(stateDirectory, SELECTION_FILE_NAME));

    assert.deepEqual(await readSelection(stateDirectory), stateFailure("outside-root", "identity"));
  });
});

describe("saveSelection", () => {
  it("creates the state directory and writes the documented format", async (t) => {
    const { stateDirectory } = await stateFixture(t);

    assert.deepEqual(
      await saveSelection(stateDirectory, { kind: "profile", profileId: "brief-example" }),
      { status: "saved" },
    );
    assert.deepEqual(await fs.readdir(stateDirectory), [SELECTION_FILE_NAME]);
    assert.equal(
      await fs.readFile(join(stateDirectory, SELECTION_FILE_NAME), "utf8"),
      PROFILE_STATE,
    );
  });

  it("writes an explicit off with no profile", async (t) => {
    const { stateDirectory } = await stateFixture(t);

    await saveSelection(stateDirectory, { kind: "off" });

    assert.equal(await fs.readFile(join(stateDirectory, SELECTION_FILE_NAME), "utf8"), OFF_STATE);
  });

  it("replaces the previous state and leaves no temporary file behind", async (t) => {
    const { stateDirectory } = await stateFixture(t);
    await saveSelection(stateDirectory, { kind: "profile", profileId: "brief-example" });

    await saveSelection(stateDirectory, { kind: "off" });

    assert.deepEqual(await fs.readdir(stateDirectory), [SELECTION_FILE_NAME]);
    assert.deepEqual(await readSelection(stateDirectory), {
      status: "loaded",
      choice: { kind: "off" },
    });
  });

  it("refuses to overwrite a state that is not valid JSON", async (t) => {
    const { stateDirectory } = await stateFixture(t);
    const filePath = await writeState(stateDirectory, "{ not json");

    assert.deepEqual(
      await saveSelection(stateDirectory, { kind: "off" }),
      stateFailure("invalid-json"),
    );
    assert.equal(await fs.readFile(filePath, "utf8"), "{ not json");
  });

  it("refuses to overwrite a state from a future version", async (t) => {
    const { stateDirectory } = await stateFixture(t);
    const future = '{"schemaVersion":2,"profileId":null,"disabled":false}';
    const filePath = await writeState(stateDirectory, future);

    assert.deepEqual(
      await saveSelection(stateDirectory, { kind: "off" }),
      stateFailure("unsupported-schema-version"),
    );
    assert.equal(await fs.readFile(filePath, "utf8"), future);
  });

  it("keeps the previous state and removes the temporary file when replacement fails", async (t) => {
    const { stateDirectory } = await stateFixture(t);
    await saveSelection(stateDirectory, { kind: "off" });
    t.mock.method(fs, "rename", () =>
      Promise.reject(Object.assign(new Error("denied"), { code: "EPERM" })),
    );

    assert.deepEqual(
      await saveSelection(stateDirectory, { kind: "profile", profileId: "brief-example" }),
      stateFailure("permission-denied", "file"),
    );
    assert.deepEqual(await fs.readdir(stateDirectory), [SELECTION_FILE_NAME]);
    assert.equal(await fs.readFile(join(stateDirectory, SELECTION_FILE_NAME), "utf8"), OFF_STATE);
  });
});

describe("saveSelection: write failure before the rename", () => {
  it("keeps the previous state and leaves no temporary file when the write fails", async (t) => {
    const { stateDirectory } = await stateFixture(t);
    await saveSelection(stateDirectory, { kind: "off" });
    const realOpen = fs.open.bind(fs);
    // Only the exclusive write is affected. The read of the previous state uses the real handle.
    t.mock.method(fs, "open", async (filePath: string, flags: string) => {
      const handle = await realOpen(filePath, flags);
      if (flags !== "wx") return handle;
      return {
        writeFile: async () => {
          throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
        },
        sync: async () => undefined,
        close: () => handle.close(),
      } as unknown as FileHandle;
    });

    assert.deepEqual(
      await saveSelection(stateDirectory, { kind: "profile", profileId: "brief-example" }),
      stateFailure("io-error", "file"),
    );
    assert.deepEqual(await fs.readdir(stateDirectory), [SELECTION_FILE_NAME]);
    assert.equal(await fs.readFile(join(stateDirectory, SELECTION_FILE_NAME), "utf8"), OFF_STATE);
  });
});
