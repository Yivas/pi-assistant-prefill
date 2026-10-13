// Structural subset of the Pi 1.1.0 extension API, declared here so the package does not import
// Pi. Only the members that src/index.ts, src/selector.ts and src/projection.ts use are listed. Each
// one is a subset of the matching declaration in dist/core/extensions/types.d.ts of Pi 1.1.0, so
// Pi's own types accept what this package passes. That does not establish compatibility with other
// Pi versions; see docs/selector.md and docs/projection.md.
//
// The `context` and `turn_end` shapes are generic in the message and draft types they receive.
// Pi's own unions (AgentMessage, SessionBoundaryDraft) therefore flow through unchanged, and only the
// records this package creates are typed here. See docs/projection.md for what the compiler checked.

export type PiExtensionMode = "tui" | "rpc" | "json" | "print";

export type PiNoticeType = "info" | "warning" | "error";

export interface PiCommandUi {
  notify(message: string, type: PiNoticeType): void;
  select(title: string, options: readonly string[]): Promise<string | undefined>;
}

export interface PiCommandContext {
  readonly mode: PiExtensionMode;
  readonly ui: PiCommandUi;
  // The session the command runs in. `status` reads the application state of its branch.
  readonly sessionManager: PiReadonlySessionManager;
}

export interface PiArgumentCompletion {
  readonly value: string;
  readonly label: string;
}

export interface PiCommandRegistration {
  readonly description: string;
  getArgumentCompletions(argumentPrefix: string): PiArgumentCompletion[] | null;
  handler(argumentText: string, context: PiCommandContext): Promise<void>;
}

// Event and session shapes used by src/projection.ts. They follow Pi 1.1.0: ContextEvent and
// ContextEventResult in dist/core/extensions/types.d.ts, SessionEntry in dist/core/session-manager.d.ts,
// and the pi-ai message types. The package does not import them, so only the members it reads or
// writes are listed.

export interface PiModel {
  readonly provider: string;
  readonly api: string;
  readonly id: string;
}

export interface PiSessionEntry {
  readonly type: string;
  readonly id: string;
  readonly parentId: string | null;
  readonly customType?: string;
  readonly data?: unknown;
  readonly message?: { readonly role: string; readonly provider?: string; readonly api?: string };
  readonly summary?: string;
}

export interface PiReadonlySessionManager {
  getBranch(): readonly PiSessionEntry[];
  getLeafId(): string | null;
}

// The context of an event handler. `model` is the selection, which may be a virtual model.
export interface PiEventContext {
  readonly model: PiModel | undefined;
  readonly sessionManager: PiReadonlySessionManager;
}

// The minimum a message must offer to be read by the projection: its role.
export interface PiMessage {
  readonly role: string;
}

export interface PiTextBlock {
  type: "text";
  text: string;
}

export interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface PiUserMessage {
  role: "user";
  content: PiTextBlock[];
  timestamp: number;
}

export interface PiAssistantMessage {
  role: "assistant";
  content: PiTextBlock[];
  api: string;
  provider: string;
  model: string;
  usage: PiUsage;
  stopReason: "stop";
  timestamp: number;
}

// `M` is the message type the host passes (Pi's AgentMessage). The projection returns the same
// objects, plus the example pair, so the result keeps the host's type.
export interface PiContextEvent<M extends PiMessage = PiMessage> {
  readonly type: "context";
  readonly messages: readonly M[];
}

export interface PiContextEventResult<M extends PiMessage = PiMessage> {
  messages: (M | PiUserMessage | PiAssistantMessage)[];
}

export interface PiSessionEvent {
  readonly type: "session_start" | "session_tree";
}

export interface PiBeforeAgentStartEvent {
  readonly type: "before_agent_start";
}

export interface PiAgentEndEvent {
  readonly type: "agent_end";
}

export interface PiCustomEntryDraft {
  readonly type: "custom";
  readonly customType: string;
  readonly data: unknown;
}

// A turn_end boundary draft. `D` is the draft type the host passes (Pi's SessionBoundaryDraft).
export interface PiBoundaryDraft {
  readonly type: string;
}

export interface PiTurnEndEvent<D extends PiBoundaryDraft = PiBoundaryDraft> {
  readonly type: "turn_end";
  readonly message: PiMessage & { readonly provider?: string; readonly api?: string };
  readonly outcome: "completed" | "aborted" | "error";
  readonly entries: readonly D[];
}

export interface PiBoundaryResult<D extends PiBoundaryDraft = PiBoundaryDraft> {
  entries: (D | PiCustomEntryDraft)[];
}

export type PiCacheWarmingAction = "warm" | "stop";

export interface PiCacheWarmingDecisionEvent {
  readonly type: "cache_warming_decision";
  readonly action: PiCacheWarmingAction;
}

export interface PiCacheWarmingDecisionResult {
  readonly action: PiCacheWarmingAction;
}

export interface PiExtensionApi {
  // Lives on the extension API, not on the command context: in Pi 1.1.0 `context.appendEntry` is
  // undefined, so calling it from a handler fails with an extension error.
  appendEntry(customType: string, data?: unknown): void;
  registerCommand(name: string, command: PiCommandRegistration): void;
  on(
    event: "session_start",
    handler: (event: PiSessionEvent, context: PiEventContext) => void,
  ): void;
  on(
    event: "session_tree",
    handler: (event: PiSessionEvent, context: PiEventContext) => void,
  ): void;
  on(
    event: "before_agent_start",
    handler: (event: PiBeforeAgentStartEvent, context: PiEventContext) => void,
  ): void;
  on(event: "agent_end", handler: (event: PiAgentEndEvent, context: PiEventContext) => void): void;
  on<M extends PiMessage>(
    event: "context",
    handler: (
      event: PiContextEvent<M>,
      context: PiEventContext,
    ) => Promise<PiContextEventResult<M> | undefined>,
  ): void;
  on<D extends PiBoundaryDraft>(
    event: "turn_end",
    handler: (event: PiTurnEndEvent<D>, context: PiEventContext) => PiBoundaryResult<D> | undefined,
  ): void;
  on(
    event: "cache_warming_decision",
    handler: (
      event: PiCacheWarmingDecisionEvent,
      context: PiEventContext,
    ) => PiCacheWarmingDecisionResult | undefined,
  ): void;
}
