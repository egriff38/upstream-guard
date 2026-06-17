import { Context, Effect, Layer } from "effect"
import type { Group } from "./types.ts"

// ── Types ─────────────────────────────────────────────────────────────────────

export type ScopeTier = "task" | "session" | "persistent"

export interface Grant {
  readonly group: string
  readonly scope: ScopeTier
  readonly bindings: Readonly<Record<string, string>>
}

export const GRANT_ENTRY_TYPE = "upstream-guard:grant" as const

// ── Shape ─────────────────────────────────────────────────────────────────────

export interface LeaseServiceShape {
  readonly init: (append: (data: Grant) => void) => void
  readonly restore: (grant: Grant) => void
  readonly grant: (group: Group, scope: ScopeTier, bindings: Readonly<Record<string, string>>) => void
  readonly revoke: (groupName: string) => void
  readonly isGranted: (groupName: string, captures: Readonly<Record<string, string>>) => boolean
  readonly all: () => ReadonlyArray<Grant>
}

// ── Tag ───────────────────────────────────────────────────────────────────────

export const LeaseService = Context.Service<LeaseServiceShape>("upstream-guard/LeaseService")
export type LeaseService = typeof LeaseService

// ── Layer ─────────────────────────────────────────────────────────────────────

export const LeaseServiceLayer = Layer.effect(
  LeaseService,
  Effect.sync(() => {
    const active = new Map<string, Grant>()
    let appendEntry: ((data: Grant) => void) | null = null

    return {
      init: (append: (data: Grant) => void): void => {
        appendEntry = append
      },
      restore: (grant: Grant): void => {
        active.set(grant.group, grant)
      },
      grant: (group: Group, scope: ScopeTier, bindings: Readonly<Record<string, string>>): void => {
        const g: Grant = { group: group.name, scope, bindings }
        active.set(group.name, g)
        if (scope === "session") appendEntry?.(g)
      },
      revoke: (groupName: string): void => {
        active.delete(groupName)
      },
      isGranted: (groupName: string, captures: Readonly<Record<string, string>>): boolean => {
        const grant = active.get(groupName)
        if (!grant) return false
        for (const [key, value] of Object.entries(captures)) {
          if (!key.startsWith("allowed")) continue
          if (grant.bindings[key] !== value) return false
        }
        return true
      },
      all: (): ReadonlyArray<Grant> => [...active.values()],
    }
  }),
)
