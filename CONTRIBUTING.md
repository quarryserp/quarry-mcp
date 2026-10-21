# Contributing

Issues and reproduction cases are welcome. Code is mirrored from Quarry's internal repository, which is the source of truth; pull requests are reviewed and ported there before the mirror is updated.

Install Bun and Node.js 20 or later, then run `bun install`, `bun run typecheck`, `bun test`, `bun run build`, and `npm pack --dry-run`. Local Bun locks are disposable; the exporter always starts from the versioned dependency declarations.
