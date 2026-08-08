import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createServer, request as httpRequest } from "node:http"
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"

import {
  computeEmployeePackageDirectoryDigest,
  createEmployeePackage,
} from "../../apps/cli/employee-package.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const builtCli = path.join(root, "dist", "apps", "cli", "bin.js")
const qoderFixture = path.join(
  root,
  "tests",
  "apps",
  "fixtures",
  "fake-qoder.mjs",
)

interface CliEnvironment {
  home: string
  bin?: string
  extra?: NodeJS.ProcessEnv
}

function cliEnvironment({ home, bin, extra = {} }: CliEnvironment): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"]
      .filter(Boolean)
      .join(path.delimiter),
    ...extra,
  }
}

function runBuiltCli(
  args: string[],
  {
    cwd = root,
    environment,
  }: { cwd?: string; environment: NodeJS.ProcessEnv },
) {
  return spawnSync(process.execPath, [builtCli, ...args], {
    cwd,
    env: environment,
    encoding: "utf8",
    input: "",
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  })
}

async function isolatedRoot(t: test.TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  return directory
}

async function installFakeQoder(directory: string): Promise<void> {
  await mkdir(directory)
  const executable = path.join(directory, "qodercli")
  await cp(qoderFixture, executable)
  await chmod(executable, 0o755)
}

async function installObservableProbe(
  directory: string,
  marker: string,
): Promise<void> {
  await mkdir(directory)
  const executable = path.join(directory, "qodercli")
  await writeFile(
    executable,
    `#!/usr/bin/env node\n` +
      `const { appendFile } = await import("node:fs/promises")\n` +
      `await appendFile(process.env.DEPLOY_PROVIDER_MARKER, "called\\n")\n` +
      `if (process.argv.includes("--version")) process.stdout.write("1.1.12\\n")\n`,
    { mode: 0o755 },
  )
  await chmod(executable, 0o755)
  assert.equal(marker.length > 0, true)
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const port = address.port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function httpJson({
  port,
  path: requestPath,
  method = "GET",
  body,
  timeoutMs = 2_000,
}: {
  port: number
  path: string
  method?: "GET" | "POST"
  body?: string
  timeoutMs?: number
}): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method,
        timeout: timeoutMs,
        headers: body
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
            }
          : undefined,
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })
        response.on("end", () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
                string,
                unknown
              >,
            })
          } catch (error) {
            reject(error)
          }
        })
      },
    )
    request.once("timeout", () => request.destroy(new Error("http_timeout")))
    request.once("error", reject)
    if (body) request.write(body)
    request.end()
  })
}

async function noConfig(home: string): Promise<boolean> {
  try {
    await access(path.join(home, ".digital-employee", "config.json"))
    return false
  } catch {
    return true
  }
}

async function markerMissing(marker: string): Promise<boolean> {
  try {
    await access(marker)
    return false
  } catch {
    return true
  }
}

async function stopVerifiedHttpProcess(
  pid: number,
  port: number,
): Promise<void> {
  const health = await httpJson({ port, path: "/health" })
  assert.equal(health.status, 200)
  assert.equal(health.body.pid, pid)
  process.kill(pid, "SIGTERM")
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
      await delay(50)
    } catch {
      return
    }
  }
  throw new Error("verified_deploy_process_did_not_exit")
}

test("built deploy rejects an invalid package before config, prompt, provider, or process", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-invalid-package-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const invalidPackage = path.join(temporary, "invalid")
  const marker = path.join(temporary, "provider.marker")
  await mkdir(home)
  await mkdir(invalidPackage)
  await installObservableProbe(bin, marker)

  const result = runBuiltCli(
    [
      "deploy",
      "--package",
      invalidPackage,
      "--channel",
      "http",
      "--engine",
      "qoder",
      "--runtime",
      "agent-native",
      "--yes",
    ],
    {
      environment: cliEnvironment({
        home,
        bin,
        extra: {
          QODER_PERSONAL_ACCESS_TOKEN: "invalid-package-secret-sentinel",
          DEPLOY_PROVIDER_MARKER: marker,
        },
      }),
    },
  )

  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /Invalid employee package/)
  assert.doesNotMatch(result.stdout, /\?|Choice/)
  assert.equal(await noConfig(home), true)
  assert.equal(await markerMissing(marker), true)
})

test("built deploy rejects an explicit invalid channel before package, prompt, provider, or process", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-invalid-channel-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const marker = path.join(temporary, "provider.marker")
  await mkdir(home)
  await installObservableProbe(bin, marker)

  const result = runBuiltCli(
    [
      "deploy",
      "--package",
      path.join(temporary, "does-not-exist"),
      "--channel",
      "bogus",
      "--engine",
      "qoder",
      "--runtime",
      "agent-native",
      "--yes",
    ],
    {
      environment: cliEnvironment({
        home,
        bin,
        extra: {
          QODER_PERSONAL_ACCESS_TOKEN: "invalid-channel-secret-sentinel",
          DEPLOY_PROVIDER_MARKER: marker,
        },
      }),
    },
  )

  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /Invalid channel/)
  assert.match(result.stderr, /dingtalk\|lark\|wecom\|console\|http/)
  assert.doesNotMatch(result.stdout, /\?|Choice/)
  assert.equal(await noConfig(home), true)
  assert.equal(await markerMissing(marker), true)
})

test("built deploy rejects an explicit unavailable engine before config or runtime start", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-unavailable-engine-")
  const home = path.join(temporary, "home")
  const packageDirectory = path.join(temporary, "unavailable-engine")
  await mkdir(home)
  await createEmployeePackage(packageDirectory, { name: "unavailable-engine" })

  const result = runBuiltCli(
    [
      "deploy",
      packageDirectory,
      "--channel",
      "http",
      "--engine",
      "qoder",
      "--runtime",
      "agent-native",
      "--yes",
    ],
    {
      environment: cliEnvironment({
        home,
        extra: { QODER_PERSONAL_ACCESS_TOKEN: "unavailable-engine-sentinel" },
      }),
    },
  )

  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /selected engine is unsupported, unavailable, or incompatible/i)
  assert.doesNotMatch(result.stdout, /\?|Choice|Ready:/)
  assert.equal(await noConfig(home), true)
})

test("built complete --yes deploy binds --package and starts a verified /v1/ask runtime without stdin", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-http-package-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const packageDirectory = path.join(temporary, "bound-http")
  const port = await freePort()
  const secret = "http-deploy-secret-sentinel"
  await mkdir(home)
  await installFakeQoder(bin)
  await createEmployeePackage(packageDirectory, { name: "bound-http" })
  const digest = await computeEmployeePackageDirectoryDigest(packageDirectory)

  const result = runBuiltCli(
    [
      "deploy",
      "--package",
      packageDirectory,
      "--channel",
      "http",
      "--engine",
      "qoder",
      "--runtime",
      "agent-native",
      "--name",
      "Bound HTTP",
      "--locale",
      "en",
      "--port",
      String(port),
      "--yes",
    ],
    {
      cwd: temporary,
      environment: cliEnvironment({
        home,
        bin,
        extra: { QODER_PERSONAL_ACCESS_TOKEN: secret },
      }),
    },
  )

  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout, /\?|Choice/)
  assert.match(result.stdout, /bound-http@0\.1\.0/)
  assert.match(result.stdout, new RegExp(digest))
  assert.match(result.stdout, /runtime=agent-native/)
  assert.match(result.stdout, new RegExp(`http://127\\.0\\.0\\.1:${port}/v1/ask`))

  const configPath = path.join(home, ".digital-employee", "config.json")
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    outcome: string
    runtime: string
    engine: string
    package: { name: string; version: string; digest: string; localReference: string }
    process: { pid: number }
    endpoint: { port: number; askPath: string }
  }
  t.after(async () => stopVerifiedHttpProcess(config.process.pid, port))
  assert.equal(config.outcome, "ready")
  assert.equal(config.runtime, "agent-native")
  assert.equal(config.engine, "qoder")
  assert.deepEqual(
    {
      name: config.package.name,
      version: config.package.version,
      digest: config.package.digest,
    },
    { name: "bound-http", version: "0.1.0", digest },
  )
  assert.equal(config.package.localReference, await realpath(packageDirectory))
  assert.equal(config.endpoint.askPath, "/v1/ask")
  assert.equal((await stat(configPath)).mode & 0o777, 0o600)
  assert.equal((await stat(path.dirname(configPath))).mode & 0o777, 0o700)

  const health = await httpJson({ port, path: "/health" })
  assert.equal(health.status, 200)
  assert.equal(health.body.pid, config.process.pid)
  assert.deepEqual(health.body.package, {
    name: "bound-http",
    version: "0.1.0",
    digest,
    runtime: "agent-native",
    engine: "qoder",
  })

  const oldPath = await httpJson({ port, path: "/answer" })
  assert.equal(oldPath.status, 404)
  const answer = await httpJson({
    port,
    path: "/v1/ask",
    method: "POST",
    body: JSON.stringify({ message: "fixture question" }),
    timeoutMs: 10_000,
  })
  assert.equal(answer.status, 200)
  assert.equal(answer.body.answer, "fixture answer")

  const argv = spawnSync("ps", ["-p", String(config.process.pid), "-o", "command="], {
    encoding: "utf8",
  })
  const artifacts = [result.stdout, result.stderr, await readFile(configPath, "utf8"), JSON.stringify(health.body), JSON.stringify(answer.body), argv.stdout]
  for (const artifact of artifacts) assert.doesNotMatch(artifact, new RegExp(secret))
})

test("built deploy consumes cwd when no package path is supplied", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-http-cwd-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const packageDirectory = path.join(temporary, "cwd-bound")
  const port = await freePort()
  await mkdir(home)
  await installFakeQoder(bin)
  await createEmployeePackage(packageDirectory, { name: "cwd-bound" })

  const result = runBuiltCli(
    [
      "deploy",
      "--channel",
      "http",
      "--engine",
      "qoder",
      "--runtime",
      "agent-native",
      "--port",
      String(port),
      "--yes",
    ],
    {
      cwd: packageDirectory,
      environment: cliEnvironment({
        home,
        bin,
        extra: { QODER_PERSONAL_ACCESS_TOKEN: "cwd-secret-sentinel" },
      }),
    },
  )
  assert.equal(result.status, 0, result.stderr)
  const config = JSON.parse(
    await readFile(path.join(home, ".digital-employee", "config.json"), "utf8"),
  ) as { package: { name: string; localReference: string }; process: { pid: number } }
  t.after(async () => stopVerifiedHttpProcess(config.process.pid, port))
  assert.equal(config.package.name, "cwd-bound")
  assert.equal(config.package.localReference, await realpath(packageDirectory))
})
