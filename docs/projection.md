# Applying a profile to new sessions

The `/prefill` command records a profile choice (see [selector.md](selector.md)). This document describes how the chosen profile is projected into a session: when, what the model receives, what the session records, and what is not checked.

Status: implemented as event handlers in `src/projection.ts`, `src/session-state.ts` and `src/index.ts`, and tested with a simulated host. No real provider was used, and the automated suite does not start Pi. The manual Pi run in [selector.md](selector.md) loads the extension but cannot generate a turn without a provider.

## What "projected" means

The package adds a user message and an assistant message from the profile in front of the conversation, in the request only. The session transcript never stores them. A record in the session says that the package projected the example and that the request then completed. It does not say that the provider received the example, that the model used it, or that any later handler left it in place. No inclusion is guaranteed.

## When an example is projected

A new application starts only when all of these hold:

- the branch has no conversation (see [Eligibility](#eligibility));
- the selection resolves to a profile, using the library's rules: a recorded choice, a binding for the selected provider and model, or else the configured default. `PI_PREFILL_OFF=1`, a recorded explicit off, or no profile means nothing is projected;
- the selected model is not a virtual one (see [Compatibility](#compatibility));
- the profile reads and matches the revision recorded in the application record (see [Revision](#revision)).

A continued application needs only the revision and an eligible selection. A committed application keeps projecting in its branch while the profile is unchanged and the selection stays eligible.

## Eligibility

The turn state is judged once, when `before_agent_start` runs. Pi persists the user prompt later, so the prompt is not in the branch at that moment. A branch is eligible when it holds no conversation: system messages, custom entries, model changes and thinking-level changes do not count. User and assistant messages, custom messages, compactions and non-empty branch summaries do.

Two defenses keep an earlier eligibility from applying to a later run:

- the turn state lasts only for its run: `agent_end` resets it, so a run without `before_agent_start` has no eligibility;
- at the moment of projection, the request must be fresh: no assistant message, and at most one message that is not system (the prompt). A transcript that already holds a conversation never takes the pair.

Both defenses are tested separately. A message from another extension that Pi places in the first request (`nextTurn`) is not part of the eligibility rule; it is a message in the request, so the freshness check refuses the start when it is present.

## Order and position

The projection works on the messages Pi passes to the `context` event, which exclude the system prompt. The pair goes after any system messages that open the list, never in front of them:

```text
[leading system messages]  user example, assistant example  conversation...
```

The last message of the request stays the one Pi built, so the example never ends a request. Each message of the pair holds a single text block. The assistant message of the pair records the selected model's provider, API and id, with zero usage, because no provider produced it.

## Records

The package writes custom entries. Their data never contains profile text.

| Entry type | Phase or reason | Written when |
| --- | --- | --- |
| `pi-assistant-prefill.application` | `intent` | Before the first projected request of a new application. |
| `pi-assistant-prefill.application` | `projected` | Once, in the same handler, when the request is projected. |
| `pi-assistant-prefill.application` | `committed` | At the `turn_end` boundary of the first completed response (no error, no abort) of a request that carried the example, whatever the destination of that response. |
| `pi-assistant-prefill.diagnostic` | a reason from the list below | When an expected failure refuses a request. |

An application record holds `schemaVersion`, `phase`, `applicationId` (a random UUID per application), `profileId`, `revision` and `combinedBytes` (the length of the two texts in UTF-8 bytes). It also holds the provenance of the decision: `source` (`manual`, `binding` or `default`), `bindingId` (the rule that won, or `null`), and the `provider` and `model` identifiers the selection carried. Those four fields are optional in the stored format, and a record written before they existed reads with each one as `null`. The `revision` is a SHA-256 digest of the three profile files, so it is a summary of their content, and it is stored in the session file.

A branch holds at most one application, and its phases must follow `intent`, `projected`, `committed` for one identifier. Any other order, a second identifier, an unknown field or a value outside the format makes the branch `invalid`: nothing is projected into it, and `/prefill status` says so.

Diagnostic reasons: `invalid-record`, `selection-incompatible`, `library-failed` (with the library's category and code), `profile-unavailable` (with the category and code when the files cannot be read) and `revision-mismatch`. A branch written by 0.1.x can also hold `destination-not-anthropic`: nothing writes it any more, and the value is still read so those branches stay readable instead of turning invalid.

The state is read from the active branch only. Nothing is written when a session starts, and the state is derived again on `session_start` and `session_tree`, so a restart does not duplicate records.

## Revision

The revision covers the raw bytes of `profile.json`, `user.md` and `assistant.md`, each file contributing its name and length before its bytes. The texts projected are decoded from those same bytes. Every continued request re-reads the three files and compares the revision. A different revision, a missing profile or unreadable files stop the projection for that request and write a diagnostic. Nothing is stored that would keep it stopped: the next request checks again.

The check is made at the time of the request. A change to the profile after the check and before the provider reads the request is not detected. A formatting change to `profile.json` counts as a change even when the example text stays the same.

## Commitment and cache warming

The commitment is the only record that changes behavior across requests. It means that the package projected the example in a request and that the response completed. It does not mean that the provider received the example.

An application that is only intended or projected, but not committed, stays pending on its branch. A later run does not resume it, and it does not start a new application on that branch either: while the branch holds a pending application, later requests on that branch carry no example and write no record. A retry within the same run does continue it. Nothing clears the pending state by time or by a restart. A new application can start only on a branch that does not hold this application's records, for example a branch from before its intent record. `/prefill status` reports the pending state and says that no new application starts on the branch.

While an application is pending (intent or projection without commitment), the package stops every cache refresh decision. The design of this phase stopped refreshes only while the intent alone existed. Stopping during the whole pending state is more conservative. It is a deliberate deviation: a pending application has no commitment, so keeping a warm refresh would not be backed by any record.

After the commitment, a warm refresh decision is left alone and counted. The count is of decisions made by `cache_warming_decision`, not of requests the provider actually received. It lives in memory, per application, so reloading Pi resets it, and it is shown by `/prefill status`.

## The selected model

The compatibility of a request is decided by the selection: the model the user chose, with its provider and its model identifier. The models a provider rule or a model rule matches are those identifiers, as Pi's registry writes them.

Pi converts the messages of a request into the protocol of the provider it dispatches to, so the example is sent in whatever shape that provider expects. The rule therefore does not name a protocol or an endpoint: an Anthropic model and a model of another provider are both eligible, and a router that Pi exposes as a physical model is eligible too.

## Changes after the commitment

Turning the profile off, choosing another profile, or changing the model affects only later requests:

- the committed example of a branch stays in its branch and continues to be projected while the profile matches its revision;
- a virtual selected model (see [Compatibility](#compatibility)) sends the request without the example and writes a diagnostic;
- changing the model of a committed branch sends the same prefix to the new provider. The commitment and its provenance stay as recorded: they describe the decision that applied the example, not the destination of later requests;
- a changed profile, or a profile that cannot be read, sends the request without the example and writes a diagnostic.

## Compatibility

The selection decides eligibility, and a selected model is eligible when its API is not `pi-virtual`. Pi gives that API to its virtual models, which it routes itself instead of sending them to a provider of their own, and it does not export the constant. Every physical model of every provider is eligible, whatever protocol it speaks.

Pi converts the conversation into the protocol of the selected provider, so the example travels with the request instead of being written for one provider's format. What the package does not do is check the endpoint behind a provider label: the rule compares the provider and model identifiers of the selection, never the destination of a response.

Disabling the example with `PI_PREFILL_OFF` or with an explicit off stops new applications. It does not retract a pair already sent in requests of this branch.

## Status

`/prefill status` reports the application state of the current branch, after the pending choice and the disable with its origin:

- none: no application in this branch;
- not committed yet: the application identifier, the revision and the size;
- committed: the same metadata, the warm refresh decisions counted, the provenance stored in the record (a line of its own: a chosen profile, a binding with its identifier, the configured default, or `not recorded` for a record from an earlier version) and, when the record carries them, the provider and model of the selection;
- invalid: the records cannot be read, so nothing is projected;
- indeterminate: the command received no session, for example in a mode without one.

Status shows the revision recorded in the branch. It does not compare that revision with the current files. It never shows profile text.

## Failures and diagnostics

Expected failures are never thrown. The handler writes a diagnostic entry and sends the request without the example. An unexpected error is not caught here, and the host reports it.

The same diagnostic is not written twice in a row. A refusal that comes back after a different reason, or after a clean request, is written again only if a different diagnostic was written in between. A condition that clears and returns without any other diagnostic in between is recorded once. That is a limit of the current rule.

If the host does not resolve the identifier of the assistant message at `turn_end`, Pi does not call the handler. The application then stays pending, and nothing retries it. The same holds for any failure that prevents the commitment write.

## Verification

The automated suite (`npm run check`) covers, with a simulated host and temporary libraries:

- eligibility on empty, conversational, and system-or-custom-only branches;
- placement after leading system messages, and that the last message of the request is unchanged;
- the commitment after a completed projected request, the request really carrying the pair, pair text blocks only, no profile text in records, no commitment on error or abort, retries within a run, and no second commitment;
- continuity after a restart, branch navigation, and that session start writes nothing;
- revision mismatch and a deleted profile, each reported once, with projection resumed after a revert;
- a virtual selection, refused with a diagnostic, at the start of an application and on a committed branch;
- an application that a binding chose for a model of another provider, with the binding identifier and the provider and model recorded as its provenance;
- the state reported to `/prefill status`: none, not committed, committed with its provenance, a record written before the provenance fields, and invalid;
- the eligibility judged at the start of the turn, separately from the freshness check: a branch that holds a conversation is not eligible even when the request holds only the prompt;
- the cache warming stop while pending, and the decision count after the commitment;
- a turn that ends and a run without `before_agent_start`, and a transcript that already holds a conversation;
- an invalid application record, refused and reported;
- unusable library root and unreadable selection, reported as diagnostics without throwing;
- no change to the library bytes and no network or process calls.

Not covered by the automated suite:

- a real Pi runtime, a real provider, or a turn generated by Pi (the event order is taken from Pi 1.1.0's source and declarations, and the tests reproduce it with a host double);
- the removal of the pair by another `context` handler;
- messages from other extensions in the first request;
- a profile changed between the check and the provider reading the request;
- an assistant identifier that the host does not resolve at `turn_end`.

Manual checks with Pi 1.1.0 run outside the suite, in `test/harness/`: the outbound boundary of the first projected request, the interruption of the host before and after the commitment, the atomicity of the selection state, a manual compaction, the cache warming refresh and the export of a session with known state. The pending stop of the cache warming is covered by a unit test, because the end-to-end path cannot tell it apart on this host. They use a local double of the provider endpoint, so they do not show compatibility with a real provider or that a model used the example; the warming economics are synthetic. The JSONL export is interactive only and has manual steps, not an automated check. The procedure and the limits are in [verification-harness.md](verification-harness.md).

Type compatibility with Pi 1.1.0 was checked with the TypeScript compiler against Pi's own declarations, outside the repository and without adding a dependency. The check is not part of `npm run check`. The procedure:

1. Create a temporary directory outside the repository, with a `tsconfig.json` that repeats the compiler options of the repository's `tsconfig.json` (`strict`, `NodeNext`, `verbatimModuleSyntax`, `exactOptionalPropertyTypes`, `skipLibCheck`) and lists two files.
2. In the first file, import `ExtensionFactory` and `ExtensionAPI` from the Pi package's `dist/index.d.ts`, and the default export of `src/index.ts`. Assign the default export to an `ExtensionFactory` value.
3. In the second file, import the Pi handler types for `session_start`, `session_tree`, `before_agent_start`, `agent_end`, `context`, `turn_end` and `cache_warming_decision`, and assign to each one a function that calls the matching method of a `PrefixProjection` value, with no cast.
4. Run the repository's own compiler: `node_modules/.bin/tsc -p <that tsconfig>`.

The result recorded for Pi 1.1.0 is exit code 0. A negative control, one handler that returns `{ role: "user" }` as a message, fails with `TS2322`. The compiler therefore checks the handler signatures and the factory acceptance. It does not check the runtime values built for the example pair, which follow the message types only by construction, and it does not check the runtime order of events.

## Limits

- The profile pair travels in the request that applies it and in every later request of that branch, so its whole text is sent again on each turn. A large profile costs that content every time, and the recorded size in bytes is what the state shows.
- Whether Pi's own usage and context display counts the injected messages was not checked. Do not read those figures as proof that the example is or is not counted.
- The 16 KiB figure is a selection-time advisory only: choosing a profile above it reports the size, and the projection records the applied size, but nothing enforces the threshold.
- No real provider was used. The behavior described here is tested with a host double.
- Only Pi 1.1.0 was read and checked. Other versions are not checked.
- Another `context` handler, running after this one, can remove the pair. The commitment does not change in that case.
- The revision is a digest of the file content, stored in the session file. It is a summary, not the content.
- Messages from other extensions in the first request (`nextTurn`) are not part of the eligibility rule, and the freshness check refuses the start when they are present.
- The eligibility rule reads the provider label and the API of the selected model, not the endpoint behind it, so a change of endpoint under the same label is not detected.
- The warm refresh counts live in memory and are lost when Pi reloads.
- If the host does not resolve the assistant identifier at `turn_end`, the application stays pending with no retry.
- A profile changed between the revision check and the provider's reading of the request is not detected.
- A compaction cut can land on the `committed` record of an application. Pi's cut search walks back over entries that carry no messages, and that record has none, so it becomes the first kept entry. Pi then builds the summary as a split-turn summary (`No prior history. ... (split turn)`). The request that follows is still correct: the pair goes once in front of the compaction summary, and the kept turns follow. The records are not sent to the model, so the contract does not require them to be outside the cut. Nothing in the projection avoids this without changing where the records are stored: every entry on the branch takes part in Pi's context projection, and the cut search skips any entry without messages in the same way. The observed behaviour is recorded in [verification-harness.md](verification-harness.md#compaction-compactionmjs).
