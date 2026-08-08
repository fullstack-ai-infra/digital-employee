/** Channel-specific deploy orchestration with observable outcome evidence. */

import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { get as httpGet } from "node:http"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"

import { t } from "./i18n.js"
import { getConfigPath } from "./config.js"
import type {
  DeployConfig,
  DeployEndpoint,
  DeployOutcome,
  DeployProcessState,
} from "./config.js"

export type ChannelId = "dingtalk" | "lark" | "wecom" | "console" | "http"

export interface ChannelDeployResult {
  outcome: DeployOutcome
  steps: string[]
  code?: string
  guidance?: string
  endpoint?: DeployEndpoint
  process?: DeployProcessState
}

export interface ChannelDeployContext {
  signal?: AbortSignal
  readinessTimeoutMs?: number
}

function outcome(
  value: DeployOutcome,
  code: string,
  guidance: string,
): ChannelDeployResult {
  return { outcome: value, steps: [], code, guidance }
}

/**
 * DingTalk remote creation remains pending until provider output/readback is
 * implemented. It must never be represented as completed local readiness.
 */
export async function deployDingTalk(
  _config: DeployConfig,
): Promise<ChannelDeployResult> {
  return outcome(
    "pending_external_action",
    "dingtalk_provider_action_required",
    t("deploy.guidance_dingtalk_pending"),
  )
}

export async function deployLark(
  _config: DeployConfig,
): Promise<ChannelDeployResult> {
  return outcome(
    "unsupported",
    "lark_live_deploy_unsupported",
    t("deploy.guidance_lark_unsupported"),
  )
}

export async function deployWeCom(
  _config: DeployConfig,
): Promise<ChannelDeployResult> {
  return outcome(
    "unsupported",
    "wecom_live_deploy_unsupported",
    t("deploy.guidance_wecom_unsupported"),
  )
}

/** Console requires an attached foreground terminal; no detached no-op exists. */
export async function deployConsole(
  _config: DeployConfig,
): Promise<ChannelDeployResult> {
  return outcome(
    "pending_external_action",
    "console_foreground_start_required",
    t("deploy.guidance_console_pending"),
  )
}

interface HttpReadiness {
  schemaVersion?: unknown
  status?: unknown
  pid?: unknown
  endpoint?: { askPath?: unknown; healthPath?: unknown }
  package?: {
    name?: unknown
    version?: unknown
    digest?: unknown
    runtime?: unknown
    engine?: unknown
  }
}

async function readHttpReadiness(
  endpoint: DeployEndpoint,
  timeoutMs: number,
): Promise<HttpReadiness | undefined> {
  return new Promise((resolve) => {
    const request = httpGet(
      {
        host: endpoint.host,
        port: endpoint.port,
        path: endpoint.healthPath,
        timeout: timeoutMs,
        headers: { accept: "application/json" },
      },
      (response) => {
        const chunks: Buffer[] = []
        let bytes = 0
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          bytes += buffer.length
          if (bytes <= 64 * 1024) chunks.push(buffer)
          else request.destroy()
        })
        response.on("end", () => {
          if (response.statusCode !== 200 || bytes > 64 * 1024) {
            resolve(undefined)
            return
          }
          try {
            resolve(
              JSON.parse(Buffer.concat(chunks).toString("utf8")) as HttpReadiness,
            )
          } catch {
            resolve(undefined)
          }
        })
      },
    )
    request.once("timeout", () => request.destroy())
    request.once("error", () => resolve(undefined))
  })
}

function readinessMatches(
  readiness: HttpReadiness | undefined,
  config: DeployConfig,
  pid: number,
): boolean {
  return Boolean(
    readiness?.schemaVersion === "deploy-readiness.v1" &&
      readiness.status === "ok" &&
      readiness.pid === pid &&
      readiness.endpoint?.askPath === "/v1/ask" &&
      readiness.endpoint?.healthPath === "/health" &&
      readiness.package?.name === config.package?.name &&
      readiness.package?.version === config.package?.version &&
      readiness.package?.digest === config.package?.digest &&
      readiness.package?.runtime === config.runtime &&
      readiness.package?.engine === config.engine,
  )
}

function httpRuntimeInvocation(): { command: string; args: string[] } {
  const sourceMode = import.meta.url.endsWith(".ts")
  const entry = fileURLToPath(
    new URL(sourceMode ? "./http-runtime.ts" : "./http-runtime.js", import.meta.url),
  )
  return {
    command: process.execPath,
    args: [
      ...(sourceMode ? ["--import", "tsx"] : []),
      entry,
      "--state",
      getConfigPath(),
    ],
  }
}

function terminateOwnedProcess(child: ChildProcess): void {
  const pid = child.pid
  if (!pid || pid === process.pid) return
  try {
    process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM")
  } catch {
    try {
      child.kill("SIGTERM")
    } catch {
      // The process already exited.
    }
  }
}

export async function readbackHttpDeployment(
  config: DeployConfig,
): Promise<boolean> {
  if (!config.endpoint || !config.process) return false
  const readiness = await readHttpReadiness(config.endpoint, 500)
  return readinessMatches(readiness, config, config.process.pid)
}

export async function deployHttp(
  config: DeployConfig,
  {
    signal,
    readinessTimeoutMs = 8_000,
  }: ChannelDeployContext = {},
): Promise<ChannelDeployResult> {
  if (!config.endpoint || !config.package || !config.engine || !config.runtime) {
    return outcome("failed", "http_deploy_state_invalid", t("deploy.error_state_invalid"))
  }
  if (config.runtime !== "agent-native") {
    return outcome(
      "unsupported",
      "http_standalone_runtime_not_available",
      t("deploy.guidance_standalone_unsupported"),
    )
  }

  const invocation = httpRuntimeInvocation()
  let child: ChildProcess
  try {
    child = spawn(invocation.command, invocation.args, {
      detached: true,
      env: process.env,
      stdio: "ignore",
      windowsHide: true,
    })
  } catch {
    return outcome("failed", "http_process_start_failed", t("deploy.error_process_start"))
  }
  if (!child.pid) {
    terminateOwnedProcess(child)
    return outcome("failed", "http_process_start_failed", t("deploy.error_process_start"))
  }

  const startedAt = new Date().toISOString()
  let exited = false
  child.once("exit", () => {
    exited = true
  })
  const abort = () => terminateOwnedProcess(child)
  signal?.addEventListener("abort", abort, { once: true })
  try {
    const deadline = Date.now() + readinessTimeoutMs
    while (!exited && !signal?.aborted && Date.now() < deadline) {
      const readiness = await readHttpReadiness(config.endpoint, 400)
      if (readinessMatches(readiness, config, child.pid)) {
        child.unref()
        return {
          outcome: "ready",
          steps: [t("deploy.step_http_ready", { port: String(config.endpoint.port) })],
          endpoint: config.endpoint,
          process: { pid: child.pid, startedAt },
        }
      }
      await delay(100, undefined, { signal }).catch(() => undefined)
    }
  } finally {
    signal?.removeEventListener("abort", abort)
  }
  terminateOwnedProcess(child)
  return outcome(
    "failed",
    signal?.aborted ? "deploy_interrupted" : "http_readiness_failed",
    signal?.aborted
      ? t("deploy.error_interrupted")
      : t("deploy.error_http_readiness"),
  )
}

export function endpointUrl(endpoint: DeployEndpoint): string {
  return `http://${endpoint.host}:${endpoint.port}${endpoint.askPath}`
}
