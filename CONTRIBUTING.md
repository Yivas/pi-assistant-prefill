# Contributing

Issues and pull requests are welcome. The repository contains a profile library in development. It is not an executable Pi extension, and there is no supported Pi baseline yet.

Use the issue forms for a concrete problem or proposal. Search existing issues first. Describe the affected repository revision, your goal, expected result and what you observed. For implementation proposals, explain the public Pi API you would use and how its behavior could be checked; do not claim compatibility without evidence.

## Development checks

Install dependencies with scripts disabled. The lockfile has no install scripts, and the project does not need them.

```sh
npm ci --ignore-scripts
npm run check
```

`npm run check` runs formatting, lint, type checking and the test suite. Its parts are available separately:

| Command | Purpose |
| --- | --- |
| `npm run format:check` | Biome formatting check |
| `npm run lint` | Biome lint |
| `npm run typecheck` | TypeScript type check, no output files |
| `npm test` | Node.js test runner on the `.ts` test files |

The tools are pinned in `package.json`. The verified environment is Node.js 24.9.0 with npm 11.6.2. Node.js runs the TypeScript sources directly, so other Node.js versions are not verified. Tests create their own temporary directories and do not read personal profiles, configuration or sessions. Some tests create directory and file symbolic links. On Windows, creating a file link requires Developer Mode or a process that holds the symbolic link privilege. Without it those tests fail and are not skipped. The project does not elevate privileges or change system settings automatically.

Report only checks you actually ran, with their results. Code changes must pass `npm run check` before review.

## Pull requests

Keep pull requests focused. Describe motivation, changed behavior or text, checks actually run and remaining limitations. Documentation-only changes should check links, accuracy and privacy.

Do not submit personal profiles, prompts, session logs, credentials, private configuration or machine-specific paths. Synthetic examples must be clearly identified. Security reports belong in the [private channel](https://github.com/Yivas/pi-assistant-prefill/security/advisories/new), following [SECURITY.md](SECURITY.md).

Contributions must be compatible with [MIT](LICENSE). Preserve required third-party notices and explain the origin of any incorporated material. No CLA or DCO is required at this stage. Participation follows the [Code of Conduct](CODE_OF_CONDUCT.md). Review and release schedules are not guaranteed.
