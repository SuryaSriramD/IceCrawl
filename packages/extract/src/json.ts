export type ParsedJson = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

/**
 * Reads the JSON object a model answered with, tolerating markdown fences and a sentence around it.
 * The error strings are fixed sentences: they must never quote the model's output, which is derived from page text.
 */
export function parseModelJson(text: string): ParsedJson {
  const trimmed = text.trim();
  const candidates = [trimmed];
  if (trimmed.startsWith('```')) {
    candidates.push(trimmed.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, ''));
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));

  let sawJson = false;
  for (const candidate of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    sawJson = true;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return { ok: true, value: value as Record<string, unknown> };
    }
  }
  return { ok: false, error: sawJson ? 'the answer was valid JSON but not a JSON object' : 'the answer was not valid JSON' };
}
