# Contributing to Toban CLI

Thanks for your interest in contributing to Toban CLI!

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/toban-cli.git`
3. Install dependencies: `npm install`
4. Build: `npm run build`
5. Run tests: `npm test`

## Development

```bash
npm run build        # Build with tsup
npm run typecheck    # Type checking
npm test             # Run tests
npm run dev          # Direct execution with tsx
```

## Pull Request Process

1. Create a feature branch from `main`
2. Make your changes with tests
3. Ensure `npm run build && npm run typecheck && npm test` all pass
4. Submit a PR with a clear description of what and why

## Code Style

- TypeScript strict mode, ESM modules
- Keep changes minimal and focused
- No unnecessary abstractions — simple code over clever code
- See the project's ADRs for architectural decisions

## Reporting Issues

- Use [GitHub Issues](https://github.com/totte-dev/toban-cli/issues) for bugs and feature requests
- Include reproduction steps for bugs
- For security vulnerabilities, see [SECURITY.md](./SECURITY.md)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
