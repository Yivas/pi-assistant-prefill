# pi-assistant-prefill

A Pi extension for selecting editable conversation examples, including assistant-role messages where supported.

**Status: source of a Pi extension with the `/prefill` command; no published package.** The repository contains the TypeScript source of the extension, the profile library it reads and the command documentation in [docs/selector.md](docs/selector.md). The command lists profiles, records a choice or an explicit disable, shows the recorded state, previews a profile and reloads the catalog. It does not apply the chosen example to a session yet, and it changes no profile file or library configuration.

There is no published package and no command that installs the extension into Pi. The automated tests call the command with a simulated context and do not start Pi. The structural types match the Pi 1.1.0 declarations, checked by hand. One manual run against an installed Pi 1.1.0 on Windows with Node.js 24.9.0 is described in [docs/selector.md](docs/selector.md); no other Pi version, platform or model provider was checked. The file format and resolution rules are in [docs/profile-format.md](docs/profile-format.md).

## Scope

The intended workflow is to choose a local profile, start an eligible new session and see which example was applied. It will remain separate from Pi's system prompt and authentication. Assistant-role examples are supplied by the operator; they are not proof of a model's prior output and do not guarantee a particular response.

Personal profiles and conversation logs do not belong in this repository. No bundled runtime profiles are distributed; synthetic examples appear only in documentation and tests.

## Participation

This is a collaborative open-source project under the [MIT license](LICENSE). [Issues](https://github.com/Yivas/pi-assistant-prefill/issues) and pull requests are welcome for scope, documentation and future implementation proposals. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) first. No response time or release date is promised.

Report sensitive security issues through the [private reporting channel](https://github.com/Yivas/pi-assistant-prefill/security/advisories/new), not a public issue. See [SECURITY.md](SECURITY.md).
