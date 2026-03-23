import { describe, it, expect, vi } from "vitest";
import { extractCompletionJson } from "../utils/completion-parser.js";
import type { BuilderRecord } from "../utils/completion-schema.js";
import type { TemplateAction } from "../agents/agent-templates.js";

describe("review-record: builder_record extraction", () => {
  const makePostActions = (): TemplateAction[] => [
    { type: "update_task", when: "success", params: { status: "review" } },
  ];

  it("extracts builder_record from COMPLETION_JSON line", () => {
    const lines = [
      'COMPLETION_JSON:{"review_comment":"summary","commits":"abc","builder_record":{"intent":"Fix auth bug","changes_summary":["Added JWT validation"],"risks":["No integration tests"]}}',
    ];
    let captured: BuilderRecord | undefined;
    extractCompletionJson(lines, makePostActions(), {
      onBuilderRecord: (r) => { captured = r; },
    });
    expect(captured).toBeDefined();
    expect(captured!.intent).toBe("Fix auth bug");
    expect(captured!.changes_summary).toEqual(["Added JWT validation"]);
    expect(captured!.risks).toEqual(["No integration tests"]);
  });

  it("extracts builder_record from stream-json result event", () => {
    const lines = [
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: 'Some preamble\nCOMPLETION_JSON:{"review_comment":"done","commits":"","builder_record":{"intent":"Refactor","changes_summary":["Split module"],"risks":[]}}',
      }),
    ];
    let captured: BuilderRecord | undefined;
    extractCompletionJson(lines, makePostActions(), {
      onBuilderRecord: (r) => { captured = r; },
    });
    expect(captured).toBeDefined();
    expect(captured!.intent).toBe("Refactor");
    expect(captured!.changes_summary).toEqual(["Split module"]);
    expect(captured!.risks).toEqual([]);
  });

  it("handles missing builder_record gracefully", () => {
    const lines = [
      'COMPLETION_JSON:{"review_comment":"no builder record","commits":"abc"}',
    ];
    let captured: BuilderRecord | undefined;
    extractCompletionJson(lines, makePostActions(), {
      onBuilderRecord: (r) => { captured = r; },
    });
    expect(captured).toBeUndefined();
  });

  it("handles string risks (non-array) by wrapping in array", () => {
    const lines = [
      'COMPLETION_JSON:{"review_comment":"test","commits":"","builder_record":{"intent":"Fix","changes_summary":"single change","risks":"single risk"}}',
    ];
    let captured: BuilderRecord | undefined;
    extractCompletionJson(lines, makePostActions(), {
      onBuilderRecord: (r) => { captured = r; },
    });
    expect(captured).toBeDefined();
    expect(captured!.changes_summary).toEqual(["single change"]);
    expect(captured!.risks).toEqual(["single risk"]);
  });

  it("handles builder_record with empty fields", () => {
    const lines = [
      'COMPLETION_JSON:{"review_comment":"test","commits":"","builder_record":{"intent":"","changes_summary":[],"risks":[]}}',
    ];
    let captured: BuilderRecord | undefined;
    extractCompletionJson(lines, makePostActions(), {
      onBuilderRecord: (r) => { captured = r; },
    });
    expect(captured).toBeDefined();
    expect(captured!.intent).toBe("");
    expect(captured!.changes_summary).toEqual([]);
    expect(captured!.risks).toEqual([]);
  });

  it("does not call onBuilderRecord when builder_record is not an object", () => {
    const lines = [
      'COMPLETION_JSON:{"review_comment":"test","commits":"","builder_record":"not an object"}',
    ];
    let captured: BuilderRecord | undefined;
    extractCompletionJson(lines, makePostActions(), {
      onBuilderRecord: (r) => { captured = r; },
    });
    expect(captured).toBeUndefined();
  });
});
