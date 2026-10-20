import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import type {
  PiBoundaryDraft,
  PiCustomEntryDraft,
  PiEventContext,
  PiExtensionApi,
  PiMessage,
  PiModel,
  PiReadonlySessionManager,
  PiSessionEntry,
} from "../src/extension-types.ts";
import prefillExtension from "../src/index.ts";
import { PrefixProjection } from "../src/projection.ts";
import { saveSelection } from "../src/selection.ts";
import type { SelectorOptions } from "../src/selector.ts";
import {
  APPLICATION_ENTRY_TYPE,
  DIAGNOSTIC_ENTRY_TYPE,
  type PrefixDiagnostic,
} from "../src/session-state.ts";
import {
  BRIEF_ASSISTANT_TEXT,
  BRIEF_USER_TEXT,
  briefFiles,
  createLibraryFixture,
  externalCallRecorder,
  type LibraryFixture,
  snapshotTree,
  writeProfile,
  writeRootFile,
} from "./library-fixture.ts";

const PROFILE_ID = "brief-example";
const ANTHROPIC: PiModel = { provider: "anthropic", api: "anthropic-messages", id: "claude-test" };
const VIRTUAL: PiModel = { provider: "router", api: "pi-virtual", id: "auto" };
const OPENAI: PiModel = { provider: "openai", api: "openai-responses", id: "gpt-test" };
const COMPLETED = "completed";

// The branch of a simulated session. Each appended entry is a child of the leaf, and the leaf moves
// to it, as Pi's session manager does. Navigation moves the leaf without appending anything.
class FakeSession implements PiReadonlySessionManager {
  readonly entries: PiSessionEntry[] = [];
  private leaf: string | null = null;

  getLeafId(): string | null {
    return this.leaf;
  }

  getBranch(): PiSessionEntry[] {
    const byId = new Map(this.entries.map((entry) => [entry.id, entry]));
    const branch: PiSessionEntry[] = [];
    for (let id = this.leaf; id !== null; ) {
      const entry = byId.get(id);
      if (entry === undefined) break;
      branch.unshift(entry);
      id = entry.parentId;
    }
    return branch;
  }

  moveTo(leafId: string | null): void {
    this.leaf = leafId;
  }

  appendMessage(message: { readonly role: string } & Record<string, unknown>): void {
    this.append({ type: "message", message });
  }

  appendCustom(customType: string, data: unknown): void {
    this.append({ type: "custom", customType, data });
  }

  // The turn_end boundary persists the drafts a handler returned, in order.
  applyDrafts(drafts: readonly PiBoundaryDraft[]): void {
    for (const draft of drafts) {
      if (draft.type !== "custom") throw new Error(`unexpected draft: ${draft.type}`);
      const custom = draft as PiCustomEntryDraft;
      this.appendCustom(custom.customType, custom.data);
    }
  }

  // The conversation Pi would send: message entries that are not system messages.
  conversation(): PiMessage[] {
    return this.getBranch()
      .filter((entry) => entry.type === "message" && entry.message?.role !== "system")
      .map((entry) => entry.message as PiMessage);
  }

  // The custom records of the whole tree, as persisted.
  customRecords(): { readonly customType: string; readonly data: unknown }[] {
    return this.entries
      .filter((entry) => entry.type === "custom")
      .map((entry) => ({ customType: entry.customType ?? "", data: entry.data }));
  }

  append(fields: Record<string, unknown>): void {
    const id = `entry-${this.entries.length + 1}`;
    this.entries.push({ ...fields, id, parentId: this.leaf } as PiSessionEntry);
    this.leaf = id;
  }
}

interface Harness {
  readonly options: SelectorOptions;
  readonly session: FakeSession;
  readonly projection: PrefixProjection;
  model: PiModel;
}

function harnessFor(
  options: SelectorOptions,
  model: PiModel,
  session = new FakeSession(),
): Harness {
  const projection = new PrefixProjection({
    resolveOptions: () => ({ kind: "resolved", options }),
    appendEntry: (customType, data) => session.appendCustom(customType, data),
  });
  return { options, session, projection, model };
}

// A library with the brief profile and a selection of it. The state directory is beside the library.
async function selectedHarness(t: TestContext, model: PiModel = ANTHROPIC): Promise<Harness> {
  const library: LibraryFixture = await createLibraryFixture(t);
  await writeProfile(library.root, PROFILE_ID, briefFiles(PROFILE_ID));
  const options: SelectorOptions = {
    libraryRoot: library.root,
    stateDirectory: join(library.base, "pi-assistant-prefill"),
    environment: {},
  };
  await saveSelection(options.stateDirectory, { kind: "profile", profileId: PROFILE_ID });
  return harnessFor(options, model);
}

function contextOf(harness: Harness): PiEventContext {
  return { model: harness.model, sessionManager: harness.session };
}

function beginTurn(harness: Harness): void {
  harness.projection.beginTurn(contextOf(harness));
}

// The prompt is persisted after before_agent_start, as Pi does, so it is not in the branch yet when
// the turn begins.
function userPrompt(harness: Harness, text: string): PiMessage {
  const message = { role: "user", content: [{ type: "text", text }], timestamp: 0 };
  harness.session.appendMessage(message);
  return message;
}

async function request(harness: Harness): Promise<readonly PiMessage[] | undefined> {
  const result = await harness.projection.projectContext(
    { type: "context", messages: harness.session.conversation() },
    contextOf(harness),
  );
  return result?.messages;
}

// The assistant message is persisted before turn_end, and its drafts are persisted after it.
function respond(harness: Harness, outcome: "completed" | "aborted" | "error" = COMPLETED): void {
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "Answer." }],
    provider: harness.model.provider,
    api: harness.model.api,
    model: harness.model.id,
    stopReason: outcome === COMPLETED ? "stop" : outcome,
  };
  harness.session.appendMessage(message);
  const boundary = harness.projection.endTurnBoundary(
    { type: "turn_end", message, outcome, entries: [] },
    contextOf(harness),
  );
  harness.session.applyDrafts(boundary?.entries ?? []);
}

async function runTurn(
  harness: Harness,
  text: string,
  outcome: "completed" | "aborted" | "error" = COMPLETED,
): Promise<readonly PiMessage[] | undefined> {
  beginTurn(harness);
  userPrompt(harness, text);
  const sent = await request(harness);
  respond(harness, outcome);
  return sent;
}

function textOf(message: PiMessage | undefined): string | undefined {
  return (message as { content?: { text?: string }[] } | undefined)?.content?.[0]?.text;
}

function phasesOf(harness: Harness): unknown[] {
  return harness.session
    .customRecords()
    .filter((record) => record.customType === APPLICATION_ENTRY_TYPE)
    .map((record) => (record.data as { phase: unknown }).phase);
}

function diagnosticsOf(harness: Harness): PrefixDiagnostic[] {
  return harness.session
    .customRecords()
    .filter((record) => record.customType === DIAGNOSTIC_ENTRY_TYPE)
    .map((record) => record.data as PrefixDiagnostic);
}

describe("registration", () => {
  it("subscribes to the lifecycle events the projection uses", () => {
    const events: string[] = [];
    const pi: PiExtensionApi = {
      appendEntry() {},
      registerCommand() {},
      on(event: string) {
        events.push(event);
      },
    };

    prefillExtension(pi);

    assert.deepEqual(events, [
      "session_start",
      "session_tree",
      "agent_end",
      "before_agent_start",
      "context",
      "turn_end",
      "cache_warming_decision",
    ]);
  });
});

describe("eligibility", () => {
  it("starts an application on a branch without conversation and keeps the prompt last", async (t) => {
    const harness = await selectedHarness(t);

    // Pi begins the turn before the prompt is persisted, so the snapshot sees an empty branch.
    beginTurn(harness);
    const prompt = userPrompt(harness, "What is a list?");
    const sent = await request(harness);

    assert.deepEqual(
      sent?.map((message) => message.role),
      ["user", "assistant", "user"],
    );
    assert.equal(textOf(sent?.[0]), BRIEF_USER_TEXT);
    assert.equal(textOf(sent?.[1]), BRIEF_ASSISTANT_TEXT);
    assert.equal(sent?.at(-1), prompt);
    assert.deepEqual(phasesOf(harness), ["intent", "projected"]);
  });

  it("does not start on a branch that already holds a conversation", async (t) => {
    const harness = await selectedHarness(t);
    userPrompt(harness, "Earlier question");
    harness.session.appendMessage({ role: "assistant", content: [] });
    beginTurn(harness);

    const sent = await request(harness);

    assert.equal(sent, undefined);
    assert.deepEqual(phasesOf(harness), []);
  });

  it("judges a new branch without counting system messages and custom entries", async (t) => {
    const harness = await selectedHarness(t);
    harness.session.appendMessage({ role: "system", content: "prompt" });
    harness.session.appendCustom("other.extension", { note: true });
    harness.session.append({ type: "model_change", provider: "anthropic", modelId: "claude" });
    beginTurn(harness);
    userPrompt(harness, "Hello");

    const sent = await request(harness);

    assert.equal(textOf(sent?.[0]), BRIEF_USER_TEXT);
  });

  it("does not project when the request holds no conversational message", async (t) => {
    const harness = await selectedHarness(t);
    beginTurn(harness);

    const result = await harness.projection.projectContext(
      { type: "context", messages: [{ role: "system" }] },
      contextOf(harness),
    );

    assert.equal(result, undefined);
    assert.deepEqual(harness.session.customRecords(), []);
  });
});

describe("placement", () => {
  it("places the pair after leading system messages, never in front of them", async (t) => {
    const harness = await selectedHarness(t);
    beginTurn(harness);
    const prompt = userPrompt(harness, "Hello");
    const system = { role: "system", content: "prompt" };

    const result = await harness.projection.projectContext(
      { type: "context", messages: [system, prompt] },
      contextOf(harness),
    );

    assert.deepEqual(
      result?.messages.map((message) => message.role),
      ["system", "user", "assistant", "user"],
    );
    assert.equal(result?.messages[0], system);
    assert.equal(result?.messages.at(-1), prompt);
  });

  it("keeps the request unchanged when no profile is selected", async (t) => {
    const harness = await selectedHarness(t);
    await saveSelection(harness.options.stateDirectory, { kind: "off" });
    beginTurn(harness);
    userPrompt(harness, "Hello");

    assert.equal(await request(harness), undefined);
    assert.deepEqual(harness.session.customRecords(), []);
  });
});

describe("commitment", () => {
  it("commits after the completed response of the projected request", async (t) => {
    const harness = await selectedHarness(t);

    const sent = await runTurn(harness, "What is a list?");

    assert.equal(sent?.length, 3, "the request carried the pair before the prompt");
    assert.equal(textOf(sent?.[0]), BRIEF_USER_TEXT);
    assert.equal(textOf(sent?.[1]), BRIEF_ASSISTANT_TEXT);
    assert.deepEqual(phasesOf(harness), ["intent", "projected", "committed"]);
    const committed = harness.session
      .customRecords()
      .find((record) => (record.data as { phase: string }).phase === "committed");
    const data = committed?.data as Record<string, unknown>;
    assert.equal(data.schemaVersion, 1);
    assert.equal(data.profileId, PROFILE_ID);
    assert.equal(data.combinedBytes, 77);
    assert.equal(data.source, "manual");
    assert.equal(data.bindingId, null);
    assert.equal(data.provider, ANTHROPIC.provider);
    assert.equal(data.model, ANTHROPIC.id);
    assert.match(String(data.applicationId), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
    assert.match(String(data.revision), /^[0-9a-f]{64}$/);
  });

  it("never stores the profile text in any record", async (t) => {
    const harness = await selectedHarness(t);

    await runTurn(harness, "What is a list?");

    const stored = JSON.stringify(harness.session.customRecords());
    assert.equal(stored.includes(BRIEF_USER_TEXT), false);
    assert.equal(stored.includes(BRIEF_ASSISTANT_TEXT), false);
  });

  it("does not commit a response that ended in error or abort", async (t) => {
    const harness = await selectedHarness(t);

    await runTurn(harness, "What is a list?", "aborted");

    assert.deepEqual(phasesOf(harness), ["intent", "projected"]);
  });

  it("keeps a branch with a pending application from starting a new one", async (t) => {
    const harness = await selectedHarness(t);
    await runTurn(harness, "What is a list?", "aborted");

    beginTurn(harness);
    userPrompt(harness, "Try again");
    const sent = await request(harness);
    respond(harness, COMPLETED);

    assert.equal(sent, undefined);
    assert.deepEqual(phasesOf(harness), ["intent", "projected"]);
    assert.equal(harness.projection.describeApplication(harness.session).kind, "pending");
    assert.deepEqual(diagnosticsOf(harness), []);
  });

  it("keeps the pending application for a retry in the same turn and commits it there", async (t) => {
    const harness = await selectedHarness(t);
    beginTurn(harness);
    userPrompt(harness, "What is a list?");
    await request(harness);
    respond(harness, "error");

    const retried = await request(harness);
    respond(harness, COMPLETED);

    assert.equal(textOf(retried?.[0]), BRIEF_USER_TEXT);
    assert.deepEqual(phasesOf(harness), ["intent", "projected", "committed"]);
  });

  it("does not write a second commitment on a later turn", async (t) => {
    const harness = await selectedHarness(t);
    await runTurn(harness, "First question");

    const sent = await runTurn(harness, "Second question");

    assert.equal(textOf(sent?.[0]), BRIEF_USER_TEXT);
    assert.deepEqual(phasesOf(harness), ["intent", "projected", "committed"]);
  });
});

describe("continuity and navigation", () => {
  it("continues the committed prefix after a restart without writing records", async (t) => {
    const harness = await selectedHarness(t);
    await runTurn(harness, "First question");
    const recordsBefore = harness.session.customRecords();

    const restarted = harnessFor(harness.options, ANTHROPIC, harness.session);
    restarted.projection.reset();
    const sent = await runTurn(restarted, "Second question");

    assert.equal(textOf(sent?.[0]), BRIEF_USER_TEXT);
    assert.deepEqual(harness.session.customRecords(), recordsBefore);
  });

  it("keeps the committed prefix when the selection changes or is turned off", async (t) => {
    const harness = await selectedHarness(t);
    await runTurn(harness, "First question");
    await saveSelection(harness.options.stateDirectory, { kind: "off" });

    const sent = await runTurn(harness, "Second question");

    assert.equal(textOf(sent?.[0]), BRIEF_USER_TEXT);
  });

  it("does not project a sibling branch without the prefix", async (t) => {
    const harness = await selectedHarness(t);
    await runTurn(harness, "First question");
    const branchRoot = harness.session.entries.find(
      (entry) => entry.type === "message" && entry.message?.role === "user",
    );

    // A second branch from the first prompt: a conversation with no application records.
    harness.session.moveTo(branchRoot?.id ?? null);
    harness.session.appendMessage({ role: "assistant", content: [] });
    harness.projection.reset();
    beginTurn(harness);
    const sent = await request(harness);

    assert.equal(sent, undefined);
  });

  it("projects again when navigation returns to the branch with the prefix", async (t) => {
    const harness = await selectedHarness(t);
    await runTurn(harness, "First question");
    const committedLeaf = harness.session.getLeafId();
    const branchRoot = harness.session.entries.find(
      (entry) => entry.type === "message" && entry.message?.role === "user",
    );
    harness.session.moveTo(branchRoot?.id ?? null);
    harness.projection.reset();
    harness.session.moveTo(committedLeaf);
    harness.projection.reset();

    const sent = await request(harness);

    assert.equal(textOf(sent?.[0]), BRIEF_USER_TEXT);
  });

  it("writes nothing when a session starts again", async (t) => {
    const harness = await selectedHarness(t);
    await runTurn(harness, "First question");
    const before = harness.session.customRecords();

    harness.projection.reset();
    beginTurn(harness);
    await request(harness);

    assert.deepEqual(harness.session.customRecords(), before);
  });
});

describe("revision and content", () => {
  it("stops projecting when the applied profile was edited, reports it once, and resumes after the revert", async (t) => {
    const harness = await selectedHarness(t);
    await runTurn(harness, "First question");
    const userFile = join(harness.options.libraryRoot, PROFILE_ID, "user.md");
    await writeFile(userFile, "Edited text.");

    const first = await runTurn(harness, "Second question");
    const second = await runTurn(harness, "Third question");
    await writeFile(userFile, BRIEF_USER_TEXT);
    const reverted = await runTurn(harness, "Fourth question");

    assert.equal(first, undefined);
    assert.equal(second, undefined);
    assert.equal(textOf(reverted?.[0]), BRIEF_USER_TEXT);
    assert.deepEqual(diagnosticsOf(harness), [
      { schemaVersion: 1, reason: "revision-mismatch", profileId: PROFILE_ID, detail: null },
    ]);
  });

  it("stops projecting when the applied profile was deleted and reports the reason", async (t) => {
    const harness = await selectedHarness(t);
    await runTurn(harness, "First question");
    await rm(join(harness.options.libraryRoot, PROFILE_ID), { recursive: true, force: true });

    const sent = await runTurn(harness, "Second question");

    assert.equal(sent, undefined);
    assert.deepEqual(diagnosticsOf(harness), [
      {
        schemaVersion: 1,
        reason: "profile-unavailable",
        profileId: PROFILE_ID,
        detail: "file/missing-file",
      },
    ]);
  });
});

describe("compatibility", () => {
  it("does not start with a virtual model and reports the selection once", async (t) => {
    const harness = await selectedHarness(t, VIRTUAL);

    const first = await runTurn(harness, "First question");
    const second = await runTurn(harness, "Second question");

    assert.equal(first, undefined);
    assert.equal(second, undefined);
    assert.deepEqual(phasesOf(harness), []);
    assert.deepEqual(diagnosticsOf(harness), [
      { schemaVersion: 1, reason: "selection-incompatible", profileId: PROFILE_ID, detail: null },
    ]);
  });

  it("projects into a model of another provider and records the binding that chose the profile", async (t) => {
    const library: LibraryFixture = await createLibraryFixture(t);
    await writeProfile(library.root, PROFILE_ID, briefFiles(PROFILE_ID));
    await writeRootFile(
      library.root,
      "config.json",
      '{"schemaVersion":2,"defaultProfileId":null,"bindings":[{"id":"b-1a2b3c4d","profileId":"brief-example","provider":"openai","model":"gpt-test"}]}',
    );
    const options: SelectorOptions = {
      libraryRoot: library.root,
      stateDirectory: join(library.base, "pi-assistant-prefill"),
      environment: {},
    };
    const harness = harnessFor(options, OPENAI);

    const sent = await runTurn(harness, "Question");
    const intent = harness.session
      .customRecords()
      .find((record) => (record.data as { phase?: unknown }).phase === "intent");
    const recorded = intent?.data as Record<string, unknown>;

    assert.equal(textOf(sent?.[0]), BRIEF_USER_TEXT);
    assert.equal(textOf(sent?.[1]), BRIEF_ASSISTANT_TEXT);
    assert.deepEqual(
      {
        source: recorded.source,
        bindingId: recorded.bindingId,
        provider: recorded.provider,
        model: recorded.model,
      },
      { source: "binding", bindingId: "b-1a2b3c4d", provider: "openai", model: "gpt-test" },
    );
  });

  it("does not send the prefix to a virtual model on a committed branch, and keeps it", async (t) => {
    const harness = await selectedHarness(t);
    await runTurn(harness, "First question");
    harness.model = VIRTUAL;

    const sent = await runTurn(harness, "Second question");

    assert.equal(sent, undefined);
    assert.deepEqual(phasesOf(harness), ["intent", "projected", "committed"]);
  });
});

describe("cache warming", () => {
  it("stops a refresh while no commitment exists", async (t) => {
    const harness = await selectedHarness(t);
    await runTurn(harness, "Question", "aborted");
    assert.equal(harness.projection.describeApplication(harness.session).kind, "pending");

    const decision = harness.projection.decideCacheWarming(
      { type: "cache_warming_decision", action: "warm" },
      contextOf(harness),
    );

    assert.deepEqual(decision, { action: "stop" });
  });

  it("leaves a refresh alone after the commitment and counts it apart from the records", async (t) => {
    const harness = await selectedHarness(t);
    await runTurn(harness, "Question");
    const before = harness.session.customRecords();

    const first = harness.projection.decideCacheWarming(
      { type: "cache_warming_decision", action: "warm" },
      contextOf(harness),
    );
    const second = harness.projection.decideCacheWarming(
      { type: "cache_warming_decision", action: "warm" },
      contextOf(harness),
    );

    assert.equal(first, undefined);
    assert.equal(second, undefined);
    const status = harness.projection.describeApplication(harness.session);
    assert.equal(status.kind === "committed" && status.refreshes, 2);
    assert.deepEqual(harness.session.customRecords(), before);
  });
});

describe("failures", () => {
  it("reports an unusable library root as a diagnostic instead of throwing", async (t) => {
    const harness = await selectedHarness(t);
    const fileRoot = join(harness.options.stateDirectory, "not-a-directory");
    await writeFile(fileRoot, "file");
    const broken = harnessFor({ ...harness.options, libraryRoot: fileRoot }, ANTHROPIC);
    beginTurn(broken);
    userPrompt(broken, "Question");

    const sent = await request(broken);

    assert.equal(sent, undefined);
    assert.deepEqual(diagnosticsOf(broken), [
      {
        schemaVersion: 1,
        reason: "library-failed",
        profileId: null,
        detail: "catalog/root-not-directory",
      },
    ]);
  });

  it("reports an unreadable selection as a diagnostic instead of throwing", async (t) => {
    const harness = await selectedHarness(t);
    await writeFile(join(harness.options.stateDirectory, "selection.json"), "{not json");
    beginTurn(harness);
    userPrompt(harness, "Question");

    const sent = await request(harness);

    assert.equal(sent, undefined);
    assert.deepEqual(diagnosticsOf(harness), [
      {
        schemaVersion: 1,
        reason: "library-failed",
        profileId: null,
        detail: "selection/invalid-json",
      },
    ]);
  });
});

describe("side effects", () => {
  it("writes nothing to the library and makes no network or process calls", async (t) => {
    const harness = await selectedHarness(t);
    const before = await snapshotTree(harness.options.libraryRoot);
    const external = externalCallRecorder(t);

    await runTurn(harness, "First question");
    await runTurn(harness, "Second question");

    assert.deepEqual(external, []);
    assert.deepEqual(await snapshotTree(harness.options.libraryRoot), before);
  });
});

describe("application state reported to status", () => {
  function recordOf(harness: Harness, phase: string): Record<string, unknown> {
    const record = harness.session
      .customRecords()
      .find((entry) => (entry.data as { phase?: unknown }).phase === phase);
    return record?.data as Record<string, unknown>;
  }

  it("reports no application on a branch without records", async (t) => {
    const harness = await selectedHarness(t);

    assert.deepEqual(harness.projection.describeApplication(harness.session), { kind: "none" });
  });

  it("reports a pending application that no completed response carried", async (t) => {
    const harness = await selectedHarness(t);
    await runTurn(harness, "Question", "aborted");
    const intent = recordOf(harness, "intent");

    assert.deepEqual(harness.projection.describeApplication(harness.session), {
      kind: "pending",
      applicationId: intent.applicationId,
      profileId: PROFILE_ID,
      revision: intent.revision,
      combinedBytes: 77,
      source: "manual",
      bindingId: null,
      provider: ANTHROPIC.provider,
      model: ANTHROPIC.id,
      refreshes: 0,
    });
  });

  it("reports a committed application with the warm refreshes counted after it", async (t) => {
    const harness = await selectedHarness(t);
    await runTurn(harness, "Question");
    const committed = recordOf(harness, "committed");
    harness.projection.decideCacheWarming(
      { type: "cache_warming_decision", action: "warm" },
      contextOf(harness),
    );

    assert.deepEqual(harness.projection.describeApplication(harness.session), {
      kind: "committed",
      applicationId: committed.applicationId,
      profileId: PROFILE_ID,
      revision: committed.revision,
      combinedBytes: 77,
      source: "manual",
      bindingId: null,
      provider: ANTHROPIC.provider,
      model: ANTHROPIC.id,
      refreshes: 1,
    });
  });

  it("reports a branch with an unreadable application record as invalid", async (t) => {
    const harness = await selectedHarness(t);
    harness.session.appendCustom(APPLICATION_ENTRY_TYPE, {
      schemaVersion: 1,
      phase: "committed",
      applicationId: "not-a-uuid",
    });

    assert.deepEqual(harness.projection.describeApplication(harness.session), { kind: "invalid" });
  });
});

describe("turn state", () => {
  it("does not project in a run that had no before_agent_start after an eligible turn ended", async (t) => {
    const harness = await selectedHarness(t);
    beginTurn(harness);
    harness.projection.endRun();
    userPrompt(harness, "Sent without before_agent_start");

    const sent = await request(harness);

    assert.equal(sent, undefined);
    assert.deepEqual(phasesOf(harness), []);
  });

  it("does not project into a transcript that gained a conversation after the turn was judged eligible", async (t) => {
    const harness = await selectedHarness(t);
    beginTurn(harness);
    harness.session.appendMessage({ role: "user", content: [{ type: "text", text: "Earlier" }] });
    userPrompt(harness, "Now");

    const sent = await request(harness);

    assert.equal(sent, undefined);
    assert.deepEqual(phasesOf(harness), []);
  });

  it("does not project a request whose messages already carry an assistant message", async (t) => {
    const harness = await selectedHarness(t);
    beginTurn(harness);
    const prompt = userPrompt(harness, "Question");
    const earlier = { role: "assistant", content: [{ type: "text", text: "Earlier answer." }] };

    const result = await harness.projection.projectContext(
      { type: "context", messages: [prompt, earlier] },
      contextOf(harness),
    );

    assert.equal(result, undefined);
    assert.deepEqual(phasesOf(harness), []);
  });
  it("judges a branch with a conversation as not eligible, even when the request holds only the prompt", async (t) => {
    const harness = await selectedHarness(t);
    userPrompt(harness, "Earlier question");
    harness.session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Earlier answer." }],
    });
    beginTurn(harness);
    const prompt = userPrompt(harness, "Question");

    // The freshness check alone accepts a request of only the prompt. Only the eligibility judged at
    // the start of the turn refuses it here.
    const result = await harness.projection.projectContext(
      { type: "context", messages: [prompt] },
      contextOf(harness),
    );

    assert.equal(result, undefined);
    assert.deepEqual(phasesOf(harness), []);
  });
});

describe("invalid records and blocks", () => {
  it("refuses a branch with an invalid application record and reports invalid-record once", async (t) => {
    const harness = await selectedHarness(t);
    harness.session.appendCustom(APPLICATION_ENTRY_TYPE, {
      schemaVersion: 1,
      phase: "projected",
      applicationId: "not-a-uuid",
    });
    beginTurn(harness);
    userPrompt(harness, "Question");

    const first = await request(harness);
    const second = await request(harness);

    assert.equal(first, undefined);
    assert.equal(second, undefined);
    assert.deepEqual(diagnosticsOf(harness), [
      { schemaVersion: 1, reason: "invalid-record", profileId: null, detail: null },
    ]);
  });

  it("builds the pair from one text block per message", async (t) => {
    const harness = await selectedHarness(t);
    beginTurn(harness);
    const prompt = userPrompt(harness, "Question");

    const result = await harness.projection.projectContext(
      { type: "context", messages: [prompt] },
      contextOf(harness),
    );
    const blocks = result?.messages
      .slice(0, 2)
      .map((message) => (message as { content: { type: string }[] }).content.map((b) => b.type));

    assert.deepEqual(blocks, [["text"], ["text"]]);
  });
});
