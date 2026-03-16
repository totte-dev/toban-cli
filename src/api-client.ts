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

export interface ApiClient {
  fetchWorkspace(): Promise<WorkspaceInfo>;
  fetchGitToken(): Promise<{ token: string; repo: string | null } | null>;
  fetchTasks(): Promise<Task[]>;
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
  fetchPlaybookPrompt(): Promise<string>;
  fetchMessages(channel: string): Promise<Message[]>;
  sendMessage(from: string, to: string, content: string): Promise<void>;
  fetchMySecrets(): Promise<Record<string, string>>;
  fetchApiDocs(agentName: string): Promise<string>;
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
  };
}
