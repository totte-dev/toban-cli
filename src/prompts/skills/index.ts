/**
 * Skills knowledge base for Reviewer prompt injection.
 *
 * Each skill provides domain-specific review criteria that are
 * injected into the Reviewer prompt via {{customReviewRules}}.
 */

export const SKILL_KNOWLEDGE: Record<string, string> = {

  "cloudflare-workers": `## Cloudflare Workers Review Criteria
- Workers run in V8 isolates — no shared state between requests unless using Durable Objects
- Module-level variables persist within a single isolate but NOT across edge locations
- CPU time limited (10ms free, 50ms paid per request)
- Memory limited (~128MB per isolate)
- No filesystem access, no native modules
- In-memory Maps for rate limiting only work per-isolate — ineffective at scale
- Use Durable Objects or KV for persistent state
- Workers restart frequently — in-memory state is ephemeral
- Check: proper use of ctx.waitUntil for background work
- Check: no blocking operations that exceed CPU limits
- Check: secrets via environment bindings, never hardcoded`,

  "security-audit": `## Security Review Criteria
- Input validation: all user input validated via Zod or equivalent at API boundaries
- SQL injection: prepared statements only, never string concatenation
- XSS: output escaped for context (HTML, JS, URL)
- Authentication: session tokens httpOnly, Secure, SameSite
- Authorization: workspace-scoped access enforced on every endpoint
- Secrets: never in code, environment variables or secret store only
- CORS: specific origins, not wildcard
- Rate limiting: in place for auth and API endpoints
- Error messages: no internal details leaked to client
- Dependencies: no known critical vulnerabilities (npm audit)`,

  "typescript-strict": `## TypeScript Review Criteria
- Strict mode enabled, no any types
- Proper error handling (no empty catch blocks without comment)
- Interfaces over type aliases for object shapes
- No non-null assertions (!) without justification
- Async/await properly used (no floating promises)
- Enum alternatives: const objects or union types preferred
- Return types explicitly declared on public functions`,

  "testing": `## Testing Review Criteria
- New functions have corresponding tests
- Edge cases covered: null, empty, boundary values
- Tests assert behavior, not implementation (no mock-return testing)
- Integration tests for API endpoints (status + body)
- Test names describe the expected behavior
- No flaky tests (no timing-dependent assertions)
- Coverage threshold met for changed files`,

};

export function getSkillKnowledge(skills: string[]): string {
  const blocks: string[] = [];
  for (const skill of skills) {
    const knowledge = SKILL_KNOWLEDGE[skill];
    if (knowledge) blocks.push(knowledge);
  }
  return blocks.join("\n\n");
}

export function getAvailableSkills(): string[] {
  return Object.keys(SKILL_KNOWLEDGE);
}
