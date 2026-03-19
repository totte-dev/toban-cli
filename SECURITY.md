# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Toban CLI, please report it responsibly:

1. **Do not** open a public GitHub issue
2. Use [GitHub Security Advisories](https://github.com/totte-dev/toban-cli/security/advisories/new) to submit a private report
3. Or contact us via [X DM (@recuupfeg)](https://x.com/recuupfeg)
4. Include steps to reproduce and potential impact

We aim to acknowledge reports within 48 hours and provide fixes within 7 days for critical issues.

## Supported Versions

| Version | Supported |
|---------|-----------|
| latest  | Yes       |

## Security Model

- Agents run in isolated git worktrees (not your working directory)
- The CLI never stores your Anthropic API key — Claude Code handles its own auth
- Toban API keys are workspace-scoped and transmitted over HTTPS
- Git operations use short-lived GitHub App installation tokens (1-hour expiry)

For the full security guide, see [Security Documentation](https://app.toban.dev/docs/security).
