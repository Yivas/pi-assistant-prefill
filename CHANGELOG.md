# Changelog

## 0.1.1

### Added

- Searchable TUI menu with profile creation and editing through the host's input and editor dialogs.

### Changed

- A bare `/prefill` opens the menu in the TUI. `/prefill list` keeps the direct profile selector.

## 0.1.0

First release of the extension source.

- Read-only profile library: catalog, per-profile manifest and texts, global configuration and resolution, with limits and diagnostics documented in [docs/profile-format.md](docs/profile-format.md).
- `/prefill` command: list, use, off, status, preview and reload, with a per-mode contract and presentation escaping, documented in [docs/selector.md](docs/selector.md).
- Application of the chosen profile to a new eligible session: request-context projection, per-branch records, eligibility and compatibility rules, documented in [docs/projection.md](docs/projection.md).
- Manual verification harness and the case-by-case status in [docs/compatibility.md](docs/compatibility.md), including what remains unproven.

No behaviour against a real model provider has been verified.
