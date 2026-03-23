/**
 * Simple fetch-based client for the Toban API.
 * Used by the CLI runner to fetch tasks and report agent status.
 */

export interface Task {
  id: string;
  title: string;
  description: string;
  status: "todo" | "in_progress" | "review" | "done";
  priority: string | number;
  owner?: string;
  agent?: string;
  target_repo?: string | null;
  type?: string;
  story_points?: number | null;
  labels?: string[] | string;
  review_comment?: string | null;
  review_verdict?: string | null;
  category?: "read_only" | "mutating" | "destructive" | null;
  steps?: string | string[] | null;
  acceptance_criteria?: string | string[] | null;
  files_hint?: string | string[] | null;
  constraints_list?: string | string[] | null;
  context_notes?: string | null;
  sprint?: number | null;
  parent_task?: string | null;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface AgentInfo {
  name: string;
  status: string;
  engine?: string;
  execution_mode?: string;
}

export interface SprintStartResult {
  sprint: { number: number; status: string };
  agents: AgentInfo[];
  tasks: Task[];
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  github_repo: string | null;
  github_org: string | null;
  github_login: string | null;
  language: string | null;
  terminal_emulator: string | null;
}

export interface WorkspaceRepository {
  id: string;
  repo_path: string;
  repo_name: string;
  repo_url: string;
  description: string;
  access_agents: string[];
}

export interface Message {
  id: string;
  from: string;
  to: string;
  content: string;
  read: boolean;
  created_at: string;
}

export interface RetroCommentInput {
  agent_name: string;
  went_well?: string;
  to_improve?: string;
  suggested_tasks?: Array<{ title: string; description?: string; priority?: string; owner?: string }>;
}

export interface ProgressReport {
  agent_name: string;
  task_name?: string;
  step?: string;
  file?: string;
  detail?: string;
}

export interface AgentMemory {
  key: string;
  type: string;
  content: string;
  agent_name?: string;
  shared?: boolean;
  tags?: string;
}

export interface ApiClient {
  fetchWorkspace(): Promise<WorkspaceInfo>;
  fetchGitToken(): Promise<{ token: string; repo: string | null } | null>;
  fetchTasks(sprint?: number): Promise<Task[]>;
  fetchRepositories(): Promise<WorkspaceRepository[]>;
  startSprint(): Promise<SprintStartResult>;
  fetchSprintData(): Promise<SprintStartResult>;
  fetchCurrentSprint(): Promise<{ number: number; status: string } | null>;
  completeSprint(number: number): Promise<void>;
  updateTask(id: string, data: Partial<Task>): Promise<void>;
  updateAgent(data: {
    name: string;
    status: string;
    activity?: string;
  }): Promise<void>;
  submitRetroComment(sprintNumber: number, data: RetroCommentInput): Promise<void>;
  reportProgress(data: ProgressReport): Promise<void>;
  fetchPlaybookPrompt(agentName?: string, taskTags?: string[]): Promise<string>;
  /** Fetch raw playbook rules for local keyword matching */
  fetchPlaybookRules(): Promise<Array<{ id: string; category: string; title: string; content: string; tags: string | null }>>;
  /** Create a custom playbook rule */
  createPlaybookRule(title: string, content: string, category: string): Promise<void>;
  /** Fetch anti-patterns (rejected false positive tokens) per rule */
  fetchAntiPatterns(): Promise<Record<string, string[]>>;
  fetchMessages(channel: string): Promise<Message[]>;
  sendMessage(from: string, to: string, content: string): Promise<void>;
  fetchMySecrets(): Promise<Record<string, string>>;
  fetchApiDocs(agentName: string): Promise<string>;
  fetchAgentMemories(agentName: string): Promise<AgentMemory[]>;
  putAgentMemory(agentName: string, key: string, data: { type: string; content: string; shared?: boolean; tags?: string }): Promise<void>;
  fetchRelevantFailures(): Promise<Array<{ summary: string; failure_type: string; agent_name: string | null; created_at: string }>>;
  recordFailure(data: { task_id: string; failure_type: string; summary: string; agent_name?: string; sprint?: number; review_comment?: string; files_involved?: string }): Promise<void>;
  /** Fetch plan limits (max concurrent builders, etc.) */
  fetchPlanLimits(): Promise<PlanLimits>;
  /** Check and trigger automatic sprint phase transition */
  checkAutoTransition(sprintNumber: number): Promise<{ transitioned: boolean; from?: string; to?: string; reason?: string }>;
  /** Record a single event to the unified event store */
  recordEvent(event: EventInput): Promise<void>;
  /** Record multiple events in a batch (max 50) */
  recordEvents(events: EventInput[]): Promise<void>;
}

export interface EventInput {
  type: string;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  sprint?: number;
  task_id?: string;
  agent_name?: string;
  data?: Record<string, unknown>;
}

export interface PlanLimits {
  max_builders: number;
  max_cloud_engineers: number;
  build_command: string | null;
  test_command: string | null;
  stall_timeout_minutes: number;
}

/** Create standard auth headers for API requests. */
export function createAuthHeaders(apiKey: string): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
}

/** Retry a fetch call on 5xx or 429 errors with exponential backoff + jitter */
export async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 3): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok || attempt === maxRetries) return res;
      if (res.status === 429) {
        // Respect Retry-After header, fallback to exponential backoff
        const retryAfter = res.headers.get("Retry-After");
        const delayMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 2000 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, delayMs + Math.random() * 500));
      } else if (res.status >= 500) {
        // Exponential backoff: 2s, 4s, 8s + jitter
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt + Math.random() * 500));
      } else {
        // 4xx (not 429) — don't retry
        return res;
      }
    } catch (err) {
      // Network error (fetch failed, connection refused, etc.)
      if (attempt === maxRetries) throw err;
      // Exponential backoff: 2s, 4s, 8s + jitter
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt + Math.random() * 500));
    }
  }
  return fetch(url, options); // unreachable, but type-safe
}

export function createApiClient(apiUrl: string, apiKey: string): ApiClient {
  const headers = createAuthHeaders(apiKey);

  return {
    async fetchWorkspace(): Promise<WorkspaceInfo> {
      const res = await fetch(`${apiUrl}/api/v1/workspace`, { headers });
      if (!res.ok) {
        throw new Error(`Failed to fetch workspace: ${res.status} ${res.statusText}`);
      }
      return (await res.json()) as WorkspaceInfo;
    },

    async fetchTasks(sprint?: number): Promise<Task[]> {
      const qs = sprint != null ? `?sprint=${sprint}` : "";
      const res = await fetch(`${apiUrl}/api/v1/tasks${qs}`, { headers });
      if (!res.ok) {
        throw new Error(`Failed to fetch tasks: ${res.status} ${res.statusText}`);
      }
      const data = (await res.json()) as { tasks?: Task[] } | Task[];
      return Array.isArray(data) ? data : data.tasks ?? [];
    },

    async fetchRepositories(): Promise<WorkspaceRepository[]> {
      try {
        const res = await fetch(`${apiUrl}/api/v1/workspace/repositories`, { headers });
        if (!res.ok) return [];
        const data = (await res.json()) as WorkspaceRepository[];
        return Array.isArray(data) ? data : [];
      } catch {
        return [];
      }
    },

    async startSprint(): Promise<SprintStartResult> {
      const res = await fetch(`${apiUrl}/api/v1/sprints/current/start`, {
        method: "POST",
        headers,
      });
      if (!res.ok) {
        throw new Error(`Failed to start sprint: ${res.status} ${res.statusText}`);
      }
      return (await res.json()) as SprintStartResult;
    },

    async fetchSprintData(): Promise<SprintStartResult> {
      const res = await fetch(`${apiUrl}/api/v1/sprints/current/tasks`, { headers });
      if (!res.ok) {
        throw new Error(`Failed to fetch sprint: ${res.status} ${res.statusText}`);
      }
      return (await res.json()) as SprintStartResult;
    },

    async fetchCurrentSprint(): Promise<{ number: number; status: string } | null> {
      try {
        const res = await fetch(`${apiUrl}/api/v1/sprints/current`, { headers });
        if (!res.ok) return null;
        return (await res.json()) as { number: number; status: string };
      } catch {
        return null;
      }
    },

    async completeSprint(number: number): Promise<void> {
      const res = await fetch(`${apiUrl}/api/v1/sprints/${number}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ status: "completed" }),
      });
      if (!res.ok) {
        throw new Error(`Failed to complete sprint: ${res.status} ${res.statusText}`);
      }
    },

    async updateTask(id: string, data: Partial<Task>): Promise<void> {
      const res = await fetchWithRetry(`${apiUrl}/api/v1/tasks/${id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(`Failed to update task ${id}: ${res.status} ${res.statusText} — ${errBody.slice(0, 200)}`);
      }
    },

    async updateAgent(data: {
      name: string;
      status: string;
      activity?: string;
    }): Promise<void> {
      try {
        await fetch(`${apiUrl}/api/v1/agents`, {
          method: "PUT",
          headers,
          body: JSON.stringify(data),
        });
      } catch {
        // Non-fatal
      }
    },

    async submitRetroComment(sprintNumber: number, data: RetroCommentInput): Promise<void> {
      try {
        await fetch(`${apiUrl}/api/v1/sprints/${sprintNumber}/retro`, {
          method: "POST",
          headers,
          body: JSON.stringify(data),
        });
      } catch {
        // Non-fatal
      }
    },

    async reportProgress(data: ProgressReport): Promise<void> {
      try {
        await fetch(`${apiUrl}/api/v1/agents/progress`, {
          method: "POST",
          headers,
          body: JSON.stringify(data),
        });
      } catch {
        // Non-fatal
      }
    },

    async fetchGitToken(): Promise<{ token: string; repo: string | null } | null> {
      try {
        const res = await fetch(`${apiUrl}/api/v1/workspace/git-token`, { headers });
        if (!res.ok) return null;
        return (await res.json()) as { token: string; repo: string | null };
      } catch {
        return null;
      }
    },

    async fetchMessages(channel: string): Promise<Message[]> {
      try {
        const res = await fetch(`${apiUrl}/api/v1/messages?channel=${encodeURIComponent(channel)}`, { headers });
        if (!res.ok) return [];
        const data = (await res.json()) as { messages?: Message[] } | Message[];
        return Array.isArray(data) ? data : data.messages ?? [];
      } catch {
        return [];
      }
    },

    async sendMessage(from: string, to: string, content: string): Promise<void> {
      try {
        await fetch(`${apiUrl}/api/v1/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify({ from, to, content }),
        });
      } catch {
        // Non-fatal
      }
    },

    async fetchPlaybookPrompt(agentName?: string, taskTags?: string[]): Promise<string> {
      try {
        const params = new URLSearchParams();
        if (agentName) params.set("agent", agentName);
        if (taskTags?.length) params.set("tags", taskTags.join(","));
        const qs = params.toString() ? `?${params.toString()}` : "";
        const res = await fetch(`${apiUrl}/api/v1/playbook/prompt${qs}`, { headers });
        if (!res.ok) return "";
        const data = (await res.json()) as { prompt: string };
        return data.prompt ?? "";
      } catch {
        return "";
      }
    },

    async createPlaybookRule(title: string, content: string, category: string): Promise<void> {
      await fetch(`${apiUrl}/api/v1/playbook`, {
        method: "POST",
        headers,
        body: JSON.stringify({ title, content, category }),
      });
    },

    async fetchAntiPatterns(): Promise<Record<string, string[]>> {
      try {
        const res = await fetch(`${apiUrl}/api/v1/rule-evaluations/anti-patterns`, { headers });
        if (!res.ok) return {};
        return (await res.json()) as Record<string, string[]>;
      } catch {
        return {};
      }
    },

    async fetchPlaybookRules(): Promise<Array<{ id: string; category: string; title: string; content: string; tags: string | null }>> {
      try {
        const res = await fetch(`${apiUrl}/api/v1/playbook`, { headers });
        if (!res.ok) return [];
        const data = (await res.json()) as Array<{ id: string; category: string; title: string; content: string; tags: string | null; enabled?: number }>;
        if (!Array.isArray(data)) return [];
        return data.filter((r) => r.enabled !== 0);
      } catch {
        return [];
      }
    },

    async fetchMySecrets(): Promise<Record<string, string>> {
      try {
        const res = await fetch(`${apiUrl}/api/v1/secrets/mine`, { headers });
        if (!res.ok) return {};
        const data = (await res.json()) as Record<string, string>;
        return data ?? {};
      } catch {
        return {};
      }
    },

    async fetchApiDocs(agentName: string): Promise<string> {
      try {
        const res = await fetch(`${apiUrl}/api/v1/agents/${encodeURIComponent(agentName)}/api-docs`, { headers });
        if (!res.ok) return "";
        const data = (await res.json()) as { prompt?: string };
        return data.prompt ?? "";
      } catch {
        return "";
      }
    },

    async fetchAgentMemories(agentName: string): Promise<AgentMemory[]> {
      try {
        const res = await fetch(`${apiUrl}/api/v1/agents/${encodeURIComponent(agentName)}/memories`, { headers });
        if (!res.ok) return [];
        const data = (await res.json()) as { memories: AgentMemory[] };
        return data.memories ?? [];
      } catch {
        return [];
      }
    },

    async putAgentMemory(agentName: string, key: string, data: { type: string; content: string; shared?: boolean; tags?: string }): Promise<void> {
      try {
        await fetch(`${apiUrl}/api/v1/agents/${encodeURIComponent(agentName)}/memories/${encodeURIComponent(key)}`, {
          method: "PUT",
          headers,
          body: JSON.stringify(data),
        });
      } catch {
        // Non-fatal
      }
    },

    async fetchRelevantFailures(): Promise<Array<{ summary: string; failure_type: string; agent_name: string | null; created_at: string }>> {
      try {
        const res = await fetch(`${apiUrl}/api/v1/failures/relevant?limit=5`, { headers });
        if (!res.ok) return [];
        return (await res.json()) as Array<{ summary: string; failure_type: string; agent_name: string | null; created_at: string }>;
      } catch {
        return [];
      }
    },

    async recordFailure(data: { task_id: string; failure_type: string; summary: string; agent_name?: string; sprint?: number; review_comment?: string; files_involved?: string }): Promise<void> {
      try {
        await fetch(`${apiUrl}/api/v1/failures`, {
          method: "POST",
          headers,
          body: JSON.stringify(data),
        });
      } catch { /* best-effort */ }
    },

    async fetchPlanLimits(): Promise<PlanLimits> {
      try {
        const res = await fetch(`${apiUrl}/api/v1/workspace/plan-limits`, { headers });
        if (res.ok) {
          return (await res.json()) as PlanLimits;
        }
      } catch { /* non-fatal */ }
      // Default: free tier limits
      return { max_builders: 1, max_cloud_engineers: 1, build_command: null, test_command: null, stall_timeout_minutes: 10 };
    },

    async checkAutoTransition(sprintNumber: number): Promise<{ transitioned: boolean; from?: string; to?: string; reason?: string }> {
      try {
        const res = await fetch(`${apiUrl}/api/v1/sprints/${sprintNumber}/auto-transition`, {
          method: "POST",
          headers,
        });
        if (res.ok) {
          return (await res.json()) as { transitioned: boolean; from?: string; to?: string; reason?: string };
        }
      } catch { /* non-fatal */ }
      return { transitioned: false, reason: "API call failed" };
    },

    async recordEvent(event: EventInput): Promise<void> {
      try {
        await fetch(`${apiUrl}/api/v1/events`, {
          method: "POST",
          headers,
          body: JSON.stringify(event),
        });
      } catch { /* best-effort, don't block agent execution */ }
    },

    async recordEvents(events: EventInput[]): Promise<void> {
      if (events.length === 0) return;
      try {
        await fetch(`${apiUrl}/api/v1/events`, {
          method: "POST",
          headers,
          body: JSON.stringify(events),
        });
      } catch { /* best-effort */ }
    },
  };
}
