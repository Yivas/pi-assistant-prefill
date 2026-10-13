import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  escapeBody,
  escapeLabel,
  noticeTypeFor,
  profileOptionLabel,
  renderSelectorEntry,
  renderSelectorText,
} from "../src/status.ts";
import { renderMessage } from "../src/messages.ts";
import type { SelectorResult } from "../src/selector.ts";
import type { ApplicationStatus } from "../src/session-state.ts";

describe("escapeLabel", () => {
  it("keeps ordinary Unicode text unchanged", () => {
    assert.equal(escapeLabel("Ejemplo breve — ñandú"), "Ejemplo breve — ñandú");
  });

  it("shows line and paragraph separators as notation", () => {
    assert.equal(escapeLabel("a\u2028b\u2029c"), "a\\u2028b\\u2029c");
  });

  it("shows bidirectional controls as notation", () => {
    assert.equal(escapeLabel("x\u202Ey\u2066z\u200E\u061C"), "x\\u202Ey\\u2066z\\u200E\\u061C");
  });
});

describe("escapeBody", () => {
  it("shows ESC and an OSC title sequence as text", () => {
    assert.equal(escapeBody("\u001b]0;title\u0007text"), "\\u001B]0;title\\u0007text");
  });

  it("keeps line feeds and tabs and escapes carriage returns", () => {
    assert.equal(escapeBody("a\tb\nc\r\nd"), "a\tb\nc\\u000D\nd");
  });

  it("escapes DEL and C1 controls such as CSI", () => {
    assert.equal(escapeBody("\u009b31m\u007f"), "\\u009B31m\\u007F");
  });

  it("shows a literal backslash sequence differently from a real ESC", () => {
    const literal = escapeBody("\\u001B[31m");
    const real = escapeBody("\u001b[31m");

    assert.equal(literal, "\\\\u001B[31m");
    assert.equal(real, "\\u001B[31m");
    assert.notEqual(literal, real);
  });

  it("escapes a backslash in a label as well", () => {
    assert.equal(escapeLabel("C:\\temp"), "C:\\\\temp");
  });

  it("escapes presentation characters in a body too", () => {
    assert.equal(escapeBody("\u202e\u2028"), "\\u202E\\u2028");
  });
});

describe("profileOptionLabel", () => {
  it("escapes the name and keeps the identifier", () => {
    assert.equal(
      profileOptionLabel({ id: "brief-example", name: "Brief\u202Eexample", description: "d" }),
      "brief-example: Brief\\u202Eexample",
    );
  });
});

describe("status text", () => {
  it("reports no pending choice, no explicit off and the unapplied notice", () => {
    const result: SelectorResult = {
      kind: "status",
      status: {
        pendingProfileId: null,
        explicitOff: false,
        environment: "inactive",
        application: { kind: "indeterminate" },
      },
    };

    assert.equal(
      renderSelectorText(result),
      [
        "Pending choice: none",
        "Explicit off: no",
        "Application state of this branch: not read in this mode.",
      ].join("\n"),
    );
    assert.equal(noticeTypeFor(result), "info");
  });

  it("names the pending profile and the environment origin of a disable", () => {
    const result: SelectorResult = {
      kind: "status",
      status: {
        pendingProfileId: "brief-example",
        explicitOff: false,
        environment: "forced",
        application: { kind: "indeterminate" },
      },
    };

    assert.equal(
      renderSelectorText(result),
      [
        "Pending choice: brief-example",
        "Explicit off: no",
        "Disabled by the environment: PI_PREFILL_OFF is 1.",
        "Application state of this branch: not read in this mode.",
      ].join("\n"),
    );
  });

  it("builds the entry from the status fields only, with no body text", () => {
    const entry = renderSelectorEntry({
      kind: "status",
      status: {
        pendingProfileId: null,
        explicitOff: true,
        environment: "inactive",
        application: { kind: "indeterminate" },
      },
    });

    assert.deepEqual(entry, {
      kind: "status",
      pendingProfileId: null,
      explicitOff: true,
      environment: "inactive",
      application: { kind: "indeterminate" },
    });
  });

  it("flags an unsupported environment value without echoing it", () => {
    const result: SelectorResult = {
      kind: "status",
      status: {
        pendingProfileId: null,
        explicitOff: false,
        environment: "invalid",
        application: { kind: "indeterminate" },
      },
    };

    assert.equal(
      renderSelectorText(result).split("\n")[2],
      "PI_PREFILL_OFF has an unsupported value. Only 1 disables the prefill.",
    );
  });
});

describe("preview text", () => {
  it("shows metadata and both escaped bodies with their byte counts", () => {
    const result: SelectorResult = {
      kind: "preview",
      profile: {
        id: "brief-example",
        name: "Brief example",
        description: "A short explanation with one example",
        userText: "Hi\u001b[31m",
        assistantText: "Yes",
      },
    };

    assert.equal(
      renderSelectorText(result),
      [
        "Profile: brief-example",
        "Name: Brief example",
        "Description: A short explanation with one example",
        "Combined content: 10 bytes",
        "User text (7 bytes):",
        "Hi\\u001B[31m",
        "Assistant text (3 bytes):",
        "Yes",
      ].join("\n"),
    );
  });

  it("stores escaped bodies in the entry", () => {
    const entry = renderSelectorEntry({
      kind: "preview",
      profile: {
        id: "brief-example",
        name: "Brief example",
        description: "A short explanation with one example",
        userText: "Hi\u001b[31m",
        assistantText: "Yes",
      },
    });

    assert.deepEqual(entry, {
      kind: "preview",
      profile: {
        id: "brief-example",
        name: "Brief example",
        description: "A short explanation with one example",
        userText: "Hi\\u001B[31m",
        assistantText: "Yes",
      },
      combinedBytes: 10,
    });
  });
});

describe("selection notices", () => {
  it("warns with the size and the operational threshold above 16 KiB", () => {
    const result: SelectorResult = {
      kind: "selected",
      profileId: "big-example",
      combinedBytes: 16386,
      exceedsOperationalLimit: true,
    };

    assert.equal(
      renderSelectorText(result),
      [
        "Selected big-example. The choice is recorded for this agent directory. A session records an application when it starts on a physical Anthropic model with an empty branch, unless PI_PREFILL_OFF is 1.",
        "The combined content is 16386 bytes, above the 16 KiB operational threshold.",
      ].join("\n"),
    );
    assert.equal(noticeTypeFor(result), "warning");
  });

  it("tells the operator how to fix an unsupported PI_PREFILL_OFF value", () => {
    const result: SelectorResult = {
      kind: "failed",
      diagnostic: {
        category: "configuration",
        code: "environment-invalid",
        profileId: null,
        candidateOrdinal: null,
      },
    };

    assert.equal(
      renderSelectorText(result),
      "Prefill failed: PI_PREFILL_OFF has an unsupported value, so new selections are blocked; set it to 1 to disable, or to 0 or unset it.",
    );
  });

  it("reports a failure with the stable code and the identifier", () => {
    const result: SelectorResult = {
      kind: "failed",
      diagnostic: {
        category: "command",
        code: "unknown-subcommand",
        profileId: null,
        candidateOrdinal: null,
      },
    };

    assert.equal(
      renderSelectorText(result),
      "Prefill failed: unknown subcommand; use list, use <id>, off, status, preview <id> or reload.",
    );
    assert.equal(noticeTypeFor(result), "error");
  });
});

describe("reload text", () => {
  it("reports an empty catalog with no configured default", () => {
    const result: SelectorResult = {
      kind: "reloaded",
      catalog: { status: "loaded", profiles: [], diagnostics: [] },
      configuration: { status: "loaded", defaultProfileId: null },
    };

    assert.equal(
      renderSelectorText(result),
      [
        "Catalog: 0 valid, 0 left out.",
        "Configured default: none.",
        "Reload reads the catalog and configuration only. Nothing was applied.",
      ].join("\n"),
    );
  });

  it("reports an unusable catalog by its stable code", () => {
    const result: SelectorResult = {
      kind: "reloaded",
      catalog: {
        status: "failed",
        diagnostic: {
          category: "catalog",
          code: "root-not-directory",
          profileId: null,
          candidateOrdinal: null,
        },
      },
      configuration: { status: "loaded", defaultProfileId: null },
    };

    assert.equal(
      renderSelectorText(result).split("\n")[0],
      "Catalog unusable: catalog/root-not-directory.",
    );
  });
});

describe("renderMessage", () => {
  it("fills placeholders and rejects a key or parameter that does not exist", () => {
    assert.equal(
      renderMessage("list.item", { id: "brief-example", name: "Brief" }),
      "brief-example: Brief",
    );
    assert.throws(() => renderMessage("no.such.key"), /unknown message key/);
    assert.throws(
      () => renderMessage("list.item", { id: "brief-example" }),
      /missing message parameter/,
    );
  });
});

// Mulberry32 with a fixed seed, so a failing input is the same on every run.
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// Reads an escaped text back: two backslashes stand for one, a backslash followed by u and four
// hex digits is one UTF-16 code unit, and any other character stands for itself. Only the escapes
// the module produces are accepted.
function unescapeText(escaped: string): string {
  let text = "";
  let index = 0;
  while (index < escaped.length) {
    const character = escaped.charAt(index);
    if (character !== "\\") {
      text += character;
      index += 1;
    } else if (escaped.charAt(index + 1) === "\\") {
      text += "\\";
      index += 2;
    } else {
      const hex = escaped.slice(index + 2, index + 6);
      assert.equal(escaped.charAt(index + 1), "u");
      assert.match(hex, /^[0-9A-F]{4}$/);
      text += String.fromCharCode(Number.parseInt(hex, 16));
      index += 6;
    }
  }
  return text;
}

describe("escaping is injective", () => {
  const alphabet = [
    "\\",
    "u",
    "0",
    "1",
    "B",
    "[",
    "a",
    "\u001b",
    "\n",
    "\t",
    "\r",
    "\u0000",
    "\u007f",
    "\u009b",
    "\u2028",
    "\u2029",
    "\u202e",
    "\u2066",
    "\u200e",
    "\u061c",
    "\u00e9",
    "\ud83d\ude00",
  ];

  it("reads back every generated body and label, so no two inputs share an output", () => {
    const random = seededRandom(20261013);
    for (let iteration = 0; iteration < 3000; iteration += 1) {
      const length = Math.floor(random() * 12);
      let text = "";
      for (let position = 0; position < length; position += 1) {
        text += alphabet[Math.floor(random() * alphabet.length)];
      }
      assert.equal(unescapeText(escapeBody(text)), text, JSON.stringify(text));
      assert.equal(unescapeText(escapeLabel(text)), text, JSON.stringify(text));
    }
  });

  it("maps spellings that look alike to different outputs", () => {
    const spellings = ["\\u001B", "\u001b", "\\\\u001B", "\\", "\u001B\\u001B"];
    const outputs = new Set(spellings.map((text) => escapeBody(text)));

    assert.equal(outputs.size, spellings.length);
  });
});

describe("application state text", () => {
  const applicationId = "5c8b2f1e-0a1b-4c2d-8e3f-123456789abc";
  const revision = "ab".repeat(32);
  const base = { pendingProfileId: null, explicitOff: false, environment: "inactive" } as const;

  function textWith(application: ApplicationStatus): string {
    return renderSelectorText({ kind: "status", status: { ...base, application } });
  }

  it("reports a pending application as not committed, with its metadata", () => {
    assert.equal(
      textWith({
        kind: "pending",
        applicationId,
        profileId: "brief-example",
        revision,
        combinedBytes: 77,
        suspended: false,
        refreshes: 0,
      }),
      [
        "Pending choice: none",
        "Explicit off: no",
        `Application not committed yet: brief-example (application ${applicationId}, revision ${revision}, 77 bytes). No completed request carried it. While it stays pending, no new application starts on this branch.`,
      ].join("\n"),
    );
  });

  it("reports a committed application with its refresh count and no suspension line", () => {
    assert.equal(
      textWith({
        kind: "committed",
        applicationId,
        profileId: "brief-example",
        revision,
        combinedBytes: 77,
        suspended: false,
        refreshes: 2,
      }),
      [
        "Pending choice: none",
        "Explicit off: no",
        `Application committed in this branch: brief-example was projected into a completed request (application ${applicationId}, revision ${revision}, 77 bytes). Warm refresh decisions counted: 2.`,
      ].join("\n"),
    );
  });

  it("reports an unsupported destination as its own line, apart from the commitment", () => {
    const text = textWith({
      kind: "committed",
      applicationId,
      profileId: "brief-example",
      revision,
      combinedBytes: 77,
      suspended: true,
      refreshes: 0,
    });
    const lines = text.split("\n");
    assert.equal(lines.length, 4);
    assert.match(lines[2] ?? "", /^Application committed in this branch: brief-example /);
    assert.match(lines[3] ?? "", /^Unsupported destination: /);
  });

  it("reports an invalid branch and an empty branch", () => {
    assert.equal(
      textWith({ kind: "invalid" }).split("\n").at(-1),
      "Application state of this branch: records unreadable, so no example is projected into it.",
    );
    assert.equal(textWith({ kind: "none" }).split("\n").at(-1), "Applied in this branch: none.");
  });
});
