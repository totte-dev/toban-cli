/**
 * Sprint statistics computation.
 *
 * Computes completion rate, story point stats, and task duration
 * from sprint task data for retrospective/completed phase summaries.
 */

export interface TaskInput {
  id: string;
  title: string;
  status: string;
  story_points?: number;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface TaskDuration {
  title: string;
  durationMinutes: number;
}

export interface SprintStats {
  totalTasks: number;
  doneTasks: number;
  completionRate: number;
  tasksByStatus: Record<string, number>;
  totalStoryPoints: number;
  doneStoryPoints: number;
  taskDurations: TaskDuration[];
  avgDurationMinutes: number | null;
}

export function buildSprintStats(tasks: TaskInput[]): SprintStats {
  const totalTasks = tasks.length;
  const tasksByStatus: Record<string, number> = { todo: 0, in_progress: 0, review: 0, done: 0 };

  let totalStoryPoints = 0;
  let doneStoryPoints = 0;
  const taskDurations: TaskDuration[] = [];

  for (const task of tasks) {
    const status = task.status;
    tasksByStatus[status] = (tasksByStatus[status] ?? 0) + 1;

    if (typeof task.story_points === "number") {
      totalStoryPoints += task.story_points;
      if (status === "done") {
        doneStoryPoints += task.story_points;
      }
    }

    if (status === "done" && task.created_at && task.updated_at) {
      const start = new Date(task.created_at).getTime();
      const end = new Date(task.updated_at).getTime();
      if (!isNaN(start) && !isNaN(end) && end > start) {
        taskDurations.push({
          title: task.title,
          durationMinutes: Math.round((end - start) / 60_000),
        });
      }
    }
  }

  const doneTasks = tasksByStatus.done;
  const completionRate = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;
  const avgDurationMinutes = taskDurations.length > 0
    ? Math.round(taskDurations.reduce((sum, d) => sum + d.durationMinutes, 0) / taskDurations.length)
    : null;

  return {
    totalTasks,
    doneTasks,
    completionRate,
    tasksByStatus,
    totalStoryPoints,
    doneStoryPoints,
    taskDurations,
    avgDurationMinutes,
  };
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0 && days === 0) parts.push(`${mins}m`);
  return parts.join(" ");
}

export function formatSprintStats(stats: SprintStats): string {
  if (stats.totalTasks === 0) return "";

  const lines: string[] = [];
  lines.push("### Sprint Statistics");
  lines.push(`  - Completion: ${stats.doneTasks}/${stats.totalTasks} tasks (${stats.completionRate}%)`);
  lines.push(`  - Status: ${stats.tasksByStatus.done} done, ${stats.tasksByStatus.review} review, ${stats.tasksByStatus.in_progress} in_progress, ${stats.tasksByStatus.todo} todo`);

  if (stats.totalStoryPoints > 0) {
    lines.push(`  - Story Points: ${stats.doneStoryPoints}/${stats.totalStoryPoints} SP`);
  }

  if (stats.taskDurations.length > 0) {
    lines.push(`  - Avg Duration: ${formatDuration(stats.avgDurationMinutes!)}`);
    lines.push("  - Task Durations:");
    for (const td of stats.taskDurations) {
      lines.push(`    - ${td.title}: ${formatDuration(td.durationMinutes)}`);
    }
  }

  return lines.join("\n");
}
