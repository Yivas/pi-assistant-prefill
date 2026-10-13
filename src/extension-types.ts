// Structural subset of the Pi 1.1.0 extension API, declared here so the package does not import
// Pi. Only the members that src/index.ts and src/selector.ts use are listed. Each one is a subset
// of the matching declaration in dist/core/extensions/types.d.ts of Pi 1.1.0, so Pi's own types
// accept what this package passes. That does not establish compatibility with other Pi versions;
// see docs/selector.md.

export type PiExtensionMode = "tui" | "rpc" | "json" | "print";

export type PiNoticeType = "info" | "warning" | "error";

export interface PiCommandUi {
  notify(message: string, type: PiNoticeType): void;
  select(title: string, options: readonly string[]): Promise<string | undefined>;
}

export interface PiCommandContext {
  readonly mode: PiExtensionMode;
  readonly ui: PiCommandUi;
}

export interface PiArgumentCompletion {
  readonly value: string;
  readonly label: string;
}

export interface PiCommandRegistration {
  readonly description: string;
  getArgumentCompletions(argumentPrefix: string): readonly PiArgumentCompletion[] | null;
  handler(argumentText: string, context: PiCommandContext): Promise<void>;
}

export interface PiExtensionApi {
  // Lives on the extension API, not on the command context: in Pi 1.1.0 `context.appendEntry` is
  // undefined, so calling it from a handler fails with an extension error.
  appendEntry(customType: string, data?: unknown): void;
  registerCommand(name: string, command: PiCommandRegistration): void;
}
