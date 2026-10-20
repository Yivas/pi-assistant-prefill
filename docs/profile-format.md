# Profile library format and resolution

This document describes the profile library, its configuration and the resolution rules. The profile format is version 1; the configuration is version 2, and version 1 is still read. The TUI menu creates and edits profiles in this format, and its Manage bindings action is the only code in the package that writes the library configuration; loading, resolution and the other commands keep the library read-only.

Status: implemented as a library with tests and read by the `/prefill` command (see [selector.md](selector.md)). It ships inside the published package `pi-assistant-prefill`, installed with `pi install npm:pi-assistant-prefill@0.1.2`. The command's automated tests do not start Pi; one manual run against Pi 1.1.0 on Windows with Node.js 24.9.0 is described in [selector.md](selector.md). No real model provider was tested: the application was checked against local doubles of the Anthropic messages and OpenAI-compatible chat completions endpoints, as [compatibility.md](compatibility.md) records.

All examples use synthetic data. The `brief-example` profile below is a placeholder, not a model prompt or a recommended example.

## Library location

The caller passes the library root. For a profile library in the agent directory, the root is `<agent-dir>/prefills`. The library does not look up the agent directory itself and does not search project, parent, or nested directories.

## Profile directories

Each immediate child of the root is a candidate. A candidate is valid only when its directory (or the directory it links to) contains these three files:

| File | Content |
| --- | --- |
| `profile.json` | Manifest, schema version 1 (see below) |
| `user.md` | The example's user message |
| `assistant.md` | The example's assistant message |

Other files in a profile directory are ignored and never interpreted. Regular files at the root are not candidates. A link named `config.json` at the root is never a candidate.

### Manifest (`profile.json`)

All four fields are required, and no other field is allowed.

| Field | Rule |
| --- | --- |
| `schemaVersion` | Number `1`. Other values are rejected, not migrated. |
| `id` | Must equal the directory name and the canonical directory basename. 1 to 64 characters, matching `^[a-z0-9]+(?:-[a-z0-9]+)*$`. Windows device names (`con`, `prn`, `aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`) are rejected. |
| `name` | Display label. Unicode is allowed. C0 and C1 controls are rejected, and so are values that contain only white space. |
| `description` | Same rules as `name`. |

The manifest is JSON in UTF-8. A leading UTF-8 byte order mark is accepted and excluded from the text. Comments, trailing commas, duplicate keys, and unknown fields are rejected. Duplicate detection compares decoded key names, so `"id"` and `"\u0069d"` count as the same key.

The machine-readable shape is in [`schema/profile.schema.json`](../schema/profile.schema.json). It does not express the duplicate-key, control-character, and white-space rules, which the parser enforces.

```json
{
  "schemaVersion": 1,
  "id": "brief-example",
  "name": "Brief example",
  "description": "A short explanation with one example"
}
```

### Message files

`user.md` and `assistant.md` are UTF-8 text. A leading byte order mark is excluded. Everything else is kept as written: line endings, Markdown, links, code spans, and text that looks like interpolation or terminal escapes. Nothing is trimmed, normalized, interpolated, or rendered. Control characters in a body are kept as written, so a display must escape them. A body that is empty or contains only white space is rejected.

```text
user.md
  Explain what a variable is.

assistant.md
  A variable stores a value.

  For example: age = 18.
```

## Byte limits

Limits apply to the raw bytes, including any byte order mark. The limit is inclusive: a file of exactly the limit is accepted and one byte more is rejected.

| File | Limit |
| --- | --- |
| `profile.json` | 8192 bytes |
| `config.json` | 8192 bytes |
| `user.md`, `assistant.md` | 65536 bytes each |

Each candidate can contribute up to 139,264 raw bytes (8 KiB, 64 KiB and 64 KiB). For 100 candidates that is about 13.3 MiB of file content. Each file is read twice, so the reader can pass about 26.6 MiB of content through its buffers. This is not a limit on the total memory use of the process.

## Candidate rules

- At most 100 candidates per catalog. Every immediate directory and link counts, including invalid ones. Candidate 101 blocks the whole catalog; the library never keeps the first 100.
- Candidates are ordered by their names in UTF-16 code unit order, without a locale. Diagnostics for a candidate without a valid identifier use its ordinal in that order.
- A missing root below an existing directory is an empty catalog. A non-directory root fails with `catalog/root-not-directory`; a dangling link fails with `identity/broken-link`. Other unusable roots also fail, rather than returning an empty catalog.
- Links are allowed when their final target is a regular file or directory inside the canonical root. Containment is checked by path components, so a sibling directory whose name starts with the root's name is outside.
- A link that escapes the root, is broken, or forms a cycle is an error for that candidate or file.
- Two or more candidates that resolve to the same canonical directory are all invalid. The first one found is never chosen.
- The canonical directory's basename and the directory entry name must both equal `id`.
- Before a snapshot is returned, the library reads the three files again and compares their bytes with the first reads. It also checks that the directory resolves to the same path and keeps the device and inode it had at resolution. A difference fails the candidate. This reports a difference it observes between the first and the second read. A change made after the second read, or reverted before it, is not detected, and the reads are not a transaction against another process running as the same user.

A valid profile is returned as an immutable snapshot of its identifier, labels, and both message texts. An invalid profile is left out with a diagnostic, and the other valid profiles stay available.

## Configuration (`config.json`)

The configuration is optional. Version 2 is the current format; version 1 is still read.

| Field | Rule |
| --- | --- |
| `schemaVersion` | Required. Number `1` or `2`. Any other value is rejected with `unsupported-schema-version`; reading never migrates a document. |
| `defaultProfileId` | Optional. A valid identifier or `null`. Absent and `null` both mean no default. |
| `bindings` | Optional. An array of binding rules. Absent means an empty list. A version 1 file written by the extension has no rules; the field follows the same rules when a hand-written version 1 document carries it. |

A binding rule selects a profile for one provider, or for one model of a provider:

| Field | Rule |
| --- | --- |
| `id` | Required. `b-` followed by eight lowercase hexadecimal digits (`^b-[0-9a-f]{8}$`). The writer generates it. |
| `profileId` | Required. A valid identifier. |
| `provider` | Required. The provider string as Pi's model registry writes it: 1 to 128 characters, not blank, without control characters. |
| `model` | Required. `null` for the provider rule, which answers for any model of that provider. Otherwise a model identifier with the same rules as `provider`. |

Every field of a rule is required, because a rule without `model` would be ambiguous between the provider rule and a missing value. Provider and model are compared with the selection as written: the library resolves no aliases, prefixes or endpoints. Two rules with the same `provider` and the same `model` are rejected with `duplicate-binding`, because the winner would otherwise depend on the order of the list. Two rules may share an `id`, and Remove deletes every rule that carries it.

The document is JSON in UTF-8 with the reader rules of the manifest: an optional byte order mark, no comments, no trailing commas, no duplicate keys, no unknown fields. Its limit is 8192 bytes, inclusive.

```json
{
  "schemaVersion": 2,
  "defaultProfileId": "brief-example",
  "bindings": [
    {
      "id": "b-1a2b3c4d",
      "profileId": "brief-example",
      "provider": "example-provider",
      "model": null
    },
    {
      "id": "b-4d5e6f70",
      "profileId": "brief-example",
      "provider": "example-provider",
      "model": "example-model"
    }
  ]
}
```

A malformed, unreadable, oversized, or unknown-version configuration blocks every new resolution except an environment off or an explicit off choice (see below). The library does not replace it with an empty one. A library root that is not a directory, including one below a regular file, fails with the catalog's `root-not-directory`. A missing root below an existing directory has no configuration. A dangling link on the path fails with `broken-link`. The reader never writes the configuration; Manage bindings in the TUI menu does.

## Writing the configuration

Only Manage bindings in the TUI menu writes `config.json`, through its Add and Remove actions. The writer in `src/config-writer.ts` reads the current document, applies the change and replaces the file:

1. The library directory is created when it is absent, and the current `config.json` is read and validated with the rules above. A document the reader would reject is reported and never overwritten.
2. Add generates the identifier from the system's random source and refuses a provider-and-model pair that a rule already carries. Remove takes an existing identifier.
3. The whole document is written as version 2, with `defaultProfileId` and the other rules kept. A version 1 file is therefore migrated by the write, and an absent file is created with `defaultProfileId: null` and the new rule.
4. The result is checked against the 8192-byte limit, then written to a temporary `.config.json.<uuid>.tmp` file in the same directory, flushed, and renamed over `config.json`. The previous file is not removed first, so an interrupted write leaves one of the two documents. On the platforms that apply it, the temporary file uses owner-only permissions.
5. Before the rename, the file is read again and its SHA-256 digest is compared with the digest of the bytes read in step 1. A different digest fails with `config-changed` and leaves the file as another process wrote it; a file that has since disappeared counts as a change too. The temporary file is removed.

A link at `config.json`, and a path that is not a regular file, are refused with `unsafe-path`. Failures are returned, not thrown: `invalid-binding` (a rejected profile, provider or model identifier), `duplicate-binding`, `invalid-configuration` (the document read in step 1 is not valid, with the category and code as detail), `size`, `config-changed`, `unsafe-path` and `io`. The menu reports the reason and nothing is written.

The digest check covers the file up to the last read before the rename. A change made between that read and the rename is not detected, and another process running as the same user is not prevented from writing the file.

## Resolution

`resolveProfile` takes the library root, the environment, the recorded choice and the model of the session that is about to apply an example. It returns one of `selected`, `off`, `none` or `failed`, in this precedence order:

1. **Environment off.** `PI_PREFILL_OFF=1` returns `off` immediately, without reading the library or the configuration. Unset, empty, and `0` do not force off. Any other value is an `environment-invalid` error that blocks new selections, but an explicit off choice still works.
2. **Explicit off.** `{ kind: "off" }` returns `off` without reading anything.
3. **Explicit profile.** `{ kind: "profile", profileId }` selects that profile or fails with `profile-unavailable`. That result does not repeat why the candidate was rejected; `loadProfileCatalog` returns those diagnostics. An invalid identifier fails with `invalid-id` and never falls back to the default. A missing default is ignored when an explicit profile is valid.
4. **Model binding.** Used only when the choice is `{ kind: "unset" }`. Among the rules whose `provider` equals the selection's provider, a rule with the same `model` wins over a provider rule. The result is `selected` with source `binding` and carries the winning `bindingId`. If the winning profile is missing from the catalog, the result is `binding-profile-unavailable`, and neither another rule nor the default replaces it.
5. **Provider binding.** The rule of that provider whose `model` is `null`, when no model rule matched. Same source, same failure rule. A session without a selected model matches no rule, because a rule names a provider and a model identifier, not whatever runs later.
6. **Configured default.** Used only when the choice is `{ kind: "unset" }` and no rule matched. If no default is configured, the result is `none`. If the configured default is missing from the catalog, the result is `default-profile-unavailable`. The library never picks another profile in its place.
7. **No candidate.** `none`.

The resolution calls a recorded choice `choice`; the application record stores the same decision as `manual` (see [projection.md](projection.md#records)).

An unusable catalog (a root error, or more than 100 candidates) blocks every non-off resolution in the same way, including the one that would return `none`. A malformed configuration does the same, and it is read before the catalog, so its failure is the one reported when both fail.

`none` and `off` are different results. `none` means no candidate. `off` means the example must not be applied, and `retainedProfileId` keeps the chosen identifier when it is valid. An explicit `off` choice returns `retainedProfileId: null`: the library keeps no state, so the caller keeps its own selection.

An `off` result decides against a new application. It cannot retract examples already sent, and does not remove them from existing history or context retained by the host. Later requests may still contain those examples. This library does not inspect or rewrite sessions.

A `selected` result shows that a profile was resolved. It does not show that a model received it. How a selected example is applied to a new session is described in [projection.md](projection.md).

## Diagnostics

A diagnostic has this shape:

```ts
{ category, code, profileId, candidateOrdinal }
```

For a candidate, `profileId` is set only after its manifest validates; before that, `candidateOrdinal` gives the candidate's position in the sorted scan. Resolution failures set `profileId` to the identifier that was requested or configured, when that identifier is valid. A diagnostic never contains file paths, file names, message text, configuration content, or raw JSON.

Reader categories: `configuration`, `catalog`, `identity`, `file`, `manifest`, `text`, `size`. The TUI profile writer reports validation and write failures separately, and reloads the catalog after saving to report reader diagnostics. The configuration writer returns a reason instead, listed in [Writing the configuration](#writing-the-configuration). The diagnostic types are defined in `src/diagnostic.ts`; the other types are defined in `src/profiles.ts` and `src/config.ts`.

## Reading guarantees and limits

- Loading and resolving never create, change, or delete files. Only Create and Edit in the TUI menu write profiles, and only Manage bindings writes the configuration; see [Menu](selector.md#menu) for the profile writes and [Writing the configuration](#writing-the-configuration) for the configuration write.
- A successful configuration write replaces the file with a version 2 document. A refused write leaves its bytes as they were.
- Before and after each read, the library compares device, inode, size, and modification time. It rejects a file that changed during the read.
- Special files (FIFOs, devices, directories) are rejected before the read.
- The library makes no network request and starts no process.
- A failed resolution does not write or repair any file. Library and configuration bytes are the same before and after.

These checks do not protect against another process running as the same user that changes files between checks. Treat the profile library as local data that you edit yourself.

## Public API

Import from the source modules:

```ts
import { join } from "node:path";
import { loadProfileCatalog } from "./src/profiles.ts";
import { resolveProfile } from "./src/config.ts";

const libraryRoot = join(agentDirectory, "prefills"); // agentDirectory is supplied by the caller

const catalog = await loadProfileCatalog(libraryRoot);
const resolution = await resolveProfile({
  libraryRoot,
  environment: process.env,
  choice: { kind: "unset" },
  // The selection of the session that is about to apply an example, or null without one.
  model: { provider: "example-provider", id: "example-model" },
});
```

| Export | Module | Purpose |
| --- | --- | --- |
| `loadProfileCatalog(libraryRoot)` | `src/profiles.ts` | Valid profile snapshots and per-candidate diagnostics, or a catalog failure. |
| `isProfileId(value)` | `src/profiles.ts` | Identifier check for untrusted input. |
| `loadProfileConfig(libraryRoot)` | `src/config.ts` | The configured default and binding rules, or a configuration failure. |
| `resolveProfile(options)` | `src/config.ts` | One of `selected`, `off`, `none`, or `failed`. The options carry the selection's provider and model identifiers, or `null` for a session without one. |
| `CONFIGURATION_SCHEMA_VERSION` | `src/config.ts` | The version the writer saves, `2`. |
| `PROFILE_OFF_ENVIRONMENT_VARIABLE` | `src/config.ts` | The name `PI_PREFILL_OFF`. |
| `writeProfile(libraryRoot, request)` | `src/profile-writer.ts` | Creates or edits one profile after validating it, or returns a failure reason as `ProfileWriteResult`. |
| `addProfileBinding(libraryRoot, request)` | `src/config-writer.ts` | Adds one rule to the configuration, or returns a failure reason as `ConfigWriteResult`. |
| `removeProfileBinding(libraryRoot, bindingId)` | `src/config-writer.ts` | Removes every rule that carries the identifier, or returns a failure reason. |

The types `ProfileDiagnostic`, `ProfileDiagnosticCategory` and `ProfileDiagnosticCode` are exported from `src/diagnostic.ts`. `ProfileSnapshot` and `ProfileCatalogLoad` are exported from `src/profiles.ts`. `ProfileConfigLoad`, `ProfileChoice`, `ProfileEnvironment`, `ProfileResolution`, `ResolveProfileOptions`, `ProfileBinding`, `ProfileConfiguration` and `ConfigurationDocument` are exported from `src/config.ts`. `ProfileBindingRequest`, `ConfigWriteResult` and `ConfigWriteFailure` are exported from `src/config-writer.ts`. Import each type from its module.

## Verification

The tests in `test/` use temporary directories and literal expected values. They cover valid and invalid manifests, text encoding and limits, link containment, candidate limits, configuration precedence, both configuration versions, binding selection, environment off, and the absence of writes and external calls in the reader. `test/config-writer.test.ts` covers the configuration write: a version 1 document is migrated to version 2, and a file that another writer replaced during the save is reported as `config-changed` and left as it is. The profile writer has its own tests in `test/selector.test.ts`: they create and edit a catalog-valid profile, and check that a cancelled save and an existing id leave the library unchanged. Run them as described in [CONTRIBUTING.md](../CONTRIBUTING.md).
