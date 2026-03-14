/**
 * Prompt generation for spawned agents.
 *
 * Builds the system prompt that gets passed to Claude Code (or other engines)
 * so the agent knows its role, task, and how to report back.
 */

export interface PromptContext {
  /** Agent role name (e.g. "builder", "cloud-engineer") */
  role: string;
  /** Human-readable project name */
  projectName?: string;
  /** Project spec (JSON string with vision, target_users, tech_stack, etc.) */
  projectSpec?: string;
  /** Task ID */
  taskId: string;
  /** Task title */
  taskTitle: string;
  /** Task description / instructions */
  taskDescription?: string;
  /** Task priority (p0, p1, p2) */
  taskPriority?: string;
  /** Toban API base URL for status reporting */
  apiUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** Pre-built playbook rules block */
  playbookRules?: string;
}

const ROLE_DESCRIPTIONS: Record<string, string> = {
  builder:
    "You are a software development agent. You write production-quality code, run tests, and commit clean changes.",
  "cloud-engineer":
    "You are a cloud infrastructure agent. You manage CI/CD pipelines, IaC (Terraform/Pulumi), monitoring, and deployment configurations.",
  strategist:
    "You are a business strategy agent. You research markets, analyze competitors, and produce strategic documents.",
  marketer:
    "You are a marketing agent. You create content, manage community presence, and build developer relations materials.",
  operator:
    "You are an operations agent. You monitor systems, handle incidents, and maintain operational runbooks.",
};

const SPEC_LABELS: Record<string, string> = {
  vision: "Vision & Goals",
  target_users: "Target Users",
  tech_stack: "Tech Stack",
  mvp_requirements: "MVP Requirements",
  constraints: "Constraints & Decisions",
};

function buildSpecBlock(specJson?: string): string {
  if (!specJson) return "";
  try {
    const spec = JSON.parse(specJson) as Record<string, string>;
    const sections = Object.entries(spec)
      .filter(([, v]) => v && v.trim())
      .map(([k, v]) => `### ${SPEC_LABELS[k] ?? k}\n${v.trim()}`)
      .join("\n\n");
    if (!sections) return "";
    return `\n\n## Project Spec\n${sections}`;
  } catch {
    return "";
  }
}

/**
 * Build the full prompt string for an agent.
 */
export function buildAgentPrompt(ctx: PromptContext): string {
  const roleDesc =
    ROLE_DESCRIPTIONS[ctx.role] ??
    `You are the ${ctx.role} agent.`;

  const projectLine = ctx.projectName
    ? `\nProject: ${ctx.projectName}`
    : "";

  const priorityLine = ctx.taskPriority
    ? `\nPriority: ${ctx.taskPriority}`
    : "";

  const specBlock = buildSpecBlock(ctx.projectSpec);

  const descriptionBlock = ctx.taskDescription
    ? `\n\nDescription:\n${ctx.taskDescription}`
    : "";

  const playbookBlock = ctx.playbookRules ?? "";

  return `${roleDesc}${projectLine}${specBlock}
${playbookBlock}
Your task: ${ctx.taskTitle}${priorityLine}${descriptionBlock}

Report progress to the Toban API:
- API URL: ${ctx.apiUrl}
- API Key: ${ctx.apiKey}
- Update task status: PATCH ${ctx.apiUrl}/api/v1/tasks/${ctx.taskId} with {"status": "in-progress"} or {"status": "review"}
- Use Authorization header: Bearer ${ctx.apiKey}

Work in this directory. When done, commit your changes with a descriptive message.

When completing a task, write a brief retrospective as a JSON comment to stdout on a new line in this format:
RETRO_JSON:{"went_well":"what went well","to_improve":"what could be improved","suggested_tasks":[{"title":"task title","priority":"p1"}]}
This helps the team improve in future sprints.`;
}
