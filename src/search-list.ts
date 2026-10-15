import type { PiCommandContext, PiKeybindings, PiTheme } from "./extension-types.ts";
import { renderMessage } from "./messages.ts";

// Adapted from Yivas's pi-prompt-profiles picker (MIT).
const MAX_VISIBLE = 10;

export interface MenuChoice {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly fallbackLabel?: string;
}

interface MenuRequest {
  readonly title: string;
  readonly subtitle?: string;
  readonly items: readonly MenuChoice[];
}

// Conservatively count non-ASCII-wide code points as two columns. Truncating a little
// early is preferable to Pi aborting a render because a line exceeds the terminal width.
function columnWidth(character: string): number {
  return (character.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1;
}

function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) width += columnWidth(character);
  return width;
}

function truncate(text: string, width: number): string {
  let result = "";
  let used = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    const safe = code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : character;
    const size = columnWidth(safe);
    if (used + size > width) break;
    result += safe;
    used += size;
  }
  return result;
}

class SearchList {
  private query = "";
  private selected = 0;

  private readonly request: MenuRequest;
  private readonly theme: PiTheme;
  private readonly keybindings: PiKeybindings;
  private readonly done: (value: string | undefined) => void;
  private readonly terminal: { readonly rows: number };

  constructor(
    request: MenuRequest,
    theme: PiTheme,
    keybindings: PiKeybindings,
    done: (value: string | undefined) => void,
    terminal: { readonly rows: number },
  ) {
    this.request = request;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
    this.terminal = terminal;
  }

  invalidate(): void {}

  private filtered(): readonly MenuChoice[] {
    const query = this.query.trim().toLowerCase();
    return this.request.items.filter(
      (item) =>
        item.label.toLowerCase().includes(query) ||
        (item.description ?? "").toLowerCase().includes(query),
    );
  }

  private visibleRows(): number {
    const rows = this.terminal.rows;
    if (!Number.isFinite(rows) || rows <= 0) return 3;
    const subtitleRows = this.request.subtitle?.split("\n").length ?? 0;
    return Math.max(1, Math.min(MAX_VISIBLE, Math.floor(rows) - 7 - subtitleRows));
  }

  render(width: number): string[] {
    const { theme } = this;
    const filtered = this.filtered();
    const lines = [theme.fg("accent", theme.bold(truncate(this.request.title, width)))];
    if (this.request.subtitle) {
      for (const line of this.request.subtitle.split("\n")) {
        lines.push(theme.fg("muted", truncate(line, width)));
      }
    }
    const prefix = truncate(renderMessage("menu.search.label"), width);
    const search = truncate(
      this.query || renderMessage("menu.search.placeholder"),
      Math.max(0, width - displayWidth(prefix)),
    );
    lines.push(`${theme.fg("muted", prefix)}${this.query ? search : theme.fg("dim", search)}`);
    lines.push("");
    const maxVisible = this.visibleRows();
    const start = Math.min(
      Math.max(this.selected - Math.floor(maxVisible / 2), 0),
      Math.max(0, filtered.length - maxVisible),
    );
    const end = Math.min(filtered.length, start + maxVisible);
    if (filtered.length === 0) {
      lines.push(theme.fg("muted", truncate(renderMessage("menu.search.empty"), width)));
    }
    for (let index = start; index < end; index += 1) {
      const item = filtered[index];
      if (!item) continue;
      const selected = index === this.selected;
      const label = truncate(`${selected ? "→ " : "  "}${item.label}`, width);
      const description = item.description
        ? truncate(` — ${item.description}`, Math.max(0, width - displayWidth(label)))
        : "";
      lines.push(theme.fg(selected ? "accent" : "text", label) + theme.fg("muted", description));
    }
    if (filtered.length > maxVisible) {
      lines.push(
        theme.fg(
          "muted",
          truncate(
            renderMessage("menu.search.count", { start: start + 1, end, total: filtered.length }),
            width,
          ),
        ),
      );
    }
    lines.push("", theme.fg("muted", truncate(renderMessage("menu.search.hint"), width)));
    return lines;
  }

  handleInput(data: string): void {
    const { keybindings } = this;
    let delta = 0;
    if (keybindings.matches(data, "tui.select.up")) delta = -1;
    else if (keybindings.matches(data, "tui.select.down")) delta = 1;
    else if (keybindings.matches(data, "tui.select.pageUp")) delta = -this.visibleRows();
    else if (keybindings.matches(data, "tui.select.pageDown")) delta = this.visibleRows();
    else if (keybindings.matches(data, "tui.select.confirm") || data === "\n") {
      this.done(this.filtered()[this.selected]?.value);
      return;
    } else if (keybindings.matches(data, "tui.select.cancel")) {
      this.done(undefined);
      return;
    } else if (data === "\x7f" || data === "\b") {
      this.query = this.query.slice(0, -1);
      this.selected = 0;
      return;
    } else if (/^[ -~]$/.test(data)) {
      this.query += data;
      this.selected = 0;
      return;
    }
    const total = this.filtered().length;
    this.selected = Math.max(0, Math.min(this.selected + delta, total - 1));
  }
}

export async function selectMenuItem(
  context: PiCommandContext,
  request: MenuRequest,
): Promise<string | undefined> {
  if (context.mode === "tui" && context.ui.custom) {
    return context.ui.custom<string | undefined>(
      (tui, theme, keybindings, done) =>
        new SearchList(request, theme, keybindings, done, tui.terminal),
    );
  }
  const title = [request.title, request.subtitle].filter(Boolean).join("\n");
  const picked = await context.ui.select(
    title,
    request.items.map((item) => item.fallbackLabel ?? item.label),
  );
  return request.items.find((item) => (item.fallbackLabel ?? item.label) === picked)?.value;
}
