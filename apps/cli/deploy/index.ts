/** Fail-closed package-bound deploy orchestration. */

import path from "node:path"
import { realpath } from "node:fs/promises"

import {
  computeEmployeePackageDirectoryDigest,
  createSealedEmployeePackageSnapshot,
} from "../employee-package.js"
import { inspectEmployeeHostCompatibility } from "../agent-run.js"
import { selectPrompt, textPrompt, confirmPrompt } from "./prompts.js"
import {
  loadConfig,
  saveConfig,
} from "./config.js"
import type {
  DeployConfig,
  DeployPackageBinding,
  DeployRuntime,
} from "./config.js"
import {
  deployDingTalk,
  deployLark,
  deployWeCom,
  deployConsole,
  deployHttp,
  endpointUrl,
  readbackHttpDeployment,
} from "./channels.js"
import type { ChannelDeployResult, ChannelId } from "./channels.js"
import {
  detectSystemLocale,
  getAvailableLocales,
  getLocaleDisplayName,
  setLocale,
  t,
} from "./i18n.js"
import type { SupportedLocale } from "./i18n.js"

export interface DeployOptions {
  packagePath?: string
  packagePathConflict?: boolean
  extraPackagePaths?: boolean
  channel?: string
  engine?: string
  name?: string
  locale?: string
  runtime?: string
  port?: string
  yes?: boolean
  help?: boolean
  providedOptions?: ReadonlySet<string>
}

const VALID_CHANNELS = ["dingtalk", "lark", "wecom", "console", "http"] as const
const VALID_RUNTIMES = ["agent-native", "standalone-v1"] as const
const AGENT_NATIVE_ENGINES = [
  "claude-code",
  "qoder",
  "qwen-code",
  "codebuddy",
] as const
const STANDALONE_ENGINES = ["extractive", "openai-compatible"] as const
const VALID_ENGINES = [...AGENT_NATIVE_ENGINES, ...STANDALONE_ENGINES] as const
const FROZEN_DEPLOY_LOCALES = ["en", "zh-CN", "ja"] as const
const DEPLOY_OPTIONS = new Set([
  "channel",
  "engine",
  "name",
  "locale",
  "runtime",
  "package",
  "port",
  "yes",
  "help",
])

function supported(values: readonly string[]): string {
  return values.join("|")
}

function failInput(field: string, values: readonly string[]): void {
  process.stderr.write(
    `${t("deploy.error_invalid_value", {
      field,
      supported: supported(values),
    })}\n`,
  )
  process.exitCode = 1
}

function failCode(key: string, code: string): void {
  process.stderr.write(`${t(key, { code })}\n`)
  process.exitCode = 1
}

function safeFailureCode(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback
  const match = error.message.match(/^([A-Za-z][A-Za-z0-9_.-]{0,127})/)
  return match?.[1]?.toLowerCase() ?? fallback
}

function isOneOf(value: string, choices: readonly string[]): boolean {
  return choices.includes(value)
}

function validPort(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined
  const port = Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65_535
    ? port
    : undefined
}

function validateExplicitInputs(options: DeployOptions): boolean {
  for (const option of options.providedOptions ?? []) {
    if (!DEPLOY_OPTIONS.has(option)) {
      failInput(`--${option}`, [...DEPLOY_OPTIONS].map((entry) => `--${entry}`))
      return false
    }
  }
  if (options.packagePathConflict || options.extraPackagePaths) {
    failCode("deploy.error_incompatible_options", "package_path_must_be_unique")
    return false
  }
  if (options.locale && !isOneOf(options.locale, FROZEN_DEPLOY_LOCALES)) {
    failInput("locale", FROZEN_DEPLOY_LOCALES)
    return false
  }
  if (options.channel && !isOneOf(options.channel, VALID_CHANNELS)) {
    failInput("channel", VALID_CHANNELS)
    return false
  }
  if (options.runtime && !isOneOf(options.runtime, VALID_RUNTIMES)) {
    failInput("runtime", VALID_RUNTIMES)
    return false
  }
  if (options.engine && !isOneOf(options.engine, VALID_ENGINES)) {
    failInput("engine", VALID_ENGINES)
    return false
  }
  if (
    options.runtime === "agent-native" &&
    options.engine &&
    !isOneOf(options.engine, AGENT_NATIVE_ENGINES)
  ) {
    failInput("engine(agent-native)", AGENT_NATIVE_ENGINES)
    return false
  }
  if (
    options.runtime === "standalone-v1" &&
    options.engine &&
    !isOneOf(options.engine, STANDALONE_ENGINES)
  ) {
    failInput("engine(standalone-v1)", STANDALONE_ENGINES)
    return false
  }
  if (options.name !== undefined) {
    if (
      !options.name.trim() ||
      options.name.length > 128 ||
      /[\u0000-\u001f\u007f]/.test(options.name)
    ) {
      failCode("deploy.error_invalid_name", "invalid_name")
      return false
    }
  }
  if (options.port !== undefined && validPort(options.port) === undefined) {
    failInput("port", ["1..65535"])
    return false
  }
  if (
    options.providedOptions?.has("port") &&
    options.channel &&
    options.channel !== "http"
  ) {
    failCode("deploy.error_incompatible_options", "port_requires_http_channel")
    return false
  }
  return true
}

function completeAutomationInputs(options: DeployOptions): boolean {
  if (!options.yes || options.help) return true
  const missing = [
    !options.channel ? "channel" : undefined,
    !options.engine ? "engine" : undefined,
    !options.runtime ? "runtime" : undefined,
  ].filter((entry): entry is string => Boolean(entry))
  if (missing.length === 0) return true
  process.stderr.write(
    `${t("deploy.error_missing_automation_flags", {
      fields: missing.map((entry) => `--${entry}`).join(", "),
    })}\n`,
  )
  process.exitCode = 1
  return false
}

async function resolvePackageBinding(
  requestedPath: string,
): Promise<DeployPackageBinding> {
  const localReference = await realpath(path.resolve(requestedPath))
  const snapshot = await createSealedEmployeePackageSnapshot(localReference)
  try {
    return {
      name: snapshot.manifest.name,
      version: snapshot.manifest.version,
      digest: snapshot.digest,
      localReference,
    }
  } finally {
    await snapshot.cleanup()
  }
}

function sameDeployment(left: DeployConfig, right: DeployConfig): boolean {
  return Boolean(
    left.channel === right.channel &&
      left.engine === right.engine &&
      left.runtime === right.runtime &&
      left.package?.name === right.package?.name &&
      left.package?.version === right.package?.version &&
      left.package?.digest === right.package?.digest &&
      left.endpoint?.port === right.endpoint?.port,
  )
}

function writeBinding(binding: DeployPackageBinding, runtime: DeployRuntime): void {
  process.stdout.write(
    `${t("deploy.binding", {
      identity: `${binding.name}@${binding.version}`,
      digest: binding.digest,
      runtime,
    })}\n`,
  )
}

async function resolveRuntime(options: DeployOptions): Promise<DeployRuntime> {
  if (options.runtime) return options.runtime as DeployRuntime
  return selectPrompt(t("deploy.runtime_prompt"), [
    { label: t("deploy.runtime_agent_native"), value: "agent-native" },
    { label: t("deploy.runtime_standalone"), value: "standalone-v1" },
  ]) as Promise<DeployRuntime>
}

async function resolveChannel(options: DeployOptions): Promise<ChannelId> {
  if (options.channel) return options.channel as ChannelId
  return selectPrompt(t("deploy.channel_prompt"), [
    { label: t("deploy.channel_dingtalk"), value: "dingtalk" },
    { label: t("deploy.channel_lark"), value: "lark" },
    { label: t("deploy.channel_wecom"), value: "wecom" },
    { label: t("deploy.channel_console"), value: "console" },
    { label: t("deploy.channel_http"), value: "http" },
  ]) as Promise<ChannelId>
}

async function resolveEngine(
  options: DeployOptions,
  runtime: DeployRuntime,
): Promise<string> {
  if (options.engine) return options.engine
  const choices = runtime === "agent-native"
    ? AGENT_NATIVE_ENGINES.map((engine) => ({
        label: engine,
        value: engine,
      }))
    : STANDALONE_ENGINES.map((engine) => ({
        label: engine,
        value: engine,
      }))
  return selectPrompt(t("deploy.engine_prompt"), choices)
}

async function preflightEngine(
  runtime: DeployRuntime,
  engine: string,
  binding: DeployPackageBinding,
): Promise<string | undefined> {
  if (runtime === "standalone-v1") {
    if (engine === "extractive") return undefined
    if (
      engine === "openai-compatible" &&
      process.env.OPENAI_API_KEY?.trim() &&
      process.env.OPENAI_MODEL?.trim()
    ) {
      return undefined
    }
    return "standalone_engine_credentials_unavailable"
  }
  try {
    const { host, compatibility } = await inspectEmployeeHostCompatibility({
      directory: binding.localReference,
      engine,
    })
    if (
      host.status !== "ready" ||
      host.available !== true ||
      host.adapterStatus !== "runnable"
    ) {
      return host.issues.find((entry) => entry.blocking)?.code ??
        "agent_host_unavailable"
    }
    if (!compatibility.compatible) {
      return compatibility.issues.find((entry) => entry.blocking)?.code ??
        "agent_host_incompatible"
    }
    const currentDigest = await computeEmployeePackageDirectoryDigest(
      binding.localReference,
    )
    if (currentDigest !== binding.digest) return "employee_package_changed"
    return undefined
  } catch (error) {
    return safeFailureCode(error, "agent_host_preflight_failed")
  }
}

async function dispatchChannel(
  channel: ChannelId,
  config: DeployConfig,
  signal: AbortSignal,
): Promise<ChannelDeployResult> {
  if (channel === "dingtalk") return deployDingTalk(config)
  if (channel === "lark") return deployLark(config)
  if (channel === "wecom") return deployWeCom(config)
  if (channel === "console") return deployConsole(config)
  return deployHttp(config, { signal })
}

function setOutcomeExitCode(outcome: ChannelDeployResult["outcome"]): void {
  if (outcome === "ready") return
  process.exitCode = outcome === "pending_external_action" ? 2 : 1
}

function renderOutcome(config: DeployConfig, result: ChannelDeployResult): void {
  if (result.outcome === "ready") {
    process.stdout.write(`${t("deploy.outcome_ready")}\n`)
    if (result.endpoint) {
      process.stdout.write(
        `${t("deploy.http_endpoint", { endpoint: endpointUrl(result.endpoint) })}\n`,
      )
    }
    return
  }
  const key = result.outcome === "pending_external_action"
    ? "deploy.outcome_pending"
    : result.outcome === "unsupported"
      ? "deploy.outcome_unsupported"
      : "deploy.outcome_failed"
  process.stderr.write(`${t(key, { code: result.code ?? "deploy_failed" })}\n`)
  if (result.guidance) process.stderr.write(`${result.guidance}\n`)
  void config
}

export async function deploy(options: DeployOptions = {}): Promise<void> {
  const initialLocale = options.locale && isOneOf(options.locale, FROZEN_DEPLOY_LOCALES)
    ? options.locale
    : options.yes
      ? "en"
      : detectSystemLocale()
  setLocale(initialLocale)

  if (!validateExplicitInputs(options)) return
  if (options.help) {
    process.stdout.write(`${t("deploy.help")}\n`)
    return
  }
  if (!completeAutomationInputs(options)) return

  let binding: DeployPackageBinding
  try {
    binding = await resolvePackageBinding(options.packagePath ?? process.cwd())
  } catch (error) {
    failCode(
      "deploy.error_invalid_package",
      safeFailureCode(error, "employee_package_invalid"),
    )
    return
  }

  const existing = await loadConfig()
  let locale: SupportedLocale
  if (options.locale) {
    locale = options.locale
  } else if (options.yes) {
    locale = "en"
    setLocale(locale)
  } else {
    setLocale(existing.locale || detectSystemLocale())
    const choices = getAvailableLocales()
      .filter((code) => isOneOf(code, FROZEN_DEPLOY_LOCALES))
      .map((code) => ({ label: getLocaleDisplayName(code), value: code }))
    locale = await selectPrompt(t("deploy.lang_prompt"), choices)
    setLocale(locale)
  }

  const channel = await resolveChannel(options)
  const botName = options.name?.trim() || (
    options.yes
      ? t("deploy.name_default")
      : await textPrompt(t("deploy.name_prompt"), t("deploy.name_default"))
  )
  const runtime = await resolveRuntime(options)
  const engine = await resolveEngine(options, runtime)

  if (
    runtime === "agent-native" &&
    !isOneOf(engine, AGENT_NATIVE_ENGINES)
  ) {
    failInput("engine(agent-native)", AGENT_NATIVE_ENGINES)
    return
  }
  if (
    runtime === "standalone-v1" &&
    !isOneOf(engine, STANDALONE_ENGINES)
  ) {
    failInput("engine(standalone-v1)", STANDALONE_ENGINES)
    return
  }

  const port = validPort(options.port ?? "3000")!
  const candidate: DeployConfig = {
    schemaVersion: "deploy-state.v1",
    locale,
    channel,
    botName,
    engine,
    runtime,
    package: binding,
    outcome: "pending_external_action",
    ...(channel === "http"
      ? {
          endpoint: {
            protocol: "http" as const,
            host: "127.0.0.1" as const,
            port,
            askPath: "/v1/ask" as const,
            healthPath: "/health" as const,
          },
          ...(process.env.DIGITAL_EMPLOYEE_HTTP_TOKEN?.trim()
            ? {
                secretReferences: {
                  httpTokenEnv: "DIGITAL_EMPLOYEE_HTTP_TOKEN" as const,
                },
              }
            : {}),
        }
      : {}),
    ...(runtime === "standalone-v1" && engine === "openai-compatible"
      ? {
          secretReferences: {
            openaiApiKeyEnv: "OPENAI_API_KEY" as const,
          },
        }
      : {}),
    updatedAt: new Date().toISOString(),
  }

  if (
    existing.outcome === "ready" &&
    sameDeployment(existing, candidate) &&
    channel === "http" &&
    await readbackHttpDeployment(existing)
  ) {
    writeBinding(binding, runtime)
    renderOutcome(existing, {
      outcome: "ready",
      steps: [],
      endpoint: existing.endpoint,
      process: existing.process,
    })
    return
  }

  if (existing.outcome || existing.deployedAt) {
    if (options.yes) {
      if (existing.process && await readbackHttpDeployment(existing)) {
        failCode("deploy.error_existing_running", "existing_deployment_running")
        return
      }
    } else {
      process.stdout.write(`${t("deploy.existing_detected")}\n`)
      const overwrite = await confirmPrompt(t("deploy.existing_overwrite"), {
        yes: t("deploy.existing_yes"),
        no: t("deploy.existing_no"),
      })
      if (!overwrite) {
        failCode("deploy.error_aborted", "deploy_aborted")
        return
      }
      if (existing.process && await readbackHttpDeployment(existing)) {
        failCode("deploy.error_existing_running", "existing_deployment_running")
        return
      }
    }
  }

  const preflightFailure = await preflightEngine(runtime, engine, binding)
  if (preflightFailure) {
    failCode("deploy.error_engine_unavailable", preflightFailure)
    return
  }

  writeBinding(binding, runtime)
  try {
    await saveConfig(candidate)
  } catch {
    failCode("deploy.error_state_write", "deploy_state_write_failed")
    return
  }

  const controller = new AbortController()
  const interrupt = () => controller.abort()
  process.once("SIGINT", interrupt)
  process.once("SIGTERM", interrupt)
  let result: ChannelDeployResult
  try {
    result = await dispatchChannel(channel, candidate, controller.signal)
  } catch {
    result = {
      outcome: "failed",
      steps: [],
      code: "deploy_orchestration_failed",
      guidance: t("deploy.error_orchestration"),
    }
  } finally {
    process.removeListener("SIGINT", interrupt)
    process.removeListener("SIGTERM", interrupt)
  }

  const now = new Date().toISOString()
  const finalConfig: DeployConfig = {
    ...candidate,
    outcome: result.outcome,
    ...(result.endpoint ? { endpoint: result.endpoint } : {}),
    ...(result.process ? { process: result.process } : {}),
    ...(result.code ? { code: result.code } : {}),
    ...(result.outcome === "ready" ? { deployedAt: now } : {}),
    updatedAt: now,
  }
  try {
    await saveConfig(finalConfig)
  } catch {
    if (result.process) {
      try {
        process.kill(
          process.platform === "win32" ? result.process.pid : -result.process.pid,
          "SIGTERM",
        )
      } catch {
        // The child already exited.
      }
    }
    failCode("deploy.error_state_write", "deploy_state_write_failed")
    return
  }

  for (const step of result.steps) process.stdout.write(`  ${step}\n`)
  renderOutcome(finalConfig, result)
  setOutcomeExitCode(result.outcome)
}
