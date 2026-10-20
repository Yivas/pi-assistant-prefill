# pi-assistant-prefill

A Pi extension for selecting editable conversation examples, including assistant-role messages where supported.

**Status: Pi extension published as `pi-assistant-prefill`.** The repository contains the TypeScript source of the extension, the profile library it reads and the command documentation in [docs/selector.md](docs/selector.md). The command lists profiles, records a choice or an explicit disable, shows the recorded state, previews a profile and reloads the catalog. The extension is enabled for non-virtual models: when a new session starts with an empty branch on a selected model whose API is not `pi-virtual`, the chosen example is sent in front of the conversation under the conditions in [docs/projection.md](docs/projection.md). The selection can be a recorded choice, a binding for the selected provider and model, or the configured default. The example is sent when the selection resolves to a profile, `PI_PREFILL_OFF` is not 1, and the profile still matches its recorded revision. Only Create and Edit in the TUI menu write profile files, and only Manage bindings writes the library configuration. Requests were checked against local doubles of an Anthropic endpoint and of an OpenAI-compatible endpoint; no real provider has been used, so which providers accept the projection is unproven. [docs/compatibility.md](docs/compatibility.md) records each case.

Install it with `pi install npm:pi-assistant-prefill@0.1.2`; Pi 1.1.0 loads the extension from the package and the command becomes available. The automated tests call the command with a simulated context and do not start Pi. The structural types match the Pi 1.1.0 declarations as checked with the TypeScript compiler from a temporary directory; that check is not part of `npm run check` (see [docs/projection.md](docs/projection.md)). One manual run against an installed Pi 1.1.0 on Windows with Node.js 24.9.0 is described in [docs/selector.md](docs/selector.md); no other Pi version, platform or model provider was checked. [docs/compatibility.md](docs/compatibility.md) records each case that was checked, the evidence behind it and what remains unproven. The file format and resolution rules are in [docs/profile-format.md](docs/profile-format.md). Released versions and their notes are listed in [CHANGELOG.md](CHANGELOG.md) and in the [releases page](https://github.com/Yivas/pi-assistant-prefill/releases).

## Scope

The intended workflow is to choose a local profile, start an eligible new session and see which example was applied. It will remain separate from Pi's system prompt and authentication. Assistant-role examples are supplied by the operator; they are not proof of a model's prior output and do not guarantee a particular response.

Personal profiles and conversation logs do not belong in this repository. No bundled runtime profiles are distributed; synthetic examples appear only in documentation and tests.

## Participation

This is a collaborative open-source project under the [MIT license](LICENSE). [Issues](https://github.com/Yivas/pi-assistant-prefill/issues) and pull requests are welcome for scope, documentation and future implementation proposals. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) first. No response time or release date is promised.

Report sensitive security issues through the [private reporting channel](https://github.com/Yivas/pi-assistant-prefill/security/advisories/new), not a public issue. See [SECURITY.md](SECURITY.md).
