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

export interface ApiClient {
  fetchWorkspace(): Promise<WorkspaceInfo>;
  fetchGitToken(): Promise<{ token: string; repo: string | null } | null>;
  fetchTasks(): Promise<Task[]>;
  fetchRepositories(): Promise<WorkspaceRepository[]>;
  startSprint(): Promise<SprintStartResult>;
  updateTask(id: string, data: Partial<Task>): Promise<void>;
  updateAgent(data: {
    name: string;
    status: string;
    activity?: string;
  }): Promise<void>;
  submitRetroComment(sprintNumber: number, data: RetroCommentInput): Promise<void>;
  reportProgress(data: ProgressReport): Promise<void>;
  fetchPlaybookPrompt(): Promise<string>;
  sendMessage(from: string, to: string, content: string): Promise<void>;
}

export function createApiClient(apiUrl: string, apiKey: string): ApiClient {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  return {
    async fetchWorkspace(): Promise<WorkspaceInfo> {
      const res = await fetch(`${apiUrl}/api/v1/workspace`, { headers });
      if (!res.ok) {
        throw new Error(`Failed to fetch workspace: ${res.status} ${res.statusText}`);
      }
      return (await res.json()) as WorkspaceInfo;
    },

    async fetchTasks(): Promise<Task[]> {
      const res = await fetch(`${apiUrl}/api/v1/tasks`, { headers });
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

    async updateTask(id: string, data: Partial<Task>): Promise<void> {
      const res = await fetch(`${apiUrl}/api/v1/tasks/${id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        throw new Error(`Failed to update task ${id}: ${res.status} ${res.statusText}`);
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

    async fetchPlaybookPrompt(): Promise<string> {
      try {
        const res = await fetch(`${apiUrl}/api/v1/playbook/prompt`, { headers });
        if (!res.ok) return "";
        const data = (await res.json()) as { prompt: string };
        return data.prompt ?? "";
      } catch {
        return "";
      }
    },
  };
}
