import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { loadProfileConfig } from "../src/config.ts";
import { addProfileBinding } from "../src/config-writer.ts";
import { createLibraryFixture, writeProfile, writeRootFile } from "./library-fixture.ts";

async function libraryWithBriefProfile(t: TestContext): Promise<string> {
  const { root } = await createLibraryFixture(t);
  await writeProfile(root, "brief-example");
  return root;
}

async function writeBinding(root: string) {
  return addProfileBinding(root, {
    profileId: "brief-example",
    provider: "openai",
    model: "gpt-test",
  });
}

describe("addProfileBinding", () => {
  it("migrates a version 1 configuration, then refuses to replace a file that changed on disk", async (t) => {
    const root = await libraryWithBriefProfile(t);
    await writeRootFile(
      root,
      "config.json",
      '{"schemaVersion":1,"defaultProfileId":"brief-example"}',
    );

    assert.deepEqual(await writeBinding(root), { status: "saved" });
    const migrated = JSON.parse(await fs.readFile(join(root, "config.json"), "utf8"));
    assert.equal(migrated.schemaVersion, 2);
    assert.equal(migrated.defaultProfileId, "brief-example");
    assert.match(String(migrated.bindings[0].id), /^b-[0-9a-f]{8}$/);
    assert.deepEqual(
      { ...migrated.bindings[0], id: "generated" },
      { id: "generated", profileId: "brief-example", provider: "openai", model: "gpt-test" },
    );
    const configuration = await loadProfileConfig(root);
    assert.equal(configuration.status === "loaded" && configuration.bindings.length, 1);

    // Another writer replaces the file after this write read it. The temporary file is created
    // before the check, so opening it is the moment the test changes the configuration underneath.
    const concurrent = '{"schemaVersion":2,"defaultProfileId":null,"bindings":[]}';
    const realOpen = fs.open.bind(fs);
    t.mock.method(fs, "open", async (filePath: string, flags: string, mode?: number) => {
      if (filePath.endsWith(".tmp")) await writeRootFile(root, "config.json", concurrent);
      return realOpen(filePath, flags, mode);
    });

    assert.deepEqual(
      await addProfileBinding(root, {
        profileId: "brief-example",
        provider: "anthropic",
        model: null,
      }),
      { status: "failed", reason: "config-changed", detail: null },
    );
    assert.equal(await fs.readFile(join(root, "config.json"), "utf8"), concurrent);
    assert.deepEqual(
      (await fs.readdir(root)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  });
});
