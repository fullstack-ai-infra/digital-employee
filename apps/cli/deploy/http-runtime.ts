#!/usr/bin/env node

import { computeEmployeePackageDirectoryDigest } from "../employee-package.js"
import { runEmployeePackage } from "../agent-run.js"
import { createHttpServer } from "../../server/server.js"
import { loadConfigFromPath } from "./config.js"

function requiredStatePath(argv: string[]): string {
  if (argv.length !== 2 || argv[0] !== "--state" || !argv[1]) {
    throw new TypeError("deploy_http_runtime_requires_state")
  }
  return argv[1]
}

function safeCompletedOutput(output: unknown): Record<string, unknown> {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    return { status: "answered", ...(output as Record<string, unknown>) }
  }
  return { status: "answered", output }
}

export async function runHttpDeploymentRuntime(
  statePath: string,
): Promise<void> {
  const config = await loadConfigFromPath(statePath)
  if (
    config.schemaVersion !== "deploy-state.v1" ||
    config.channel !== "http" ||
    config.runtime !== "agent-native" ||
    !config.engine ||
    !config.package ||
    !config.endpoint
  ) {
    throw new TypeError("deploy_http_runtime_state_invalid")
  }
  const digest = await computeEmployeePackageDirectoryDigest(
    config.package.localReference,
  )
  if (digest !== config.package.digest) {
    throw new TypeError("deploy_http_runtime_package_digest_mismatch")
  }

  const binding = {
    name: config.package.name,
    version: config.package.version,
    digest: config.package.digest,
    runtime: config.runtime,
    engine: config.engine,
  }
  const server = createHttpServer({
    token: config.secretReferences?.httpTokenEnv
      ? process.env[config.secretReferences.httpTokenEnv]
      : undefined,
    employee: {
      async answer(input) {
        const result = await runEmployeePackage({
          directory: config.package!.localReference,
          engine: config.engine!,
          input: { message: input.message },
          expectedPackageDigest: config.package!.digest,
        })
        if (result.status === "failed") {
          return {
            status: "rejected",
            error: {
              code: result.error.code,
              retryable: result.error.retryable,
            },
          }
        }
        return safeCompletedOutput(result.output)
      },
    },
    health: () => ({
      schemaVersion: "deploy-readiness.v1",
      status: "ok",
      pid: process.pid,
      endpoint: {
        askPath: "/v1/ask",
        healthPath: "/health",
      },
      package: binding,
    }),
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once("error", onError)
    server.listen(config.endpoint!.port, config.endpoint!.host, () => {
      server.removeListener("error", onError)
      resolve()
    })
  })

  const stop = () => {
    server.close(() => process.exit(0))
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
}

runHttpDeploymentRuntime(requiredStatePath(process.argv.slice(2))).catch(() => {
  process.exitCode = 1
})
