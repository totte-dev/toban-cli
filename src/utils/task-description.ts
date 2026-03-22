/**
 * Structured task description parser.
 *
 * Task descriptions can be either:
 * - Free text (legacy): passed through as-is
 * - Structured JSON: parsed into typed fields for prompt injection
 *
 * Structured format:
 * {
 *   "category": "read_only" | "mutating" | "destructive",
 *   "target_repo": "toban-cli",
 *   "context": "Background explanation",
 *   "steps": ["Step 1", "Step 2"],
 *   "acceptance_criteria": ["Criterion 1", "Criterion 2"],
 *   "files_hint": ["src/handlers/", "src/__tests__/"],
 *   "constraints": ["Don't break existing tests"],
 *   "related_tasks": ["fc7e2119"]
 * }
 */

export type TaskCategory = "read_only" | "mutating" | "destructive";

export interface StructuredDescription {
  category?: TaskCategory;
  target_repo?: string;
  context?: string;
  steps?: string[];
  acceptance_criteria?: string[];
  files_hint?: string[];
  constraints?: string[];
  related_tasks?: string[];
}

/**
 * Try to parse a description string as structured JSON.
 * Returns null if it's free text (not valid JSON or missing expected fields).
 */
export function parseStructuredDescription(description: string | undefined | null): StructuredDescription | null {
  if (!description?.trim()) return null;

  try {
    const parsed = JSON.parse(description);
    if (typeof parsed !== "object" || Array.isArray(parsed)) return null;

    // Must have at least one structured field to be considered structured
    const structuredKeys = ["category", "steps", "acceptance_criteria", "files_hint", "constraints", "context"];
    const hasStructuredField = structuredKeys.some((k) => k in parsed);
    if (!hasStructuredField) return null;

    return {
      category: validateCategory(parsed.category),
      target_repo: typeof parsed.target_repo === "string" ? parsed.target_repo : undefined,
      context: typeof parsed.context === "string" ? parsed.context : undefined,
      steps: Array.isArray(parsed.steps) ? parsed.steps.filter((s: unknown) => typeof s === "string") : undefined,
      acceptance_criteria: Array.isArray(parsed.acceptance_criteria) ? parsed.acceptance_criteria.filter((s: unknown) => typeof s === "string") : undefined,
      files_hint: Array.isArray(parsed.files_hint) ? parsed.files_hint.filter((s: unknown) => typeof s === "string") : undefined,
      constraints: Array.isArray(parsed.constraints) ? parsed.constraints.filter((s: unknown) => typeof s === "string") : undefined,
      related_tasks: Array.isArray(parsed.related_tasks) ? parsed.related_tasks.filter((s: unknown) => typeof s === "string") : undefined,
    };
  } catch {
    return null;
  }
}

function validateCategory(value: unknown): TaskCategory | undefined {
  if (value === "read_only" || value === "mutating" || value === "destructive") return value;
  return undefined;
}

/**
 * Build a prompt-friendly string from a structured description.
 * Formats each field as a clear section for the agent.
 */
export function formatDescriptionForPrompt(desc: StructuredDescription): string {
  const sections: string[] = [];

  if (desc.context) {
    sections.push(`Context:\n${desc.context}`);
  }

  if (desc.steps?.length) {
    sections.push(`Steps:\n${desc.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`);
  }

  if (desc.acceptance_criteria?.length) {
    sections.push(`Acceptance Criteria:\n${desc.acceptance_criteria.map((c) => `- ${c}`).join("\n")}`);
  }

  if (desc.files_hint?.length) {
    sections.push(`Files to focus on:\n${desc.files_hint.map((f) => `- ${f}`).join("\n")}`);
  }

  if (desc.constraints?.length) {
    sections.push(`Constraints:\n${desc.constraints.map((c) => `- ${c}`).join("\n")}`);
  }

  return sections.join("\n\n");
}

/**
 * Get a description string for prompt injection.
 * If structured, formats nicely. If free text, returns as-is.
 */
export function getPromptDescription(description: string | undefined | null): string {
  if (!description?.trim()) return "";

  const structured = parseStructuredDescription(description);
  if (structured) {
    return formatDescriptionForPrompt(structured);
  }

  return description;
}

/**
 * Extract category from description (structured or fallback to "mutating").
 */
export function getTaskCategory(description: string | undefined | null): TaskCategory {
  const structured = parseStructuredDescription(description);
  return structured?.category ?? "mutating";
}
