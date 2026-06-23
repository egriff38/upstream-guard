import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent"
import { Effect, Layer } from "effect"
import { readFileSync } from "fs"
import type { MatchResult } from "./core/types.ts"
import { PermissionsImportError } from "./core/config.ts"
import { PermissionService, PermissionServiceLayer, splitShellSegments } from "./core/permission.ts"
import type { PermissionServiceShape } from "./core/permission.ts"
import { LeaseService, LeaseServiceLayer } from "./core/leases.ts"
import type { LeaseServiceShape, Grant, ScopeTier } from "./core/leases.ts"

// ─────────────────────────────────────────────────────────────────────────────
// upstream-guard
//
// Commands matching the group lattice (permissions repo) pass silently.
// Unmatched commands get a four-way dialog:
//   • Allow once              — proceeds this time only
//   • Allow all <capture>=<v> — session-scoped lease binding (when captures exist)
//   • Customize permissions   — opens negotiation pane via herdr
//   • Deny                    — blocks and tells the LLM why
//
// MCP upstream writes are intercepted separately.
// Persistent allow-list (allowed.json) is read for backwards compat during
// migration. New persistent grants are written to the permissions repo.
// ─────────────────────────────────────────────────────────────────────────────

// ── Legacy allowed.json (read-only during migration) ─────────────────────────

const ALLOWED_FILE = new URL("allowed.json", import.meta.url).pathname
const legacyAllowed = new Set<string>()

function loadLegacyAllowed(): void {
  try {
    const entries: unknown = JSON.parse(readFileSync(ALLOWED_FILE, "utf8"))
    if (Array.isArray(entries)) {
      legacyAllowed.clear()
      for (const e of entries) {
        if (typeof e === "string") legacyAllowed.add(e)
      }
    }
  } catch { /* file doesn't exist yet */ }
}

// ── MCP upstream writes ───────────────────────────────────────────────────────

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
])

// ── Dialog option labels ──────────────────────────────────────────────────────

const OPT_ONCE       = "Allow once"
const OPT_CUSTOMIZE  = "Customize permissions"
const OPT_DENY       = "Deny"

// ── Permission dialog ─────────────────────────────────────────────────────────

type Decision =
  | { tag: "once" }
  | { tag: "grant"; scope: ScopeTier; bindings: Readonly<Record<string, string>> }
  | { tag: "customize" }
  | { tag: "deny" }

async function requestPermission(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  title: string,
  cmd: string,
  match: MatchResult | null,
): Promise<Decision> {
  if (!ctx.hasUI) return { tag: "deny" }

  const display = cmd.length > 300 ? cmd.slice(0, 300) + "…" : cmd

  // Build lease options from named captures with the `allowed*` convention.
  const leaseCaptures = match
    ? Object.entries(match.captures).filter(([k]) => k.startsWith("allowed"))
    : []
  const leaseLabel = leaseCaptures.length > 0
    ? `Allow all (${leaseCaptures.map(([k, v]) => `${k}=${v}`).join(", ")})`
    : null

  const opts = [
    OPT_ONCE,
    ...(leaseLabel ? [leaseLabel] : []),
    OPT_CUSTOMIZE,
    OPT_DENY,
  ]

  pi.events.emit("herdr:blocked", { active: true, label: "Waiting for confirmation…" })
  ctx.ui.setWorkingMessage("Waiting for confirmation…")
  let choice: string | undefined
  try {
    choice = await ctx.ui.select(`${title}: ${display}`, opts)
  } finally {
    pi.events.emit("herdr:blocked", { active: false })
    ctx.ui.setWorkingMessage(undefined)
  }

  if (choice === OPT_ONCE) return { tag: "once" }
  if (choice === OPT_CUSTOMIZE) return { tag: "customize" }
  if (leaseLabel && choice === leaseLabel) {
    return {
      tag: "grant",
      scope: match?.group.defaultScope ?? "session",
      bindings: Object.fromEntries(leaseCaptures),
    }
  }
  return { tag: "deny" }
}

// ── Negotiation pane ──────────────────────────────────────────────────────────

let negotiationPaneId: string | null = null

function buildNegotiationPrompt(
  blockedCmd: string,
  leases: LeaseServiceShape,
  permissions: PermissionServiceShape,
  cwd: string,
): string {
  const bindings = leases.all()
  const bindingSummary = bindings.length
    ? bindings.map(g => `  • ${g.group}: ${JSON.stringify(g.bindings)}`).join("\n")
    : "  (none)"
  const groupNames = permissions.groups.map(g => g.name).join(", ")

  return [
    `You are a permission negotiation assistant for upstream-guard.`,
    ``,
    `A command was blocked: \`${blockedCmd}\``,
    `Working directory: ${cwd}`,
    ``,
    `Active session bindings:\n${bindingSummary}`,
    ``,
    `Available permission groups: ${groupNames}`,
    `Permissions repo: ${process.env["HOME"]}/.omp/permissions/`,
    ``,
    `Review the blocked command and the existing permission groups. Suggest which group`,
    `to add a pattern to, or propose a new group with an appropriate extends chain.`,
    `Use named capture groups (?<allowedX>...) for values that should scope the lease.`,
    `Do NOT write any files until the user explicitly approves your proposal.`,
    `When approved changes are written, output the exact text GRANTS_APPLIED on its own line.`,
  ].join("\n")
}

async function openOrFocusNegotiationPane(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  blockedCmd: string,
  leases: LeaseServiceShape,
  permissions: PermissionServiceShape,
): Promise<void> {
  const prompt = buildNegotiationPrompt(blockedCmd, leases, permissions, ctx.cwd)

  if (negotiationPaneId) {
    // Re-use existing pane: send the new prompt directly to the running OMP instance.
    await pi.exec("herdr", ["agent", "wait", negotiationPaneId, "--status", "idle", "--timeout", "10000"])
      .catch(() => { /* best-effort — send anyway */ })
    await pi.exec("herdr", ["agent", "send", negotiationPaneId, prompt])
    return
  }

  // Split a new pane to the right, don't steal focus.
  const splitResult = await pi.exec("herdr", [
    "pane", "split", process.env["HERDR_PANE_ID"] ?? "", "--direction", "right", "--no-focus",
  ])
  const splitParsed = JSON.parse(splitResult.stdout || "{}") as { result?: { pane?: { pane_id?: string } } }
  const paneId = splitParsed?.result?.pane?.pane_id ?? ""
  if (!paneId) {
    ctx.ui.notify("Could not open negotiation pane — is herdr running?", "error")
    return
  }
  negotiationPaneId = paneId

  // Start OMP in the new pane, then wait for it to be idle before sending the prompt.
  await pi.exec("herdr", ["pane", "run", paneId, "omp"])
  await pi.exec("herdr", ["agent", "wait", paneId, "--status", "idle", "--timeout", "30000"])
    .catch(() => { /* timeout — send anyway, OMP may still be loading */ })
  await pi.exec("herdr", ["agent", "send", paneId, prompt])
}


// ── Runtime layer ─────────────────────────────────────────────────────────────

const MainLayer = Layer.mergeAll(
  PermissionServiceLayer,
  LeaseServiceLayer,
)

// ── Extension entry point ─────────────────────────────────────────────────────

export default function upstreamGuard(pi: ExtensionAPI) {
  pi.setLabel("Upstream Guard")

  // Services are initialized once per session and reused across tool calls.
  let permissionSvc: PermissionServiceShape | null = null
  let leaseSvc: LeaseServiceShape | null = null

  const getServices = () => Effect.runPromise(
    Effect.gen(function* () {
      const p = yield* PermissionService
      const l = yield* LeaseService
      return { p, l } as const
    }).pipe(Effect.provide(MainLayer))
  )

  pi.on("session_start", async (_event, ctx) => {
    loadLegacyAllowed()

    try {
      const { p, l } = await getServices()
      permissionSvc = p
      leaseSvc = l

      // Wire appendEntry for session-scoped grant persistence.
      l.init((data: Grant) => {
        pi.appendEntry("upstream-guard:grant", data)
      })

      // Replay session-scoped grants from log.
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === "custom" && entry.customType === "upstream-guard:grant") {
          const grant = entry.data as Grant
          if (grant.scope === "session") l.restore(grant)
        }
      }
    } catch (err) {
      const msg = err instanceof PermissionsImportError
        ? `Failed to load permissions from ${err.path}. Falling back to built-in allow-list.`
        : "upstream-guard: failed to initialize permission services."
      ctx.ui.notify(msg, "error")
    }
  })

  // ── /reload-guard slash command ───────────────────────────────────────────

  pi.registerCommand("reload-guard", {
    description: "Reload the upstream-guard extension (picks up changes to index.ts or permissions repo)",
    handler: async (_args, ctx) => {
      await ctx.reload()
    },
  })


  // ── request_permission_lease tool ─────────────────────────────────────────

  const z = pi.zod

  const leaseSchema = z.object({
    group: z.string().describe("Group name, e.g. 'git:remoteAuthor'"),
    scope: z.enum(["task", "session"] as const).default("task"),
    bindings: z.record(z.string(), z.string()).optional(),
  })
  const requestLeaseParams = z.object({
    leases: z.array(leaseSchema).min(1),
    reason: z.string().describe("Why this task needs these permissions"),
  })

  // TypeBox cannot resolve the generic depth of nested zod schemas at compile time;
  // the runtime schema and execute params are correct.
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-expect-error TS2589
  pi.registerTool({
    name: "request_permission_lease",
    label: "Request Permission Lease",
    description:
      "Declare the permission groups and bindings a skill or subagent needs before starting its task. " +
      "The user is prompted once to approve, deny, or customize the full set.",
    parameters: requestLeaseParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!leaseSvc || !permissionSvc) {
        return {
          content: [{ type: "text", text: "Permission services not initialized." }],
          details: { granted: false },
        }
      }

      const display = params.leases
        .map(l => { const b = l.bindings ?? {}; return `  • ${l.group}${Object.keys(b).length ? ` (${Object.entries(b).map(([k, v]) => `${k}=${v}`).join(", ")})` : ""}` })
        .join("\n")

      pi.events.emit("herdr:blocked", { active: true, label: "Lease request…" })
      ctx.ui.setWorkingMessage("Waiting for lease approval…")
      let choice: string | undefined
      try {
        choice = await ctx.ui.select(
          `Grant permission lease?\n${params.reason}\n\n${display}`,
          ["Grant", OPT_CUSTOMIZE, OPT_DENY],
        )
      } finally {
        pi.events.emit("herdr:blocked", { active: false })
        ctx.ui.setWorkingMessage(undefined)
      }

      if (choice === "Grant") {
        for (const req of params.leases) {
          const grp = permissionSvc.groups.find(g => g.name === req.group)
          if (grp) leaseSvc.grant(grp, req.scope, req.bindings ?? {})
        }
        return {
          content: [{ type: "text", text: `Granted ${params.leases.length} lease(s).` }],
          details: { granted: true, leases: params.leases },
        }
      }

      if (choice === OPT_CUSTOMIZE) {
        await openOrFocusNegotiationPane(pi, ctx, `lease: ${params.reason}`, leaseSvc, permissionSvc)
        return {
          content: [{ type: "text", text: "Negotiation pane opened. Retry after permissions are updated." }],
          details: { granted: false, customize: true },
        }
      }

      return {
        content: [{ type: "text", text: "Permission lease denied." }],
        details: { granted: false },
      }
    },
  })

  // ── list_permission_leases tool ───────────────────────────────────────────

  pi.registerTool({
    name: "list_permission_leases",
    label: "List Permission Leases",
    description: "List all active permission leases for this session, including group name, scope, and any bound capture variables.",
    parameters: z.object({}),
    async execute(_id, _params, _signal, _onUpdate, _ctx) {
      if (!leaseSvc) {
        return { content: [{ type: "text", text: "Permission services not initialized." }] }
      }
      const grants = leaseSvc.all()
      if (grants.length === 0) {
        return { content: [{ type: "text", text: "No active leases." }] }
      }
      const lines = grants.map(g => {
        const bindings = Object.entries(g.bindings)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")
        return `  • ${g.group} [${g.scope}]${bindings ? ` (${bindings})` : ""}`
      })
      return {
        content: [{ type: "text", text: `Active leases:\n${lines.join("\n")}` }],
        details: { leases: grants },
      }
    },
  })

  // ── tool_call interceptor ─────────────────────────────────────────────────

  pi.on("tool_call", async (event, ctx) => {

    // ── bash ────────────────────────────────────────────────────────────────
    if (event.toolName === "bash") {
      const cmd = String(event.input.command ?? "").trim()
      if (!cmd) return

      // Legacy exact-match fallback during migration.
      if (legacyAllowed.has(cmd)) return

      const segments = splitShellSegments(cmd)

      if (!permissionSvc || !leaseSvc) {
        // Services failed to load — fall back to built-in ALLOW check is gone;
        // without services we must prompt rather than silently allow.
        const decision = await requestPermission(ctx, pi, "Allow command?", cmd, null)
        if (decision.tag !== "once") {
          return { block: true, reason: "Permission services unavailable; command blocked." }
        }
        return
      }

      // Check every segment. If all match (with satisfied leases), pass.
      const failing = segments.filter(seg => {
        const match = permissionSvc!.check(seg)
        if (!match) return true // no pattern → failing
        // Pattern matched. Are there lease captures that need to be verified?
        const leaseCaptures = Object.entries(match.captures).filter(([k]) => k.startsWith("allowed"))
        if (leaseCaptures.length === 0) return false // unconditional match → passing
        return !leaseSvc!.isGranted(match.group.name, match.captures)
      })

      if (failing.length === 0) return // all segments pass

      // Use the full command for the dialog (not individual segments).
      const firstMatch = permissionSvc.check(failing[0]!)
      const decision = await requestPermission(ctx, pi, "Allow command?", cmd, firstMatch)

      if (decision.tag === "once") return

      if (decision.tag === "grant") {
        const grp = firstMatch?.group
        if (grp) leaseSvc.grant(grp, decision.scope, decision.bindings)
        ctx.ui.notify(`Lease granted: ${grp?.name ?? "unknown"} for this session`, "info")
        return
      }

      if (decision.tag === "customize") {
        await openOrFocusNegotiationPane(pi, ctx, cmd, leaseSvc, permissionSvc)
        return {
          block: true,
          reason: "Customize permissions in the negotiation pane, then retry.",
        }
      }

      return {
        block: true,
        reason: ctx.hasUI ? "User denied command." : `Command blocked (no UI): ${cmd.slice(0, 120)}`,
      }
    }

    // ── MCP upstream writes ──────────────────────────────────────────────────
    if (UPSTREAM_MCP_TOOLS.has(event.toolName)) {
      const label = event.toolName.replace("mcp__github_", "").replace(/_/g, " ")
      const decision = await requestPermission(
        ctx, pi, `Allow upstream: ${label}?`,
        JSON.stringify(event.input, null, 2),
        null,
      )

      if (decision.tag === "once") return
      if (decision.tag === "grant") return // MCP tools don't use capture bindings
      if (decision.tag === "customize") {
        await openOrFocusNegotiationPane(
          pi, ctx, `mcp:${event.toolName}`, leaseSvc!, permissionSvc!
        )
      }

      return {
        block: true,
        reason: ctx.hasUI ? "User denied upstream operation." : `Upstream tool ${event.toolName} requires UI confirmation.`,
      }
    }
  })
}
