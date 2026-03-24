/**
 * Unified Job Queue — processes enrich and review jobs serially.
 *
 * Task execution continues through the existing SlotScheduler/Runner.
 * This queue handles lightweight jobs (enrich, review) that don't need
 * a full agent slot but should be serialized to avoid resource contention.
 */

import type { JobBase, EnrichJob, ReviewJob, JobStatus } from "../types.js";
import * as ui from "../ui.js";

export type Job = EnrichJob | ReviewJob;
export type JobHandler = (job: Job) => Promise<void>;

export class JobQueue {
  private queue: Job[] = [];
  private handler: JobHandler | null = null;
  private onUpdate: ((jobs: Job[]) => void) | null = null;

  /** Register the handler that processes jobs. */
  setHandler(handler: JobHandler): void {
    this.handler = handler;
  }

  /** Register callback for queue state changes (for WS broadcast). */
  setOnUpdate(callback: (jobs: Job[]) => void): void {
    this.onUpdate = callback;
  }

  /** Enqueue a job. Processing starts automatically if idle. */
  enqueue(job: Job): void {
    this.queue.push(job);
    ui.info(`[job-queue] Enqueued ${job.type} job for task ${job.taskId.slice(0, 8)}`);
    this.notify();
    this.processNext();
  }

  /** Get all jobs (for status display). */
  getJobs(): Job[] {
    return [...this.queue];
  }

  /** Get counts by status. */
  getCounts(): { pending: number; running: number; done: number; failed: number } {
    const counts = { pending: 0, running: 0, done: 0, failed: 0 };
    for (const j of this.queue) {
      counts[j.status]++;
    }
    return counts;
  }

  /** Clear completed/failed jobs (housekeeping). */
  prune(): void {
    this.queue = this.queue.filter((j) => j.status === "pending" || j.status === "running");
  }

  private notify(): void {
    this.onUpdate?.(this.getJobs());
  }

  /** Max concurrent jobs (review is lightweight with maxTurns=1) */
  private maxConcurrent = 3;
  private runningCount = 0;

  private async processNext(): Promise<void> {
    if (!this.handler) return;

    while (this.runningCount < this.maxConcurrent) {
      const next = this.queue.find((j) => j.status === "pending");
      if (!next) break;

      this.runningCount++;
      next.status = "running";
      next.startedAt = new Date().toISOString();
      this.notify();

      // Fire and forget — processNext will be called again on completion
      this.runJob(next).finally(() => {
        this.runningCount--;
        this.processNext();
      });
    }
  }

  private async runJob(job: Job): Promise<void> {
    try {
      await this.handler!(job);
      job.status = "done";
      job.completedAt = new Date().toISOString();
    } catch (err) {
      job.status = "failed";
      job.completedAt = new Date().toISOString();
      job.error = err instanceof Error ? err.message : String(err);
      ui.error(`[job-queue] ${job.type} job failed: ${job.error}`);
    }
    this.notify();
  }
}

/** Create a job ID. */
export function createJobId(): string {
  return crypto.randomUUID();
}
