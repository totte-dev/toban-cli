/**
 * Prompt template loader — manages prompt templates with variable interpolation.
 *
 * Templates use {{variable}} placeholders that are replaced with dynamic data.
 * To edit prompts, modify src/prompts/templates.ts.
 */

import { PROMPT_TEMPLATES } from "./prompts/templates.js";

const TEMPLATES = PROMPT_TEMPLATES;

/**
 * Load a prompt template by name.
 */
export function loadPromptTemplate(name: string): string {
  const tpl = TEMPLATES[name];
  if (!tpl) throw new Error(`Prompt template not found: ${name}`);
  return tpl;
}

/**
 * Replace {{variable}} placeholders in a template string.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

/**
 * Load a prompt template and render it with variables.
 */
export function renderPrompt(name: string, vars: Record<string, string>): string {
  return renderTemplate(loadPromptTemplate(name), vars);
}

/**
 * Load the phase-specific instructions from phases.md.
 * Phases are separated by ---phase:<name>--- markers.
 */
export function loadPhaseInstructions(phase: string): string {
  const content = loadPromptTemplate("phases");
  const sections = content.split(/---phase:(\w+)---/);

  // First section is "planning" (before any marker)
  if (phase === "planning") return sections[0].trim();

  // Find the section matching the phase
  for (let i = 1; i < sections.length; i += 2) {
    if (sections[i] === phase && sections[i + 1]) {
      return sections[i + 1].trim();
    }
  }

  // Default fallback
  const defaultIdx = sections.indexOf("default");
  if (defaultIdx !== -1 && sections[defaultIdx + 1]) {
    return renderTemplate(sections[defaultIdx + 1].trim(), { phase });
  }

  return `## Phase: ${phase}\nHelp the user with sprint management.`;
}
