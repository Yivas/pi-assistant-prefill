import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  profileLibraryDirectory,
  resolveAgentDirectory,
  selectionStateDirectory,
} from "../src/agent-dir.ts";

const WINDOWS_HOME = "C:\\Users\\operator";
const POSIX_HOME = "/home/operator";

const UNSUPPORTED = {
  status: "failed",
  diagnostic: {
    category: "configuration",
    code: "agent-directory-unsupported",
    profileId: null,
    candidateOrdinal: null,
  },
};

describe("resolveAgentDirectory: default location", () => {
  it("uses <home>/.pi/agent when the variable is unset or empty", () => {
    assert.deepEqual(resolveAgentDirectory({}, WINDOWS_HOME, "win32"), {
      status: "resolved",
      path: "C:\\Users\\operator\\.pi\\agent",
    });
    assert.deepEqual(resolveAgentDirectory({ PI_CODING_AGENT_DIR: "" }, POSIX_HOME, "linux"), {
      status: "resolved",
      path: "/home/operator/.pi/agent",
    });
  });
});

describe("resolveAgentDirectory: tilde expansion", () => {
  it("expands a bare tilde to the home directory", () => {
    assert.deepEqual(resolveAgentDirectory({ PI_CODING_AGENT_DIR: "~" }, WINDOWS_HOME, "win32"), {
      status: "resolved",
      path: "C:\\Users\\operator",
    });
    assert.deepEqual(resolveAgentDirectory({ PI_CODING_AGENT_DIR: "~" }, POSIX_HOME, "linux"), {
      status: "resolved",
      path: "/home/operator",
    });
  });

  it("expands ~/ and ~\\ followed by a relative path", () => {
    assert.deepEqual(
      resolveAgentDirectory({ PI_CODING_AGENT_DIR: "~/projects/agent" }, POSIX_HOME, "linux"),
      { status: "resolved", path: "/home/operator/projects/agent" },
    );
    assert.deepEqual(
      resolveAgentDirectory({ PI_CODING_AGENT_DIR: "~/projects/agent" }, WINDOWS_HOME, "win32"),
      { status: "resolved", path: "C:\\Users\\operator\\projects\\agent" },
    );
    assert.deepEqual(
      resolveAgentDirectory({ PI_CODING_AGENT_DIR: "~\\projects\\agent" }, WINDOWS_HOME, "win32"),
      { status: "resolved", path: "C:\\Users\\operator\\projects\\agent" },
    );
  });
});

describe("resolveAgentDirectory: rejected forms", () => {
  it("rejects ~user forms, which need an absolute path", () => {
    for (const home of [POSIX_HOME, WINDOWS_HOME]) {
      const platform = home === POSIX_HOME ? "linux" : "win32";
      assert.deepEqual(
        resolveAgentDirectory({ PI_CODING_AGENT_DIR: "~operator/agent" }, home, platform),
        UNSUPPORTED,
      );
    }
  });

  it("rejects an MSYS-style /c/ form on Windows and leaves it alone elsewhere", () => {
    assert.deepEqual(
      resolveAgentDirectory(
        { PI_CODING_AGENT_DIR: "/c/Users/operator/agent" },
        WINDOWS_HOME,
        "win32",
      ),
      UNSUPPORTED,
    );
    assert.deepEqual(
      resolveAgentDirectory({ PI_CODING_AGENT_DIR: "/d" }, WINDOWS_HOME, "win32"),
      UNSUPPORTED,
    );
    assert.deepEqual(
      resolveAgentDirectory(
        { PI_CODING_AGENT_DIR: "/c/Users/operator/agent" },
        POSIX_HOME,
        "linux",
      ),
      { status: "resolved", path: "/c/Users/operator/agent" },
    );
  });

  it("rejects file URLs, relative paths and other values", () => {
    for (const value of ["file:///C:/agent", "relative/agent", "agent"]) {
      assert.deepEqual(
        resolveAgentDirectory({ PI_CODING_AGENT_DIR: value }, WINDOWS_HOME, "win32"),
        UNSUPPORTED,
      );
      assert.deepEqual(
        resolveAgentDirectory({ PI_CODING_AGENT_DIR: value }, POSIX_HOME, "linux"),
        UNSUPPORTED,
      );
    }
  });
});

describe("resolveAgentDirectory: absolute paths", () => {
  it("uses an absolute path as it is", () => {
    assert.deepEqual(
      resolveAgentDirectory({ PI_CODING_AGENT_DIR: "C:\\custom\\agent" }, WINDOWS_HOME, "win32"),
      { status: "resolved", path: "C:\\custom\\agent" },
    );
    assert.deepEqual(
      resolveAgentDirectory(
        { PI_CODING_AGENT_DIR: "\\\\server\\share\\agent" },
        WINDOWS_HOME,
        "win32",
      ),
      { status: "resolved", path: "\\\\server\\share\\agent" },
    );
    assert.deepEqual(
      resolveAgentDirectory({ PI_CODING_AGENT_DIR: "/opt/agent" }, POSIX_HOME, "linux"),
      {
        status: "resolved",
        path: "/opt/agent",
      },
    );
  });
});

describe("library and state locations", () => {
  it("places the profile library and the plugin state beside each other under the agent directory", () => {
    assert.equal(profileLibraryDirectory("/agent"), join("/agent", "prefills"));
    assert.equal(selectionStateDirectory("/agent"), join("/agent", "pi-assistant-prefill"));
  });
});
