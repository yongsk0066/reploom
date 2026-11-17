#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { prepareProjects } from "./prepare.mjs";

const [command, configPath, ...extra] = process.argv.slice(2);
if (command !== "prepare" || !configPath || extra.length) {
  console.error("Usage: reploom prepare ./reploom.config.mjs");
  process.exitCode = 1;
} else {
  const filename = path.resolve(configPath);
  const { default: config } = await import(pathToFileURL(filename).href);
  const manifest = await prepareProjects({ projectRoot: path.dirname(filename), ...config });
  console.log(`Prepared ${Object.keys(manifest.projects).length} projects (${manifest.buildId})`);
}
