import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { createEmployeePackage } from "../../apps/cli/employee-package.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const cli = path.join(root, "apps", "cli", "bin.ts")
const qoderFixture = path.join(root, "tests", "apps", "fixtures", "fake-qoder.mjs")
const claudeFixture = path.join(root, "tests", "apps", "fixtures", "fake-claude.mjs")
const qwenFixture = path.join(root, "tests", "apps", "fixtures", "fake-qwen.mjs")
const codeBuddyFixture = path.join(
  root,
  "tests",
  "apps",
  "fixtures",
  "fake-codebuddy.mjs",
)

function runCli(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
  input?: string,
) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: environment,
    ...(input === undefined ? {} : { input }),
  })
}

async function installFakeQoder(directory: string): Promise<void> {
  const executable = path.join(directory, "qodercli")
  await writeFile(executable, await readFile(qoderFixture, "utf8"), {
    mode: 0o755,
  })
  await chmod(executable, 0o755)
}

async function installFakeHost(
  directory: string,
  command: string,
  fixturePath: string,
): Promise<void> {
  const executable = path.join(directory, command)
  await writeFile(executable, await readFile(fixturePath, "utf8"), {
    mode: 0o755,
  })
  await chmod(executable, 0o755)
}

test("help leads with Agent-native commands while standalone stays explicit", () => {
  const help = runCli(["help"])
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /Agent-native usage:/)
  assert.match(
    help.stdout,
    /run \[directory\] --engine claude-code\|qoder\|qwen-code\|codebuddy/,
  )
  assert.match(help.stdout, /Codex is probe-only/)
  assert.match(help.stdout, /digital-employee legacy <ask\|sync\|start\|serve>/)
  assert.match(help.stdout, /bounded local '<host> --version' probe/)
  assert.match(help.stdout, /does not attempt authentication, invoke a model/)
  assert.doesNotMatch(help.stdout, /^\s+digital-employee ask /m)
})

test("default npm and container entry points stay on the Agent-native CLI", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  )
  assert.equal(
    packageJson.scripts.start,
    "npm run build --silent && node ./dist/apps/cli/bin.js --help",
  )

  const dockerfile = await readFile(path.join(root, "Dockerfile"), "utf8")
  assert.match(
    dockerfile,
    /ENTRYPOINT \["node", "\.\/node_modules\/@fullstack-ai-infra\/digital-employee\/dist\/apps\/cli\/bin\.js"\]/,
  )
  assert.match(dockerfile, /CMD \["--help"\]/)
  assert.doesNotMatch(dockerfile, /^CMD .*legacy/m)
})

test("standalone-v1 has an explicit namespace and compatible deprecated aliases", () => {
  const args = [
    "--question",
    "What should I include in an incident report?",
    "--json",
  ]
  const explicit = runCli(["legacy", "ask", ...args])
  assert.equal(explicit.status, 0, explicit.stderr)
  assert.doesNotMatch(explicit.stderr, /deprecated alias/)
  assert.doesNotThrow(() => JSON.parse(explicit.stdout))

  const alias = runCli(["ask", ...args])
  assert.equal(alias.status, 0, alias.stderr)
  assert.match(alias.stderr, /deprecated alias for 'legacy ask'/)
  assert.doesNotThrow(() => JSON.parse(alias.stdout))
})

test("doctor distinguishes a runnable adapter from verified model access", async (t) => {
  if (process.platform === "win32") return t.skip("fixture executable is POSIX-only")
  const directory = await mkdtemp(path.join(os.tmpdir(), "employee-doctor-"))
  await installFakeQoder(directory)

  const result = runCli(["doctor", "--engine", "qoder", "--json"], {
    ...process.env,
    PATH: `${directory}${path.delimiter}${process.env.PATH}`,
    QODER_PERSONAL_ACCESS_TOKEN: "fixture-service-token",
  })
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.status, "installed")
  assert.equal(output.runnable, true)
  assert.equal(output.hosts[0].status, "ready")
  assert.equal(output.hosts[0].adapterStatus, "runnable")
  assert.equal(
    output.hosts[0].issues.some(
      (issue: { code: string }) => issue.code === "authentication_not_verified",
    ),
    true,
  )
})

test("static validation succeeds while Qoder without a service token fails closed", async (t) => {
  if (process.platform === "win32") return t.skip("fixture executable is POSIX-only")
  const directory = await mkdtemp(path.join(os.tmpdir(), "employee-cli-"))
  const packageDirectory = path.join(directory, "team-answer")
  const executableDirectory = path.join(directory, "bin")
  await createEmployeePackage(packageDirectory)
  await mkdir(executableDirectory)
  await installFakeQoder(executableDirectory)

  const staticResult = runCli(["validate", packageDirectory, "--json"])
  assert.equal(staticResult.status, 0, staticResult.stderr)
  assert.equal(JSON.parse(staticResult.stdout).status, "valid")

  const hostResult = runCli(
    ["validate", packageDirectory, "--engine", "qoder", "--json"],
    {
      ...process.env,
      PATH: `${executableDirectory}${path.delimiter}${process.env.PATH}`,
      QODER_PERSONAL_ACCESS_TOKEN: "",
    },
  )
  assert.equal(hostResult.status, 1, hostResult.stderr)
  const output = JSON.parse(hostResult.stdout)
  assert.equal(output.status, "incompatible")
  assert.equal(output.compatibility.compatible, false)
  assert.equal(output.hosts, undefined)
  assert.equal(output.host.adapterStatus, "runnable")
  assert.equal(
    output.compatibility.issues.some(
      (issue: { code: string }) => issue.code === "qoder_service_token_not_configured",
    ),
    true,
  )

  const manifestPath = path.join(packageDirectory, "employee.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  manifest.policy.filesystem.read = ["./knowledge/*.md"]
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  const stillStaticValid = runCli(["validate", packageDirectory, "--json"])
  assert.equal(stillStaticValid.status, 0, stillStaticValid.stderr)
  const packageAware = runCli(
    ["validate", packageDirectory, "--engine", "qoder", "--json"],
    {
      ...process.env,
      PATH: `${executableDirectory}${path.delimiter}${process.env.PATH}`,
      QODER_PERSONAL_ACCESS_TOKEN: "fixture-service-token",
    },
  )
  assert.equal(packageAware.status, 1, packageAware.stderr)
  const packageAwareOutput = JSON.parse(packageAware.stdout)
  assert.equal(packageAwareOutput.status, "incompatible")
  assert.equal(
    packageAwareOutput.compatibility.issues.some(
      (issue: { code: string }) => issue.code === "qoder_invalid_workspace_file",
    ),
    true,
  )
})

test("run executes a portable package through the Qoder adapter, not standalone-v1", async (t) => {
  if (process.platform === "win32") return t.skip("fixture executable is POSIX-only")
  const directory = await mkdtemp(path.join(os.tmpdir(), "employee-run-"))
  const packageDirectory = path.join(directory, "team-answer")
  const executableDirectory = path.join(directory, "bin")
  await createEmployeePackage(packageDirectory)
  await mkdir(executableDirectory)
  await installFakeQoder(executableDirectory)

  const result = runCli(
    [
      "run",
      packageDirectory,
      "--engine",
      "qoder",
      "--stdin",
      "--json",
    ],
    {
      ...process.env,
      PATH: `${executableDirectory}${path.delimiter}${process.env.PATH}`,
      QODER_PERSONAL_ACCESS_TOKEN: "fixture-service-token",
    },
    '{"message":"fixture question"}\n',
  )
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.schemaVersion, "employee-run.v1alpha1")
  assert.equal(output.status, "completed")
  assert.equal(output.engine, "qoder")
  assert.equal(output.output.answer, "fixture answer")
})

for (const [engine, command, fixturePath, configuration] of [
  [
    "claude-code",
    "claude",
    claudeFixture,
    { ANTHROPIC_API_KEY: "fixture-anthropic-api-key" },
  ],
  [
    "qwen-code",
    "qwen",
    qwenFixture,
    { OPENAI_API_KEY: "fixture-openai-api-key", OPENAI_MODEL: "fixture-model" },
  ],
  [
    "codebuddy",
    "codebuddy",
    codeBuddyFixture,
    {
      CODEBUDDY_API_KEY: "fixture-codebuddy-api-key",
      CODEBUDDY_MODEL: "fixture-model",
    },
  ],
] as const) {
  test(`run executes a portable package through the ${engine} adapter`, async (t) => {
    if (process.platform === "win32") {
      return t.skip("fixture executable is POSIX-only")
    }
    const directory = await mkdtemp(path.join(os.tmpdir(), `employee-${engine}-`))
    const packageDirectory = path.join(directory, "team-answer")
    const executableDirectory = path.join(directory, "bin")
    await createEmployeePackage(packageDirectory)
    await mkdir(executableDirectory)
    await installFakeHost(executableDirectory, command, fixturePath)

    const result = runCli(
      ["run", packageDirectory, "--engine", engine, "--stdin", "--json"],
      {
        ...process.env,
        PATH: `${executableDirectory}${path.delimiter}${process.env.PATH}`,
        ...configuration,
      },
      '{"message":"fixture question"}\n',
    )
    assert.equal(result.status, 0, result.stderr)
    const output = JSON.parse(result.stdout)
    assert.equal(output.status, "completed")
    assert.equal(output.engine, engine)
    assert.equal(output.output.answer, "fixture answer")
  })
}

test("run keeps Codex probe-only and never falls back to another runtime", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "employee-codex-probe-only-"))
  const packageDirectory = path.join(parent, "team-answer")
  await createEmployeePackage(packageDirectory)

  const result = runCli(
    [
      "run",
      packageDirectory,
      "--engine",
      "codex",
      "--stdin",
      "--json",
    ],
    process.env,
    '{"message":"fixture question"}\n',
  )
  assert.equal(result.status, 1, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.status, "failed")
  assert.equal(output.engine, "codex")
  assert.equal(output.error.code, "agent_host_adapter_not_runnable")
})
