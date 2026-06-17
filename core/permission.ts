import { Context, Effect, Layer } from "effect"
import type { Group, MatchResult, Pattern } from "./types.ts"
import { Permissions, PermissionsLayer } from "./config.ts"

// ── Traversal ─────────────────────────────────────────────────────────────────

const flattenPatterns = (g: Group, seen = new Set<string>()): ReadonlyArray<Pattern> => {
  if (seen.has(g.name)) return []
  seen.add(g.name)
  return [
    ...(g.extends ?? []).flatMap(p => flattenPatterns(p, seen)),
    ...g.patterns,
  ]
}

// ── Shape ─────────────────────────────────────────────────────────────────────

export interface PermissionServiceShape {
  readonly check: (cmd: string) => MatchResult | null
  readonly groups: ReadonlyArray<Group>
}

// ── Tag ───────────────────────────────────────────────────────────────────────

export const PermissionService = Context.Service<PermissionServiceShape>(
  "upstream-guard/PermissionService"
)
export type PermissionService = typeof PermissionService

// ── Layer ─────────────────────────────────────────────────────────────────────

export const PermissionServiceLayer = Layer.effect(
  PermissionService,
  Effect.gen(function* () {
    const { groups } = yield* Permissions

    const check = (cmd: string): MatchResult | null => {
      for (const g of groups) {
        for (const p of flattenPatterns(g)) {
          const m = cmd.match(p.regex)
          if (m) return { group: g, pattern: p, captures: m.groups ?? {} }
        }
      }
      return null
    }

    return { check, groups }
  }),
).pipe(Layer.provide(PermissionsLayer))

// ── Shell segment splitter ────────────────────────────────────────────────────

export const splitShellSegments = (cmd: string): ReadonlyArray<string> => {
  const segments: string[] = []
  let current = ""
  let quote: string | null = null

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!
    if (quote) {
      current += ch
      if (ch === quote) quote = null
    } else if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
    } else if (
      (ch === "&" && cmd[i + 1] === "&") ||
      (ch === "|" && cmd[i + 1] === "|")
    ) {
      segments.push(current.trim())
      current = ""
      i++
    } else if (ch === ";") {
      segments.push(current.trim())
      current = ""
    } else {
      current += ch
    }
  }
  if (current.trim()) segments.push(current.trim())
  return segments.filter(s => s.length > 0)
}
