import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { loadProfileConfig, type ResolveProfileOptions, resolveProfile } from "../src/config.ts";
import {
  BRIEF_ASSISTANT_TEXT,
  BRIEF_DESCRIPTION,
  BRIEF_NAME,
  BRIEF_USER_TEXT,
  briefFiles,
  createLibraryFixture,
  externalCallRecorder,
  fileSystemCallRecorder,
  linkDirectory,
  linkFile,
  snapshotTree,
  writeProfile,
  writeRootFile,
} from "./library-fixture.ts";

const BRIEF_PROFILE = {
  id: "brief-example",
  name: BRIEF_NAME,
  description: BRIEF_DESCRIPTION,
  userText: BRIEF_USER_TEXT,
  assistantText: BRIEF_ASSISTANT_TEXT,
};

function configurationFailure(code: string) {
  return {
    status: "failed",
    diagnostic: { category: "configuration", code, profileId: null, candidateOrdinal: null },
  };
}

// The version 1 shape: a configuration with a default and no bindings.
function loadedConfiguration(defaultProfileId: string | null) {
  return { status: "loaded", defaultProfileId, bindings: [] };
}

// These cases start from a recorded or configured decision and no selected model; the binding table
// below passes a model explicitly.
function resolveWithoutModel(options: Omit<ResolveProfileOptions, "model">) {
  return resolveProfile({ ...options, model: null });
}

describe("loadProfileConfig", () => {
  it("uses the canonical root to locate configuration in a linked library", async (t) => {
    const { base, root } = await createLibraryFixture(t);
    await writeRootFile(
      root,
      "config.json",
      '{"schemaVersion":1,"defaultProfileId":"brief-example"}',
    );
    const linkedRoot = join(base, "linked-root");
    await linkDirectory(root, linkedRoot);
    const canonicalRoot = await fs.realpath(root);
    const configurationPaths: string[] = [];
    const realLstat = fs.lstat.bind(fs);
    t.mock.method(fs, "lstat", (filePath: string) => {
      if (basename(filePath) === "config.json") configurationPaths.push(filePath);
      return realLstat(filePath);
    });

    const configuration = await loadProfileConfig(linkedRoot);

    assert.deepEqual(configuration, loadedConfiguration("brief-example"));
    assert.deepEqual(configurationPaths, [join(canonicalRoot, "config.json")]);
  });

  it("treats an absent configuration as having no default profile", async (t) => {
    const { root } = await createLibraryFixture(t);

    assert.deepEqual(await loadProfileConfig(root), loadedConfiguration(null));
  });

  it("reads a null default as no default profile", async (t) => {
    const { root } = await createLibraryFixture(t);
    await writeRootFile(root, "config.json", '{ "schemaVersion": 1, "defaultProfileId": null }');

    assert.deepEqual(await loadProfileConfig(root), loadedConfiguration(null));
  });

  it("reads a configuration without the optional default field as no default", async (t) => {
    const { root } = await createLibraryFixture(t);
    await writeRootFile(root, "config.json", '{"schemaVersion":1}');

    assert.deepEqual(await loadProfileConfig(root), loadedConfiguration(null));
  });

  it("reads a valid default identifier without validating its profile", async (t) => {
    const { root } = await createLibraryFixture(t);
    await writeRootFile(
      root,
      "config.json",
      '{"schemaVersion":1,"defaultProfileId":"brief-example"}',
    );

    assert.deepEqual(await loadProfileConfig(root), loadedConfiguration("brief-example"));
  });

  it("accepts a UTF-8 byte order mark in the configuration", async (t) => {
    const { root } = await createLibraryFixture(t);
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    await writeRootFile(
      root,
      "config.json",
      Buffer.concat([bom, Buffer.from('{"schemaVersion":1,"defaultProfileId":"brief-example"}')]),
    );

    assert.deepEqual(await loadProfileConfig(root), loadedConfiguration("brief-example"));
  });

  const invalidConfigurations: ReadonlyArray<readonly [string, string, string]> = [
    ["malformed JSON", '{"schemaVersion":1,', "invalid-json"],
    [
      "duplicate key",
      '{"schemaVersion":1,"defaultProfileId":null,"defaultProfileId":"brief-example"}',
      "duplicate-key",
    ],
    ["unknown field", '{"schemaVersion":1,"theme":"dark"}', "unknown-field"],
    ["future schema version", '{"schemaVersion":3}', "unsupported-schema-version"],
    ["missing schema version", '{"defaultProfileId":null}', "missing-field"],
    [
      "default with path syntax",
      '{"schemaVersion":1,"defaultProfileId":"../outside"}',
      "invalid-id",
    ],
    ["reserved default identifier", '{"schemaVersion":1,"defaultProfileId":"con"}', "reserved-id"],
    ["default that is not a string", '{"schemaVersion":1,"defaultProfileId":7}', "invalid-field"],
    ["configuration that is an array", "[]", "not-object"],
  ];

  for (const [label, content, code] of invalidConfigurations) {
    it(`blocks with a configuration diagnostic for ${label}`, async (t) => {
      const { root } = await createLibraryFixture(t);
      await writeRootFile(root, "config.json", content);

      assert.deepEqual(await loadProfileConfig(root), configurationFailure(code));
    });
  }

  it("accepts a configuration of exactly 8192 bytes and rejects 8193", async (t) => {
    const { root } = await createLibraryFixture(t);
    const base = '{"schemaVersion":1,"defaultProfileId":null}';
    await writeRootFile(root, "config.json", base + " ".repeat(8192 - base.length));

    assert.deepEqual(await loadProfileConfig(root), loadedConfiguration(null));

    await writeRootFile(root, "config.json", base + " ".repeat(8192 - base.length + 1));
    assert.deepEqual(await loadProfileConfig(root), {
      status: "failed",
      diagnostic: { category: "size", code: "too-large", profileId: null, candidateOrdinal: null },
    });
  });

  it("reads a configuration linked to a regular file inside the library root", async (t) => {
    const { root } = await createLibraryFixture(t);
    const target = await writeRootFile(
      root,
      "settings.json",
      '{"schemaVersion":1,"defaultProfileId":"brief-example"}',
    );
    await linkFile(target, join(root, "config.json"));

    assert.deepEqual(await loadProfileConfig(root), loadedConfiguration("brief-example"));
  });

  it("rejects a configuration link that escapes the library root", async (t) => {
    const { base, root } = await createLibraryFixture(t);
    const outside = await writeRootFile(base, "outside.json", '{"schemaVersion":1}');
    await linkFile(outside, join(root, "config.json"));

    assert.deepEqual(await loadProfileConfig(root), {
      status: "failed",
      diagnostic: {
        category: "identity",
        code: "outside-root",
        profileId: null,
        candidateOrdinal: null,
      },
    });
  });

  it("rejects a broken configuration link", async (t) => {
    const { base, root } = await createLibraryFixture(t);
    await linkFile(join(base, "missing.json"), join(root, "config.json"));

    assert.deepEqual(await loadProfileConfig(root), {
      status: "failed",
      diagnostic: {
        category: "identity",
        code: "broken-link",
        profileId: null,
        candidateOrdinal: null,
      },
    });
  });

  it("rejects a configuration that is a directory", async (t) => {
    const { root } = await createLibraryFixture(t);
    await fs.mkdir(join(root, "config.json"));

    assert.deepEqual(await loadProfileConfig(root), {
      status: "failed",
      diagnostic: {
        category: "file",
        code: "not-regular-file",
        profileId: null,
        candidateOrdinal: null,
      },
    });
  });

  it("treats a missing library root as an absent configuration", async (t) => {
    const { base } = await createLibraryFixture(t);

    assert.deepEqual(await loadProfileConfig(join(base, "absent-root")), loadedConfiguration(null));
  });
});

describe("resolveProfile: explicit decisions and default", () => {
  it("selects the explicit profile even when the configured default is missing", async (t) => {
    const { root } = await createLibraryFixture(t);
    await writeProfile(root, "brief-example");
    await writeRootFile(
      root,
      "config.json",
      '{"schemaVersion":1,"defaultProfileId":"absent-profile"}',
    );

    const resolution = await resolveWithoutModel({
      libraryRoot: root,
      environment: {},
      choice: { kind: "profile", profileId: "brief-example" },
    });

    assert.deepEqual(resolution, { status: "selected", source: "choice", profile: BRIEF_PROFILE });
  });

  it("uses a valid configured default when there is no explicit decision", async (t) => {
    const { root } = await createLibraryFixture(t);
    await writeProfile(root, "brief-example");
    await writeRootFile(
      root,
      "config.json",
      '{"schemaVersion":1,"defaultProfileId":"brief-example"}',
    );

    const resolution = await resolveWithoutModel({
      libraryRoot: root,
      environment: {},
      choice: { kind: "unset" },
    });

    assert.deepEqual(resolution, { status: "selected", source: "default", profile: BRIEF_PROFILE });
  });

  it("reports a missing configured default without choosing another profile", async (t) => {
    const { root } = await createLibraryFixture(t);
    await writeProfile(root, "brief-example");
    await writeRootFile(
      root,
      "config.json",
      '{"schemaVersion":1,"defaultProfileId":"absent-profile"}',
    );

    const resolution = await resolveWithoutModel({
      libraryRoot: root,
      environment: {},
      choice: { kind: "unset" },
    });

    assert.deepEqual(resolution, {
      status: "failed",
      diagnostic: {
        category: "configuration",
        code: "default-profile-unavailable",
        profileId: "absent-profile",
        candidateOrdinal: null,
      },
    });
  });

  it("reports an invalid explicit identifier without falling back to the default", async (t) => {
    const { root } = await createLibraryFixture(t);
    await writeProfile(root, "brief-example");
    await writeRootFile(
      root,
      "config.json",
      '{"schemaVersion":1,"defaultProfileId":"brief-example"}',
    );

    const resolution = await resolveWithoutModel({
      libraryRoot: root,
      environment: {},
      choice: { kind: "profile", profileId: "../outside" },
    });

    assert.deepEqual(resolution, {
      status: "failed",
      diagnostic: {
        category: "identity",
        code: "invalid-id",
        profileId: null,
        candidateOrdinal: null,
      },
    });
  });

  it("reports a missing explicit profile instead of using the default", async (t) => {
    const { root } = await createLibraryFixture(t);
    await writeProfile(root, "brief-example");
    await writeRootFile(
      root,
      "config.json",
      '{"schemaVersion":1,"defaultProfileId":"brief-example"}',
    );

    const resolution = await resolveWithoutModel({
      libraryRoot: root,
      environment: {},
      choice: { kind: "profile", profileId: "absent-profile" },
    });

    assert.deepEqual(resolution, {
      status: "failed",
      diagnostic: {
        category: "catalog",
        code: "profile-unavailable",
        profileId: "absent-profile",
        candidateOrdinal: null,
      },
    });
  });

  it("returns none, not off, when there is no decision and no default", async (t) => {
    const { root } = await createLibraryFixture(t);
    await writeProfile(root, "brief-example");

    const resolution = await resolveWithoutModel({
      libraryRoot: root,
      environment: {},
      choice: { kind: "unset" },
    });

    assert.deepEqual(resolution, { status: "none" });
  });

  it("blocks a default selection when the malformed configuration is present", async (t) => {
    const { root } = await createLibraryFixture(t);
    await writeProfile(root, "brief-example");
    await writeRootFile(root, "config.json", '{"schemaVersion":1,');

    const resolution = await resolveWithoutModel({
      libraryRoot: root,
      environment: {},
      choice: { kind: "unset" },
    });

    assert.deepEqual(resolution, {
      status: "failed",
      diagnostic: {
        category: "configuration",
        code: "invalid-json",
        profileId: null,
        candidateOrdinal: null,
      },
    });
  });

  it("blocks an explicit selection when the malformed configuration is present", async (t) => {
    const { root } = await createLibraryFixture(t);
    await writeProfile(root, "brief-example");
    await writeRootFile(root, "config.json", '{"schemaVersion":1,');

    const resolution = await resolveWithoutModel({
      libraryRoot: root,
      environment: {},
      choice: { kind: "profile", profileId: "brief-example" },
    });

    assert.deepEqual(resolution, {
      status: "failed",
      diagnostic: {
        category: "configuration",
        code: "invalid-json",
        profileId: null,
        candidateOrdinal: null,
      },
    });
  });

  it("blocks resolution when the library has more than 100 candidates", async (t) => {
    const { root } = await createLibraryFixture(t);
    for (let index = 0; index < 101; index += 1) {
      await fs.mkdir(join(root, `Bad-${String(index).padStart(3, "0")}`));
    }
    await writeRootFile(root, "config.json", '{"schemaVersion":1,"defaultProfileId":null}');

    const resolution = await resolveWithoutModel({
      libraryRoot: root,
      environment: {},
      choice: { kind: "unset" },
    });

    assert.deepEqual(resolution, {
      status: "failed",
      diagnostic: {
        category: "catalog",
        code: "candidate-limit-exceeded",
        profileId: null,
        candidateOrdinal: null,
      },
    });
  });
});

describe("resolveProfile: off", () => {
  it("turns an explicit off decision into off without reading the library", async (t) => {
    const { base } = await createLibraryFixture(t);
    const brokenRoot = await writeRootFile(base, "not-a-directory", "file");

    const resolution = await resolveWithoutModel({
      libraryRoot: brokenRoot,
      environment: {},
      choice: { kind: "off" },
    });

    assert.deepEqual(resolution, { status: "off", source: "choice", retainedProfileId: null });
  });

  it("forces off with PI_PREFILL_OFF=1 without reading a broken library and keeps the selected identifier", async (t) => {
    const { base } = await createLibraryFixture(t);
    const brokenRoot = await writeRootFile(base, "not-a-directory", "file");

    const resolution = await resolveWithoutModel({
      libraryRoot: brokenRoot,
      environment: { PI_PREFILL_OFF: "1" },
      choice: { kind: "profile", profileId: "brief-example" },
    });

    assert.deepEqual(resolution, {
      status: "off",
      source: "environment",
      retainedProfileId: "brief-example",
    });
  });

  it("forces off with PI_PREFILL_OFF=1 even when the configuration is malformed", async (t) => {
    const { root } = await createLibraryFixture(t);
    await writeRootFile(root, "config.json", '{"schemaVersion":1,');

    const resolution = await resolveWithoutModel({
      libraryRoot: root,
      environment: { PI_PREFILL_OFF: "1" },
      choice: { kind: "unset" },
    });

    assert.deepEqual(resolution, { status: "off", source: "environment", retainedProfileId: null });
  });

  it("keeps the identifier out of an environment off when the explicit identifier is invalid", async (t) => {
    const { root } = await createLibraryFixture(t);

    const resolution = await resolveWithoutModel({
      libraryRoot: root,
      environment: { PI_PREFILL_OFF: "1" },
      choice: { kind: "profile", profileId: "../outside" },
    });

    assert.deepEqual(resolution, { status: "off", source: "environment", retainedProfileId: null });
  });

  for (const value of ["", "0", undefined]) {
    it(`does not force off when PI_PREFILL_OFF is ${JSON.stringify(value)}`, async (t) => {
      const { root } = await createLibraryFixture(t);
      await writeProfile(root, "brief-example");
      await writeRootFile(
        root,
        "config.json",
        '{"schemaVersion":1,"defaultProfileId":"brief-example"}',
      );

      const resolution = await resolveWithoutModel({
        libraryRoot: root,
        environment: { PI_PREFILL_OFF: value },
        choice: { kind: "unset" },
      });

      assert.deepEqual(resolution, {
        status: "selected",
        source: "default",
        profile: BRIEF_PROFILE,
      });
    });
  }

  it("fails on other PI_PREFILL_OFF values but keeps explicit off available", async (t) => {
    const { root } = await createLibraryFixture(t);
    await writeProfile(root, "brief-example");

    const invalidEnvironment = await resolveWithoutModel({
      libraryRoot: root,
      environment: { PI_PREFILL_OFF: "true" },
      choice: { kind: "profile", profileId: "brief-example" },
    });
    assert.deepEqual(invalidEnvironment, {
      status: "failed",
      diagnostic: {
        category: "configuration",
        code: "environment-invalid",
        profileId: null,
        candidateOrdinal: null,
      },
    });

    const explicitOff = await resolveWithoutModel({
      libraryRoot: root,
      environment: { PI_PREFILL_OFF: " 1" },
      choice: { kind: "off" },
    });
    assert.deepEqual(explicitOff, { status: "off", source: "choice", retainedProfileId: null });
  });

  it("does not select the default when an explicit off overrides it", async (t) => {
    const { root } = await createLibraryFixture(t);
    await writeProfile(root, "brief-example");
    await writeRootFile(
      root,
      "config.json",
      '{"schemaVersion":1,"defaultProfileId":"brief-example"}',
    );

    const resolution = await resolveWithoutModel({
      libraryRoot: root,
      environment: {},
      choice: { kind: "off" },
    });

    assert.deepEqual(resolution, { status: "off", source: "choice", retainedProfileId: null });
  });
});

describe("loadProfileConfig: library root and read failures", () => {
  it("reports a library root below a regular file as a catalog failure", async (t) => {
    const { base } = await createLibraryFixture(t);
    const filePath = await writeRootFile(base, "prefills-file", "not a directory");
    const root = join(filePath, "prefills");

    assert.deepEqual(await loadProfileConfig(root), {
      status: "failed",
      diagnostic: {
        category: "catalog",
        code: "root-not-directory",
        profileId: null,
        candidateOrdinal: null,
      },
    });
    assert.deepEqual(
      await resolveWithoutModel({ libraryRoot: root, environment: {}, choice: { kind: "unset" } }),
      {
        status: "failed",
        diagnostic: {
          category: "catalog",
          code: "root-not-directory",
          profileId: null,
          candidateOrdinal: null,
        },
      },
    );
  });

  it("treats a missing library root below an existing directory as having no configuration", async (t) => {
    const { base } = await createLibraryFixture(t);

    assert.deepEqual(
      await loadProfileConfig(join(base, "absent", "prefills")),
      loadedConfiguration(null),
    );
  });

  it("reports a library root that is a regular file as a catalog failure", async (t) => {
    const { base } = await createLibraryFixture(t);
    const filePath = await writeRootFile(base, "prefills-file", "not a directory");

    assert.deepEqual(await loadProfileConfig(filePath), {
      status: "failed",
      diagnostic: {
        category: "catalog",
        code: "root-not-directory",
        profileId: null,
        candidateOrdinal: null,
      },
    });
  });

  it("maps a denied configuration read to a file diagnostic", async (t) => {
    const { root } = await createLibraryFixture(t);
    await writeRootFile(root, "config.json", '{"schemaVersion":1,"defaultProfileId":null}');
    t.mock.method(fs, "open", async () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });

    assert.deepEqual(await loadProfileConfig(root), {
      status: "failed",
      diagnostic: {
        category: "file",
        code: "permission-denied",
        profileId: null,
        candidateOrdinal: null,
      },
    });
  });
});

describe("resolveProfile: no reads once off is decided", () => {
  it("returns off from PI_PREFILL_OFF=1 or an explicit off without filesystem or external calls", async (t) => {
    const { base } = await createLibraryFixture(t);
    const brokenRoot = await writeRootFile(base, "prefills-file", "not a directory");
    const before = await snapshotTree(base);
    const fileSystemCalls = fileSystemCallRecorder(t);
    const externalCalls = externalCallRecorder(t);

    const forced = await resolveWithoutModel({
      libraryRoot: brokenRoot,
      environment: { PI_PREFILL_OFF: "1" },
      choice: { kind: "profile", profileId: "brief-example" },
    });
    const explicit = await resolveWithoutModel({
      libraryRoot: brokenRoot,
      environment: { PI_PREFILL_OFF: "true" },
      choice: { kind: "off" },
    });

    assert.deepEqual(forced, {
      status: "off",
      source: "environment",
      retainedProfileId: "brief-example",
    });
    assert.deepEqual(explicit, { status: "off", source: "choice", retainedProfileId: null });
    assert.deepEqual(fileSystemCalls, []);
    assert.deepEqual(externalCalls, []);
    assert.deepEqual(await snapshotTree(base), before);
  });

  it("keeps library and configuration bytes when a malformed configuration blocks a selection", async (t) => {
    const { root } = await createLibraryFixture(t);
    await writeProfile(root, "brief-example");
    await writeRootFile(root, "config.json", '{"schemaVersion":1,');
    const before = await snapshotTree(root);

    const resolution = await resolveWithoutModel({
      libraryRoot: root,
      environment: {},
      choice: { kind: "profile", profileId: "brief-example" },
    });

    assert.deepEqual(resolution, {
      status: "failed",
      diagnostic: {
        category: "configuration",
        code: "invalid-json",
        profileId: null,
        candidateOrdinal: null,
      },
    });
    assert.deepEqual(await snapshotTree(root), before);
  });
});

describe("resolveProfile: side effects", () => {
  it("resolves without writing the library or configuration and without network or process use", async (t) => {
    const { root } = await createLibraryFixture(t);
    await writeProfile(root, "brief-example");
    await writeRootFile(
      root,
      "config.json",
      '{"schemaVersion":1,"defaultProfileId":"brief-example"}',
    );
    const before = await snapshotTree(root);
    const external = externalCallRecorder(t);

    const resolution = await resolveWithoutModel({
      libraryRoot: root,
      environment: {},
      choice: { kind: "unset" },
    });

    assert.deepEqual(external, []);
    assert.deepEqual(resolution, { status: "selected", source: "default", profile: BRIEF_PROFILE });
    assert.deepEqual(await snapshotTree(root), before);
  });

  it("keeps the temporary library path out of resolution results", async (t) => {
    const { base, root } = await createLibraryFixture(t);
    await writeRootFile(
      root,
      "config.json",
      '{"schemaVersion":1,"defaultProfileId":"absent-profile"}',
    );

    const resolution = await resolveWithoutModel({
      libraryRoot: root,
      environment: {},
      choice: { kind: "unset" },
    });

    assert.equal(JSON.stringify(resolution).includes(basename(base)), false);
  });

  it("does not write a link target while reading a linked configuration", async (t) => {
    const { root } = await createLibraryFixture(t);
    const target = await writeRootFile(
      root,
      "settings.json",
      '{"schemaVersion":1,"defaultProfileId":null}',
    );
    await linkFile(target, join(root, "config.json"));
    const before = await fs.readFile(target, "utf8");

    await resolveWithoutModel({ libraryRoot: root, environment: {}, choice: { kind: "unset" } });

    assert.equal(await fs.readFile(target, "utf8"), before);
  });
});

describe("resolveProfile: bindings and configuration versions", () => {
  const OTHER_PROFILE = {
    id: "other-example",
    name: BRIEF_NAME,
    description: BRIEF_DESCRIPTION,
    userText: BRIEF_USER_TEXT,
    assistantText: BRIEF_ASSISTANT_TEXT,
  };
  const CLAUDE = { provider: "anthropic", id: "claude-test" };
  const GPT = { provider: "openai", id: "gpt-test" };
  const PROVIDER_RULE =
    '{"id":"b-11111111","profileId":"brief-example","provider":"anthropic","model":null}';
  const MODEL_RULE =
    '{"id":"b-22222222","profileId":"other-example","provider":"anthropic","model":"claude-test"}';

  function configurationOf(...rules: string[]): string {
    return `{"schemaVersion":2,"defaultProfileId":null,"bindings":[${rules.join(",")}]}`;
  }

  function bindingFailure(code: string, profileId: string | null) {
    return {
      status: "failed",
      diagnostic: { category: "configuration", code, profileId, candidateOrdinal: null },
    };
  }

  // Each case states the whole decision it observes: the document, the recorded choice, the selected
  // model and the result. Precedence is read from the table, not from the order of the tests.
  const cases: ReadonlyArray<{
    readonly label: string;
    readonly configuration: string | null;
    readonly choice: ResolveProfileOptions["choice"];
    readonly model: ResolveProfileOptions["model"];
    readonly environment?: Readonly<Record<string, string>>;
    readonly expected: unknown;
  }> = [
    {
      label: "the model rule wins over the provider rule",
      configuration: configurationOf(PROVIDER_RULE, MODEL_RULE),
      choice: { kind: "unset" },
      model: CLAUDE,
      expected: {
        status: "selected",
        source: "binding",
        profile: OTHER_PROFILE,
        bindingId: "b-22222222",
      },
    },
    {
      label: "the provider rule answers for any other model of that provider",
      configuration: configurationOf(PROVIDER_RULE, MODEL_RULE),
      choice: { kind: "unset" },
      model: { provider: "anthropic", id: "claude-other" },
      expected: {
        status: "selected",
        source: "binding",
        profile: BRIEF_PROFILE,
        bindingId: "b-11111111",
      },
    },
    {
      label: "a binding is used before the configured default",
      configuration: `{"schemaVersion":2,"defaultProfileId":"other-example","bindings":[${MODEL_RULE}]}`,
      choice: { kind: "unset" },
      model: CLAUDE,
      expected: {
        status: "selected",
        source: "binding",
        profile: OTHER_PROFILE,
        bindingId: "b-22222222",
      },
    },
    {
      label: "an explicit profile is used before a binding",
      configuration: configurationOf(MODEL_RULE),
      choice: { kind: "profile", profileId: "brief-example" },
      model: CLAUDE,
      expected: { status: "selected", source: "choice", profile: BRIEF_PROFILE },
    },
    {
      label: "no rule matches another provider and there is no default",
      configuration: configurationOf(MODEL_RULE),
      choice: { kind: "unset" },
      model: GPT,
      expected: { status: "none" },
    },
    {
      label: "a session without a selected model matches no binding",
      configuration: `{"schemaVersion":2,"defaultProfileId":"brief-example","bindings":[${PROVIDER_RULE}]}`,
      choice: { kind: "unset" },
      model: null,
      expected: { status: "selected", source: "default", profile: BRIEF_PROFILE },
    },
    {
      label: "a rule that points at no usable profile fails instead of falling back",
      configuration: `{"schemaVersion":2,"defaultProfileId":"brief-example","bindings":[
        {"id":"b-33333333","profileId":"absent-profile","provider":"anthropic","model":null}
      ]}`,
      choice: { kind: "unset" },
      model: CLAUDE,
      expected: bindingFailure("binding-profile-unavailable", "absent-profile"),
    },
    {
      label: "two rules for the same provider and model are rejected",
      configuration: `{"schemaVersion":2,"defaultProfileId":null,"bindings":[${MODEL_RULE},${'{"id":"b-44444444","profileId":"brief-example","provider":"anthropic","model":"claude-test"}'}]}`,
      choice: { kind: "unset" },
      model: CLAUDE,
      expected: bindingFailure("duplicate-binding", null),
    },
    {
      label: "a malformed binding id is rejected",
      configuration: `{"schemaVersion":2,"defaultProfileId":null,"bindings":[
        {"id":"11111111","profileId":"brief-example","provider":"anthropic","model":null}
      ]}`,
      choice: { kind: "unset" },
      model: CLAUDE,
      expected: bindingFailure("invalid-field", null),
    },
    {
      label: "a version 1 document has no bindings and keeps its default",
      configuration: '{"schemaVersion":1,"defaultProfileId":"brief-example"}',
      choice: { kind: "unset" },
      model: CLAUDE,
      expected: { status: "selected", source: "default", profile: BRIEF_PROFILE },
    },
    {
      label: "a version 1 document is read with an empty rule list",
      configuration: '{"schemaVersion":1,"defaultProfileId":null}',
      choice: { kind: "unset" },
      model: CLAUDE,
      expected: { status: "none" },
    },
    {
      label: "the environment off wins over a binding",
      configuration: configurationOf(PROVIDER_RULE),
      choice: { kind: "unset" },
      model: CLAUDE,
      environment: { PI_PREFILL_OFF: "1" },
      expected: { status: "off", source: "environment", retainedProfileId: null },
    },
    {
      label: "an explicit off wins over a binding",
      configuration: configurationOf(PROVIDER_RULE),
      choice: { kind: "off" },
      model: CLAUDE,
      expected: { status: "off", source: "choice", retainedProfileId: null },
    },
  ];

  it("resolves the recorded choice, the bindings and the default in one order", async (t) => {
    const library = await createLibraryFixture(t);
    await writeProfile(library.root, "brief-example");
    await writeProfile(library.root, "other-example", briefFiles("other-example"));

    for (const { label, configuration, choice, model, environment, expected } of cases) {
      const { root } = library;
      await fs.rm(join(root, "config.json"), { force: true });
      if (configuration !== null) await writeRootFile(root, "config.json", configuration);

      const resolution = await resolveProfile({
        libraryRoot: root,
        environment: environment ?? {},
        choice,
        model,
      });

      assert.deepEqual(resolution, expected, label);
    }
  });
});
