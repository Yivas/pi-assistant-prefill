# pi-assistant-prefill

A planned Pi extension for selecting editable conversation examples, including assistant-role messages where supported.

**Status: profile library implemented, extension not implemented.** The repository contains a TypeScript library that reads and validates local profile files and resolves the selected example. It is not a Pi extension yet: it registers no command, changes no session and has no published package, installation command or verified Pi or provider compatibility. The file format and resolution rules are in [docs/profile-format.md](docs/profile-format.md).

## Scope

The intended workflow is to choose a local profile, start an eligible new session and see which example was applied. It will remain separate from Pi's system prompt and authentication. Assistant-role examples are supplied by the operator; they are not proof of a model's prior output and do not guarantee a particular response.

Personal profiles and conversation logs do not belong in this repository. No bundled runtime profiles are distributed; synthetic examples appear only in documentation and tests.

## Participation

This is a collaborative open-source project under the [MIT license](LICENSE). [Issues](https://github.com/Yivas/pi-assistant-prefill/issues) and pull requests are welcome for scope, documentation and future implementation proposals. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) first. No response time or release date is promised.

Report sensitive security issues through the [private reporting channel](https://github.com/Yivas/pi-assistant-prefill/security/advisories/new), not a public issue. See [SECURITY.md](SECURITY.md).
