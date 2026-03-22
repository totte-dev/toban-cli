import { describe, it, expect } from "vitest";
import { buildGuardrailRules, checkDiffViolations } from "../utils/guardrail.js";

describe("guardrail", () => {
  describe("buildGuardrailRules", () => {
    it("returns default rules when config is null (standard mode)", () => {
      const rules = buildGuardrailRules(null, false);
      expect(rules.length).toBeGreaterThanOrEqual(2);
      expect(rules[0]).toContain("npm publish");
      expect(rules[1]).toContain(".env");
    });

    it("returns stricter rules in auto mode", () => {
      const rules = buildGuardrailRules(null, true);
      expect(rules[0]).toContain("vercel");
      expect(rules[0]).toContain("gh pr");
      expect(rules[1]).toContain("LICENSE");
      expect(rules.length).toBeGreaterThanOrEqual(4); // + deps + network rules
    });

    it("uses custom config when provided", () => {
      const rules = buildGuardrailRules({
        command_blocklist: ["custom-cmd"],
        file_blocklist: ["custom-file"],
      }, false);
      expect(rules[0]).toContain("custom-cmd");
      expect(rules[1]).toContain("custom-file");
    });

    it("adds deps deny rule when policy is deny", () => {
      const rules = buildGuardrailRules({ deps_policy: "deny" }, false);
      expect(rules.some((r) => r.includes("Do NOT add new dependencies"))).toBe(true);
    });

    it("adds network deny rule when policy is deny", () => {
      const rules = buildGuardrailRules({ external_network: "deny" }, false);
      expect(rules.some((r) => r.includes("Do NOT make HTTP requests"))).toBe(true);
    });
  });

  describe("checkDiffViolations", () => {
    it("detects .env file modifications", () => {
      const diff = " 2 files changed\n src/index.ts | 5 ++\n .env.local | 1 +";
      const violations = checkDiffViolations(diff, null, false);
      expect(violations.length).toBe(1);
      expect(violations[0].rule).toBe("file_blocklist");
      expect(violations[0].operation).toContain(".env.local");
    });

    it("detects package.json changes in deny mode", () => {
      const diff = " 1 file changed\n package.json | 3 +++";
      const violations = checkDiffViolations(diff, { deps_policy: "deny" }, false);
      expect(violations.some((v) => v.rule === "deps_policy")).toBe(true);
    });

    it("allows package.json in allow mode", () => {
      const diff = " 1 file changed\n package.json | 3 +++";
      const violations = checkDiffViolations(diff, { deps_policy: "allow" }, false);
      expect(violations.some((v) => v.rule === "deps_policy")).toBe(false);
    });

    it("detects CI config changes in auto mode", () => {
      const diff = " 1 file changed\n .github/workflows/ci.yml | 5 +++++";
      const violations = checkDiffViolations(diff, null, true);
      expect(violations.some((v) => v.operation.includes(".github/workflows/ci.yml"))).toBe(true);
    });

    it("detects LICENSE changes in auto mode", () => {
      const diff = " 1 file changed\n LICENSE | 1 +";
      const violations = checkDiffViolations(diff, null, true);
      expect(violations.some((v) => v.operation.includes("LICENSE"))).toBe(true);
    });

    it("returns no violations for safe changes", () => {
      const diff = " 2 files changed\n src/app.ts | 10 +++++++---\n src/utils.ts | 5 +++++";
      const violations = checkDiffViolations(diff, null, false);
      expect(violations).toHaveLength(0);
    });

    it("uses custom file blocklist", () => {
      const diff = " 1 file changed\n config/secrets.yaml | 2 ++";
      const violations = checkDiffViolations(diff, { file_blocklist: ["config/secrets.*"] }, false);
      expect(violations.length).toBe(1);
    });
  });
});
