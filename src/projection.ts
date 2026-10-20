import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { isRegistryIdentifier, type ProfileModelKey, resolveProfile } from "./config.ts";
import { type ProfileDiagnostic, ProfileFailure } from "./diagnostic.ts";
import type {
  PiAssistantMessage,
  PiBoundaryDraft,
  PiBoundaryResult,
  PiCacheWarmingDecisionEvent,
  PiCacheWarmingDecisionResult,
  PiContextEvent,
  PiContextEventResult,
  PiCustomEntryDraft,
  PiEventContext,
  PiMessage,
  PiModel,
  PiReadonlySessionManager,
  PiTurnEndEvent,
  PiUsage,
  PiUserMessage,
} from "./extension-types.ts";
import { decodeUtf8, readRegularFileWithin, resolveRootDirectory } from "./file-read.ts";
import type { SelectorOptionsResolution } from "./index.ts";
import { readSelection } from "./selection.ts";
import type { SelectorOptions } from "./selector.ts";
import {
  APPLICATION_ENTRY_TYPE,
  type ApplicationRecord,
  type ApplicationSource,
  type ApplicationStatus,
  applicationData,
  type BranchPrefixState,
  CurrentLeafState,
  DIAGNOSTIC_ENTRY_TYPE,
  diagnosticData,
  hasConversation,
  lastDiagnostic,
  type PrefixDiagnostic,
  sameDiagnostic,
} from "./session-state.ts";
import { MAX_JSON_DOCUMENT_BYTES } from "./strict-json.ts";

// Byte limits of docs/profile-format.md. The library keeps them private, so they are repeated here.
const MAX_TEXT_FILE_BYTES = 65536;
// The API Pi gives to a virtual model. Such a model is routed by Pi itself and is not a provider the
// example can be sent to, so it never starts an application. Pi does not export the constant.
const VIRTUAL_MODEL_API = "pi-virtual";

export interface PrefixProjectionOptions {
  readonly resolveOptions: () => SelectorOptionsResolution;
  readonly appendEntry: (customType: string, data: unknown) => void;
}

// The run that one prompt starts. Eligibility is judged when the run begins, because Pi persists the
// prompt after before_agent_start (agent-session.js: the prompt is recorded on message_end). The
// state never outlives its run: agent_end resets it, and a run that has no before_agent_start has
// no eligibility at all.
interface TurnState {
  eligible: boolean;
  applicationId: string | null;
  projectedRequest: boolean;
}

const NO_TURN: TurnState = { eligible: false, applicationId: null, projectedRequest: false };

interface AppliedContent {
  readonly userText: string;
  readonly assistantText: string;
  readonly revision: string;
  readonly combinedBytes: number;
}

// The projection of one profile into requests. The handlers keep no state of their own beyond the
// turn and the refresh decision counts; the application state is read from the branch on every
// decision.
export class PrefixProjection {
  private readonly options: PrefixProjectionOptions;
  private readonly currentLeaf = new CurrentLeafState();
  private readonly refreshDecisions = new Map<string, number>();
  private turn: TurnState = { ...NO_TURN };

  constructor(options: PrefixProjectionOptions) {
    this.options = options;
  }

  // session_start and session_tree: the branch may be a different one, so the state is derived again.
  reset(): void {
    this.currentLeaf.reset();
    this.turn = { ...NO_TURN };
  }

  // agent_end: the run is over, so its eligibility and its pending application end with it.
  endRun(): void {
    this.turn = { ...NO_TURN };
  }

  beginTurn(context: PiEventContext): void {
    const state = this.currentLeaf.of(context.sessionManager);
    const eligible = state.kind === "none" && !hasConversation(context.sessionManager.getBranch());
    this.turn = { eligible, applicationId: null, projectedRequest: false };
  }

  // Pi passes the conversation without system messages and restores them afterwards, so the pair
  // only needs to go in front of the conversation. The selection is read first, before any await:
  // the handler does not depend on the model still being the same once a read has completed.
  async projectContext<M extends PiMessage>(
    event: PiContextEvent<M>,
    context: PiEventContext,
  ): Promise<PiContextEventResult<M> | undefined> {
    const selection = eligibleSelection(context.model);
    if (!event.messages.some((message) => message.role !== "system")) return undefined;
    const state = this.currentLeaf.of(context.sessionManager);
    switch (state.kind) {
      case "invalid":
        return this.refuse(context, { reason: "invalid-record", profileId: null, detail: null });
      case "none":
        return this.startApplication(event, context, selection);
      case "pending":
      case "committed":
        return this.continueApplication(event, context, state, selection);
    }
  }

  // Runs after the assistant message of a request is persisted. The example is committed only by the
  // first completed response of a request that carried it, and only through this boundary.
  endTurnBoundary<D extends PiBoundaryDraft>(
    event: PiTurnEndEvent<D>,
    context: PiEventContext,
  ): PiBoundaryResult<D> | undefined {
    const projected = this.turn.projectedRequest;
    this.turn.projectedRequest = false;
    const state = this.currentLeaf.of(context.sessionManager);
    if (state.kind !== "pending" && state.kind !== "committed") return undefined;

    const drafts = boundaryDrafts(event, state, projected);
    return drafts.length === 0 ? undefined : { entries: [...event.entries, ...drafts] };
  }

  // While no commitment exists, every refresh decision is stopped. After the commitment a warm
  // decision is left alone and counted; the count is of decisions, not of requests actually sent.
  decideCacheWarming(
    event: PiCacheWarmingDecisionEvent,
    context: PiEventContext,
  ): PiCacheWarmingDecisionResult | undefined {
    const state = this.currentLeaf.of(context.sessionManager);
    if (state.kind === "pending") return { action: "stop" };
    if (state.kind === "committed" && event.action === "warm") {
      const applicationId = state.application.applicationId;
      this.refreshDecisions.set(applicationId, this.decisionCountOf(applicationId) + 1);
    }
    return undefined;
  }

  // What `/prefill status` reports about the branch: the record metadata with the provenance it was
  // written with, and the warm refresh decisions counted for the application.
  describeApplication(sessionManager: PiReadonlySessionManager): ApplicationStatus {
    const state = this.currentLeaf.of(sessionManager);
    switch (state.kind) {
      case "none":
        return { kind: "none" };
      case "invalid":
        return { kind: "invalid" };
      case "pending":
      case "committed": {
        const { application } = state;
        return {
          kind: state.kind,
          applicationId: application.applicationId,
          profileId: application.profileId,
          revision: application.revision,
          combinedBytes: application.combinedBytes,
          source: application.source,
          bindingId: application.bindingId,
          provider: application.provider,
          model: application.model,
          refreshes: this.decisionCountOf(application.applicationId),
        };
      }
    }
  }

  private decisionCountOf(applicationId: string): number {
    return this.refreshDecisions.get(applicationId) ?? 0;
  }

  private async startApplication<M extends PiMessage>(
    event: PiContextEvent<M>,
    context: PiEventContext,
    selection: PiModel | null,
  ): Promise<PiContextEventResult<M> | undefined> {
    // Two defenses against a stale or misplaced eligibility: the turn must be eligible, and the
    // transcript of this request must still be empty. A run that Pi starts without before_agent_start
    // has no eligible turn; a transcript that already holds a conversation never takes the pair.
    if (!this.turn.eligible) return undefined;
    if (!isFreshTranscript(event.messages)) return undefined;

    const resolution = this.options.resolveOptions();
    if (resolution.kind === "failed") {
      return this.refuse(context, libraryFailure(resolution.diagnostic));
    }
    // The selection is the model of this session, resolved at the moment the application starts:
    // bindings name a provider and a model identifier, and no global default can stand in for them.
    const selected = await selectedProfile(resolution.options, context.model ?? null);
    if (selected.kind === "none") return undefined;
    if (selected.kind === "failed") return this.refuse(context, selected.diagnostic);
    if (selection === null) {
      return this.refuse(context, incompatibleSelection(selected.profileId));
    }
    // The record must stay readable, so a destination the configuration reader would reject never
    // becomes a stored application.
    if (!isRegistryIdentifier(selection.provider) || !isRegistryIdentifier(selection.id)) {
      return this.refuse(context, incompatibleSelection(selected.profileId));
    }
    const content = await this.loadContent(
      context,
      resolution.options.libraryRoot,
      selected.profileId,
      null,
    );
    if (content === null) return undefined;

    // Intent comes first, then the projection. If the write of the projected record fails, the
    // branch keeps only the intent, which never counts as a commitment.
    const application: ApplicationRecord = {
      applicationId: randomUUID(),
      profileId: selected.profileId,
      revision: content.revision,
      combinedBytes: content.combinedBytes,
      source: recordSource(selected.source),
      bindingId: selected.bindingId,
      provider: selection.provider,
      model: selection.id,
    };
    this.options.appendEntry(APPLICATION_ENTRY_TYPE, applicationData("intent", application));
    this.options.appendEntry(APPLICATION_ENTRY_TYPE, applicationData("projected", application));
    this.turn.applicationId = application.applicationId;
    return this.project(event, content, selection);
  }

  private async continueApplication<M extends PiMessage>(
    event: PiContextEvent<M>,
    context: PiEventContext,
    state: Extract<BranchPrefixState, { kind: "pending" | "committed" }>,
    selection: PiModel | null,
  ): Promise<PiContextEventResult<M> | undefined> {
    const { application } = state;
    // A pending application belongs to the run that wrote it. A later run does not resume it.
    if (state.kind === "pending" && application.applicationId !== this.turn.applicationId) {
      return undefined;
    }
    if (selection === null)
      return this.refuse(context, incompatibleSelection(application.profileId));
    const resolution = this.options.resolveOptions();
    if (resolution.kind === "failed") {
      return this.refuse(context, libraryFailure(resolution.diagnostic));
    }
    const content = await this.loadContent(
      context,
      resolution.options.libraryRoot,
      application.profileId,
      application.revision,
    );
    if (content === null) return undefined;
    return this.project(event, content, selection);
  }

  // Reads the profile once and checks the revision. Expected failures are refused with a diagnostic
  // and reported as null, so the caller sends the request without the example.
  private async loadContent(
    context: PiEventContext,
    libraryRoot: string,
    profileId: string,
    expectedRevision: string | null,
  ): Promise<AppliedContent | null> {
    let content: AppliedContent | null;
    try {
      content = await readAppliedContent(libraryRoot, profileId);
    } catch (error) {
      if (!(error instanceof ProfileFailure)) throw error;
      const detail = `${error.category}/${error.code}`;
      this.refuse(context, { reason: "profile-unavailable", profileId, detail });
      return null;
    }
    if (content === null) {
      this.refuse(context, { reason: "profile-unavailable", profileId, detail: null });
      return null;
    }
    if (expectedRevision !== null && content.revision !== expectedRevision) {
      this.refuse(context, { reason: "revision-mismatch", profileId, detail: null });
      return null;
    }
    return content;
  }

  // Marks the request as projected. The result keeps the host's messages as they are and adds the
  // pair in front of the conversation.
  private project<M extends PiMessage>(
    event: PiContextEvent<M>,
    content: AppliedContent,
    model: PiModel,
  ): PiContextEventResult<M> {
    this.turn.projectedRequest = true;
    return { messages: insertPrefixPair(event.messages, buildPrefixPair(content, model)) };
  }

  // Expected failures become a diagnostic entry and never a thrown error: the host would report an
  // error and send the request without any reason. An entry equal to the last diagnostic of the
  // branch is not written again, so a failure repeated on every request is recorded once. A reason
  // that returns after another reason, or after a clean request, is written again.
  private refuse(context: PiEventContext, diagnostic: PrefixDiagnostic): undefined {
    const branch = context.sessionManager.getBranch();
    if (!sameDiagnostic(lastDiagnostic(branch), diagnostic)) {
      this.options.appendEntry(DIAGNOSTIC_ENTRY_TYPE, diagnosticData(diagnostic));
    }
    return undefined;
  }
}

type SelectedProfile =
  | { readonly kind: "none" }
  | { readonly kind: "failed"; readonly diagnostic: PrefixDiagnostic }
  | {
      readonly kind: "selected";
      readonly profileId: string;
      readonly source: "choice" | "binding" | "default";
      readonly bindingId: string | null;
    };

// The selection is resolved with the library's own rules, so a binding, a default profile and
// PI_PREFILL_OFF behave as they do for /prefill.
async function selectedProfile(
  options: SelectorOptions,
  model: ProfileModelKey | null,
): Promise<SelectedProfile> {
  const selection = await readSelection(options.stateDirectory);
  if (selection.status === "failed") {
    return { kind: "failed", diagnostic: libraryFailure(selection.diagnostic) };
  }
  const resolution = await resolveProfile({
    libraryRoot: options.libraryRoot,
    environment: options.environment,
    choice: selection.choice,
    model,
  });
  switch (resolution.status) {
    case "selected":
      return {
        kind: "selected",
        profileId: resolution.profile.id,
        source: resolution.source,
        bindingId: resolution.source === "binding" ? resolution.bindingId : null,
      };
    case "off":
    case "none":
      return { kind: "none" };
    case "failed":
      return { kind: "failed", diagnostic: libraryFailure(resolution.diagnostic) };
  }
}

// The record keeps one vocabulary: a profile the operator chose is a manual one. The resolution calls
// that source a choice, because for the library a recorded choice and a binding are both a decision.
function recordSource(source: "choice" | "binding" | "default"): ApplicationSource {
  return source === "choice" ? "manual" : source;
}

// Reads the three files of a profile. The revision is computed from the same bytes that become the
// texts, so the example sent is exactly the content the revision describes. Returns null when the
// library root is absent. Expected problems surface as ProfileFailure from the library's reads.
async function readAppliedContent(
  libraryRoot: string,
  profileId: string,
): Promise<AppliedContent | null> {
  const realRoot = await resolveRootDirectory(libraryRoot);
  if (realRoot === null) return null;
  const manifest = await readProfileFile(
    realRoot,
    profileId,
    "profile.json",
    MAX_JSON_DOCUMENT_BYTES,
  );
  const user = await readProfileFile(realRoot, profileId, "user.md", MAX_TEXT_FILE_BYTES);
  const assistant = await readProfileFile(realRoot, profileId, "assistant.md", MAX_TEXT_FILE_BYTES);
  const userText = decodeUtf8(user.bytes);
  const assistantText = decodeUtf8(assistant.bytes);
  return {
    userText,
    assistantText,
    revision: revisionOf([manifest, user, assistant]),
    combinedBytes: Buffer.byteLength(userText) + Buffer.byteLength(assistantText),
  };
}

interface ProfileFile {
  readonly name: string;
  readonly bytes: Buffer;
}

async function readProfileFile(
  realRoot: string,
  profileId: string,
  name: string,
  maxBytes: number,
): Promise<ProfileFile> {
  const bytes = await readRegularFileWithin(
    realRoot,
    path.join(realRoot, profileId, name),
    maxBytes,
  );
  return { name, bytes };
}

// Each file contributes its name and length before its bytes, so the same bytes under two names
// cannot produce the same revision.
function revisionOf(files: readonly ProfileFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${file.name}\n${file.bytes.length}\n`);
    hash.update(file.bytes);
  }
  return hash.digest("hex");
}

// The pair as ordinary messages: the operator's user text, then the assistant text, each one a
// single text block. The assistant message records the selected model, so the request reads like a
// response from that model. No provider produced it, so its usage is zero.
function buildPrefixPair(
  content: AppliedContent,
  model: PiModel,
): [PiUserMessage, PiAssistantMessage] {
  const timestamp = Date.now();
  return [
    { role: "user", content: [{ type: "text", text: content.userText }], timestamp },
    {
      role: "assistant",
      content: [{ type: "text", text: content.assistantText }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp,
    },
  ];
}

// A transcript takes the pair only when it has no assistant message and at most one message that
// is not system: the prompt of the turn. Anything else already holds a conversation.
function isFreshTranscript(messages: readonly PiMessage[]): boolean {
  const conversation = messages.filter((message) => message.role !== "system");
  return conversation.length <= 1 && conversation.every((message) => message.role !== "assistant");
}

// The pair goes after the system messages that open the list, never in front of them. A list
// without system messages gets the pair at index zero.
function insertPrefixPair<M extends PiMessage>(
  messages: readonly M[],
  pair: readonly (PiUserMessage | PiAssistantMessage)[],
): (M | PiUserMessage | PiAssistantMessage)[] {
  const firstConversation = messages.findIndex((message) => message.role !== "system");
  const head = firstConversation === -1 ? messages.length : firstConversation;
  return [...messages.slice(0, head), ...pair, ...messages.slice(head)];
}

// The selection decides eligibility: any physical model Pi can dispatch passes, so the example
// travels to whatever provider the operator chose. A virtual model is excluded: Pi routes it itself
// and it is not a destination of its own.
function eligibleSelection(model: PiModel | undefined): PiModel | null {
  if (model === undefined) return null;
  return model.api === VIRTUAL_MODEL_API ? null : model;
}

// A completed response of a projected request commits the application whatever its destination.
function boundaryDrafts(
  event: PiTurnEndEvent,
  state: Extract<BranchPrefixState, { kind: "pending" | "committed" }>,
  projected: boolean,
): PiCustomEntryDraft[] {
  return projected && event.outcome === "completed" && state.kind === "pending"
    ? [customDraft(APPLICATION_ENTRY_TYPE, applicationData("committed", state.application))]
    : [];
}

function customDraft(customType: string, data: unknown): PiCustomEntryDraft {
  return { type: "custom", customType, data };
}

function libraryFailure(diagnostic: ProfileDiagnostic): PrefixDiagnostic {
  return {
    reason: "library-failed",
    profileId: diagnostic.profileId,
    detail: `${diagnostic.category}/${diagnostic.code}`,
  };
}

function incompatibleSelection(profileId: string): PrefixDiagnostic {
  return { reason: "selection-incompatible", profileId, detail: null };
}

function emptyUsage(): PiUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
