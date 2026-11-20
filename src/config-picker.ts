import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Input, replaceControlCharacters, SelectList, type SelectItem, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type PickerItem = SelectItem & { preview?: string };
type PickerOptions = { search?: boolean; current?: string; hint?: string };

type PickerContext = Pick<ExtensionCommandContext, "mode" | "ui">;

export function pickConfigItem(ctx: PickerContext, title: string, items: PickerItem[], options: PickerOptions = {}) {
  if (ctx.mode !== "tui") return ctx.ui.select(title, items.map(({ value }) => value));
  return ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
    const muted = (text: string) => theme.fg("muted", text);
    const accent = (text: string) => theme.fg("accent", text);
    const input = new Input({ prompt: "  Search  ", placeholder: "Model name, provider, or ID", placeholderStyle: muted });
    const byValue = new Map(items.map((item) => [item.value, item]));
    const makeList = (choices: PickerItem[]) => new SelectList(choices, 6, {
      selectedPrefix: accent,
      selectedText: (text) => accent(theme.bold(text)),
      description: muted,
      scrollInfo: muted,
      noMatch: () => muted("  No matching options"),
    });
    let list = makeList(items);
    const bind = () => {
      list.onSelect = ({ value }) => done(value);
      list.onCancel = () => done(undefined);
    };
    bind();
    list.setSelectedIndex(items.findIndex(({ value }) => value === options.current));
    const listKeys = ["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown", "tui.select.confirm", "tui.select.cancel"] as const;
    return {
      capturesViewportInput: true,
      get focused() { return input.focused; },
      set focused(value: boolean) { input.focused = value; },
      render(width: number) {
        const inner = Math.max(1, width - 2);
        const rule = () => accent("─".repeat(inner));
        const lines = [rule(), `  ${accent(theme.bold(title))}`];
        if (options.hint) lines.push(`  ${muted(options.hint)}`);
        if (options.search) lines.push("", ...input.render(inner));
        lines.push("", ...list.render(inner));
        const selected = list.getSelectedItem();
        const preview = selected && byValue.get(selected.value)?.preview;
        if (preview) {
          const wrapped = preview.split("\n").flatMap((line) => wrapTextWithAnsi(replaceControlCharacters(line), Math.max(1, inner - 4)));
          lines.push("", ...wrapped.slice(0, 4).map((line) => `  ${muted(line)}`));
        }
        lines.push("", `  ${muted("↑↓ Browse   Enter Select   Esc Back")}`, rule());
        return lines.map((line) => truncateToWidth(line, width));
      },
      invalidate() { input.invalidate(); list.invalidate(); },
      handleInput(data: string) {
        if (!options.search || listKeys.some((key) => keys.matches(data, key))) {
          list.handleInput(data);
        } else {
          const before = input.getValue();
          input.handleInput(data);
          const query = input.getValue();
          if (query !== before) {
            list = makeList(fuzzyFilter(items, query, ({ value, label }) => `${label} ${value}`));
            bind();
          }
        }
        tui.requestRender();
      },
    };
  }, { overlay: true, overlayOptions: { width: "90%", maxHeight: "95%", margin: 1 }, blocked: { kind: "question", message: title } });
}
