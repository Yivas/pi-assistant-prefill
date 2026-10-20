import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PiSessionEntry } from "../src/extension-types.ts";
import {
  APPLICATION_ENTRY_TYPE,
  type BranchPrefixState,
  CurrentLeafState,
  DIAGNOSTIC_ENTRY_TYPE,
  deriveBranchPrefixState,
  hasConversation,
  lastDiagnostic,
  type PrefixDiagnostic,
  sameDiagnostic,
} from "../src/session-state.ts";

const APPLICATION_ID = "5c8b2f1e-0a1b-4c2d-8e3f-123456789abc";
const REVISION = "ab".repeat(32);

function record(phase: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    phase,
    applicationId: APPLICATION_ID,
    profileId: "brief-example",
    revision: REVISION,
    combinedBytes: 77,
    ...overrides,
  };
}

// Entry fields without id and parentId. Tests list entries of Pi's other types too, so the
// fields are not limited to the ones the package reads.
type EntryFields = { readonly type: string } & Readonly<Record<string, unknown>>;

// Entries as a branch lists them, root first. Each one is a child of the previous.
function branchOf(...entries: EntryFields[]): PiSessionEntry[] {
  return entries.map(
    (entry, index) =>
      ({
        ...entry,
        id: `e${index}`,
        parentId: index === 0 ? null : `e${index - 1}`,
      }) as PiSessionEntry,
  );
}

function applicationEntry(data: unknown): EntryFields {
  return { type: "custom", customType: APPLICATION_ENTRY_TYPE, data };
}

function diagnosticEntry(data: unknown): EntryFields {
  return { type: "custom", customType: DIAGNOSTIC_ENTRY_TYPE, data };
}

function messageEntry(role: string): EntryFields {
  return { type: "message", message: { role } };
}

describe("deriveBranchPrefixState: records in order", () => {
  it("reads a branch without application records as no application", () => {
    assert.deepEqual(deriveBranchPrefixState([]), { kind: "none" });
    assert.deepEqual(
      deriveBranchPrefixState(
        branchOf(
          { type: "model_change", provider: "anthropic", modelId: "claude" },
          { type: "custom", customType: "other.extension", data: { anything: true } },
        ),
      ),
      { kind: "none" },
    );
  });

  it("reads an intent alone as pending, so no commitment exists", () => {
    const state = deriveBranchPrefixState(branchOf(applicationEntry(record("intent"))));
    assert.deepEqual(state, {
      kind: "pending",
      application: {
        applicationId: APPLICATION_ID,
        profileId: "brief-example",
        revision: REVISION,
        combinedBytes: 77,
        source: null,
        bindingId: null,
        provider: null,
        model: null,
      },
    });
  });

  it("reads an intent and a projected record as pending", () => {
    const state = deriveBranchPrefixState(
      branchOf(applicationEntry(record("intent")), applicationEntry(record("projected"))),
    );
    assert.equal(state.kind, "pending");
  });

  it("reads intent, projected and committed records as committed", () => {
    const state = deriveBranchPrefixState(
      branchOf(
        applicationEntry(record("intent")),
        applicationEntry(record("projected")),
        applicationEntry(record("committed")),
      ),
    );
    assert.equal(state.kind, "committed");
    assert.equal(state.kind === "committed" && state.application.profileId, "brief-example");
  });

  it("rejects a committed record that does not follow a projected record", () => {
    const state = deriveBranchPrefixState(
      branchOf(applicationEntry(record("intent")), applicationEntry(record("committed"))),
    );
    assert.deepEqual(state, { kind: "invalid" });
  });

  it("rejects a record that starts without an intent", () => {
    assert.deepEqual(deriveBranchPrefixState(branchOf(applicationEntry(record("projected")))), {
      kind: "invalid",
    });
  });

  it("rejects a second application on the same branch", () => {
    const other = record("intent", { applicationId: "11111111-2222-4333-8444-555555555555" });
    const state = deriveBranchPrefixState(
      branchOf(
        applicationEntry(record("intent")),
        applicationEntry(record("projected")),
        applicationEntry(record("committed")),
        applicationEntry(other),
      ),
    );
    assert.deepEqual(state, { kind: "invalid" });
  });

  it("ignores records with another custom type and messages of any role", () => {
    const state = deriveBranchPrefixState(
      branchOf(messageEntry("user"), applicationEntry(record("intent")), messageEntry("assistant")),
    );
    assert.equal(state.kind, "pending");
  });
});

describe("deriveBranchPrefixState: invalid records", () => {
  const invalidCases: Record<string, unknown>[] = [
    { schemaVersion: 2, phase: "intent" },
    { phase: "intent" },
    { schemaVersion: 1, phase: "started" },
    { schemaVersion: 1, phase: "intent", extra: true },
    record("intent", { applicationId: "not-a-uuid" }),
    record("intent", { profileId: "Brief Example" }),
    record("intent", { profileId: "con" }),
    record("intent", { revision: "ab" }),
    record("intent", { combinedBytes: -1 }),
    record("intent", { combinedBytes: 1.5 }),
    record("intent", { combinedBytes: "77" }),
    record("intent", { source: "auto" }),
    record("intent", { bindingId: "11111111" }),
    record("intent", { provider: "openai\u0007" }),
    record("intent", { model: 7 }),
  ];

  for (const data of invalidCases) {
    it(`treats a record as invalid when it breaks the format: ${JSON.stringify(data)}`, () => {
      assert.deepEqual(deriveBranchPrefixState(branchOf(applicationEntry(data))), {
        kind: "invalid",
      });
    });
  }

  it("treats a diagnostic with an unknown reason as invalid", () => {
    const state = deriveBranchPrefixState(
      branchOf(
        diagnosticEntry({ schemaVersion: 1, reason: "surprise", profileId: null, detail: null }),
      ),
    );
    assert.deepEqual(state, { kind: "invalid" });
  });
});

describe("deriveBranchPrefixState: destination reports", () => {
  it("does not change the application state when a destination diagnostic is written", () => {
    const plain = branchOf(
      applicationEntry(record("intent")),
      applicationEntry(record("projected")),
      applicationEntry(record("committed")),
    );
    const reported = branchOf(
      applicationEntry(record("intent")),
      applicationEntry(record("projected")),
      applicationEntry(record("committed")),
      diagnosticEntry({
        schemaVersion: 1,
        reason: "destination-not-anthropic",
        profileId: "brief-example",
        detail: null,
      }),
    );
    assert.deepEqual(deriveBranchPrefixState(reported), deriveBranchPrefixState(plain));
  });

  it("ignores a destination diagnostic written before any application", () => {
    const state = deriveBranchPrefixState(
      branchOf(
        diagnosticEntry({
          schemaVersion: 1,
          reason: "destination-not-anthropic",
          profileId: null,
          detail: null,
        }),
      ),
    );
    assert.deepEqual(state, { kind: "none" });
  });
});

describe("deriveBranchPrefixState: re-derivation", () => {
  it("returns the same state when the same branch is read again", () => {
    const branch = branchOf(
      applicationEntry(record("intent")),
      applicationEntry(record("projected")),
      applicationEntry(record("committed")),
    );
    assert.deepEqual(deriveBranchPrefixState(branch), deriveBranchPrefixState(branch));
  });
});

describe("hasConversation", () => {
  it("does not count system messages, custom entries or model changes", () => {
    const branch = branchOf(
      messageEntry("system"),
      { type: "custom", customType: "other.extension", data: {} },
      { type: "model_change", provider: "anthropic", modelId: "claude" },
      { type: "thinking_level_change", thinkingLevel: "medium" },
      applicationEntry(record("intent")),
    );
    assert.equal(hasConversation(branch), false);
  });

  it("counts user and assistant messages, custom messages and compactions", () => {
    assert.equal(hasConversation(branchOf(messageEntry("user"))), true);
    assert.equal(hasConversation(branchOf(messageEntry("assistant"))), true);
    assert.equal(
      hasConversation(branchOf({ type: "custom_message", customType: "note", content: [] })),
      true,
    );
    assert.equal(hasConversation(branchOf({ type: "compaction", summary: "earlier work" })), true);
  });

  it("does not count a branch summary without text", () => {
    assert.equal(hasConversation(branchOf({ type: "branch_summary", summary: "" })), false);
    assert.equal(hasConversation(branchOf({ type: "branch_summary", summary: "x" })), true);
  });
});

describe("lastDiagnostic and sameDiagnostic", () => {
  it("returns the last diagnostic entry of the branch", () => {
    const branch = branchOf(
      diagnosticEntry({
        schemaVersion: 1,
        reason: "selection-incompatible",
        profileId: "brief-example",
        detail: null,
      }),
      messageEntry("user"),
      diagnosticEntry({
        schemaVersion: 1,
        reason: "revision-mismatch",
        profileId: "brief-example",
        detail: null,
      }),
    );
    assert.deepEqual(lastDiagnostic(branch), {
      reason: "revision-mismatch",
      profileId: "brief-example",
      detail: null,
    });
    assert.equal(lastDiagnostic(branchOf(messageEntry("user"))), null);
  });

  it("compares reason, profile and detail", () => {
    const diagnostic: PrefixDiagnostic = {
      reason: "library-failed",
      profileId: null,
      detail: "catalog/root-not-directory",
    };
    assert.equal(sameDiagnostic(diagnostic, { ...diagnostic }), true);
    assert.equal(sameDiagnostic(diagnostic, { ...diagnostic, detail: null }), false);
    assert.equal(sameDiagnostic(null, diagnostic), false);
  });
});

describe("CurrentLeafState", () => {
  function fakeSession(
    leafId: string | null,
    branch: readonly PiSessionEntry[],
    reads: { branch: number },
  ) {
    return {
      getLeafId: () => leafId,
      getBranch: () => {
        reads.branch += 1;
        return branch;
      },
    };
  }

  it("reads the branch once while the leaf stays the same", () => {
    const reads = { branch: 0 };
    const cache = new CurrentLeafState();
    const session = fakeSession("e0", branchOf(messageEntry("user")), reads);

    const first: BranchPrefixState = cache.of(session);
    const second: BranchPrefixState = cache.of(session);

    assert.deepEqual(first, { kind: "none" });
    assert.deepEqual(second, first);
    assert.equal(reads.branch, 1);
  });

  it("derives the state again when the leaf changes", () => {
    const reads = { branch: 0 };
    const cache = new CurrentLeafState();
    cache.of(fakeSession("e0", [], reads));
    cache.of(fakeSession("e1", [], reads));
    assert.equal(reads.branch, 2);
  });

  it("derives the state again after a reset", () => {
    const reads = { branch: 0 };
    const cache = new CurrentLeafState();
    const session = fakeSession("e0", [], reads);
    cache.of(session);
    cache.reset();
    cache.of(session);
    assert.equal(reads.branch, 2);
  });
});
