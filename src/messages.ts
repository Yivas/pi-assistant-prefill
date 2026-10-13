import messageCatalog from "../resources/messages.en.json" with { type: "json" };

const MESSAGES: Readonly<Record<string, string>> = messageCatalog;

// Placeholders are written as {name}. A missing key or parameter is a programming error, so it
// throws instead of printing a partial sentence. Parameter values are inserted as they are; the
// caller escapes any text that comes from a profile.
export function renderMessage(
  key: string,
  parameters: Readonly<Record<string, string | number>> = {},
): string {
  const template = MESSAGES[key];
  if (template === undefined) throw new Error(`unknown message key: ${key}`);
  return template.replace(/\{(\w+)\}/g, (_placeholder, name: string) => {
    const value = parameters[name];
    if (value === undefined) throw new Error(`missing message parameter: ${name}`);
    return String(value);
  });
}
