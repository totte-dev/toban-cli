/**
 * ChatPoller - Polls for manager chat messages and responds via AI.
 *
 * Watches the manager channel for new user messages, builds context
 * from workspace/sprint/tasks, and responds using Claude Code CLI
 * (falls back to Anthropic API if ANTHROPIC_API_KEY is set).
 */

import { spawn } from "node:child_process";

interface Message {
  id: string;
  from: string;
  to: string;
  content: string;
  read: boolean;
  created_at: string;
}

interface SprintInfo {
  number: number;
  status: string;
}

interface AgentSummary {
  name: string;
  status: string;
  activity?: string;
}

interface TaskSummary {
  id: string;
  title: string;
  status: string;
  priority: string | number;
  owner?: string;
}

export interface ChatPollerOptions {
  apiUrl: string;
  apiKey: string;
  anthropicApiKey?: string;
  model?: string;
  pollIntervalMs?: number;
}

export class ChatPoller {
  private apiUrl: string;
  private apiKey: string;
  private anthropicApiKey?: string;
  private model: string;
  private pollIntervalMs: number;
  private lastSeenId: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private useClaudeCli: boolean;
  private cachedSystemPrompt: string | null = null;
  private cachedSystemPromptAt = 0;

  constructor(options: ChatPollerOptions) {
    this.apiUrl = options.apiUrl;
    this.apiKey = options.apiKey;
    this.anthropicApiKey = options.anthropicApiKey;
    this.model = options.model ?? "claude-sonnet-4-20250514";
    this.pollIntervalMs = options.pollIntervalMs ?? 5000;
    // Use Claude CLI by default, fall back to Anthropic API if key is provided
    this.useClaudeCli = !options.anthropicApiKey;
  }

  /**
   * Start the polling loop.
   */
  start(): void {
    console.log(`[chat] Starting manager chat poller (every ${this.pollIntervalMs}ms, model: ${this.model})`);
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
    // Run immediately once
    this.poll();
  }

  /**
   * Stop the polling loop.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log("[chat] Chat poller stopped");
  }

  private async poll(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      // Update manager agent heartbeat
      await this.updateManagerStatus();

      // Fetch messages in the manager channel
      const messages = await this.fetchMessages();
      if (!messages || messages.length === 0) {
        this.processing = false;
        return;
      }

      // Find new user messages we haven't processed yet
      const newUserMessages = this.findNewUserMessages(messages);

      for (const msg of newUserMessages) {
        console.log(`[chat] New message from user: "${msg.content.slice(0, 60)}${msg.content.length > 60 ? "..." : ""}"`);

        try {
          const reply = await this.generateReply(msg, messages);
          await this.postReply(reply);
          console.log(`[chat] Replied: "${reply.slice(0, 60)}${reply.length > 60 ? "..." : ""}"`);
        } catch (err) {
          console.error(`[chat] Failed to generate/post reply:`, err);
        }

        // Track this message as processed
        this.lastSeenId = msg.id;
      }
    } catch (err) {
      console.error(`[chat] Poll error:`, err);
    } finally {
      this.processing = false;
    }
  }

  private async fetchMessages(): Promise<Message[]> {
    const res = await fetch(`${this.apiUrl}/api/v1/messages?channel=manager`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { messages?: Message[] } | Message[];
    return Array.isArray(data) ? data : data.messages ?? [];
  }

  private findNewUserMessages(messages: Message[]): Message[] {
    // Messages are assumed to be sorted by created_at ascending
    const sorted = [...messages].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );

    if (!this.lastSeenId) {
      // On first poll, only respond to the very last unread user message (if any)
      // to avoid replaying the entire history
      const lastUserMsg = sorted.filter(
        (m) => m.from === "user" && m.to === "manager"
      ).pop();

      if (lastUserMsg) {
        // Check if the last message in the channel is from the user (i.e. no reply yet)
        const lastMsg = sorted[sorted.length - 1];
        if (lastMsg && lastMsg.from === "user" && lastMsg.id === lastUserMsg.id) {
          this.lastSeenId = lastUserMsg.id;
          return [lastUserMsg];
        }
      }

      // Mark all as seen
      if (sorted.length > 0) {
        this.lastSeenId = sorted[sorted.length - 1].id;
      }
      return [];
    }

    // Find messages after our last seen ID
    const lastSeenIdx = sorted.findIndex((m) => m.id === this.lastSeenId);
    const newMessages = lastSeenIdx === -1 ? sorted : sorted.slice(lastSeenIdx + 1);

    return newMessages.filter(
      (m) => m.from === "user" && m.to === "manager"
    );
  }

  private async generateReply(
    userMessage: Message,
    allMessages: Message[]
  ): Promise<string> {
    if (this.useClaudeCli) {
      return this.generateReplyViaClaude(userMessage, allMessages);
    }
    return this.generateReplyViaApi(userMessage, allMessages);
  }

  /**
   * Generate reply using Claude Code CLI (no API key needed).
   * Uses the user's existing Claude Code login session.
   */
  private async generateReplyViaClaude(
    userMessage: Message,
    allMessages: Message[]
  ): Promise<string> {
    const history = this.buildConversationHistory(allMessages, userMessage);

    // Detect if this is a continuation or first contact
    const priorManagerReplies = allMessages.filter((m) => m.from === "manager" && m.to === "user");
    const isFirstContact = priorManagerReplies.length <= 1; // 0 or just the welcome message

    const systemPrompt = await this.buildSystemPrompt(isFirstContact);

    // Build the prompt: include recent history for context
    const contextLines: string[] = [];
    // Only include the last few exchanges for context (skip the current message)
    for (const msg of history.slice(-6, -1)) {
      const label = msg.role === "user" ? "User" : "Manager";
      contextLines.push(`${label}: ${msg.content}`);
    }

    const fullPrompt = contextLines.length > 0
      ? `Recent conversation:\n${contextLines.join("\n")}\n\nUser: ${userMessage.content}`
      : userMessage.content;

    // Remove CLAUDECODE env var to avoid nested session detection
    const env = { ...process.env };
    delete env.CLAUDECODE;

    return new Promise<string>((resolve, reject) => {
      const child = spawn("claude", [
        "--print",
        "--system-prompt", systemPrompt,
        "--model", this.model,
        fullPrompt,
      ], {
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Claude CLI timed out after 60s"));
      }, 60_000);

      child.on("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (err.code === "ENOENT") {
          reject(new Error("Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code"));
        } else {
          reject(new Error(`Claude CLI spawn error: ${err.message}`));
        }
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout.trim() || "(no response)");
        } else {
          reject(new Error(`Claude CLI exited with code ${code}: ${stderr.slice(0, 200)}`));
        }
      });

      // Don't unref — we need to wait for the child to complete
    });
  }

  /**
   * Generate reply using Anthropic API directly (requires ANTHROPIC_API_KEY).
   */
  private async generateReplyViaApi(
    userMessage: Message,
    allMessages: Message[]
  ): Promise<string> {
    const priorManagerReplies = allMessages.filter((m) => m.from === "manager" && m.to === "user");
    const isFirstContact = priorManagerReplies.length <= 1;
    const systemPrompt = await this.buildSystemPrompt(isFirstContact);
    const conversationHistory = this.buildConversationHistory(allMessages, userMessage);

    const body = {
      model: this.model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: conversationHistory,
    };

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.anthropicApiKey!,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as {
      content: Array<{ type: string; text?: string }>;
    };

    const textBlock = data.content.find((c) => c.type === "text");
    return textBlock?.text ?? "(no response)";
  }

  private async buildSystemPrompt(isFirstContact = true): Promise<string> {
    // Cache the context part for 30 seconds to reduce API calls
    const CACHE_TTL = 30_000;
    const now = Date.now();
    if (this.cachedSystemPrompt && now - this.cachedSystemPromptAt < CACHE_TTL && !isFirstContact) {
      // Replace the last line (first/continuation rule) with current context
      const base = this.cachedSystemPrompt.replace(/- This is a (?:FIRST|CONTINUATION).*$/s, "");
      return base + "- This is a CONTINUATION of an ongoing conversation. Respond naturally to what the user said. Do NOT re-introduce yourself or repeat the phase overview. Just answer or act. Match the language the user wrote in.";
    }

    let projectName = "Unknown";
    let sprintNumber = "?";
    let sprintStatus = "unknown";
    let agentsList = "  (unavailable)";
    let tasksList = "  (unavailable)";
    let workspaceLang = "en";

    try {
      const [workspace, sprints, tasks] = await Promise.all([
        this.fetchJson<{ name?: string; language?: string }>(`${this.apiUrl}/api/v1/workspace`),
        this.fetchJson<{ sprints?: SprintInfo[] } | SprintInfo[]>(`${this.apiUrl}/api/v1/sprints`),
        this.fetchJson<{ tasks?: TaskSummary[] } | TaskSummary[]>(`${this.apiUrl}/api/v1/tasks`),
      ]);

      if (workspace?.name) projectName = workspace.name;
      if (workspace?.language) workspaceLang = workspace.language;

      const sprintArr = Array.isArray(sprints) ? sprints : sprints?.sprints ?? [];
      const currentSprint = sprintArr.find((s) => s.status === "active") ?? sprintArr[sprintArr.length - 1];
      if (currentSprint) {
        sprintNumber = String(currentSprint.number);
        sprintStatus = currentSprint.status;
      }

      const taskArr = Array.isArray(tasks) ? tasks : tasks?.tasks ?? [];
      if (taskArr.length > 0) {
        tasksList = taskArr
          .map((t) => `  - [${t.status}] ${t.title} (${t.priority}${t.owner ? `, owner: ${t.owner}` : ""})`)
          .join("\n");
      }
    } catch {
      // Use defaults
    }

    try {
      const agentsRes = await this.fetchJson<{ agents?: AgentSummary[] } | AgentSummary[]>(
        `${this.apiUrl}/api/v1/agents`
      );
      const agentArr = Array.isArray(agentsRes) ? agentsRes : agentsRes?.agents ?? [];
      if (agentArr.length > 0) {
        agentsList = agentArr
          .map((a) => `  - ${a.name}: ${a.status}${a.activity ? ` (${a.activity})` : ""}`)
          .join("\n");
      }
    } catch {
      // Use default
    }

    const phaseInstructions = this.getPhaseInstructions(sprintStatus);

    const prompt = `You are the Sprint Manager for project "${projectName}".

Current Sprint: #${sprintNumber} (${sprintStatus})

Available Agents:
${agentsList}

Sprint Tasks:
${tasksList}

${phaseInstructions}

IMPORTANT RULES:
- Never just list stats. Interpret the situation and suggest the logical next step.
- Keep responses short (3-5 sentences max). Details only when asked.
${isFirstContact
  ? `- This is the FIRST interaction. Greet briefly and propose the next action for this phase. Respond in ${workspaceLang === "ja" ? "Japanese" : "English"}.`
  : "- This is a CONTINUATION of an ongoing conversation. Respond naturally to what the user said. Do NOT re-introduce yourself or repeat the phase overview. Just answer or act. Match the language the user wrote in."}`;

    this.cachedSystemPrompt = prompt;
    this.cachedSystemPromptAt = Date.now();
    return prompt;
  }

  private getPhaseInstructions(phase: string): string {
    switch (phase) {
      case "planning":
        return `## Phase: Planning
You are helping the user plan the sprint.
- Summarize the backlog briefly and ask which tasks to include in this sprint.
- Suggest priorities and agent assignments based on task content.
- If the user seems satisfied, propose moving to "active" phase.
Example opener: "バックログに◯件のタスクがあります。このスプリントに入れるタスクを選びましょう。"`;

      case "active":
        return `## Phase: Active
You are managing active sprint execution.
- If there are TODO tasks assigned to an agent: propose running that agent. e.g. "<agent>に◯件の未着手タスクがあります。実行を依頼しましょうか？"
- If tasks are in-progress: briefly report who is working on what.
- If all tasks are done or in review: propose moving to "review" phase.
- If a task is blocked: explain why and suggest how to unblock.
DO NOT list all task stats. Focus on what needs to happen next.`;

      case "review":
        return `## Phase: Review
You are helping the user review completed work.
- Tell the user how many tasks are awaiting review and propose going through them one by one.
- For each task, summarize what was done and ask for approval or rejection.
- When all reviewed, propose moving to "retrospective" phase.
Example opener: "◯件のタスクがレビュー待ちです。順に確認していきましょう。"`;

      case "retrospective":
        return `## Phase: Retrospective
You are facilitating a sprint retrospective.
- Summarize results: completed vs incomplete tasks, per-agent performance.
- Ask what went well and what could be improved.
- Propose action items for the next sprint.
- When done, suggest closing this sprint and starting a new planning phase.
Example opener: "スプリントの振り返りを行いましょう。完了◯件、未完了◯件でした。"`;

      default:
        return `## Phase: ${phase}
Help the user with sprint management. Propose the next action based on task status.`;
    }
  }

  private buildConversationHistory(
    allMessages: Message[],
    upToMessage: Message
  ): Array<{ role: "user" | "assistant"; content: string }> {
    const sorted = [...allMessages].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );

    // Take the last 20 messages for context, up to and including the current message
    const upToIdx = sorted.findIndex((m) => m.id === upToMessage.id);
    const relevant = upToIdx === -1 ? sorted.slice(-20) : sorted.slice(Math.max(0, upToIdx - 19), upToIdx + 1);

    const history: Array<{ role: "user" | "assistant"; content: string }> = [];

    for (const msg of relevant) {
      const role: "user" | "assistant" =
        msg.from === "user" ? "user" : "assistant";

      // Merge consecutive same-role messages
      if (history.length > 0 && history[history.length - 1].role === role) {
        history[history.length - 1].content += "\n" + msg.content;
      } else {
        history.push({ role, content: msg.content });
      }
    }

    // Anthropic API requires messages to start with "user" role
    while (history.length > 0 && history[0].role !== "user") {
      history.shift();
    }

    // Must have at least one message
    if (history.length === 0) {
      history.push({ role: "user", content: upToMessage.content });
    }

    return history;
  }

  private async postReply(content: string): Promise<void> {
    const res = await fetch(`${this.apiUrl}/api/v1/messages`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({
        from: "manager",
        to: "user",
        content,
      }),
    });
    if (!res.ok) {
      throw new Error(`Failed to post reply: ${res.status} ${res.statusText}`);
    }
  }

  private async updateManagerStatus(): Promise<void> {
    try {
      await fetch(`${this.apiUrl}/api/v1/agents`, {
        method: "PUT",
        headers: this.authHeaders(),
        body: JSON.stringify({
          name: "manager",
          status: "active",
          activity: "listening",
        }),
      });
    } catch {
      // Non-fatal
    }
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(url, { headers: this.authHeaders() });
    if (!res.ok) throw new Error(`${res.status}`);
    return (await res.json()) as T;
  }

  private authHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
  }
}
