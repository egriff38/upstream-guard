import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

// ─────────────────────────────────────────────────────────────────────────────
// upstream-guard
//
// Allow-list approach: commands matching ALLOW pass through silently.
// Everything else gets a three-way dialog:
//   • Allow once   — proceeds this time only
//   • Always allow — persists the exact command to allowed.json
//   • Deny         — blocks and tells the LLM why
//
// Also intercepts MCP tools that make upstream writes to GitHub.
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_FILE =
  new URL("allowed.json", import.meta.url).pathname;

// ── Built-in allow-list (regex patterns) ──────────────────────────────────────
//
// Patterns are prefix-anchored (^) where appropriate.
// Any command matching one of these passes without a prompt.
const ALLOW: ReadonlyArray<RegExp> = [
  // ── Shell navigation / inspection ─────────────────────────────────────────
  /^(ls|ll|la|l)\b/,
  /^(cat|less|more|head|tail|wc|tee)\b/,
  /^(echo|printf|pwd|cd|pushd|popd|which|type|where|man|help)\b/,
  /^(clear|reset|exit|fg|bg|jobs)\b/,
  /^(date|cal|uptime|uname|hostname|id|whoami)\b/,
  /^(open\s|code\b|cursor\b)/,
  /^(jq|awk|sed|grep|rg|fd|find|sort|uniq|cut|tr|xargs|comm|diff|wc)\b/,
  /^(sqlite3|python3?\s+-[cm]|node\s+-e)\b/,
  /^(afplay|pbpaste|pbcopy)\b/,
  /^(kill|lsof|ps)\b/,
  /^(mkdir|touch|mktemp)\b/,
  // cp is safe unless targeting system paths
  /^cp\b(?!.*\s\/etc\/|\s~\/\.aws\/)/,

  // ── Git: read-only ─────────────────────────────────────────────────────────
  /^git\s+(status|diff|log|show|branch|remote|tag|describe|shortlog|blame|fetch)\b/,
  /^git\s+(stash\s+(list|show)|worktree\s+list|ls-tree|ls-files|rev-parse)\b/,
  /^(gs|gd|glgga|glo|glog|gst)\b/,

  // ── Git: safe local mutations (no upstream) ────────────────────────────────
  /^git\s+(add|commit|stash|checkout|switch|restore|merge|rebase|cherry-pick)\b/,
  /^git\s+reset\b(?!.*--hard)/,                          // soft/mixed only
  /^git\s+worktree\s+(add|prune|remove)\b(?!.*--force)/, // remove --force requires confirm
  /^git\s+(pull|fetch)\b/,
  /^git-crypt\s+(status|unlock|lock)\b/,
  /^(ga\b|gc\b|gco\b|gcm\b|gcd\b|gf\b|gl\b|gb\b)/,

  // ── pnpm: local-only operations ────────────────────────────────────────────
  /^pnpm\s+(install|i)\b/,
  /^pnpm\s+(build|typecheck|lint|test|dev|e2e|knip|taze)\b/,
  /^pnpm\s+(-w|--workspace-root)\s+(turbo:|typecheck|lint|test|build|e2e)\b/,
  /^pnpm\s+(-r|--recursive)\s+(build|typecheck|lint)\b/,
  /^pnpm\s+(--filter|-F)\s+\S+\s+(dev|build|typecheck|lint|test|e2e)\b/,
  /^pnpm\s+(--filter|-F)\s+\S+\s+(backfill|diagnose|listTranscripts|printEnv|print-env|diagnose-office|update-sked-client|passphrase)\b/,
  /^pnpm\s+(--filter|-F)\s+\S+\s+add-number\b/,
  /^pnpm\s+exec\s+(tsc|cdk\s+synth|cdk\s+ls|turbo)\b/,
  /^pnpm\s+(turbo:|ls|list|audit|why|outdated|approve-builds)\b/,
  /^pnpm\s+(print-env|printEnv)\b/,
  /^pnpm\s+link-plugins\b/,
  /^pnpm\s+(-w\s+)?e2e\b/,
  /pnpm.*--dry-run/,

  // ── AWS: read-only ─────────────────────────────────────────────────────────
  /^aws\s+s3\s+ls\b/,
  /^aws\s+(cloudformation|cfn)\s+(describe|list|get|validate)\b/,
  /^aws\s+logs\s+(tail|filter-log-events|describe|get)\b/,
  /^aws\s+ssm\s+(get|list|describe)\b/,
  /^aws\s+lambda\s+(list|get)\b/,
  /^aws\s+sts\s+get-caller-identity\b/,
  /^aws\s+sso\s+login\b/,
  /^aws\s+stepfunctions\s+(list|describe|get)\b/,
  /^aws\s+secretsmanager\s+(list|describe|get)\b/,

  // ── curl: GET-only ─────────────────────────────────────────────────────────
  /^curl\b(?![\s\S]*-X\s*(POST|PUT|PATCH|DELETE))/i,

  // ── Node / build tools ─────────────────────────────────────────────────────
  /^(node|tsx|tsc|npx\s+tsc|npx\s+knip|npx\s+taze|npx\s+skills\s+(find|list|search))\b/,
  /^bun\s+run\b/,
  /^bun\s+upgrade\b/,

  // ── Package managers: read-only ────────────────────────────────────────────
  /^brew\s+(info|search|list|doctor|outdated|deps)\b/,
  /^npm\s+(list|ls|outdated|audit|info|view|run\s+(build|test|lint))\b/,

  // ── GitHub CLI: read-only ──────────────────────────────────────────────────
  /^gh\s+pr\s+(list|view|status|diff|checkout)\b/,
  /^gh\s+repo\s+(list|view|clone)\b/,
  /^gh\s+run\s+(list|view)\b/,
  /^gh\s+issue\s+(list|view)\b/,
  /^gh\s+api\s+repos\b/,

  // ── GitLab CLI: read-only ──────────────────────────────────────────────────
  /^glab\s+(issue|mr|project|repo)\s+(list|view|get)\b/,

  // ── Local env / secrets: read ──────────────────────────────────────────────
  /^(loadAlinaEnv|source\s|exec\s+scripts\/load-env)\b/,
  /^secretspec\s+check\b/,
  /^op\s+read\b/,
  /^ssh-add\s+-l\b/,

  // ── Navigation utilities ───────────────────────────────────────────────────
  /^(z\b|ghq\s+(list|look|ls)|branchyard)\b/,
  /^(direnv\s+(allow|status|show))\b/,
  /^(gwt|gws)\s+(list|ls|prune|status|-h)\b/,

  // ── Misc safe ─────────────────────────────────────────────────────────────
  /^(omp|claude|codex)\s*(-h|--help|list|resume|agents|-v|--version)\b/,
  /^nix(-build)?\s+.*--dry-run\b/,
  /^nix\s+(develop|--help|--version)\b/,
  /^(cabal|ghci|ghc)\b/,
  /^export\s+\w+=/,
  /^unset\s+\w+/,
  /^(source|\.)\s+/,
  /^STACK_ID=/,
];

// MCP tools that write to remote systems — always prompt regardless
const UPSTREAM_MCP_TOOLS: ReadonlySet<string> = new Set([
  "mcp__github_push_files",
  "mcp__github_create_or_update_file",
  "mcp__github_delete_file",
  "mcp__github_merge_pull_request",
  "mcp__github_create_pull_request",
  "mcp__github_create_branch",
  "mcp__github_update_pull_request",
  "mcp__github_create_repository",
  "mcp__github_fork_repository",
]);

// ── Persistent allow-list ─────────────────────────────────────────────────────
//
// Stores exact command strings the user has chosen to "Always allow".
// File: ~/.omp/agent/extensions/upstream-guard/allowed.json
//
// Commands are matched by exact equality against the trimmed input.
// To allow a class of commands, edit the file and add a line manually —
// the extension re-reads the file at each session start.

const persistentAllowed = new Set<string>();

function loadPersistentAllowed(): void {
  try {
    const raw = readFileSync(ALLOWED_FILE, "utf8");
    const entries: unknown = JSON.parse(raw);
    if (Array.isArray(entries)) {
      persistentAllowed.clear();
      for (const e of entries) {
        if (typeof e === "string") persistentAllowed.add(e);
      }
    }
  } catch {
    // File doesn't exist yet — that's fine.
  }
}

function savePersistentAllowed(): void {
  mkdirSync(dirname(ALLOWED_FILE), { recursive: true });
  writeFileSync(
    ALLOWED_FILE,
    JSON.stringify([...persistentAllowed].sort(), null, 2) + "\n",
    "utf8",
  );
}

// ── Core check ────────────────────────────────────────────────────────────────

function isAllowed(cmd: string): boolean {
  const trimmed = cmd.trimStart();
  return (
    persistentAllowed.has(trimmed) || ALLOW.some((p) => p.test(trimmed))
  );
}

// ── Compound-command splitter ─────────────────────────────────────────────────
//
// Splits a shell command on &&, ||, and ; without breaking on those characters
// that appear inside single- or double-quoted strings.
//
// The approach: walk character-by-character tracking quote state; whenever we
// hit an unquoted operator token, flush the current segment.  We do NOT handle
// backtick sub-shells or $(...) — those are rare and the guard should prompt
// on them anyway because the inner command won't be on the allow-list.

function splitShellSegments(cmd: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  const flush = () => {
    const s = current.trim();
    if (s) segments.push(s);
    current = "";
  };

  while (i < cmd.length) {
    const ch = cmd[i];

    if (inSingle) {
      if (ch === "'") inSingle = false;
      current += ch;
      i++;
      continue;
    }

    if (inDouble) {
      // Inside double-quotes a backslash can escape the next char.
      if (ch === "\\" && i + 1 < cmd.length) {
        current += ch + cmd[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inDouble = false;
      current += ch;
      i++;
      continue;
    }

    // Unquoted — check for quote openers first.
    if (ch === "'") { inSingle = true; current += ch; i++; continue; }
    if (ch === '"') { inDouble = true; current += ch; i++; continue; }

    // Check for &&, ||, or ;
    if ((ch === "&" || ch === "|") && cmd[i + 1] === ch) {
      flush();
      i += 2;
      continue;
    }
    if (ch === ";") {
      flush();
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  flush();
  return segments.length > 0 ? segments : [cmd.trim()];
}

// ── Permission dialog ─────────────────────────────────────────────────────────

const OPT_ONCE   = "Allow once";
const OPT_ALWAYS = "Always allow";
const OPT_DENY   = "Deny";

async function requestPermission(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  title: string,
  cmd: string,
): Promise<"once" | "always" | "deny"> {
  if (!ctx.hasUI) return "deny";

  const display = cmd.length > 300 ? cmd.slice(0, 300) + "…" : cmd;

  pi.events.emit("herdr:blocked", { active: true, label: "Waiting for confirmation…" });
  ctx.ui.setWorkingMessage("Waiting for confirmation…");
  let choice: string | undefined;
  try {
    choice = await ctx.ui.select(
      `${title}: ${display}`,
      [OPT_ONCE, OPT_ALWAYS, OPT_DENY],
    );
  } finally {
    pi.events.emit("herdr:blocked", { active: false });
    ctx.ui.setWorkingMessage(undefined);
  }

  if (choice === OPT_ALWAYS) return "always";
  if (choice === OPT_ONCE)   return "once";
  return "deny"; // undefined (dismissed) or OPT_DENY
}

// ── Extension entry point ─────────────────────────────────────────────────────

export default function upstreamGuard(pi: ExtensionAPI) {
  pi.setLabel("Upstream Guard");

  pi.on("session_start", async () => {
    loadPersistentAllowed();
  });

  pi.on("tool_call", async (event, ctx) => {
    // ── bash: allow-list gate ────────────────────────────────────────────────
    if (event.toolName === "bash") {
      const cmd = String(event.input.command ?? "").trim();
      if (!cmd) return;
      const segments = splitShellSegments(cmd);
      if (segments.every(isAllowed)) return;

      const decision = await requestPermission(ctx, pi, "Allow command?", cmd);

      if (decision === "always") {
        persistentAllowed.add(cmd);
        savePersistentAllowed();
        ctx.ui.notify(`Added to allow-list: ${cmd.slice(0, 80)}`, "info");
        return; // proceed
      }

      if (decision === "once") return; // proceed, don't persist

      return {
        block: true,
        reason: ctx.hasUI
          ? "User denied command."
          : `Command not on allow-list (no UI to confirm): ${cmd.slice(0, 120)}`,
      };
    }

    // ── MCP upstream writes ──────────────────────────────────────────────────
    if (UPSTREAM_MCP_TOOLS.has(event.toolName)) {
      const label = event.toolName
        .replace("mcp__github_", "")
        .replace(/_/g, " ");
      const detail = JSON.stringify(event.input, null, 2);
      const decision = await requestPermission(
        ctx,
        pi,
        `Allow upstream: ${label}?`,
        detail,
      );

      if (decision === "always") {
        // For MCP tools we store "mcp:<toolName>" so it doesn't clash with bash entries
        const key = `mcp:${event.toolName}`;
        persistentAllowed.add(key);
        savePersistentAllowed();
        ctx.ui.notify(`${label} will always be allowed`, "info");
        return;
      }

      if (decision === "once") return;

      return {
        block: true,
        reason: ctx.hasUI
          ? "User denied upstream operation."
          : `Upstream tool ${event.toolName} requires UI confirmation.`,
      };
    }
  });
}
