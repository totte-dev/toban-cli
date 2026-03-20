/**
 * Sprint complete command
 */

import { createApiClient } from "../api-client.js";
import { logError, CLI_ERR } from "../error-logger.js";
import * as ui from "../ui.js";
import { execSync } from "node:child_process";

export async function handleSprintComplete(apiUrl: string, apiKey: string, push: boolean): Promise<void> {
  const api = createApiClient(apiUrl, apiKey);
  ui.intro();
  const s = ui.createSpinner();

  s.start("Fetching current sprint...");
  const sprint = await api.fetchCurrentSprint();
  if (!sprint) { s.stop("No active sprint found"); ui.error("No active sprint."); process.exit(1); }
  s.stop(`Sprint #${sprint.number} (${sprint.status})`);

  if (sprint.status !== "completed") {
    s.start(`Completing sprint #${sprint.number}...`);
    try { await api.completeSprint(sprint.number); s.stop(`Sprint #${sprint.number} completed`); }
    catch (err) {
      s.stop("Failed");
      logError(CLI_ERR.ACTION_FAILED, `Sprint completion failed`, { sprintNumber: sprint.number }, err);
      ui.error(`Sprint completion failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  } else { ui.info(`Sprint #${sprint.number} already completed`); }

  const tagName = `sprint-${sprint.number}`;
  try {
    const existing = execSync(`git tag -l "${tagName}"`, { stdio: "pipe" }).toString().trim();
    if (existing) { ui.warn(`Tag ${tagName} already exists`); }
    else {
      execSync(`git tag "${tagName}"`, { stdio: "pipe" });
      const hash = execSync("git rev-parse --short HEAD", { stdio: "pipe" }).toString().trim();
      ui.step(`Tagged ${tagName} at ${hash}`);
    }
  } catch (err) { ui.warn(`Failed to create tag: ${err}`); }

  if (push) {
    try { execSync(`git push origin "${tagName}"`, { stdio: "inherit" }); ui.step(`Pushed ${tagName}`); }
    catch (err) {
      logError(CLI_ERR.ACTION_FAILED, `Failed to push tag ${tagName}`, { tagName }, err);
      ui.error(`Failed to push tag: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }
  // Proposals are now triggered at retrospective phase, not on complete

  ui.outro(`Sprint #${sprint.number} complete`);
}
