import { Context, Effect, Layer } from "effect"
import type { Group } from "./types.ts"
import { readFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"

// ── Errors ────────────────────────────────────────────────────────────────────

export class ConfigError {
  readonly _tag = "ConfigError"
  constructor(readonly message: string, readonly cause?: unknown) {}
}

export class PermissionsImportError {
  readonly _tag = "PermissionsImportError"
  constructor(readonly path: string, readonly cause: unknown) {}
}

// ── Shapes ────────────────────────────────────────────────────────────────────

interface ConfigShape {
  readonly permissionsRepo: string
}

interface PermissionsShape {
  readonly groups: ReadonlyArray<Group>
}

interface PermissionsModule {
  readonly ALL_GROUPS: ReadonlyArray<Group>
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CONFIG_PATH = new URL("../config.json", import.meta.url).pathname
const BUILTIN_REPO = new URL("../../permissions", import.meta.url).pathname
  .replace(/\/index\.ts$/, "")

// ── Tags ──────────────────────────────────────────────────────────────────────

export const Config = Context.Service<ConfigShape>("upstream-guard/Config")
export type Config = typeof Config

export const Permissions = Context.Service<PermissionsShape>("upstream-guard/Permissions")
export type Permissions = typeof Permissions

// ── Layers ────────────────────────────────────────────────────────────────────

export const ConfigLayer = Layer.effect(
  Config,
  Effect.gen(function* () {
    const raw = yield* Effect.try({
      try: (): { permissionsRepo?: string } => {
        try { return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { permissionsRepo?: string } }
        catch { return {} }
      },
      catch: (cause) => new ConfigError("Failed to parse config.json", cause),
    })

    const repo = raw.permissionsRepo
      ? (raw.permissionsRepo.startsWith("~")
          ? join(homedir(), raw.permissionsRepo.slice(1))
          : raw.permissionsRepo)
      : BUILTIN_REPO

    return { permissionsRepo: repo }
  }),
)

export const PermissionsLayer = Layer.effect(
  Permissions,
  Effect.gen(function* () {
    const config = yield* Config
    const indexPath = join(config.permissionsRepo, "index.ts")
    const mod = yield* Effect.tryPromise({
      try: () => import(indexPath) as Promise<PermissionsModule>,
      catch: (cause) => new PermissionsImportError(indexPath, cause),
    })
    return { groups: mod.ALL_GROUPS }
  }),
).pipe(Layer.provide(ConfigLayer))
