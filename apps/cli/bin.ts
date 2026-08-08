#!/usr/bin/env node

import { parseArgs } from "node:util";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DigitalEmployee } from "../../packages/core/src/digital-employee.js";
import { validateStdioAdapterConfig } from "../../packages/core/src/agent-host-stdio-config.js";
import type { AgentHostPolicy } from "../../packages/core/src/agent-host.js";
import { ExternalStdioAgentHostAdapter } from "./stdio-agent-host.js";
import {
  BUILT_IN_AGENT_HOST_IDS,
} from "./agent-hosts.js";
import {
  probeBuiltInAgentHosts,
  resolveBuiltInAgentHostId,
} from "./agent-host-registry.js";
import {
  inspectEmployeeHostCompatibility,
  runEmployeePackage,
} from "./agent-run.js";
import {
  createEmployeePackage,
  inspectEmployeePackage,
} from "./employee-package.js";
import { evaluateEmployeePackage } from "./employee-eval.js";
import { deploy } from "./deploy/index.js";
import { setup } from "./setup.js";

type EmployeeResult = Awaited<ReturnType<DigitalEmployee["answer"]>>;

interface CommandValues {
  config: string;
  question?: string;
  json: boolean;
  channel?: string;
  engine?: string;
  input?: string;
  inputFile?: string;
  stdin: boolean;
  deadline?: string;
  name?: string;
  author?: string;
  recipe?: string;
  host: string;
  port: string;
  locale?: string;
  runtime?: string;
  package?: string;
  yes: boolean;
  help: boolean;
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const defaultConfig = path.join(packageRoot, "configs", "demo.json");

function usage() {
  return `Digital Employee

Agent-native usage:
  digital-employee setup [directory] [--name employee-name] [--recipe minimal-answer.v1|structured-action.v1] [--json]
  digital-employee deploy [package-path] [--package path] --channel <id> --engine <id> --runtime agent-native|standalone-v1 [options]
  digital-employee doctor [--engine claude-code|qoder|codex|qwen-code|codebuddy] [--json]
  digital-employee init <directory> [--recipe minimal-answer.v1|structured-action.v1] [--name employee-name] [--author author]
  digital-employee validate [directory] [--engine claude-code|qoder|codex|qwen-code|codebuddy] [--json]
  digital-employee eval [directory] [--json]
  digital-employee run [directory] --engine claude-code|qoder|qwen-code|codebuddy (--stdin | --input-file path | --question "..." | --input '{"message":"..."}') [--json]
  digital-employee stdio-host <config.json> [--question "..."] [--json]

Standalone-v1 compatibility:
  digital-employee legacy <ask|sync|start|serve> [options]

Agent host diagnosis may execute a bounded local '<host> --version' probe.
It does not attempt authentication, invoke a model, execute tools, or start an Agent run.
Codex is probe-only.
Eval is offline fixture conformance; it never invokes a model, Agent Host, MCP, or online service.
The compatibility namespace uses the frozen model/retriever loop, not an Agent host.
`;
}

function parseCommand(argv: string[]) {
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "help";
  const rest = command === "help" ? argv.slice(command === argv[0] ? 1 : 0) : argv.slice(1);
  const parsed = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: true,
    tokens: true,
    options: {
      config: { type: "string", short: "c", default: defaultConfig },
      question: { type: "string", short: "q" },
      json: { type: "boolean", default: false },
      channel: { type: "string" },
      engine: { type: "string" },
      input: { type: "string" },
      "input-file": { type: "string" },
      stdin: { type: "boolean", default: false },
      deadline: { type: "string" },
      name: { type: "string" },
      author: { type: "string" },
      recipe: { type: "string" },
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "3000" },
      locale: { type: "string" },
      runtime: { type: "string" },
      package: { type: "string" },
      yes: { type: "boolean", short: "y", default: false },
      help: { type: "boolean", short: "h", default: false }
    }
  });
  const values = parsed.values as typeof parsed.values & { "input-file"?: string };
  return {
    command,
    values: {
      ...values,
      inputFile: values["input-file"],
    } as CommandValues,
    positionals: parsed.positionals,
    providedOptions: new Set(
      parsed.tokens
        .filter((token) => token.kind === "option")
        .map((token) => token.name),
    ),
  };
}

function printResult(result: EmployeeResult, json: boolean) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${result.answer || result.escalation?.message || "No answer"}\n`);
  if (result.citations?.length) {
    process.stdout.write("\nSources:\n");
    for (const citation of result.citations) {
      if (!citation || typeof citation !== "object" || Array.isArray(citation)) continue;
      const label = typeof citation.label === "string"
        ? citation.label
        : typeof citation.id === "string"
          ? citation.id
          : "approved source";
      const uri = typeof citation.uri === "string" ? citation.uri : "approved source";
      process.stdout.write(`- ${label}: ${uri}\n`);
    }
  }
  if (result.escalation) {
    process.stdout.write(`\nHuman review: ${result.escalation.target} (${result.escalation.reason})\n`);
  }
}

async function ask(values: CommandValues, positionals: string[]) {
  const { assertProfileCapability, createRuntime } = await import("./runtime.js");
  const question = values.question || positionals.join(" ").trim();
  if (!question) throw new TypeError("ask_requires_question");
  const runtime = await createRuntime(values.config);
  assertProfileCapability(runtime.profileManifest, "channels", "cli");
  const result = await runtime.employee.answer({
    requestId: `cli-${Date.now()}`,
    sessionId: "cli",
    actorId: "cli",
    message: question,
    metadata: { channel: "cli" }
  });
  printResult(result, values.json);
}

async function sync(values: CommandValues) {
  const { createRuntime } = await import("./runtime.js");
  const runtime = await createRuntime(values.config);
  const result = {
    status: "ready",
    employee: runtime.profile.id,
    sourceCount: runtime.sources.length,
    documentCount: runtime.documents.length
  };
  if (values.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(
      `Ready: ${result.documentCount} approved chunks from ${result.sourceCount} source(s).\n`
    );
  }
}

async function start(values: CommandValues) {
  const { assertProfileCapability, createRuntime } = await import("./runtime.js");
  const runtime = await createRuntime(values.config);
  const channelName = values.channel || runtime.config.channel?.type || "console";
  assertProfileCapability(runtime.profileManifest, "channels", channelName);
  const channel = await runtime.registry.create("channel", channelName, {
    config: runtime.config.channel || {},
    configDirectory: runtime.configDirectory,
    environment: process.env
  });
  await channel.start(async (message: {
    id: string;
    threadId: string;
    actorId?: string;
    text: string;
    channel?: string;
  }) => {
    const result = await runtime.employee.answer({
      requestId: message.id,
      sessionId: message.threadId,
      actorId: message.actorId || channelName,
      message: message.text,
      metadata: { channel: message.channel || channelName }
    });
    if (typeof channel.reply === "function") {
      await channel.reply(message, result);
    }
    return result;
  });
}

async function serve(values: CommandValues) {
  const [{ createHttpServer }, { assertProfileCapability, createRuntime }] =
    await Promise.all([
      import("../server/server.js"),
      import("./runtime.js"),
    ]);
  const runtime = await createRuntime(values.config);
  assertProfileCapability(runtime.profileManifest, "channels", "http");
  const port = Number.parseInt(values.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new TypeError("invalid_port");
  const tokenEnv = runtime.config.server?.apiTokenEnv;
  const token = tokenEnv ? process.env[tokenEnv] : undefined;
  if (tokenEnv && !token) throw new Error(`missing_server_token:${tokenEnv}`);
  const server = createHttpServer({
    employee: runtime.employee,
    token,
    health: () => ({
      status: "ok",
      employee: runtime.profile.id,
      documents: runtime.documents.length
    })
  });
  server.listen(port, values.host, () => {
    process.stdout.write(`Digital employee listening on http://${values.host}:${port}\n`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function doctor(values: CommandValues) {
  let hostIds: readonly string[];
  if (values.engine) {
    const hostId = resolveBuiltInAgentHostId(values.engine);
    if (!hostId) {
      throw new TypeError(`unknown_agent_host:${values.engine}`);
    }
    hostIds = [hostId];
  } else {
    hostIds = BUILT_IN_AGENT_HOST_IDS;
  }
  const hosts = await probeBuiltInAgentHosts(hostIds);
  const installed = hosts.filter((host) => host.available).length;
  const result = {
    status: installed > 0 ? "installed" : "not_found",
    runnable: hosts.some(
      (host) => host.adapterStatus === "runnable" && host.status === "ready"
    ),
    note: "Local readiness only; model access is verified only by a real run.",
    hosts
  };

  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write("Agent hosts:\n");
    for (const host of hosts) {
      const detail = host.version ? ` (${host.version})` : "";
      const adapter = host.adapterStatus === "runnable" ? "runnable" : "probe-only";
      process.stdout.write(
        `- ${host.displayName}: ${host.status}${detail} [${adapter}]\n`
      );
    }
    process.stdout.write(`\n${result.note}\n`);
  }

  if (installed === 0) process.exitCode = 1;
}

async function init(values: CommandValues, positionals: string[]) {
  const directory = positionals[0];
  if (!directory) throw new TypeError("init_requires_directory");
  if (positionals.length > 1) throw new TypeError("init_accepts_one_directory");
  let created;
  try {
    created = await createEmployeePackage(directory, {
      name: values.name,
      author: values.author,
      recipe: values.recipe
    });
  } catch (error) {
    if (
      error instanceof TypeError &&
      error.message === "init_target_already_exists"
    ) {
      const result = {
        status: "failed",
        code: "INIT_TARGET_ALREADY_EXISTS"
      };
      if (values.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        process.stderr.write(`digital-employee: ${result.code}\n`);
      }
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  if (values.json) {
    process.stdout.write(`${JSON.stringify(created, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `Created ${created.manifest.name} from ${created.recipe} in ${created.directory}\n`,
  );
  for (const file of created.files) process.stdout.write(`- ${file}\n`);
  process.stdout.write(
    `\nNext: edit SKILL.md, add approved knowledge, then run validate and eval.\n`
  );
}

async function evalFixtures(values: CommandValues, positionals: string[]) {
  if (positionals.length > 1) throw new TypeError("eval_accepts_one_directory");
  if (values.engine) throw new TypeError("eval_does_not_accept_engine");
  const result = await evaluateEmployeePackage(positionals[0] || process.cwd());
  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `Contract eval (offline fixture conformance): ${result.status}. ` +
        `${result.summary.passed}/${result.summary.total} case(s) passed.\n`,
    );
    for (const evalCase of result.cases) {
      process.stdout.write(
        `- ${evalCase.id}: ${evalCase.status} (${evalCase.code})\n`,
      );
    }
    if (result.status === "failed" && result.cases.length === 0) {
      process.stdout.write(`- ${result.code}\n`);
    }
  }
  if (result.status === "failed") process.exitCode = 1;
}

async function validate(values: CommandValues, positionals: string[]) {
  if (positionals.length > 1) throw new TypeError("validate_accepts_one_directory");
  const directory = positionals[0] || process.cwd();
  let host;
  let compatibility;
  let inspected;
  if (values.engine) {
    const hostId = resolveBuiltInAgentHostId(values.engine);
    if (!hostId) {
      throw new TypeError(`unknown_agent_host:${values.engine}`);
    }
    ({ inspection: inspected, host, compatibility } =
      await inspectEmployeeHostCompatibility({
        directory,
        engine: hostId,
      }));
  } else {
    inspected = await inspectEmployeePackage(directory);
  }

  const result = {
    status: compatibility && !compatibility.compatible ? "incompatible" : "valid",
    employee: {
      name: inspected.manifest.name,
      version: inspected.manifest.version,
      schemaVersion: inspected.manifest.schemaVersion
    },
    files: inspected.files,
    ...(host ? { host, compatibility } : {})
  };
  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `Static package valid: ${result.employee.name}@${result.employee.version}\n`
    );
    process.stdout.write(`Checked ${result.files.length} declared file(s).\n`);
    if (host && compatibility) {
      process.stdout.write(
        `${host.displayName}: ${compatibility.compatible ? "compatible" : "incompatible"}\n`
      );
      for (const capability of compatibility.missing) {
        process.stdout.write(`- unsupported: ${capability}\n`);
      }
      for (const capability of compatibility.unknown) {
        process.stdout.write(`- unverified: ${capability}\n`);
      }
      for (const issue of compatibility.issues.filter((entry) => entry.blocking)) {
        process.stdout.write(`- blocked: ${issue.code}\n`);
      }
    }
  }
  if (compatibility && !compatibility.compatible) process.exitCode = 1;
}

function printAgentRunOutput(output: unknown): void {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const value = output as Record<string, unknown>;
    if (typeof value.answer === "string" && value.answer) {
      process.stdout.write(`${value.answer}\n`);
      if (Array.isArray(value.citations) && value.citations.length > 0) {
        process.stdout.write("\nSources:\n");
        for (const rawCitation of value.citations) {
          if (!rawCitation || typeof rawCitation !== "object" || Array.isArray(rawCitation)) continue;
          const citation = rawCitation as Record<string, unknown>;
          const label = typeof citation.label === "string" ? citation.label : "approved source";
          const uri = typeof citation.uri === "string" ? citation.uri : "approved source";
          process.stdout.write(`- ${label}: ${uri}\n`);
        }
      }
      return;
    }
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

async function run(values: CommandValues, positionals: string[]) {
  if (positionals.length > 1) throw new TypeError("run_accepts_one_directory");
  if (!values.engine) throw new TypeError("run_requires_engine");
  const hostId = resolveBuiltInAgentHostId(values.engine);
  if (!hostId) {
    throw new TypeError(`unknown_agent_host:${values.engine}`);
  }
  const inputModes = [
    Boolean(values.input),
    Boolean(values.question),
    Boolean(values.inputFile),
    values.stdin,
  ].filter(Boolean).length;
  if (inputModes > 1) {
    throw new TypeError("run_accepts_one_input_source");
  }

  let input: unknown;
  let serializedInput: string | undefined;
  if (values.inputFile) {
    serializedInput = await readBoundedInput(createReadStream(values.inputFile));
  } else if (values.stdin) {
    serializedInput = await readBoundedInput(process.stdin);
  } else if (values.input) {
    serializedInput = values.input;
  }
  if (serializedInput !== undefined) {
    try {
      input = JSON.parse(serializedInput) as unknown;
    } catch {
      throw new TypeError("run_input_invalid_json");
    }
  } else if (values.question?.trim()) {
    input = { message: values.question.trim() };
  } else {
    throw new TypeError("run_requires_input");
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  let result;
  try {
    result = await runEmployeePackage({
      directory: positionals[0] || process.cwd(),
      engine: hostId,
      input,
      ...(values.deadline ? { deadline: values.deadline } : {}),
      signal: controller.signal,
    });
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.status === "completed") {
    printAgentRunOutput(result.output);
  } else {
    process.stderr.write(`digital-employee: ${result.error.code}\n`);
    for (const item of result.issues ?? []) {
      process.stderr.write(`- blocked: ${item.code}\n`);
    }
  }
  if (result.status === "failed") {
    process.exitCode = result.error.code.endsWith("_run_cancelled") ? 130 : 1;
  }
}

async function readBoundedInput(
  stream: AsyncIterable<string | Buffer>,
): Promise<string> {
  const limit = 1024 * 1024;
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > limit) throw new TypeError("run_input_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function warnLegacyAlias(command: string): void {
  if (process.env.DIGITAL_EMPLOYEE_SUPPRESS_LEGACY_WARNING === "1") return;
  process.stderr.write(
    `[standalone-v1] '${command}' is a deprecated alias for 'legacy ${command}'. ` +
      "This compatibility path uses the model/retriever loop, not an Agent host; " +
      "it is retained through 0.x.\n"
  );
}

async function runLegacyCommand(
  command: string | undefined,
  values: CommandValues,
  positionals: string[],
) {
  if (command === "ask") return ask(values, positionals);
  if (command === "sync") return sync(values);
  if (command === "start") return start(values);
  if (command === "serve") return serve(values);
  throw new TypeError(`unknown_legacy_command:${command || "missing"}`);
}

async function main() {
  const { command, values, positionals, providedOptions } = parseCommand(process.argv.slice(2));
  if (command === "help" || (values.help && command !== "deploy")) {
    process.stdout.write(usage());
    return;
  }
  if (command === "legacy") {
    return runLegacyCommand(positionals[0], values, positionals.slice(1));
  }
  if (["ask", "sync", "start", "serve"].includes(command)) {
    warnLegacyAlias(command);
    return runLegacyCommand(command, values, positionals);
  }
  if (command === "setup") return setup({
    directory: positionals[0] || undefined,
    json: values.json,
    name: values.name,
    recipe: values.recipe,
  });
  if (command === "deploy") return deploy({
    packagePath: values.package || positionals[0],
    packagePathConflict: Boolean(values.package && positionals.length > 0),
    extraPackagePaths: positionals.length > 1,
    channel: values.channel,
    engine: values.engine,
    name: values.name,
    locale: values.locale,
    runtime: values.runtime,
    port: values.port,
    yes: values.yes,
    help: values.help,
    providedOptions,
  });
  if (command === "doctor") return doctor(values);
  if (command === "init") return init(values, positionals);
  if (command === "validate") return validate(values, positionals);
  if (command === "eval") return evalFixtures(values, positionals);
  if (command === "run") return run(values, positionals);
  if (command === "stdio-host") return stdioHost(values, positionals);
  throw new TypeError(`unknown_command:${command}`);
}

function stdioHostPolicy(): AgentHostPolicy {
  return {
    tools: { default: "deny", allow: [] },
    filesystem: { read: ["."], write: [] },
    network: { mode: "deny" },
    approval: { mode: "never" },
    maxTurns: 4,
  };
}

async function stdioHost(values: CommandValues, positionals: string[]) {
  const configPath = positionals[0];
  if (!configPath) {
    throw new TypeError("stdio_host_config_required");
  }
  const config = validateStdioAdapterConfig(
    JSON.parse(await readFile(configPath, "utf8")),
  );
  const adapter = new ExternalStdioAgentHostAdapter(config);
  try {
    const probe = await adapter.probe();
    if (!values.question) {
      process.stdout.write(`${JSON.stringify(probe, null, 2)}\n`);
      return;
    }
    await adapter.preflight({
      runId: "cli-stdio-preflight",
      employeeId: "cli",
      workingDirectory: process.cwd(),
      prompt: values.question,
      policy: stdioHostPolicy(),
    });
    const events = [];
    for await (const event of adapter.run({
      runId: "cli-stdio-run",
      employeeId: "cli",
      workingDirectory: process.cwd(),
      prompt: values.question,
      policy: stdioHostPolicy(),
    })) {
      events.push(event);
    }
    if (values.json) {
      process.stdout.write(`${JSON.stringify(events, null, 2)}\n`);
      return;
    }
    const terminal = events[events.length - 1];
    process.stdout.write(
      `${terminal && terminal.type === "run.completed" ? JSON.stringify(terminal.output) : "run_failed"}\n`,
    );
  } finally {
    await adapter.dispose();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unexpected_error";
  process.stderr.write(`digital-employee: ${message}\n`);
  process.exitCode = 1;
});
