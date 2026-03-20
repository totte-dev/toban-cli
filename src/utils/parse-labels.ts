/**
 * Parse task labels from various formats (array, JSON string, unknown).
 */
export function parseTaskLabels(task: { labels?: string[] | string | unknown }): string[] {
  const raw = task.labels;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") { try { return JSON.parse(raw); } catch { return []; } }
  return [];
}
