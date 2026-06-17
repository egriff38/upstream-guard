# upstream-guard

OMP extension: intelligent permission negotiation for bash commands and MCP tool calls.

## Requirements

- **OMP** (`oh-my-pi`) — tested against the version that ships `@oh-my-pi/pi-coding-agent`
- **herdr** — required for the negotiation pane (permission customization flow)
- **Bun ≥ 1.1** or **Node ≥ 22 + tsx** — OMP loads `.ts` extensions natively; no build step
- **pnpm** — for installing dependencies

## Setup

```bash
# 1. Clone upstream-guard into your OMP extensions directory
git clone git@github.com:egriff38/upstream-guard.git ~/.omp/agent/extensions/upstream-guard
cd ~/.omp/agent/extensions/upstream-guard && pnpm install

# 2. Clone (or fork) the permissions repo
git clone git@github.com:egriff38/upstream-guard-permissions.git ~/.omp/permissions

# 3. Point the extension at your permissions repo (machine-local, not committed)
echo '{ "permissionsRepo": "~/.omp/permissions" }' > ~/.omp/agent/extensions/upstream-guard/config.json
```

Restart OMP after setup. The extension loads `config.json` at session start and imports groups from the resolved `permissionsRepo` path.

## Architecture

See [`CONTEXT.md`](./CONTEXT.md) for the domain glossary and [`docs/adr/`](./docs/adr/) for key decisions.

- **`index.ts`** — OMP extension adapter (thin Promise layer over the Effect domain)
- **`permissions/`** — lives in a separate repo linked via `config.json`; the negotiation agent writes here
- **`allowed.json`** — deprecated; entries are migrated to `permissions/legacy.ts` over time

## Permissions repo

Default groups: [`github.com/egriff38/upstream-guard-permissions`](https://github.com/egriff38/upstream-guard-permissions)

Fork it, add a personal remote, cherry-pick patterns from others.
