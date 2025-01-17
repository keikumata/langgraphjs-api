import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { ChildProcess } from "node:child_process";

import { parse, populate } from "dotenv";
import { watch } from "chokidar";
import { z } from "zod";
import open from "open";

import { createIpcServer } from "./utils/ipc/server.mjs";
import { getProjectPath } from "./utils/project.mjs";
import { getConfig } from "../utils/config.mjs";
import { builder } from "./utils/builder.mjs";
import { logger } from "../logging.mjs";
import { withAnalytics } from "./utils/analytics.mjs";

builder
  .command("dev")
  .description(
    "Run LangGraph API server in development mode with hot reloading."
  )
  .option("-p, --port <number>", "port to run the server on", "2024")
  .option("-h, --host <string>", "host to bind to", "localhost")
  .option("--no-browser", "disable auto-opening the browser")
  .option("-n, --n-jobs-per-worker <number>", "number of workers to run", "10")
  .option("-c, --config <path>", "path to configuration file", process.cwd())
  .allowExcessArguments()
  .allowUnknownOption()
  .hook(
    "preAction",
    withAnalytics((command) => ({
      config: command.opts().config !== process.cwd(),
      port: command.opts().port !== "2024",
      host: command.opts().host !== "localhost",
      n_jobs_per_worker: command.opts().nJobsPerWorker !== "10",
    }))
  )
  .action(async (options, { args }) => {
    try {
      const configPath = await getProjectPath(options.config);
      const projectCwd = path.dirname(configPath);
      const [pid, server] = await createIpcServer();
      const watcher = watch([configPath], {
        ignoreInitial: true,
        cwd: projectCwd,
      });

      let hasOpenedFlag = false;
      let child: ChildProcess | undefined = undefined;

      server.on("data", (data) => {
        const response = z.object({ queryParams: z.string() }).parse(data);
        if (options.browser && !hasOpenedFlag) {
          hasOpenedFlag = true;
          open(`https://smith.langchain.com/studio${response.queryParams}`);
        }
      });

      // check if .gitignore already contains .langgraph-api
      const gitignorePath = path.resolve(projectCwd, ".gitignore");
      const gitignoreContent = await fs
        .readFile(gitignorePath, "utf-8")
        .catch(() => "");

      if (!gitignoreContent.includes(".langgraph_api")) {
        logger.info(
          "Updating .gitignore to prevent `.langgraph_api` from being committed."
        );
        await fs.appendFile(
          gitignorePath,
          "\n# LangGraph API\n.langgraph_api\n"
        );
      }

      const prepareContext = async () => {
        const config = getConfig(await fs.readFile(configPath, "utf-8"));
        const newWatch = [configPath];
        const env = { ...process.env } as NodeJS.ProcessEnv;
        const configEnv = config?.env;

        if (configEnv) {
          if (typeof configEnv === "string") {
            const envPath = path.resolve(projectCwd, configEnv);
            newWatch.push(envPath);

            const envData = await fs.readFile(envPath, "utf-8");
            populate(env as Record<string, string>, parse(envData));
          } else if (Array.isArray(configEnv)) {
            throw new Error("Env storage is not supported by CLI.");
          } else if (typeof configEnv === "object") {
            if (!process.env) throw new Error("process.env is not defined");
            populate(env as Record<string, string>, configEnv);
          }
        }

        const oldWatch = Object.entries(watcher.getWatched()).flatMap(
          ([dir, files]) =>
            files.map((file) => path.resolve(projectCwd, dir, file))
        );

        const addedTarget = newWatch.filter(
          (target) => !oldWatch.includes(target)
        );

        const removedTarget = oldWatch.filter(
          (target) => !newWatch.includes(target)
        );

        watcher.unwatch(removedTarget).add(addedTarget);
        return { config, env };
      };

      const launchServer = async () => {
        const { config, env } = await prepareContext();
        if (child != null) child.kill();

        if ("python_version" in config) {
          logger.warn(
            "Launching Python server from @langchain/langgraph-cli is experimental. Please use the `langgraph-cli` package from PyPi instead."
          );

          const { spawnPythonServer } = await import("./dev.python.mjs");
          child = await spawnPythonServer(
            { ...options, rest: args },
            { configPath, config, env },
            { pid, projectCwd }
          );
        } else {
          const { spawnNodeServer } = await import("./dev.node.mjs");
          child = await spawnNodeServer(
            { ...options, rest: args },
            { configPath, config, env },
            { pid, projectCwd }
          );
        }
      };

      watcher.on("all", async (_name, path) => {
        logger.warn(`Detected changes in ${path}, restarting server`);
        launchServer();
      });

      // TODO: sometimes the server keeps sending stuff
      // while gracefully exiting
      launchServer();

      process.on("exit", () => {
        watcher.close();
        server.close();
        child?.kill();
      });
    } catch (error) {
      logger.error(error);
    }
  });
