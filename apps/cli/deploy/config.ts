/**
 * Secret-safe deploy state persistence.
 *
 * The ordinary state file contains only local package binding metadata and
 * secret references. Raw credentials are never accepted by this schema.
 */

import { constants as fsConstants } from "node:fs"
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { homedir } from "node:os"
import path from "node:path"

import type { SupportedLocale } from "./i18n.js"

export const DEPLOY_STATE_SCHEMA_VERSION = "deploy-state.v1" as const

export type DeployRuntime = "agent-native" | "standalone-v1"
export type DeployOutcome =
  | "ready"
  | "pending_external_action"
  | "unsupported"
  | "failed"

export interface DeployPackageBinding {
  name: string
  version: string
  digest: string
  /** Minimum restart-only local reference. Never emit this in normal output. */
  localReference: string
}

export interface DeployEndpoint {
  protocol: "http"
  host: "127.0.0.1"
  port: number
  askPath: "/v1/ask"
  healthPath: "/health"
}

export interface DeployProcessState {
  pid: number
  startedAt: string
}

export interface DeployConfig {
  schemaVersion?: typeof DEPLOY_STATE_SCHEMA_VERSION
  locale?: SupportedLocale
  channel?: string
  botName?: string
  engine?: string
  runtime?: DeployRuntime
  package?: DeployPackageBinding
  outcome?: DeployOutcome
  endpoint?: DeployEndpoint
  process?: DeployProcessState
  secretReferences?: {
    httpTokenEnv?: "DIGITAL_EMPLOYEE_HTTP_TOKEN"
    openaiApiKeyEnv?: "OPENAI_API_KEY"
  }
  code?: string
  deployedAt?: string
  updatedAt?: string
}

function configDir(): string {
  return path.join(homedir(), ".digital-employee")
}

export function getConfigDir(): string {
  return configDir()
}

export function getConfigPath(): string {
  return path.join(configDir(), "config.json")
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
  )
}

function optionalString(value: unknown, maxLength = 2_000): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : undefined
}

/** Drops all unknown and legacy secret-bearing fields on read. */
function sanitizeConfig(value: unknown): DeployConfig {
  if (!isPlainObject(value)) return {}
  const result: DeployConfig = {}
  if (value.schemaVersion === DEPLOY_STATE_SCHEMA_VERSION) {
    result.schemaVersion = DEPLOY_STATE_SCHEMA_VERSION
  }
  for (const key of ["locale", "channel", "botName", "engine"] as const) {
    const field = optionalString(value[key], 256)
    if (field) result[key] = field
  }
  if (value.runtime === "agent-native" || value.runtime === "standalone-v1") {
    result.runtime = value.runtime
  }
  if (
    value.outcome === "ready" ||
    value.outcome === "pending_external_action" ||
    value.outcome === "unsupported" ||
    value.outcome === "failed"
  ) {
    result.outcome = value.outcome
  }
  if (isPlainObject(value.package)) {
    const name = optionalString(value.package.name, 128)
    const version = optionalString(value.package.version, 128)
    const digest = optionalString(value.package.digest, 80)
    const localReference = optionalString(value.package.localReference, 4_096)
    if (
      name &&
      version &&
      digest?.match(/^sha256:[a-f0-9]{64}$/) &&
      localReference &&
      path.isAbsolute(localReference)
    ) {
      result.package = { name, version, digest, localReference }
    }
  }
  if (isPlainObject(value.endpoint)) {
    const port = value.endpoint.port
    if (
      value.endpoint.protocol === "http" &&
      value.endpoint.host === "127.0.0.1" &&
      Number.isInteger(port) &&
      Number(port) >= 1 &&
      Number(port) <= 65_535 &&
      value.endpoint.askPath === "/v1/ask" &&
      value.endpoint.healthPath === "/health"
    ) {
      result.endpoint = {
        protocol: "http",
        host: "127.0.0.1",
        port: Number(port),
        askPath: "/v1/ask",
        healthPath: "/health",
      }
    }
  }
  if (isPlainObject(value.process)) {
    const pid = value.process.pid
    const startedAt = optionalString(value.process.startedAt, 64)
    if (Number.isSafeInteger(pid) && Number(pid) > 0 && startedAt) {
      result.process = { pid: Number(pid), startedAt }
    }
  }
  if (isPlainObject(value.secretReferences)) {
    const secretReferences: NonNullable<DeployConfig["secretReferences"]> = {}
    if (value.secretReferences.httpTokenEnv === "DIGITAL_EMPLOYEE_HTTP_TOKEN") {
      secretReferences.httpTokenEnv = "DIGITAL_EMPLOYEE_HTTP_TOKEN"
    }
    if (value.secretReferences.openaiApiKeyEnv === "OPENAI_API_KEY") {
      secretReferences.openaiApiKeyEnv = "OPENAI_API_KEY"
    }
    if (Object.keys(secretReferences).length > 0) {
      result.secretReferences = secretReferences
    }
  }
  for (const key of ["code", "deployedAt", "updatedAt"] as const) {
    const field = optionalString(value[key], 256)
    if (field) result[key] = field
  }
  return result
}

function fileErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined
}

export async function loadConfigFromPath(configPath: string): Promise<DeployConfig> {
  let handle
  try {
    const before = await lstat(configPath)
    if (!before.isFile() || before.isSymbolicLink() || before.size > 1024 * 1024) {
      return {}
    }
    handle = await open(
      configPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    )
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 1024 * 1024) return {}
    const bytes = await handle.readFile()
    if (bytes.length !== stat.size) return {}
    return sanitizeConfig(JSON.parse(bytes.toString("utf8")) as unknown)
  } catch (error) {
    if (fileErrorCode(error) === "ENOENT") return {}
    return {}
  } finally {
    await handle?.close()
  }
}

export function loadConfig(): Promise<DeployConfig> {
  return loadConfigFromPath(getConfigPath())
}

async function ensurePrivateConfigDirectory(directory: string): Promise<void> {
  try {
    const existing = await lstat(directory)
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new TypeError("deploy_config_directory_must_be_private_directory")
    }
  } catch (error) {
    if (fileErrorCode(error) !== "ENOENT") throw error
    await mkdir(directory, { recursive: true, mode: 0o700 })
  }
  await chmod(directory, 0o700)
}

export async function saveConfig(config: DeployConfig): Promise<void> {
  const directory = getConfigDir()
  const configPath = getConfigPath()
  await ensurePrivateConfigDirectory(directory)
  const temporaryPath = path.join(
    directory,
    `.config.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
  )
  let handle
  try {
    handle = await open(temporaryPath, "wx", 0o600)
    await handle.writeFile(`${JSON.stringify(sanitizeConfig(config), null, 2)}\n`, {
      encoding: "utf8",
    })
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporaryPath, configPath)
    await chmod(configPath, 0o600)
  } catch (error) {
    try {
      await unlink(temporaryPath)
    } catch (cleanupError) {
      if (fileErrorCode(cleanupError) !== "ENOENT") throw cleanupError
    }
    throw error
  } finally {
    await handle?.close()
  }
}

export async function hasExistingDeployment(): Promise<boolean> {
  const config = await loadConfig()
  return Boolean(config.outcome || config.deployedAt)
}
