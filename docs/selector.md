# The `/prefill` command

`/prefill` chooses a profile from the local library, records an explicit disable, shows the recorded state, previews a profile and reloads the catalog. The chosen example is applied to new eligible sessions as described in [projection.md](projection.md). The command itself only records the choice and says so in its result.

## Status and verification

- The extension source is in this repository and ships in the published package `pi-assistant-prefill`, installed with `pi install npm:pi-assistant-prefill@0.1.0`.
- The automated suite (`npm run check`) calls the command with a simulated context and a temporary library. It does not start Pi.
- The structural types in `src/extension-types.ts` were checked with the TypeScript compiler against the declarations in `dist/core/extensions/types.d.ts` of Pi 1.1.0, from a temporary directory outside the repository, as described in [projection.md](projection.md#verification). That check is not part of `npm run check`.
- The manual check in [Manual isolated check](#manual-isolated-check) ran on 2026-10-13 (local time) on Windows 10.0.26300 with Node.js v24.9.0 and Pi 1.1.0. A separate TUI check on Pi 1.1.0 rendered the menu with an empty library and a temporary agent directory, including its title, state, folder and all seven actions. Selection through the menu was tested with a simulated context, not in the real TUI. No other Pi version, platform or model provider was checked.

## Subcommands

| Input | Effect |
| --- | --- |
| `/prefill` | Opens the menu in the interactive TUI. In RPC and JSON mode, lists the valid profiles without a dialog. |
| `/prefill list` | Lists the valid profiles. In the interactive TUI it opens the direct profile selector with them and an entry that records an explicit disable. |
| `/prefill use <id>` | Records `<id>` as the pending choice after checking that the catalog has a valid profile with that identifier. |
| `/prefill off` | Records an explicit disable and clears any pending choice. |
| `/prefill status` | Shows the pending choice, whether an explicit disable is recorded, the environment disable if any, the application state of the current branch (see [projection.md](projection.md#status)). |
| `/prefill preview <id>` | Shows the metadata and both message bodies of a profile, escaped. |
| `/prefill reload` | Reads the catalog and the library configuration again. It applies nothing. |

Nothing sends a message to the model, starts a generation, or writes to the profile library or to `prefills/config.json`.

## Argument grammar

The argument text arrives literally.

1. Leading and trailing ASCII whitespace (space, tab, LF, CR, form feed) is removed.
2. The first token is the subcommand. It ends at the first ASCII whitespace character.
3. The rest, after the separating whitespace, is the argument. Quotes and backslashes have no meaning. Nothing is interpolated.

Empty input opens the menu in the TUI and means `list` in RPC and JSON mode. A subcommand that takes no argument (`list`, `off`, `status`, `reload`) fails with `unexpected-argument` when one is given. `use` and `preview` require an identifier. An identifier is valid when it passes the library rule: 1 to 64 characters from `a-z` and `0-9`, with single hyphens only between characters, and not a Windows device name. Anything else fails with `invalid-id`. An unknown subcommand fails with `unknown-subcommand`, and no state changes.

Completion offers the subcommand names only. Profile identifiers need the catalog, and the completion callback is synchronous.

## Behavior by mode

| Mode | Empty input | `list` without argument | Other subcommands | Result channel |
| --- | --- | --- | --- | --- |
| `tui` | Opens the menu. | Opens the direct profile selector. Cancelling changes nothing. | Notice only. | `ui.notify` |
| `rpc` | Lists, without a dialog. | Lists, without a dialog. | Runs the subcommand. | Session entry through `pi.appendEntry`, plus `ui.notify` |
| `json` | Lists, without a dialog. | Lists, without a dialog. | Runs the subcommand. | Session entry through `pi.appendEntry`, plus `ui.notify` |
| `print` | Nothing runs. | Nothing runs. | Nothing runs. | None |

In the TUI the filtering of the list belongs to the host's select dialog. This package adds no search of its own. The empty-library menu render was checked in Pi 1.1.0; selection through the menu was tested with a simulated context, not in the real TUI.

Failures never throw. In `rpc` and `json` a failure is written as an entry with `kind: "failed"` and a diagnostic, and the notice has type `error`. A thrown error would be caught by the host and reported with exit status 0.

In `print` mode the handler returns without reading or writing anything. Text output has no result channel that reports a failure reliably.

Entries use the custom type `pi-assistant-prefill.selector`. Their `kind` field is `list`, `selected`, `off`, `status`, `preview`, `reloaded` or `failed`.

The mode is read from `ctx.mode`. The package does not use `ctx.hasUI` to decide whether a dialog is safe.

## Menu

A bare `/prefill` in the TUI always offers seven actions, even when the library is empty:

- Choose a profile (N available, or none yet)
- Preview a profile
- Show status of this session
- Turn prefill off
- Reload the library from disk
- How to add a profile
- Close

The dialog title shows a short summary, the pending choice or recorded disable, the library state (valid profiles and candidates left out, or an unusable library) and the library folder.

Choose and Preview open a second dialog with entries in the form `id: name — description`. Its `Back to the menu` entry returns to the main menu. With no valid profiles, either action shows a notice instead of opening a second dialog.

The menu only reads the library; it never writes to it. Choosing a profile or turning prefill off records the choice outside the library, as described in [Recorded state](#recorded-state).

## PI_PREFILL_OFF

Only `use` and `status` read this variable. `list`, `off`, `preview` and `reload` do not.

| Value | Meaning | `use` | `status` |
| --- | --- | --- | --- |
| `1` | Disabled by the environment. | Records the choice. | Shows the environment disable. |
| `0` or unset | Inactive. | Records the choice. | Shows nothing extra. |
| Any other value | Unsupported. | Fails with `configuration/environment-invalid`, writes nothing, and the previous state stays. | Shows that the value is unsupported. |

`off` records the disable whatever the variable holds. An unsupported value blocks new selections, as the library's resolution rules do; an explicit off is the only write that still works.

## Agent directory

The agent directory comes from `PI_CODING_AGENT_DIR`. The profile library is `<agent-dir>/prefills`, and the plugin state is `<agent-dir>/pi-assistant-prefill`.

| `PI_CODING_AGENT_DIR` | Result |
| --- | --- |
| Unset or empty | `<home>/.pi/agent`. |
| `~`, `~/...` or `~\...` | Expands to the home directory. |
| Absolute path, such as `C:\agent` or `\\server\share\agent` | Used as it is. On other platforms `/opt/agent` is used as it is too. |
| `~user/...` | Fails. Use an absolute path. |
| `/c/...` form on Windows | Fails. Use an absolute path; the value is not converted. |
| `file://...`, a relative path or any other value | Fails. Use an absolute path. |

A failure appears in every subcommand except `print`, through the same channels as any other failed result. The value itself is not echoed.

Pi 1.1.0 also normalizes forms that this package does not accept. This rule covers only the subset in the table. When a package phase declares Pi as a dependency, it must replace this rule with the public `getAgentDir()` function and check the table again.

## Manual isolated check

The automated suite does not start Pi. This procedure does, against an installed Pi, with a temporary agent directory and a synthetic profile.

1. Create a temporary directory. Inside it, create `agent\prefills\<id>\` with `profile.json`, `user.md` and `assistant.md`. Use synthetic text only.
2. Set `PI_CODING_AGENT_DIR` to the Windows path of `<temporary>\agent`. In Git Bash also set `MSYS_NO_PATHCONV=1`, so the value reaches Node unchanged.
3. Load the extension from `src/index.ts` with no other extensions, sessions, MCP servers or context files:

   ```sh
   pi --mode json -p -ne -e <path-to>/src/index.ts -nc -ns -np --no-mcp --offline -na --no-session "/prefill status"
   pi --mode json -p -ne -e <path-to>/src/index.ts -nc -ns -np --no-mcp --offline -na --no-session "/prefill use <id>"
   pi -p -ne -e <path-to>/src/index.ts -nc -ns -np --no-mcp --offline -na --no-session "/prefill use <id>"
   ```

4. Check RPC command registration and one command at a time:

   ```sh
   { printf '%s\n' '{"id":"1","type":"get_commands"}'; sleep 4; \
     printf '%s\n' '{"id":"2","type":"prompt","message":"/prefill status"}'; sleep 4; \
     printf '%s\n' '{"id":"3","type":"prompt","message":"/prefill use <id>"}'; sleep 4; \
   } | pi --mode rpc -ne -e <path-to>/src/index.ts --no-session -nc -ns -np --no-mcp --offline -na
   ```

What to observe:

- RPC: the response to `get_commands` lists a command named `prefill`.
- RPC and JSON: each command writes one `entry_appended` line with custom type `pi-assistant-prefill.selector`. `status` gives `kind: "status"` and `use` gives `kind: "selected"`.
- Text mode (`-p` without `--mode json`): no output on stdout or stderr, exit status 0, and no state written by `use`.
- No line whose type starts with `agent_`, `message_`, `turn_` or `tool_`.
- After `use`, `<temporary>\agent\pi-assistant-prefill\selection.json` holds the identifier. The library directory is unchanged.

Delete the temporary directory afterwards. The last run of this procedure, on 2026-10-13, produced those results with a synthetic profile. Its JSON runs also showed that an `/c/...` value was refused with `agent-directory-unsupported`.

## Recorded state

The choice is stored in `<agent-dir>/pi-assistant-prefill/selection.json`, outside the profile library:

```json
{
  "schemaVersion": 1,
  "profileId": "brief-example",
  "disabled": false
}
```

- `profileId` is a valid identifier or `null`.
- `disabled` is a boolean. `true` requires `profileId` to be `null`.
- A missing file or directory means no choice.
- Any other problem is a diagnostic: invalid JSON, duplicate keys, unknown or missing fields, a schema version other than `1`, a link that leads outside the directory, or a conflicting combination. The subcommands that change the state read it first and refuse to replace it. The file is left as it is.
- Writes go to a temporary file in the same directory, which is then renamed over `selection.json`. The previous file is not deleted first. The directory is created on the first write.

The state format has its own version, separate from the profile format in [profile-format.md](profile-format.md).

## Operational size threshold

When a selected profile's user and assistant messages together exceed 16 KiB (16,384 bytes), the selection is still recorded, and the notice reports the size. The threshold is an operational choice of this phase. It is not a limit of Pi, of any model or of any provider. Changing it is a deliberate decision for a later phase. The threshold only shapes the notice of the selection: the projection applies the profile whatever its size. The application record stores the size it applied (`combinedBytes`), and `/prefill status` shows that size in bytes, so a reader can compare it with 16,384 bytes. Nothing in the projection compares it with the threshold.

## Presentation escapes

Escapes change only how text is presented. Profile files and the stored selection keep the original text.

Labels (profile names and descriptions in lists and previews) escape these characters as `\uXXXX`, with four uppercase hexadecimal digits:

- U+2028 and U+2029, which break lines;
- the Unicode `Bidi_Control` characters, which reorder text on screen;
- the backslash, which is written as `\\`.

Preview bodies escape the same characters, plus every other C0 control except tab and line feed, DEL, and the C1 controls (U+0080 to U+009F). An ESC or an OSC sequence in a body therefore appears as text, such as `\u001B]0;title\u0007`, and is never sent to the terminal.

The escape is reversible. A body that literally contains `\u001B` is shown as `\\u001B`, and a real ESC is shown as `\u001B`. The tests read generated bodies and labels back and compare them with the original text. The state and the status output never contain body text.

## Limits and residual behavior

- Verified only as described in [Status and verification](#status-and-verification).
- The TUI list has not been run end to end. The filtering and the dialog's behavior belong to the host.
- After `preview` in RPC or JSON mode, the full escaped body is stored as an entry in the session transcript.
- A profile with CRLF line endings shows `\u000D` at each line end in a preview, because CR is escaped. The stored text is not changed.
- Invisible characters that are not bidirectional controls are not escaped: U+200B, U+FEFF, U+2060 to U+2064 and U+00AD. The contract does not require it.
- If `selection.json` is a symbolic link to a file inside the state directory, the rename replaces the link with a regular file. The former target is left unchanged.
- A crash between writing the temporary file and the rename can leave a `selection.json.<id>.tmp` file. It has no effect on the state.
- The TUI list offers the profiles even when `PI_PREFILL_OFF` has an unsupported value. Choosing one shows a failure notice and records nothing.
- In RPC, prompts sent without waiting for their responses can run out of order. The last completed write wins; each write is atomic.
- The state is read before each write. Another process that changes `selection.json` between that read and the rename is not detected.
- Tests that create symbolic links need the Windows privilege to create links (Developer Mode or an equivalent). Without it those tests fail, as [CONTRIBUTING.md](../CONTRIBUTING.md) explains.
- The application was tested with a simulated host only. No real provider has been used; see [projection.md](projection.md#limits-and-what-is-not-verified).
