/** Extract useful error output from execSync failures (stderr > stdout > message). */
export function getExecError(err: unknown): string {
  const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
  const stderr = typeof e.stderr === "string" ? e.stderr : e.stderr?.toString();
  const stdout = typeof e.stdout === "string" ? e.stdout : e.stdout?.toString();
  return stderr?.trim() || stdout?.trim() || e.message || String(err);
}
