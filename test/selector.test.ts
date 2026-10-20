import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { ProfileEnvironment } from "../src/config.ts";
import type {
  PiCommandContext,
  PiExtensionApi,
  PiExtensionMode,
  PiModelRegistry,
  PiNoticeType,
} from "../src/extension-types.ts";
import prefillExtension, {
  handlePrefillCommand,
  SELECTOR_ENTRY_TYPE,
  type SelectorOptionsResolution,
} from "../src/index.ts";
import { writeProfile as saveProfile } from "../src/profile-writer.ts";
import { loadProfileCatalog } from "../src/profiles.ts";
import { selectMenuItem } from "../src/search-list.ts";
import { readSelection } from "../src/selection.ts";
import {
  completeSubcommands,
  executeSelectorCommand,
  parseSelectorText,
  type SelectorOptions,
} from "../src/selector.ts";
import {
  BRIEF_DESCRIPTION,
  BRIEF_NAME,
  briefManifest,
  createLibraryFixture,
  externalCallRecorder,
  fileSystemCallRecorder,
  type ProfileFiles,
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
      status: {
        pendingProfileId: null,
        explicitOff: true,
        environment: "invalid",
        application: { kind: "indeterminate" },
      },
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
      status: {
        pendingProfileId: null,
        explicitOff: true,
        environment: "inactive",
        application: { kind: "indeterminate" },
      },
    });
  });
});

describe("executeSelectorCommand: status", () => {
  it("reports no pending choice when nothing was recorded", async (t) => {
    const library = await libraryWith(t);

    assert.deepEqual(await runCommand("status", library.options), {
      kind: "status",
      status: {
        pendingProfileId: null,
        explicitOff: false,
        environment: "inactive",
        application: { kind: "indeterminate" },
      },
    });
  });

  it("reports the pending profile after use", async (t) => {
    const library = await libraryWith(t, ["brief-example"]);
    await runCommand("use brief-example", library.options);

    assert.deepEqual(await runCommand("status", library.options), {
      kind: "status",
      status: {
        pendingProfileId: "brief-example",
        explicitOff: false,
        environment: "inactive",
        application: { kind: "indeterminate" },
      },
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
      status: {
        pendingProfileId: null,
        explicitOff: false,
        environment: "forced",
        application: { kind: "indeterminate" },
      },
    });
    assert.deepEqual(await runCommand("status", withEnvironment({ PI_PREFILL_OFF: "yes" })), {
      kind: "status",
      status: {
        pendingProfileId: null,
        explicitOff: false,
        environment: "invalid",
        application: { kind: "indeterminate" },
      },
    });
    assert.deepEqual(await runCommand("status", withEnvironment({ PI_PREFILL_OFF: "0" })), {
      kind: "status",
      status: {
        pendingProfileId: null,
        explicitOff: false,
        environment: "inactive",
        application: { kind: "indeterminate" },
      },
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
      bindings: [],
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
      on() {},
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
  readonly titles: string[];
}

// `pick` receives the offered options and returns the one the operator chooses, or undefined.
function recordingContext(
  mode: PiExtensionMode,
  pick: (options: readonly string[]) => string | undefined = () => undefined,
  modelRegistry?: PiModelRegistry,
): Recording {
  const entries: Recording["entries"] = [];
  const notices: Recording["notices"] = [];
  const offered: string[][] = [];
  const titles: string[] = [];
  const appendEntry = (customType: string, data: unknown): void => {
    entries.push({ customType, data });
  };
  const context: PiCommandContext = {
    mode,
    sessionManager: { getLeafId: () => null, getBranch: () => [] },
    ...(modelRegistry === undefined ? {} : { modelRegistry }),
    ui: {
      notify: (message, type) => {
        notices.push({ message, type });
      },
      select: async (title, options) => {
        titles.push(title);
        offered.push([...options]);
        return pick(options);
      },
    },
  };
  return { context, appendEntry, entries, notices, offered, titles };
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
        message:
          "Selected brief-example. The choice is recorded for this agent directory. A session records an application when it starts on a non-virtual model with an empty branch, unless PI_PREFILL_OFF is 1.",
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
          application: { kind: "indeterminate" },
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
      "list",
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
        message:
          "Selected brief-example. The choice is recorded for this agent directory. A session records an application when it starts on a non-virtual model with an empty branch, unless PI_PREFILL_OFF is 1.",
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
      "list",
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
      "list",
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

it("fits a narrow menu and confirms a case-insensitive description match", async () => {
  const recording = recordingContext("tui", () => undefined);
  recording.context.ui.custom = (factory) =>
    new Promise((resolve) => {
      const component = factory(
        { terminal: { rows: 24 } },
        { fg: (_color, text) => text, bold: (text) => text },
        { matches: (data, action) => data === action },
        resolve,
      );
      for (const width of [1, 12]) {
        assert.ok(component.render(width).every((line) => line.length <= width));
      }
      for (const character of "sAvEd") component.handleInput(character);
      assert.ok(component.render(60).some((line) => line.includes("→ Choose")));
      assert.ok(!component.render(60).some((line) => line.includes("Close")));
      component.handleInput("tui.select.confirm");
    });
  assert.equal(
    await selectMenuItem(recording.context, {
      title: "Prefill",
      subtitle: "Synthetic state\nSecond line",
      items: [
        { value: "close", label: "Close" },
        { value: "choose", label: "Choose", description: "Use a saved example" },
      ],
    }),
    "choose",
  );
});

it("creates and edits a catalog-valid profile through the TUI menu", async (t) => {
  const library = await libraryWith(t);
  const recording = recordingContext("tui", (options) =>
    options.find((label) => label === "Create a profile"),
  );
  const inputs = ["new-example", "New example", "Synthetic example"];
  const bodies = ["User text\n", "Assistant text\n"];
  recording.context.ui.input = async () => inputs.shift();
  recording.context.ui.editor = async () => bodies.shift();
  await handlePrefillCommand(
    "",
    recording.context,
    resolvedOptions(library.options),
    recording.appendEntry,
  );
  const created = await loadProfileCatalog(library.options.libraryRoot);
  assert.equal(created.status, "loaded");
  if (created.status !== "loaded") return;
  assert.deepEqual(created.profiles, [
    {
      id: "new-example",
      name: "New example",
      description: "Synthetic example",
      userText: "User text\n",
      assistantText: "Assistant text\n",
    },
  ]);
  assert.match(recording.notices.at(-1)?.message ?? "", /^Profile created and validated/);

  let step = 0;
  const editing = recordingContext("tui", (options) => {
    step += 1;
    return step === 1 ? "Edit a profile" : step === 2 ? options[0] : "User message";
  });
  editing.context.ui.input = async () => undefined;
  editing.context.ui.editor = async (_title, prefill) => {
    assert.equal(prefill, "User text\n");
    return "Changed user text\n";
  };
  await handlePrefillCommand(
    "",
    editing.context,
    resolvedOptions(library.options),
    editing.appendEntry,
  );
  const edited = await loadProfileCatalog(library.options.libraryRoot);
  assert.equal(edited.status, "loaded");
  if (edited.status !== "loaded") return;
  assert.deepEqual(edited.profiles, [{ ...created.profiles[0], userText: "Changed user text\n" }]);
  assert.match(editing.notices.at(-1)?.message ?? "", /profile revision changed/);
});

it("leaves the library unchanged on cancellation or an existing profile id", async (t) => {
  const library = await libraryWith(t, ["brief-example"]);
  const before = await snapshotTree(library.options.libraryRoot);
  const recording = recordingContext("tui", () => "Create a profile");
  recording.context.ui.input = async () => "new-example";
  recording.context.ui.editor = async () => undefined;
  await handlePrefillCommand(
    "",
    recording.context,
    resolvedOptions(library.options),
    recording.appendEntry,
  );
  assert.deepEqual(await snapshotTree(library.options.libraryRoot), before);
  assert.deepEqual(
    await saveProfile(library.options.libraryRoot, {
      kind: "create",
      profile: {
        id: "brief-example",
        name: "Replacement",
        description: "Synthetic",
        userText: "Changed",
        assistantText: "Changed",
      },
    }),
    { status: "failed", reason: "exists" },
  );
  assert.deepEqual(await snapshotTree(library.options.libraryRoot), before);
});

describe("the prefill menu", () => {
  const MENU = [
    "Choose a profile (1 available)",
    "Preview a profile",
    "Show status of this session",
    "Turn prefill off",
    "Reload the library from disk",
    "How to add a profile",
    "Close",
  ];

  async function openBare(
    library: Awaited<ReturnType<typeof libraryWith>>,
    pick: (options: readonly string[]) => string | undefined,
  ) {
    const recording = recordingContext("tui", pick);
    await handlePrefillCommand(
      "  ",
      recording.context,
      resolvedOptions(library.options),
      recording.appendEntry,
    );
    return recording;
  }

  it("opens on a bare command with the state in the title and every action", async (t) => {
    const library = await libraryWith(t, ["brief-example"]);
    const recording = await openBare(library, () => undefined);

    assert.deepEqual(recording.offered, [MENU]);
    const title = recording.titles[0] ?? "";
    assert.match(title, /^Prefill\n/);
    assert.match(title, /Choice: automatic \(bindings: 0\)/);
    assert.match(title, /Library: 1 valid, 0 left out/);
    assert.match(title, /Folder: /);
    assert.deepEqual(recording.notices, []);
    assert.deepEqual(await readSelection(library.options.stateDirectory), {
      status: "loaded",
      choice: { kind: "unset" },
    });
  });

  it("still offers every action when the library is empty", async (t) => {
    const library = await libraryWith(t);
    const recording = await openBare(library, () => undefined);

    assert.equal(recording.offered[0]?.length, 7);
    assert.equal(recording.offered[0]?.[0], "Choose a profile (none yet)");
    assert.match(recording.titles[0] ?? "", /Library: 0 valid, 0 left out/);
  });

  it("chooses a profile through a second dialog that lists its description", async (t) => {
    const library = await libraryWith(t, ["brief-example"]);
    const recording = await openBare(library, (options) => options[0]);

    assert.equal(recording.offered.length, 2);
    assert.equal(recording.offered[1]?.at(-1), "Back to the menu");
    assert.match(recording.offered[1]?.[0] ?? "", /^brief-example: Brief example — /);
    assert.deepEqual(await readSelection(library.options.stateDirectory), {
      status: "loaded",
      choice: { kind: "profile", profileId: "brief-example" },
    });
    assert.match(recording.notices[0]?.message ?? "", /^Selected brief-example\./);
  });

  it("returns to the menu from the profile dialog without changing anything", async (t) => {
    const library = await libraryWith(t, ["brief-example"]);
    let step = 0;
    const recording = await openBare(library, (options) => {
      step += 1;
      if (step === 1) return options[0];
      if (step === 2) return options.at(-1);
      return undefined;
    });

    assert.equal(recording.offered.length, 3);
    assert.deepEqual(recording.offered[2], MENU);
    assert.deepEqual(await readSelection(library.options.stateDirectory), {
      status: "loaded",
      choice: { kind: "unset" },
    });
  });
});

// Two providers, one of them without credentials, so the menu has to mark it.
const MODEL_REGISTRY: PiModelRegistry = {
  getAll: () => [
    { provider: "zeta", api: "openai-responses", id: "gpt-test" },
    { provider: "alpha", api: "anthropic-messages", id: "claude-test" },
  ],
  getAvailable: () => [{ provider: "alpha", api: "anthropic-messages", id: "claude-test" }],
};

it("adds a binding from the menu through the host select dialog", async (t) => {
  const library = await libraryWith(t, ["brief-example"]);
  let step = 0;
  const recording = recordingContext(
    "tui",
    (options) => {
      step += 1;
      if (step === 1) return options.find((label) => label === "Manage bindings");
      if (step === 2) return "Add a binding";
      if (step === 3) return options[0];
      if (step === 4) return options.find((label) => label === "alpha");
      // The provider rule is the first entry of the model list; the sixth dialog is the submenu
      // opened again after the save, and closing it ends the menu.
      return step === 5 ? options[0] : undefined;
    },
    MODEL_REGISTRY,
  );

  await handlePrefillCommand(
    "",
    recording.context,
    resolvedOptions(library.options),
    recording.appendEntry,
  );

  assert.deepEqual(recording.offered[3], ["alpha", "zeta (no credentials)"]);
  assert.deepEqual(recording.offered[4], ["(any model of alpha)", "claude-test"]);
  const stored = JSON.parse(
    await fs.readFile(join(library.options.libraryRoot, "config.json"), "utf8"),
  );
  assert.equal(stored.schemaVersion, 2);
  assert.deepEqual(
    stored.bindings.map((binding: { id: string }) => ({ ...binding, id: "generated" })),
    [{ id: "generated", profileId: "brief-example", provider: "alpha", model: null }],
  );
  assert.equal(recording.notices.at(-1)?.type, "info");
  assert.match(recording.notices.at(-1)?.message ?? "", /^Binding saved\./);
});
