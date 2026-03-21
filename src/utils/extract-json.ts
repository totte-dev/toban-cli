/**
 * Extract the first valid JSON object from a string that may contain
 * trailing text after the JSON. Uses bracket matching to find the
 * correct closing brace.
 *
 * Example: '{"a":1} some extra text' -> '{"a":1}'
 */
export function extractJsonObject(str: string): string | null {
  const start = str.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < str.length; i++) {
    const ch = str[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\") {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return str.slice(start, i + 1);
      }
    }
  }

  return null;
}
