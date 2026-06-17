// Structural types for permission groups and matching.
// The permissions repo's types.ts is intentionally identical in shape —
// TypeScript structural compatibility means no cross-repo type dependency.

export interface Pattern {
  readonly regex: RegExp
  readonly description?: string
  readonly source?: string
}

export interface Group {
  readonly name: string
  readonly description?: string
  readonly defaultScope?: "task" | "session" | "persistent"
  readonly extends?: ReadonlyArray<Group>
  readonly patterns: ReadonlyArray<Pattern>
}

export interface MatchResult {
  readonly group: Group
  readonly pattern: Pattern
  readonly captures: Readonly<Record<string, string>>
}
