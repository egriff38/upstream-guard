# Upstream Guard

A permission extension for OMP that intercepts bash commands and MCP tool calls, requiring user approval before execution. This context covers the permission model, its runtime semantics, and the negotiation flow for customizing permissions interactively.

## Language

### Permission Model

**Allow-list**:
The set of patterns (built-in and user-defined) that a command must match to execute without prompting. Split into a hardcoded built-in layer and a user-managed persistent layer.

**Pattern**:
A regex string that matches a class of commands. May contain named capture groups that bind values to lease variables when matched.

**Named capture** (also: lease capture):
A regex named group in a pattern whose name begins with `allowed` (e.g. `(?<allowedPath>[\w\/~]+)`). When a command matches the pattern, the captured value can be promoted into a session lease binding by the user.
_Avoid_: variable, slot, placeholder

**Group**:
A named, composable collection of patterns with a default scope tier. Groups form a capability lattice via `extends` chains — granting a group implicitly grants all groups it extends. The unit of permission that gets granted. Patterns reference a group; grants reference a group.
_Avoid_: policy, role, profile

**Grant**:
A runtime record binding a group to a specific set of lease variable values and a scope tier. Not a pattern — a specific, scoped activation of a group.
_Avoid_: permission, rule, token

**Lease variable**:
A named binding (e.g. `allowedPath → ~/projects/foo`) held in memory for the duration of a grant's scope. Future commands matching a pattern with the same capture name auto-allow only if their captured value equals the bound value.
_Avoid_: variable, context, session variable

**Scope tier**:
The lifetime of a grant. One of: task (lives for a subagent invocation), session (lives until the OMP session ends, persisted in the session log), or persistent (written to `permissions.ts`, survives across sessions).

### Files

**`permissions/*.ts`** (also: permissions module):
TypeScript source files declaring groups and patterns. Loaded by the extension at startup via a path resolved from `config.json`. Owned by the user's permissions repo. The negotiation agent writes here; the extension imports the result. On import error the extension stashes the bad commit and notifies the user.
_Avoid_: config, allow-list, policy file

**Permissions repo**:
A standalone git repo containing the user's `permissions/*.ts` files. Linked to the extension via a path in `config.json` (`permissionsRepo`). Independent of the upstream-guard repo — evolves on its own cadence, can have multiple remotes (personal, team, community) for cherry-picking patterns.

**Config pointer**:
The `permissionsRepo` field in `config.json` that tells the extension where to find the permissions repo. Falls back to `./permissions/` (bundled minimal defaults) when absent.

**`allowed.json`**:
Deprecated. The former persistent allow-list of exact command strings. Migrated to `permissions/legacy.ts` as the negotiation agent converts entries to real patterns. Read-only after migration.

**Built-in allow-list**:
The hardcoded `ALLOW[]` array in `index.ts`. Immutable system defaults. The negotiation agent can read but never write these.

### Negotiation Flow

**Negotiation agent**:
A second OMP instance spawned in a side pane by the upstream-guard extension when the user selects "Customize permissions." Receives a handoff describing the flagged command(s), proposes pattern additions and groups, and writes approved grants/patterns only after explicit user confirmation.

**Negotiation pane**:
The herdr pane hosting the negotiation agent. Opened by splitting the current pane. Reused across multiple "Customize permissions" invocations in the same session.

**Handoff**:
A JSON file written by the upstream-guard extension describing the blocked command(s), current allow-list state, and any active session bindings. Passed to the negotiation agent at startup.

**Sentinel**:
A specific string output by the negotiation agent to its terminal (e.g. `GRANTS_APPLIED`) to signal that the user has approved and grants have been written. Detected by the main pane via `herdr wait output`.

**Permission lease request**:
A tool call (`request_permission_lease`) made by a skill or subagent at the start of its run, declaring the groups and bindings it needs. The extension intercepts it, prompts the user, and grants task-scoped or session-scoped approval.
The batch form (`leases: [...]`) is standard — a skill declares all its needs in one call so the user sees the full picture before approving.

### Dialog Options

**Allow once**:
Proceeds this invocation only. No grant is created; no bindings are stored.

**Allow all `<capture>=<value>`**:
Creates a session-scoped grant binding the named capture to its matched value. Shown only when the matched pattern has a named capture group.

**Customize permissions**:
Opens (or re-focuses) the negotiation pane and passes the current blocked command as a new prompt to the negotiation agent.

**Deny**:
Blocks the command and tells the model why.
