/**
 * Reusable poll loop with guard, pause/resume, and error handling.
 */
import * as ui from "./ui.js";

export interface PollLoopOptions {
  name: string;
  intervalMs: number;
  onTick: () => Promise<void>;
  onError?: (err: unknown) => void;
}

export class PollLoop {
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private readonly name: string;
  private readonly intervalMs: number;
  private readonly onTick: () => Promise<void>;
  private readonly onError: (err: unknown) => void;

  constructor(opts: PollLoopOptions) {
    this.name = opts.name;
    this.intervalMs = opts.intervalMs;
    this.onTick = opts.onTick;
    this.onError = opts.onError ?? ((err) => ui.warn(`[${this.name}] poll error: ${err}`));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    this.poll(); // Run immediately
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  pause(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  resume(): void {
    if (!this.timer) {
      this.timer = setInterval(() => this.poll(), this.intervalMs);
    }
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  private async poll(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      await this.onTick();
    } catch (err) {
      this.onError(err);
    } finally {
      this.processing = false;
    }
  }
}
