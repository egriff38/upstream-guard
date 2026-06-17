# Config pointer for permissions repo, not git submodule

The permissions repo is linked via a path in `config.json` (`permissionsRepo: "~/my-permissions"`), not as a git submodule of the upstream-guard repo.

Submodules pin a parent repo to an exact permissions commit SHA, which is valuable when the two repos have a compatibility contract. Permission patterns have no such contract with extension code — you always want the latest config, and the permissions repo's own git history is sufficient for rollback. Submodule pinning would require the negotiation agent to update the parent pointer after every commit to the permissions repo, introducing a two-step atomic write and the standard submodule footguns (detached HEAD, forgotten push ordering). The config pointer is a single path resolution: the extension reads it at startup, the negotiation agent commits directly to the target repo, done.

Community sharing (cherry-picking others' patterns) is pure git on a standalone repo — no submodule mechanics required.
