import { type ProfileDiagnosticCategory, ProfileFailure } from "./diagnostic.ts";

// Manifest and configuration share one byte budget; the limit is inclusive.
export const MAX_JSON_DOCUMENT_BYTES = 8192;

const SCHEMA_VERSION = 1;

export type JsonDocumentCategory = Extract<ProfileDiagnosticCategory, "manifest" | "configuration">;

export type JsonObject = Record<string, unknown>;

// JSON.parse checks syntax and rejects comments, trailing commas and non-standard values.
// It keeps the last value of a repeated key, so a separate scan rejects duplicates.
export function parseStrictJsonObject(text: string, category: JsonDocumentCategory): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProfileFailure(category, "invalid-json");
  }
  if (hasDuplicateKey(text)) throw new ProfileFailure(category, "duplicate-key");
  if (!isJsonObject(value)) throw new ProfileFailure(category, "not-object");
  return value;
}

export function requireKnownFields(
  object: JsonObject,
  allowedFields: readonly string[],
  category: JsonDocumentCategory,
): void {
  for (const field of Object.keys(object)) {
    if (!allowedFields.includes(field)) throw new ProfileFailure(category, "unknown-field");
  }
}

export function requireSchemaVersion(object: JsonObject, category: JsonDocumentCategory): void {
  if (!Object.hasOwn(object, "schemaVersion")) throw new ProfileFailure(category, "missing-field");
  if (typeof object.schemaVersion !== "number") {
    throw new ProfileFailure(category, "invalid-field");
  }
  if (object.schemaVersion !== SCHEMA_VERSION) {
    throw new ProfileFailure(category, "unsupported-schema-version");
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Runs only after JSON.parse accepted the text, so every string has a closing quote.
// Keys are compared decoded, which makes escaped spellings of the same name collide.
function hasDuplicateKey(text: string): boolean {
  // One entry per open container: a key set for objects, null for arrays.
  const containers: Array<Set<string> | null> = [];
  let expectingKey = false;
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '"') {
      const closingQuote = findClosingQuote(text, index);
      const keys = containers.at(-1);
      if (expectingKey && keys) {
        const key = JSON.parse(text.slice(index, closingQuote + 1)) as string;
        if (keys.has(key)) return true;
        keys.add(key);
        expectingKey = false;
      }
      index = closingQuote + 1;
      continue;
    }
    if (character === "{") {
      containers.push(new Set());
      expectingKey = true;
    } else if (character === "[") {
      containers.push(null);
      expectingKey = false;
    } else if (character === "}" || character === "]") {
      containers.pop();
      expectingKey = false;
    } else if (character === ",") {
      expectingKey = containers.at(-1) instanceof Set;
    } else if (character === ":") {
      expectingKey = false;
    }
    index += 1;
  }
  return false;
}

function findClosingQuote(text: string, openingQuote: number): number {
  let index = openingQuote + 1;
  while (index < text.length && text[index] !== '"') {
    index += text[index] === "\\" ? 2 : 1;
  }
  return index;
}
