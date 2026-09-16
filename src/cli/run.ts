import path from "node:path";
import { Command, CommanderError } from "commander";
import { failResult, type CommandResult } from "./envelope.js";
import { capabilities } from "./commands/capabilities.js";
import { datasetDescribe } from "./commands/describe.js";
import { initTemplate } from "./commands/init.js";
import { querySnapshot } from "./commands/query.js";
import { schemaShow } from "./commands/schemaShow.js";
import { templatesList } from "./commands/templates.js";
import { build } from "./commands/build.js";
import { testProject } from "./commands/test.js";
import { validate } from "./commands/validate.js";
import { planCommand } from "./commands/plan.js";
import { applyCommand } from "./commands/apply.js";
import { refreshCommand } from "./commands/refresh.js";
import { runsList, runsShow, runsCancel } from "./commands/runs.js";
import { serveCommand } from "./commands/serve.js";
import { publishCommand } from "./commands/publish.js";
import { doctorCommand } from "./commands/doctor.js";
import { forkCommand } from "./commands/fork.js";

export interface RunCliOptions {
  cwd: string;
}

export type { CommandResult } from "./envelope.js";

function validationError(
  command: string,
  message: string,
  pointer: string | null = null,
): CommandResult<null> {
  return failResult(command, {
    code: "validation",
    message,
    resource_id: null,
    pointer,
    retryable: false,
    suggested_next: null,
  });
}

export async function runCli(
  argv: string[],
  opts: RunCliOptions,
): Promise<CommandResult> {
  const json = argv.includes("--json");
  const cmdArgv = argv.filter((arg) => arg !== "--json");

  // Gate before dispatch, not after. Checking this once the action has run
  // means a refused `build` still writes a release and a refused `publish`
  // still uploads — a caller that trusts `ok: false` and retries would then
  // double the side effects.
  if (!json) {
    return validationError(
      cmdArgv.find((arg) => !arg.startsWith("-")) ?? "",
      "--json is required",
      "/json",
    );
  }

  let result: CommandResult | undefined;
  let commandName = "";

  const program = new Command();
  program
    .name("chainplot")
    .exitOverride()
    .allowExcessArguments(false)
    .showHelpAfterError(false)
    .configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });

  program
    .command("capabilities")
    .description("report CLI version and supported capabilities")
    .action(() => {
      commandName = "capabilities";
      result = capabilities();
    });

  program
    .command("validate")
    .description("load and validate chainplot.yaml")
    .action(() => {
      commandName = "validate";
      result = validate(opts.cwd);
    });

  program
    .command("init")
    .description("scaffold a project from a template")
    .requiredOption("--template <id>", "template id")
    .requiredOption("--output <dir>", "output directory")
    .action((options: { template: string; output: string }) => {
      commandName = "init";
      const output = path.isAbsolute(options.output)
        ? options.output
        : path.resolve(opts.cwd, options.output);
      result = initTemplate(options.template, output);
    });

  const templates = program
    .command("templates")
    .description("template operations");
  templates
    .command("list")
    .description("list available project templates")
    .action(() => {
      commandName = "templates list";
      result = templatesList();
    });

  const schema = program
    .command("schema")
    .description("JSON Schema operations");
  schema
    .command("show")
    .description("print the JSON Schema for a document kind")
    .argument("<kind>", "schema kind")
    .action((kind: string) => {
      commandName = "schema show";
      result = schemaShow(kind);
    });

  const dataset = program.command("dataset").description("dataset operations");
  dataset
    .command("describe")
    .description("describe a dataset snapshot")
    .argument("<id>", "dataset id")
    .action(async (id: string) => {
      commandName = "dataset describe";
      result = await datasetDescribe(opts.cwd, id);
    });

  program
    .command("query")
    .description("run SQL against a dataset snapshot")
    .requiredOption("--file <path>", "SQL file")
    .requiredOption("--snapshot <id>", "dataset id")
    .action(async (options: { file: string; snapshot: string }) => {
      commandName = "query";
      result = await querySnapshot(opts.cwd, options.file, options.snapshot);
    });

  program
    .command("test")
    .description("run local dataset assertions")
    .action(async () => {
      commandName = "test";
      result = await testProject(opts.cwd);
    });

  program
    .command("build")
    .description("write the full static release (results, dashboards, viewer, source/)")
    .option(
      "--mode <mode>",
      "dataset_included | results_only | dataset_referenced",
      (v: string) => v as "dataset_included" | "results_only" | "dataset_referenced",
    )
    .action(async (options: { mode?: "dataset_included" | "results_only" | "dataset_referenced" }) => {
      commandName = "build";
      result = await build(opts.cwd, options.mode);
    });

  program
    .command("plan")
    .description("write a digest-bound plan; mutates nothing")
    .requiredOption("--intent <intent>", "ingest|refresh|build|publish")
    .option("--publish-target <id>", "publish target id for --intent publish")
    .action(async (options: { intent: string; publishTarget?: string }) => {
      commandName = "plan";
      result = await planCommand(
        opts.cwd,
        options.intent,
        options.publishTarget,
      );
    });

  program
    .command("publish")
    .description("publish an already-built release to a target")
    .option("--publish-target <id>", "publish target id (default: first)")
    .action(async (options: { publishTarget?: string }) => {
      commandName = "publish";
      result = await publishCommand(opts.cwd, options.publishTarget);
    });

  program
    .command("apply")
    .description("execute a plan written by `plan`")
    .requiredOption("--plan <ref>", "plan path or plan id")
    .option("--idempotency-key <key>", "idempotency key (default: plan digest)")
    .action(async (options: { plan: string; idempotencyKey?: string }) => {
      commandName = "apply";
      result = await applyCommand(
        opts.cwd,
        options.plan,
        options.idempotencyKey,
        argv.includes("--jsonl"),
      );
    });

  program
    .command("refresh")
    .description("resume indexing, rebuild, optionally publish")
    .option("--publish-target <id>", "publish target id (must exist in chainplot.yaml)")
    .action(async (options: { publishTarget?: string }) => {
      commandName = "refresh";
      result = await refreshCommand(
        opts.cwd,
        options.publishTarget,
        argv.includes("--jsonl"),
      );
    });

  const runs = program.command("runs").description("run journal operations");
  runs
    .command("list")
    .description("list journal entries")
    .action(() => {
      commandName = "runs list";
      result = runsList(opts.cwd);
    });
  runs
    .command("show")
    .description("show one journal entry")
    .argument("<key>", "idempotency key")
    .action((key: string) => {
      commandName = "runs show";
      result = runsShow(opts.cwd, key);
    });
  runs
    .command("cancel")
    .description("request cooperative cancel of a running apply")
    .argument("<key>", "idempotency key")
    .action((key: string) => {
      commandName = "runs cancel";
      result = runsCancel(opts.cwd, key);
    });

  program
    .command("serve")
    .description("preview a built release over loopback HTTP")
    .option("--dir <path>", "release directory (default: dist/releases/local)")
    .option("--port <n>", "port (default: random)", (v: string) => parseInt(v, 10))
    .action(async (options: { dir?: string; port?: number }) => {
      commandName = "serve";
      result = await serveCommand(opts.cwd, options.dir, options.port ?? 0);
      if (result.ok) {
        // serve keeps the process alive; the envelope is printed by main.ts
        // only when it exits, so surface the URL immediately on stderr.
        const url = (result.data as { url: string }).url;
        process.stderr.write(`${url}\n`);
      }
    });

  program
    .command("doctor")
    .description("check credentials, RPC, Postgres, rindexer, storage, S3")
    .action(async () => {
      commandName = "doctor";
      result = await doctorCommand(opts.cwd);
    });

  program
    .command("fork")
    .description("import a published release into a new project")
    .requiredOption("--from <source>", "release directory or https URL")
    .requiredOption("--output <dir>", "new project directory")
    .option(
      "--allow-private-networks",
      "escape hatch: allow fetches to private networks (default off)",
      false,
    )
    .action(
      async (options: {
        from: string;
        output: string;
        allowPrivateNetworks: boolean;
      }) => {
        commandName = "fork";
        result = await forkCommand(
          options.from,
          options.output,
          options.allowPrivateNetworks,
        );
      },
    );

  try {
    await program.parseAsync(cmdArgv, { from: "user" });
  } catch (err) {
    if (err instanceof CommanderError) {
      const cmd =
        commandName ||
        cmdArgv.find((a) => !a.startsWith("-")) ||
        "";
      if (
        err.code === "commander.helpDisplayed" ||
        err.code === "commander.help"
      ) {
        return validationError(
          cmd,
          cmd ? "help is not available in JSON mode" : "a command is required",
          cmd ? null : "/command",
        );
      }
      if (err.code === "commander.unknownCommand") {
        return validationError(cmd, err.message, "/command");
      }
      return validationError(cmd, err.message);
    }
    throw err;
  }

  if (!result) {
    return validationError(commandName, "a command is required", "/command");
  }

  return result;
}
