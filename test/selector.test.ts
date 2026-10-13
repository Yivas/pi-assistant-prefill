import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { ProfileEnvironment } from "../src/config.ts";
import type {
  PiCommandContext,
  PiExtensionApi,
  PiExtensionMode,
  PiNoticeType,
} from "../src/extension-types.ts";
import prefillExtension, {
  handlePrefillCommand,
  type SelectorOptionsResolution,
  SELECTOR_ENTRY_TYPE,
} from "../src/index.ts";
import {
  completeSubcommands,
  executeSelectorCommand,
  parseSelectorText,
  type SelectorOptions,
} from "../src/selector.ts";
import { readSelection } from "../src/selection.ts";
import {
  BRIEF_DESCRIPTION,
  BRIEF_NAME,
  briefManifest,
  createLibraryFixture,
  type ProfileFiles,
  externalCallRecorder,
  fileSystemCallRecorder,
  snapshotTree,
  writeProfile,
  writeRootFile,
} from "./library-fixture.ts";

// Two-byte bodies keep the expected combined size readable: "Hi" and "Yes" make 5 bytes.
function shortFiles(id: string): ProfileFiles {
  return { manifest: briefManifest(id), user: "Hi", assistant: "Yes" };
}

interface Library {
  readonly base: string;
  readonly options: SelectorOptions;
}

// Each identifier becomes a valid profile whose directory and manifest share that identifier.
async function libraryWith(t: TestContext, ids: readonly string[] = []): Promise<Library> {
  const { base, root } = await createLibraryFixture(t);
  for (const id of ids) await writeProfile(root, id, shortFiles(id));
  return {
    base,
    options: {
      libraryRoot: root,
      stateDirectory: join(base, "pi-assistant-prefill"),
      environment: {},
    },
  };
}

function resolvedOptions(options: SelectorOptions): SelectorOptionsResolution {
  return { kind: "resolved", options };
}

async function runCommand(text: string, options: SelectorOptions) {
  return executeSelectorCommand(parseSelectorText(text), options);
}

describe("parseSelectorText", () => {
  it("treats an empty or blank argument as list", () => {
    assert.deepEqual(parseSelectorText(""), { kind: "parsed", command: "list", argument: "" });
    assert.deepEqual(parseSelectorText(" \t\n "), {
      kind: "parsed",
      command: "list",
      argument: "",
    });
  });

  it("splits the subcommand from the argument after trimming ASCII spaces", () => {
    assert.deepEqual(parseSelectorText("  use   brief-example  "), {
      kind: "parsed",
      command: "use",
      argument: "brief-example",
    });
  });

  it("keeps quotes and escapes in the argument as written", () => {
    assert.deepEqual(parseSelectorText('use "brief-example"'), {
      kind: "parsed",
      command: "use",
      argument: '"brief-example"',
    });
  });

  it("rejects an unknown or differently cased subcommand", () => {
    assert.deepEqual(parseSelectorText("USE brief-example"), {
      kind: "failed",
      diagnostic: {
        category: "command",
        code: "unknown-subcommand",
        profileId: null,
        candidateOrdinal: null,
      },
    });
  });
});

describe("completeSubcommands", () => {
  it("completes the subcommand names by prefix", () => {
    assert.deepEqual(completeSubcommands("pre"), [{ value: "preview", label: "preview" }]);
    assert.equal(completeSubcommands("")?.length, 6);
  });

  it("offers nothing once the subcommand is complete and has an argument", () => {
    assert.equal(completeSubcommands("use "), null);
    assert.equal(completeSubcommands("x"), null);
  });
});

describe("executeSelectorCommand: identifiers and arguments", () => {
  it("rejects a missing or malformed identifier as invalid-id and records nothing", async (t) => {
    const library = await libraryWith(t, ["brief-example"]);

    for (const text of ["use", "use ../x", "use Brief", "use con", "preview", "preview a/b"]) {
      assert.deepEqual(await runCommand(text, library.options), {
        kind: "failed",
        diagnostic: {
          category: "command",
          code: "invalid-id",
          profileId: null,
          candidateOrdinal: null,
        },
      });
    }
    assert.deepEqual(await readSelection(library.options.stateDirectory), {
      status: "loaded",
      choice: { kind: "unset" },
    });
  });

  it("rejects an argument on a subcommand that takes none", async (t) => {
    const library = await libraryWith(t);

    assert.deepEqual(await runCommand("status now", library.options), {
      kind: "failed",
      diagnostic: {
        category: "command",
        code: "unexpected-argument",
        profileId: null,
        candidateOrdinal: null,
      },
    });
  });
});

describe("executeSelectorCommand: choosing and turning off", () => {
  it("records a profile that exists in the catalog", async (t) => {
    const library = await libraryWith(t, ["brief-example"]);

    assert.deepEqual(await runCommand("use brief-example", library.options), {
      kind: "selected",
      profileId: "brief-example",
      combinedBytes: 5,
      exceedsOperationalLimit: false,
    });
    assert.deepEqual(await readSelection(library.options.stateDirectory), {
      status: "loaded",
      choice: { kind: "profile", profileId: "brief-example" },
    });
  });

  it("writes nothing to the library or its configuration when recording a choice", async (t) => {
    const library = await libraryWith(t, ["brief-example"]);
    const before = await snapshotTree(library.options.libraryRoot);

    await runCommand("use brief-example", library.options);

    assert.deepEqual(await snapshotTree(library.options.libraryRoot), before);
  });

  it("reports an unknown profile without recording anything", async (t) => {
    const library = await libraryWith(t, ["brief-example"]);

    assert.deepEqual(await runCommand("use missing-id", library.options), {
      kind: "failed",
      diagnostic: {
        category: "catalog",
        code: "profile-unavailable",
        profileId: "missing-id",
        candidateOrdinal: null,
      },
    });
    assert.deepEqual(await readSelection(library.options.stateDirectory), {
      status: "loaded",
      choice: { kind: "unset" },
    });
  });

  it("reports an unusable library root and records nothing", async (t) => {
    const library = await libraryWith(t);
    const fileRoot = join(library.base, "prefills-file");
    await writeRootFile(library.base, "prefills-file", "not a directory");

    assert.deepEqual(
      await runCommand("use brief-example", { ...library.options, libraryRoot: fileRoot }),
      {
        kind: "failed",
        diagnostic: {
          category: "catalog",
          code: "root-not-directory",
          profileId: null,
          candidateOrdinal: null,
        },
      },
    );
  });

  it("refuses a new choice while PI_PREFILL_OFF has an unsupported value and keeps the old one", async (t) => {
    const library = await libraryWith(t, ["brief-example"]);
    await runCommand("use brief-example", library.options);
    const withInvalidEnvironment = {
      ...library.options,
      environment: { PI_PREFILL_OFF: "yes" },
    };

    assert.deepEqual(await runCommand("use brief-example", withInvalidEnvironment), {
      kind: "failed",
      diagnostic: {
        category: "configuration",
        code: "environment-invalid",
        profileId: null,
        candidateOrdinal: null,
      },
    });
    assert.deepEqual(await readSelection(library.options.stateDirectory), {
      status: "loaded",
      choice: { kind: "profile", profileId: "brief-example" },
    });
  });

  it("still records an explicit off while PI_PREFILL_OFF has an unsupported value", async (t) => {
    const library = await libraryWith(t, ["brief-example"]);
    const withInvalidEnvironment = {
      ...library.options,
      environment: { PI_PREFILL_OFF: "yes" },
    };

    assert.deepEqual(await runCommand("off", withInvalidEnvironment), { kind: "off" });
    assert.deepEqual(await readSelection(library.options.stateDirectory), {
      status: "loaded",
      choice: { kind: "off" },
    });
    assert.deepEqual(await runCommand("status", withInvalidEnvironment), {
      kind: "status",
      status: { pendingProfileId: null, explicitOff: true, environment: "invalid" },
    });
  });

  it("does not replace an unreadable state when recording a choice", async (t) => {
    const library = await libraryWith(t, ["brief-example"]);
    const stateFile = join(library.options.stateDirectory, "selection.json");
    await fs.mkdir(library.options.stateDirectory, { recursive: true });
    await fs.writeFile(stateFile, "{ not json");

    assert.deepEqual(await runCommand("use brief-example", library.options), {
      kind: "failed",
      diagnostic: {
        category: "selection",
        code: "invalid-json",
        profileId: null,
        candidateOrdinal: null,
      },
    });
    assert.equal(await fs.readFile(stateFile, "utf8"), "{ not json");
  });

  it("records an explicit off that status reports", async (t) => {
    const library = await libraryWith(t, ["brief-example"]);
    await runCommand("use brief-example", library.options);

    assert.deepEqual(await runCommand("off", library.options), { kind: "off" });
    assert.deepEqual(await runCommand("status", library.options), {
      kind: "status",
      status: { pendingProfileId: null, explicitOff: true, environment: "inactive" },
    });
  });
});

describe("executeSelectorCommand: status", () => {
  it("reports no pending choice when nothing was recorded", async (t) => {
    const library = await libraryWith(t);

    assert.deepEqual(await runCommand("status", library.options), {
      kind: "status",
      status: { pendingProfileId: null, explicitOff: false, environment: "inactive" },
    });
  });

  it("reports the pending profile after use", async (t) => {
    const library = await libraryWith(t, ["brief-example"]);
    await runCommand("use brief-example", library.options);

    assert.deepEqual(await runCommand("status", library.options), {
      kind: "status",
      status: { pendingProfileId: "brief-example", explicitOff: false, environment: "inactive" },
    });
  });

  it("reports the environment origin of a disable and an unsupported value", async (t) => {
    const library = await libraryWith(t);
    const withEnvironment = (environment: ProfileEnvironment): SelectorOptions => ({
      ...library.options,
      environment,
    });

    assert.deepEqual(await runCommand("status", withEnvironment({ PI_PREFILL_OFF: "1" })), {
      kind: "status",
      status: { pendingProfileId: null, explicitOff: false, environment: "forced" },
    });
    assert.deepEqual(await runCommand("status", withEnvironment({ PI_PREFILL_OFF: "yes" })), {
      kind: "status",
      status: { pendingProfileId: null, explicitOff: false, environment: "invalid" },
    });
    assert.deepEqual(await runCommand("status", withEnvironment({ PI_PREFILL_OFF: "0" })), {
      kind: "status",
      status: { pendingProfileId: null, explicitOff: false, environment: "inactive" },
    });
  });

  it("reports an unreadable state as a failure", async (t) => {
    const library = await libraryWith(t);
    await fs.mkdir(library.options.stateDirectory, { recursive: true });
    await fs.writeFile(
      join(library.options.stateDirectory, "selection.json"),
      '{"schemaVersion":2,"profileId":null,"disabled":false}',
    );

    assert.deepEqual(await runCommand("status", library.options), {
      kind: "failed",
      diagnostic: {
        category: "selection",
        code: "unsupported-schema-version",
        profileId: null,
        candidateOrdinal: null,
      },
    });
  });
});

describe("executeSelectorCommand: list, preview and reload", () => {
  it("lists valid profiles and counts the candidates left out", async (t) => {
    const library = await libraryWith(t, ["brief-example"]);
    await writeProfile(library.options.libraryRoot, "Bad_Name", shortFiles("Bad_Name"));

    assert.deepEqual(await runCommand("list", library.options), {
      kind: "list",
      profiles: [{ id: "brief-example", name: BRIEF_NAME, description: BRIEF_DESCRIPTION }],
      invalidCandidates: [
        { category: "identity", code: "invalid-id", profileId: null, candidateOrdinal: 1 },
      ],
    });
  });

  it("previews a profile by its explicit identifier", async (t) => {
    const library = await libraryWith(t, ["brief-example"]);

    assert.deepEqual(await runCommand("preview brief-example", library.options), {
      kind: "preview",
      profile: {
        id: "brief-example",
        name: BRIEF_NAME,
        description: BRIEF_DESCRIPTION,
        userText: "Hi",
        assistantText: "Yes",
      },
    });
  });

  it("reports the catalog and configuration on reload without applying anything", async (t) => {
    const library = await libraryWith(t, ["brief-example"]);
    await writeRootFile(
      library.options.libraryRoot,
      "config.json",
      '{"schemaVersion":1,"defaultProfileId":"brief-example"}',
    );
    const before = await snapshotTree(library.options.libraryRoot);

    const result = await runCommand("reload", library.options);

    assert.equal(result.kind, "reloaded");
    assert.equal(result.catalog.status, "loaded");
    assert.deepEqual(
      result.catalog.status === "loaded"
        ? result.catalog.profiles.map((profile) => profile.id)
        : [],
      ["brief-example"],
    );
    assert.deepEqual(result.configuration, {
      status: "loaded",
      defaultProfileId: "brief-example",
    });
    assert.deepEqual(await snapshotTree(library.options.libraryRoot), before);
    assert.deepEqual(await readSelection(library.options.stateDirectory), {
      status: "loaded",
      choice: { kind: "unset" },
    });
  });
});

describe("operational size threshold", () => {
  it("flags a selection whose combined content is above 16 KiB", async (t) => {
    const library = await libraryWith(t);
    await writeProfile(library.options.libraryRoot, "profile-0", {
      manifest: briefManifest("profile-0"),
      user: "a".repeat(16385),
      assistant: "b",
    });

    assert.deepEqual(await runCommand("use profile-0", library.options), {
      kind: "selected",
      profileId: "profile-0",
      combinedBytes: 16386,
      exceedsOperationalLimit: true,
    });
  });

  it("does not flag a selection of exactly 16 KiB", async (t) => {
    const library = await libraryWith(t);
    await writeProfile(library.options.libraryRoot, "profile-0", {
      manifest: briefManifest("profile-0"),
      user: "a".repeat(16383),
      assistant: "b",
    });

    assert.deepEqual(await runCommand("use profile-0", library.options), {
      kind: "selected",
      profileId: "profile-0",
      combinedBytes: 16384,
      exceedsOperationalLimit: false,
    });
  });
});

describe("registration", () => {
  it("registers the prefill command", () => {
    const registrations: string[] = [];
    const pi: PiExtensionApi = {
      appendEntry() {},
      registerCommand(name) {
        registrations.push(name);
      },
    };

    prefillExtension(pi);

    assert.deepEqual(registrations, ["prefill"]);
  });
});

interface Recording {
  readonly context: PiCommandContext;
  readonly appendEntry: (customType: string, data: unknown) => void;
  readonly entries: Array<{ readonly customType: string; readonly data: unknown }>;
  readonly notices: Array<{ readonly message: string; readonly type: PiNoticeType }>;
  readonly offered: string[][];
}

// `pick` receives the offered options and returns the one the operator chooses, or undefined.
function recordingContext(
  mode: PiExtensionMode,
  pick: (options: readonly string[]) => string | undefined = () => undefined,
): Recording {
  const entries: Recording["entries"] = [];
  const notices: Recording["notices"] = [];
  const offered: string[][] = [];
  const appendEntry = (customType: string, data: unknown): void => {
    entries.push({ customType, data });
  };
  const context: PiCommandContext = {
    mode,
    ui: {
      notify: (message, type) => {
        notices.push({ message, type });
      },
      select: async (_title, options) => {
        offered.push([...options]);
        return pick(options);
      },
    },
  };
  return { context, appendEntry, entries, notices, offered };
}

describe("handlePrefillCommand by mode", () => {
  it("does nothing in print mode, even for a valid choice", async (t) => {
    const library = await libraryWith(t, ["brief-example"]);
    const recording = recordingContext("print");

    await handlePrefillCommand(
      "use brief-example",
      recording.context,
      resolvedOptions(library.options),
      recording.appendEntry,
    );

    assert.deepEqual(recording.entries, []);
    assert.deepEqual(recording.notices, []);
    assert.deepEqual(await readSelection(library.options.stateDirectory), {
      status: "loaded",
      choice: { kind: "unset" },
    });
  });

  it("records the result as an entry and a notice in rpc mode", async (t) => {
    const library = await libraryWith(t, ["brief-example"]);
    const recording = recordingContext("rpc");

    await handlePrefillCommand(
      "use brief-example",
      recording.context,
      resolvedOptions(library.options),
      recording.appendEntry,
    );

    assert.deepEqual(recording.entries, [
      {
        customType: SELECTOR_ENTRY_TYPE,
        data: {
          kind: "selected",
          profileId: "brief-example",
          combinedBytes: 5,
          exceedsOperationalLimit: false,
        },
      },
    ]);
    assert.deepEqual(recording.notices, [
      {
        message: "Selected brief-example. No example is applied to a session yet.",
        type: "info",
      },
    ]);
  });

  it("reports status through an entry in json mode", async (t) => {
    const library = await libraryWith(t);
    const recording = recordingContext("json");

    await handlePrefillCommand(
      "status",
      recording.context,
      resolvedOptions(library.options),
      recording.appendEntry,
    );

    assert.deepEqual(recording.entries, [
      {
        customType: SELECTOR_ENTRY_TYPE,
        data: {
          kind: "status",
          pendingProfileId: null,
          explicitOff: false,
          environment: "inactive",
        },
      },
    ]);
  });

  it("reports a failure as a diagnostic entry without throwing", async (t) => {
    const library = await libraryWith(t);
    const recording = recordingContext("rpc");

    await handlePrefillCommand(
      "use missing-id",
      recording.context,
      resolvedOptions(library.options),
      recording.appendEntry,
    );

    assert.deepEqual(recording.entries, [
      {
        customType: SELECTOR_ENTRY_TYPE,
        data: {
          kind: "failed",
          diagnostic: {
            category: "catalog",
            code: "profile-unavailable",
            profileId: "missing-id",
            candidateOrdinal: null,
          },
        },
      },
    ]);
    assert.deepEqual(recording.notices, [
      {
        message: "Prefill failed: catalog/profile-unavailable for profile missing-id.",
        type: "error",
      },
    ]);
  });

  it("escapes a preview body in the entry and in the notice", async (t) => {
    const library = await libraryWith(t);
    await writeProfile(library.options.libraryRoot, "profile-0", {
      manifest: briefManifest("profile-0"),
      user: "\u001b]0;title\u0007Hi",
      assistant: "Yes",
    });
    const recording = recordingContext("rpc");

    await handlePrefillCommand(
      "preview profile-0",
      recording.context,
      resolvedOptions(library.options),
      recording.appendEntry,
    );

    const data = recording.entries[0]?.data as { profile: unknown };
    assert.deepEqual(data.profile, {
      id: "profile-0",
      name: BRIEF_NAME,
      description: BRIEF_DESCRIPTION,
      userText: "\\u001B]0;title\\u0007Hi",
      assistantText: "Yes",
    });
    assert.equal(recording.notices[0]?.message.includes("\u001b"), false);
  });

  it("shows a literal backslash sequence in a preview body as escaped text", async (t) => {
    const library = await libraryWith(t);
    await writeProfile(library.options.libraryRoot, "profile-0", {
      manifest: briefManifest("profile-0"),
      user: "\\u001B[31mHi",
      assistant: "Yes",
    });
    const recording = recordingContext("rpc");

    await handlePrefillCommand(
      "preview profile-0",
      recording.context,
      resolvedOptions(library.options),
      recording.appendEntry,
    );

    const data = recording.entries[0]?.data as { profile: { userText: string } };
    assert.equal(data.profile.userText, "\\\\u001B[31mHi");
    const noticeLines = recording.notices[0]?.message.split("\n") ?? [];
    assert.equal(noticeLines.includes("\\\\u001B[31mHi"), true);
  });

  it("opens a list of profiles and a disable option in tui mode", async (t) => {
    const library = await libraryWith(t, ["brief-example"]);
    const recording = recordingContext("tui");

    await handlePrefillCommand(
      "",
      recording.context,
      resolvedOptions(library.options),
      recording.appendEntry,
    );

    assert.deepEqual(recording.offered, [
      ["brief-example: Brief example", "Off: record an explicit disable"],
    ]);
    assert.deepEqual(recording.entries, []);
    assert.deepEqual(recording.notices, []);
  });

  it("records the chosen profile in tui mode and notifies the result", async (t) => {
    const library = await libraryWith(t, ["brief-example"]);
    const recording = recordingContext("tui", (options) => options[0]);

    await handlePrefillCommand(
      "list",
      recording.context,
      resolvedOptions(library.options),
      recording.appendEntry,
    );

    assert.deepEqual(recording.notices, [
      {
        message: "Selected brief-example. No example is applied to a session yet.",
        type: "info",
      },
    ]);
    assert.deepEqual(await readSelection(library.options.stateDirectory), {
      status: "loaded",
      choice: { kind: "profile", profileId: "brief-example" },
    });
  });

  it("records an explicit off from the tui list", async (t) => {
    const library = await libraryWith(t, ["brief-example"]);
    const recording = recordingContext("tui", (options) => options.at(-1));

    await handlePrefillCommand(
      "",
      recording.context,
      resolvedOptions(library.options),
      recording.appendEntry,
    );

    assert.deepEqual(await readSelection(library.options.stateDirectory), {
      status: "loaded",
      choice: { kind: "off" },
    });
  });

  it("changes nothing when the tui list is cancelled", async (t) => {
    const library = await libraryWith(t, ["brief-example"]);
    const recording = recordingContext("tui");

    await handlePrefillCommand(
      "",
      recording.context,
      resolvedOptions(library.options),
      recording.appendEntry,
    );

    assert.deepEqual(recording.notices, []);
    assert.deepEqual(await readSelection(library.options.stateDirectory), {
      status: "loaded",
      choice: { kind: "unset" },
    });
  });

  it("notifies instead of opening a dialog when the library has no valid profile", async (t) => {
    const library = await libraryWith(t);
    const recording = recordingContext("tui");

    await handlePrefillCommand(
      "",
      recording.context,
      resolvedOptions(library.options),
      recording.appendEntry,
    );

    assert.deepEqual(recording.offered, []);
    assert.deepEqual(recording.notices, [
      { message: "No valid profiles in the library.", type: "info" },
    ]);
  });

  it("shows other subcommands as notices only in tui mode", async (t) => {
    const library = await libraryWith(t);
    const recording = recordingContext("tui");

    await handlePrefillCommand(
      "status",
      recording.context,
      resolvedOptions(library.options),
      recording.appendEntry,
    );
    await handlePrefillCommand(
      "list extra",
      recording.context,
      resolvedOptions(library.options),
      recording.appendEntry,
    );

    assert.deepEqual(recording.entries, []);
    assert.deepEqual(recording.offered, []);
    assert.deepEqual(
      recording.notices.map((notice) => notice.type),
      ["info", "error"],
    );
    assert.equal(
      recording.notices[1]?.message,
      "Prefill failed: this subcommand takes no argument.",
    );
  });
});

describe("command side effects", () => {
  it("runs use and status without external process, network or fetch calls", async (t) => {
    const library = await libraryWith(t, ["brief-example"]);
    await writeRootFile(
      library.options.libraryRoot,
      "config.json",
      '{"schemaVersion":1,"defaultProfileId":"brief-example"}',
    );
    const before = await snapshotTree(library.options.libraryRoot);
    const externalCalls = externalCallRecorder(t);
    const recording = recordingContext("rpc");

    await handlePrefillCommand(
      "use brief-example",
      recording.context,
      resolvedOptions(library.options),
      recording.appendEntry,
    );
    await handlePrefillCommand(
      "status",
      recording.context,
      resolvedOptions(library.options),
      recording.appendEntry,
    );

    assert.deepEqual(externalCalls, []);
    assert.deepEqual(await snapshotTree(library.options.libraryRoot), before);
    assert.deepEqual(await readSelection(library.options.stateDirectory), {
      status: "loaded",
      choice: { kind: "profile", profileId: "brief-example" },
    });
  });

  it("reads and writes nothing in print mode", async (t) => {
    const library = await libraryWith(t, ["brief-example"]);
    const before = await snapshotTree(library.options.libraryRoot);
    const fileCalls = fileSystemCallRecorder(t);
    const externalCalls = externalCallRecorder(t);
    const recording = recordingContext("print");

    await handlePrefillCommand(
      "use brief-example",
      recording.context,
      resolvedOptions(library.options),
      recording.appendEntry,
    );
    await handlePrefillCommand(
      "status",
      recording.context,
      resolvedOptions(library.options),
      recording.appendEntry,
    );

    assert.deepEqual(fileCalls, []);
    assert.deepEqual(externalCalls, []);
    assert.deepEqual(recording.entries, []);
    assert.deepEqual(recording.notices, []);
    // The recorders replace the file functions, so they are restored before the final comparison.
    t.mock.restoreAll();
    assert.deepEqual(await snapshotTree(library.options.libraryRoot), before);
    await assert.rejects(fs.access(library.options.stateDirectory));
  });
});
