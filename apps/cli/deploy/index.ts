/** Fail-closed package-bound deploy orchestration. */

import path from "node:path"
import { realpath } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"

import {
  computeEmployeePackageDirectoryDigest,
  createSealedEmployeePackageSnapshot,
} from "../employee-package.js"
import { inspectEmployeeHostCompatibility } from "../agent-run.js"
import {
  closePromptInput,
  selectPrompt,
  textPrompt,
  confirmPrompt,
} from "./prompts.js"
import {
  acquireDeploymentLock,
  loadConfig,
  loadConfigSnapshot,
  saveConfig,
} from "./config.js"
import type {
  DeployConfig,
  DeployConfigFingerprint,
  DeployConfigSnapshot,
  DeployPackageBinding,
  DeployRuntime,
  DeploymentLock,
} from "./config.js"
import {
  deployDingTalk,
  deployLark,
  deployWeCom,
  deployConsole,
  deployHttp,
  endpointUrl,
  inspectHttpDeployment,
  readbackHttpDeployment,
} from "./channels.js"
import type {
  ChannelDeployResult,
  ChannelId,
  HttpActivationLease,
} from "./channels.js"
import {
  detectSystemLocale,
  getAvailableLocales,
  getLocaleDisplayName,
  hasMessage,
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

function availableDeployLocales(): string[] {
  return getAvailableLocales()
}

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

/**
 * Render an optional recovery line for a fail-closed error code. Each known
 * code has a localized `deploy.recovery_<code>` catalog entry naming the
 * exact next action; unknown codes fall back to `fallbackKey` when given,
 * and otherwise print nothing. Behavior, codes, and exit codes are
 * unchanged — this is human-facing copy only.
 */
function writeRecoveryGuidance(
  code: string,
  vars: Record<string, string> = {},
  fallbackKey?: string,
): void {
  const key = `deploy.recovery_${code}`
  if (hasMessage(key)) {
    process.stderr.write(`${t(key, vars)}\n`)
  } else if (fallbackKey) {
    process.stderr.write(`${t(fallbackKey, vars)}\n`)
  }
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
  if (
    options.providedOptions?.has("package") &&
    (options.packagePath === undefined || options.packagePath.trim().length === 0)
  ) {
    failCode("deploy.error_invalid_package", "package_path_empty")
    return false
  }
  if (
    options.providedOptions?.has("locale") &&
    (options.locale === undefined || !isOneOf(options.locale, availableDeployLocales()))
  ) {
    failInput("locale", availableDeployLocales())
    return false
  }
  if (
    options.providedOptions?.has("channel") &&
    (options.channel === undefined || !isOneOf(options.channel, VALID_CHANNELS))
  ) {
    failInput("channel", VALID_CHANNELS)
    return false
  }
  if (
    options.providedOptions?.has("runtime") &&
    (options.runtime === undefined || !isOneOf(options.runtime, VALID_RUNTIMES))
  ) {
    failInput("runtime", VALID_RUNTIMES)
    return false
  }
  if (
    options.providedOptions?.has("engine") &&
    (options.engine === undefined || !isOneOf(options.engine, VALID_ENGINES))
  ) {
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

async function assertExactPackageBinding(
  expected: DeployPackageBinding,
): Promise<void> {
  const current = await resolvePackageBinding(expected.localReference)
  if (
    current.localReference !== expected.localReference ||
    current.name !== expected.name ||
    current.version !== expected.version ||
    current.digest !== expected.digest
  ) {
    throw new TypeError("employee_package_changed")
  }
}

function sameDeployment(left: DeployConfig, right: DeployConfig): boolean {
  return Boolean(
    left.channel === right.channel &&
      left.botName === right.botName &&
      left.engine === right.engine &&
      left.runtime === right.runtime &&
      left.secretReferences?.httpTokenEnv ===
        right.secretReferences?.httpTokenEnv &&
      left.package?.name === right.package?.name &&
      left.package?.version === right.package?.version &&
      left.package?.digest === right.package?.digest &&
      left.package?.localReference === right.package?.localReference &&
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

// Bounded window that tolerates a transient observation failure (for
// example a loaded CI runner delaying one /health probe) without masking a
// runtime that never becomes ready: fail-closed verdicts are unchanged.
const HTTP_FINAL_READBACK_WINDOW_MS = 3_000
const HTTP_FINAL_READBACK_DELAY_MS = 150

export async function hasExactHttpReadback(
  config: DeployConfig,
  binding: DeployPackageBinding,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    if (
      config.package?.localReference !== binding.localReference ||
      config.package.digest !== binding.digest
    ) {
      return false
    }
    const deadline = Date.now() + HTTP_FINAL_READBACK_WINDOW_MS
    let ready = false
    while (!signal?.aborted && Date.now() < deadline) {
      if (await readbackHttpDeployment(config)) {
        ready = true
        break
      }
      await delay(HTTP_FINAL_READBACK_DELAY_MS, undefined, { signal })
        .catch(() => undefined)
    }
    return (
      ready &&
      await computeEmployeePackageDirectoryDigest(config.package.localReference) ===
        config.package.digest
    )
  } catch {
    return false
  }
}

function sameConfigFingerprint(
  left: DeployConfigFingerprint,
  right: DeployConfigFingerprint,
): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === "missing" || right.kind === "missing") return true
  return left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedAtMs === right.modifiedAtMs &&
    left.changedAtMs === right.changedAtMs &&
    left.digest === right.digest
}

async function loadExactConfigGeneration(
  expected: DeployConfigFingerprint,
  lock: Pick<DeploymentLock, "assertOwned">,
): Promise<DeployConfigSnapshot> {
  await lock.assertOwned()
  const snapshot = await loadConfigSnapshot()
  if (!sameConfigFingerprint(snapshot.fingerprint, expected)) {
    throw new TypeError("deploy_config_generation_changed")
  }
  await lock.assertOwned()
  return snapshot
}

async function resolveRuntime(options: DeployOptions): Promise<DeployRuntime> {
  if (options.runtime) return options.runtime as DeployRuntime
  return "agent-native"
}

function explicitLocaleFromArgv(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!
    if (value.startsWith("--locale=")) return value.slice("--locale=".length)
    if (value === "--locale") return argv[index + 1]
  }
  return undefined
}

export function renderDeployParseFailure(
  argv: readonly string[],
  error: unknown,
): void {
  const locales = availableDeployLocales()
  const requestedLocale = explicitLocaleFromArgv(argv)
  setLocale(
    requestedLocale !== undefined
      ? locales.includes(requestedLocale)
        ? requestedLocale
        : "en"
      : detectSystemLocale(),
  )
  const message = error instanceof Error ? error.message : "invalid_arguments"
  const field = message.match(/'(--[A-Za-z0-9-]+)'/)?.[1] ?? "arguments"
  failInput(field, [...DEPLOY_OPTIONS].map((entry) => `--${entry}`))
}

async function resolveChannel(options: DeployOptions): Promise<ChannelId> {
  if (options.channel) return options.channel as ChannelId
  return selectPrompt(t("deploy.channel_prompt"), [
    { label: t("deploy.channel_http"), value: "http" },
    { label: t("deploy.channel_console"), value: "console" },
    { label: t("deploy.channel_dingtalk"), value: "dingtalk" },
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
  engine: string,
  binding: DeployPackageBinding,
): Promise<string | undefined> {
  // standalone-v1 is rejected before preflight with
  // package_deploy_standalone_unsupported; this function only validates the
  // Agent-native engine path.
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
  onProcessStarted: (state: NonNullable<DeployConfig["process"]>) => Promise<string>,
  onProviderVerified: (
    provider: NonNullable<DeployConfig["provider"]>,
  ) => Promise<void>,
  onProviderOperation: (
    operation: NonNullable<DeployConfig["providerOperation"]>,
  ) => Promise<void>,
  allowProviderWrite: boolean,
  assertLockOwned: () => Promise<void>,
  assertProviderBoundary: () => Promise<void>,
  activationLease: HttpActivationLease,
): Promise<ChannelDeployResult> {
  if (channel === "dingtalk") {
    return deployDingTalk(config, {
      signal,
      allowProviderWrite,
      confirmProviderWrite: () => confirmPrompt(
        t("deploy.dingtalk_confirm_write"),
        {
          yes: t("deploy.existing_yes"),
          no: t("deploy.existing_no"),
        },
      ),
      onProviderVerified,
      onProviderOperation,
      assertLockOwned: assertProviderBoundary,
    })
  }
  if (channel === "lark") return deployLark(config)
  if (channel === "wecom") return deployWeCom(config)
  if (channel === "console") return deployConsole(config)
  return deployHttp(config, {
    signal,
    onProcessStarted,
    assertLockOwned,
    activationLease,
  })
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

async function deployImpl(options: DeployOptions = {}): Promise<void> {
  const locales = availableDeployLocales()
  const initialLocale = options.locale !== undefined
    ? isOneOf(options.locale, locales)
      ? options.locale
      : options.locale.trim() === ""
        ? detectSystemLocale()
        : "en"
    : options.yes
      ? "en"
      : detectSystemLocale()
  setLocale(initialLocale)

  if (!validateExplicitInputs(options)) return
  if (options.help) {
    process.stdout.write(
      `${t("deploy.help", { locales: supported(locales) })}\n`,
    )
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
    writeRecoveryGuidance("invalid_package")
    return
  }

  let initialExisting: DeployConfig
  try {
    initialExisting = await loadConfig()
  } catch (error) {
    failCode(
      "deploy.error_state_load",
      safeFailureCode(error, "deploy_config_invalid"),
    )
    return
  }
  setLocale(
    options.locale ||
      (options.yes ? "en" : initialExisting.locale || detectSystemLocale()),
  )

  const runtime = await resolveRuntime(options)
  if (runtime === "standalone-v1") {
    writeBinding(binding, runtime)
    const unsupported: ChannelDeployResult = {
      outcome: "unsupported",
      steps: [],
      code: "package_deploy_standalone_unsupported",
      guidance: t("deploy.guidance_standalone_legacy"),
    }
    renderOutcome(initialExisting, unsupported)
    setOutcomeExitCode(unsupported.outcome)
    return
  }
  const engine = await resolveEngine(options, runtime)
  if (!isOneOf(engine, AGENT_NATIVE_ENGINES)) {
    failInput("engine(agent-native)", AGENT_NATIVE_ENGINES)
    return
  }
  const preflightFailure = await preflightEngine(engine, binding)
  if (preflightFailure) {
    failCode("deploy.error_engine_unavailable", preflightFailure)
    writeRecoveryGuidance(
      preflightFailure,
      { engine },
      "deploy.recovery_engine_preflight",
    )
    return
  }
  let locale: SupportedLocale
  if (options.locale) {
    locale = options.locale
  } else if (options.yes) {
    locale = "en"
    setLocale(locale)
  } else {
    setLocale(initialExisting.locale || detectSystemLocale())
    const choices = getAvailableLocales()
      .map((code) => ({ label: getLocaleDisplayName(code), value: code }))
    locale = await selectPrompt(t("deploy.lang_prompt"), choices)
    setLocale(locale)
  }

  const channel = await resolveChannel(options)
  if (options.providedOptions?.has("port") && channel !== "http") {
    failCode("deploy.error_incompatible_options", "port_requires_http_channel")
    return
  }
  const httpToken = process.env.DIGITAL_EMPLOYEE_HTTP_TOKEN?.trim()
  if (
    channel === "http" &&
    (!httpToken ||
      httpToken.length > 8_192 ||
      /[\u0000-\u001f\u007f]/.test(httpToken))
  ) {
    failCode("deploy.error_aborted", "http_token_required")
    writeRecoveryGuidance("http_token_required")
    return
  }
  const botName = options.name?.trim() || (
    options.yes
      ? t("deploy.name_default")
      : await textPrompt(t("deploy.name_prompt"), t("deploy.name_default"))
  )
  const port = validPort(options.port ?? "3000")!
  const secretReferences: NonNullable<DeployConfig["secretReferences"]> = {}
  if (channel === "http") {
    secretReferences.httpTokenEnv = "DIGITAL_EMPLOYEE_HTTP_TOKEN"
  }
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
        }
      : {}),
    ...(Object.keys(secretReferences).length > 0 ? { secretReferences } : {}),
    updatedAt: new Date().toISOString(),
  }

  const controller = new AbortController()
  const interrupt = () => {
    controller.abort()
    closePromptInput("deploy_interrupted")
  }
  process.once("SIGINT", interrupt)
  process.once("SIGTERM", interrupt)
  let lock
  try {
    lock = await acquireDeploymentLock({ signal: controller.signal })
  } catch (error) {
    process.removeListener("SIGINT", interrupt)
    process.removeListener("SIGTERM", interrupt)
    failCode(
      "deploy.error_state_write",
      safeFailureCode(error, "deploy_lock_failed"),
    )
    return
  }

  try {
    let snapshot
    try {
      await lock.assertOwned()
      snapshot = await loadConfigSnapshot()
      await lock.assertOwned()
    } catch (error) {
      failCode(
        "deploy.error_state_load",
        safeFailureCode(error, "deploy_config_invalid"),
      )
      return
    }
    const existing = snapshot.config
    let stateGeneration: DeployConfigFingerprint = snapshot.fingerprint
    if (
      existing.provider &&
      !(
        existing.channel === "dingtalk" &&
        channel === "dingtalk" &&
        existing.botName === candidate.botName
      )
    ) {
      renderOutcome(existing, {
        outcome: "unsupported",
        steps: [],
        code: "dingtalk_provider_rebinding_unsupported",
      })
      setOutcomeExitCode("unsupported")
      return
    }
    if (
      existing.providerOperation &&
      !(
        channel === "dingtalk" &&
        existing.channel === "dingtalk" &&
        sameDeployment(existing, candidate)
      )
    ) {
      renderOutcome(existing, {
        outcome: "pending_external_action",
        steps: [],
        code: "dingtalk_provider_create_indeterminate",
        guidance: t("deploy.guidance_dingtalk_pending"),
      })
      setOutcomeExitCode("pending_external_action")
      return
    }
    if (
      channel === "dingtalk" &&
      existing.channel === "dingtalk" &&
      existing.botName === candidate.botName &&
      existing.provider
    ) {
      candidate.provider = existing.provider
    }
    if (
      channel === "dingtalk" &&
      existing.channel === "dingtalk" &&
      sameDeployment(existing, candidate) &&
      existing.providerOperation
    ) {
      candidate.providerOperation = existing.providerOperation
    }
    let existingHttpState: Awaited<ReturnType<typeof inspectHttpDeployment>> | undefined
    if (existing.channel === "http" && existing.process) {
      try {
        await lock.assertOwned()
        existingHttpState = await inspectHttpDeployment(existing)
        await lock.assertOwned()
      } catch {
        failCode("deploy.error_state_write", "deploy_lock_not_owned")
        return
      }
    }
    if (controller.signal.aborted) {
      failCode("deploy.error_interrupted", "deploy_interrupted")
      writeRecoveryGuidance("deploy_interrupted")
      return
    }
    if (
      (existing.outcome === "ready" ||
        existing.outcome === "pending_external_action") &&
      sameDeployment(existing, candidate) &&
      channel === "http" &&
      existingHttpState === "ready"
    ) {
      writeBinding(binding, runtime)
      let resumed = existing
      let promoted = false
      try {
        await lock.assertOwned()
        const prePublicationReadback = await hasExactHttpReadback(
          existing,
          binding,
          controller.signal,
        )
        await lock.assertOwned()
        if (controller.signal.aborted) {
          failCode("deploy.error_interrupted", "deploy_interrupted")
          writeRecoveryGuidance("deploy_interrupted")
          return
        }
        if (!prePublicationReadback) {
          failCode("deploy.error_http_state_unsafe", "http_final_readback_failed")
          return
        }
        await loadExactConfigGeneration(stateGeneration, lock)
        if (existing.outcome !== "ready") {
          resumed = {
            ...existing,
            outcome: "ready",
            code: undefined,
            deployedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
          stateGeneration = await saveConfig(resumed, {
            expected: stateGeneration,
            lock,
          })
          promoted = true
        }
        const fresh = await loadExactConfigGeneration(stateGeneration, lock)
        const postPublicationReadback = await hasExactHttpReadback(
          fresh.config,
          binding,
          controller.signal,
        )
        await lock.assertOwned()
        if (controller.signal.aborted || !postPublicationReadback) {
          if (promoted) {
            const pending: DeployConfig = {
              ...existing,
              outcome: "pending_external_action",
              code: controller.signal.aborted
                ? existing.code ?? "http_resume_interrupted"
                : "http_final_readback_failed",
              deployedAt: undefined,
              updatedAt: new Date().toISOString(),
            }
            stateGeneration = await saveConfig(pending, {
              expected: stateGeneration,
              lock,
            })
          }
          failCode(
            controller.signal.aborted
              ? "deploy.error_interrupted"
              : "deploy.error_http_state_unsafe",
            controller.signal.aborted
              ? "deploy_interrupted"
              : "http_final_readback_failed",
          )
          return
        }
        renderOutcome(resumed, {
          outcome: "ready",
          steps: [],
          endpoint: resumed.endpoint,
          process: resumed.process,
        })
      } catch {
        if (promoted) {
          try {
            stateGeneration = await saveConfig({
              ...existing,
              outcome: "pending_external_action",
              code: existing.code ?? "http_resume_verification_failed",
              deployedAt: undefined,
              updatedAt: new Date().toISOString(),
            }, {
            expected: stateGeneration,
            lock,
          })
          } catch {
            // The primary generation or lock error remains authoritative.
          }
        }
        failCode("deploy.error_state_write", "deploy_state_write_failed")
      }
      return
    }

    if (existing.process && existingHttpState !== "absent") {
      const code = existingHttpState === "ready"
        ? "http_live_deployment_preserved"
        : existingHttpState === "starting"
          ? "http_runtime_starting_unavailable"
          : existingHttpState === "stale"
            ? "http_runtime_stale_unverified"
            : "http_runtime_identity_unverified"
      failCode("deploy.error_http_state_unsafe", code)
      return
    }

    if (existing.outcome || existing.deployedAt) {
      if (options.yes) {
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
      }
      if (controller.signal.aborted) {
        failCode("deploy.error_interrupted", "deploy_interrupted")
        writeRecoveryGuidance("deploy_interrupted")
        return
      }
    }

    if (controller.signal.aborted) {
      failCode("deploy.error_interrupted", "deploy_interrupted")
      writeRecoveryGuidance("deploy_interrupted")
      return
    }
    const assertEffectBoundary = async (): Promise<void> => {
      await lock.assertOwned()
      await assertExactPackageBinding(binding)
      await lock.assertOwned()
    }
    try {
      await assertEffectBoundary()
    } catch {
      failCode("deploy.error_invalid_package", "employee_package_changed")
      return
    }
    writeBinding(binding, runtime)
    const writesInitialState = channel !== "lark" &&
      channel !== "wecom" &&
      channel !== "dingtalk"
    if (writesInitialState) {
      try {
        stateGeneration = await saveConfig(candidate, {
          expected: stateGeneration,
          lock,
        })
      } catch {
        failCode("deploy.error_state_write", "deploy_state_write_failed")
        return
      }
    }

    let result: ChannelDeployResult
    try {
      await assertEffectBoundary()
      if (controller.signal.aborted) throw new TypeError("deploy_interrupted")
      result = await dispatchChannel(
        channel,
        candidate,
        controller.signal,
        async (processState) => {
          await assertEffectBoundary()
          stateGeneration = await saveConfig({
            ...candidate,
            process: processState,
            updatedAt: new Date().toISOString(),
          }, { expected: stateGeneration, lock })
          if (stateGeneration.kind !== "present") {
            throw new TypeError("http_process_state_generation_missing")
          }
          return stateGeneration.digest
        },
        async (provider) => {
          await assertEffectBoundary()
          stateGeneration = await saveConfig({
            ...candidate,
            provider,
            providerOperation: undefined,
            updatedAt: new Date().toISOString(),
          }, { expected: stateGeneration, lock })
          candidate.provider = provider
          candidate.providerOperation = undefined
        },
        async (operation) => {
          await assertEffectBoundary()
          stateGeneration = await saveConfig({
            ...candidate,
            providerOperation: operation,
            updatedAt: new Date().toISOString(),
          }, { expected: stateGeneration, lock })
          candidate.providerOperation = operation
        },
        options.yes === true,
        () => lock.assertOwned(),
        assertEffectBoundary,
        {
          fileDescriptor: lock.fileDescriptor,
          nonce: lock.nonce,
          device: lock.device,
          inode: lock.inode,
          ownerPid: process.pid,
        },
      )
    } catch {
      result = {
        outcome: "failed",
        steps: [],
        code: "deploy_orchestration_failed",
        guidance: t("deploy.error_orchestration"),
      }
    }

    if (result.preserveState) {
      try {
        const preserved = await loadExactConfigGeneration(stateGeneration, lock)
        renderOutcome(preserved.config, result)
        setOutcomeExitCode(result.outcome)
      } catch {
        failCode("deploy.error_state_load", "deploy_config_generation_changed")
      }
      return
    }

    if (controller.signal.aborted) {
      const providerOutcomeUncertain = channel === "dingtalk" &&
        Boolean(candidate.providerOperation) &&
        !candidate.provider &&
        result.outcome === "pending_external_action"
      if (!providerOutcomeUncertain) {
        const cleanupVerified = result.cleanup ? await result.cleanup() : true
        result = cleanupVerified
          ? {
              outcome: "failed",
              steps: [],
              code: "deploy_interrupted",
              guidance: t("deploy.error_interrupted"),
            }
          : {
              outcome: "pending_external_action",
              steps: [],
              code: "http_cleanup_unverified",
              guidance: t("deploy.error_http_readiness"),
              ...(result.endpoint ? { endpoint: result.endpoint } : {}),
              ...(result.process ? { process: result.process } : {}),
              ...(result.cleanup ? { cleanup: result.cleanup } : {}),
            }
      }
    }

    const now = new Date().toISOString()
    let finalConfig: DeployConfig | undefined
    try {
      if (result.outcome === "ready" && channel === "http") {
        if (
          !result.endpoint ||
          !result.process ||
          !result.cleanup ||
          !result.finalize ||
          !result.release
        ) {
          throw new TypeError("http_ready_evidence_incomplete")
        }
        let verificationState: DeployConfig = {
          ...candidate,
          outcome: "pending_external_action",
          endpoint: result.endpoint,
          process: result.process,
          code: "http_final_verification_pending",
          deployedAt: undefined,
          updatedAt: new Date().toISOString(),
        }
        stateGeneration = await saveConfig(verificationState, {
          expected: stateGeneration,
          lock,
        })
        let failureCode: string | undefined
        let releaseSent = false
        const prePublication = await loadExactConfigGeneration(stateGeneration, lock)
        const prePublicationReadback = controller.signal.aborted
          ? false
          : await hasExactHttpReadback(
              prePublication.config,
              binding,
              controller.signal,
            )
        await lock.assertOwned()
        if (controller.signal.aborted) {
          failureCode = "deploy_interrupted"
        } else if (!prePublicationReadback) {
          failureCode = "http_final_readback_failed"
        }

        if (
          !failureCode &&
          (
            stateGeneration.kind !== "present" ||
            !await result.finalize(stateGeneration.digest)
          )
        ) {
          failureCode = controller.signal.aborted
            ? "deploy_interrupted"
            : "http_activation_finalize_failed"
        }

        if (!failureCode) {
          finalConfig = {
            ...verificationState,
            outcome: "ready",
            code: undefined,
            deployedAt: now,
            updatedAt: new Date().toISOString(),
          }
          stateGeneration = await saveConfig(finalConfig, {
            expected: stateGeneration,
            lock,
          })
          const published = await loadExactConfigGeneration(stateGeneration, lock)
          const postPublicationReadback = controller.signal.aborted
            ? false
            : await hasExactHttpReadback(
                published.config,
                binding,
                controller.signal,
              )
          await lock.assertOwned()
          if (controller.signal.aborted) {
            failureCode = "deploy_interrupted"
          } else if (!postPublicationReadback) {
            failureCode = "http_final_readback_failed"
          }
        }

        if (!failureCode) {
          const releaseResult = stateGeneration.kind === "present"
            ? await result.release(stateGeneration.digest)
            : { sent: false, acknowledged: false }
          releaseSent = releaseResult.sent
          if (controller.signal.aborted) {
            failureCode = "deploy_interrupted"
          } else if (!releaseResult.sent) {
            failureCode = "http_activation_release_failed"
          } else if (!releaseResult.acknowledged) {
            failureCode = "http_activation_release_ack_failed"
          }
        }

        if (releaseSent) {
          const released = await loadExactConfigGeneration(stateGeneration, lock)
          const postReleaseReadback = controller.signal.aborted
            ? false
            : await hasExactHttpReadback(
                released.config,
                binding,
                controller.signal,
              )
          await lock.assertOwned()
          if (controller.signal.aborted) {
            failureCode = "deploy_interrupted"
          } else if (!postReleaseReadback) {
            failureCode = "http_final_readback_failed"
          }
        }

        if (failureCode && releaseSent) {
          failCode(
            failureCode === "deploy_interrupted"
              ? "deploy.error_interrupted"
              : "deploy.error_http_state_unsafe",
            failureCode,
          )
          return
        }

        if (failureCode) {
          verificationState = {
            ...verificationState,
            code: "http_cleanup_in_progress",
            updatedAt: new Date().toISOString(),
          }
          stateGeneration = await saveConfig(verificationState, {
            expected: stateGeneration,
            lock,
          })
          const cleanupVerified = await result.cleanup()
          if (cleanupVerified) {
            result = {
              outcome: "failed",
              steps: [],
              code: failureCode,
              guidance: failureCode === "deploy_interrupted"
                ? t("deploy.error_interrupted")
                : t("deploy.error_http_readiness"),
            }
            finalConfig = {
              ...candidate,
              outcome: "failed",
              code: failureCode,
              process: undefined,
              deployedAt: undefined,
              updatedAt: new Date().toISOString(),
            }
          } else {
            result = {
              outcome: "pending_external_action",
              steps: [],
              code: "http_cleanup_unverified",
              guidance: t("deploy.error_http_readiness"),
              endpoint: verificationState.endpoint,
              process: verificationState.process,
            }
            finalConfig = {
              ...verificationState,
              code: "http_cleanup_unverified",
              updatedAt: new Date().toISOString(),
            }
          }
          stateGeneration = await saveConfig(finalConfig, {
            expected: stateGeneration,
            lock,
          })
        }
      } else {
        finalConfig = {
          ...candidate,
          outcome: result.outcome,
          ...(result.endpoint ? { endpoint: result.endpoint } : {}),
          ...(result.process ? { process: result.process } : {}),
          ...(result.provider ? { provider: result.provider } : {}),
          ...(result.code ? { code: result.code } : {}),
          ...(result.outcome === "ready" ? { deployedAt: now } : {}),
          updatedAt: now,
        }
        stateGeneration = await saveConfig(finalConfig, {
          expected: stateGeneration,
          lock,
        })
      }
    } catch {
      await result.cleanup?.()
      failCode("deploy.error_state_write", "deploy_state_write_failed")
      return
    }

    if (!finalConfig) {
      failCode("deploy.error_state_write", "deploy_state_write_failed")
      return
    }
    try {
      await lock.assertOwned()
    } catch {
      await result.cleanup?.()
      failCode("deploy.error_state_write", "deploy_lock_not_owned")
      return
    }
    for (const step of result.steps) process.stdout.write(`  ${step}\n`)
    renderOutcome(finalConfig, result)
    setOutcomeExitCode(result.outcome)
  } finally {
    await lock.release()
    process.removeListener("SIGINT", interrupt)
    process.removeListener("SIGTERM", interrupt)
  }
}

export async function deploy(options: DeployOptions = {}): Promise<void> {
  try {
    await deployImpl(options)
  } catch (error) {
    if (error instanceof Error && error.message === "deploy_interrupted") {
      failCode("deploy.error_interrupted", "deploy_interrupted")
      writeRecoveryGuidance("deploy_interrupted")
      return
    }
    if (error instanceof Error && error.message.startsWith("deploy_prompt_input_")) {
      failCode("deploy.error_prompt_input_closed", error.message)
      return
    }
    throw error
  } finally {
    closePromptInput()
  }
}
