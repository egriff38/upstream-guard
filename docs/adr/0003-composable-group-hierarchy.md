# Composable group hierarchy with explicit extends chains

Permission groups are composable TypeScript values with an `extends` field, forming a capability lattice (e.g. `git:readonly ⊂ git:localCommit ⊂ git:remoteAuthor`). Granting a group implicitly grants all groups in its `extends` chain. Patterns and groups are declared independently; patterns reference a group by value.

The alternative was a flat allow-list of patterns (the current model), where every new permission requires a new entry with no relationship to existing ones. Flat lists don't express "this task needs write access, which implies read access." They also make it impossible for a skill or subagent to declare its needs in terms a user can reason about — `request_permission_lease({ group: "git:remoteAuthor" })` is auditable; a flat list of 12 regexes is not.

The hierarchy also enables the dialog to offer "Allow all path=~/foo" as a session-scoped binding against a named group, rather than persisting an exact command string. The scope tier (task / session / persistent) is a property of the grant, not the pattern — the same group can be granted narrowly for one task or permanently.
