import { makeRequest, runTscAsync, parseReply } from "@tsrs/wasm/core";
import { createTypecheckFiles } from "./typecheck-files.mjs";
import { mapTypeDiagnostics } from "./typecheck-diagnostics.mjs";

let module;
let createFiles;
let compilerOptions;
let busy = false;
const buildInfoPath = "/.reploom/check.tsbuildinfo";
const buildInfoBudget = 1024 * 1024;
let buildInfo;
let maxMemoryBytes = 128 * 1024 * 1024;
let reuse = true;

self.onmessage = async ({ data }) => {
  const { id, protocol } = data;
  const reply = (value) => postMessage({ protocol: 1, id, ...value });
  if (protocol !== 1 || busy)
    return reply({ error: "Invalid or overlapping type checker request" });
  busy = true;
  try {
    if (data.type === "initialize") {
      module = data.module ?? (await WebAssembly.compile(data.wasm));
      const configuration = JSON.parse(new TextDecoder().decode(data.configuration));
      createFiles = createTypecheckFiles(configuration.files);
      compilerOptions = configuration.compilerOptions;
      buildInfo =
        typeof data.buildInfo === "string" && data.buildInfo.length * 2 <= buildInfoBudget
          ? data.buildInfo
          : undefined;
      maxMemoryBytes = data.maxMemoryBytes ?? 128 * 1024 * 1024;
      reuse = data.reuse !== false;
      reply({ ready: true });
      return;
    }
    if (data.type !== "check" || !module) throw new Error("Type checker is not initialized");

    const incremental =
      compilerOptions.incremental ??
      (reuse &&
        Object.values(data.files).reduce((size, source) => size + source.length, 0) >= 128_000);

    if (!incremental) buildInfo = undefined;

    const files = {
      ...data.files,
      ...(buildInfo === undefined ? {} : { [buildInfoPath]: buildInfo }),
      "/tsconfig.json": JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          strict: false,
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "react-jsx",
          allowJs: true,
          checkJs: true,
          skipLibCheck: true,
          resolveJsonModule: true,
          allowImportingTsExtensions: true,
          ...compilerOptions,
          noEmit: true,
          incremental,
          tsBuildInfoFile: incremental ? buildInfoPath : undefined,
          composite: false,
        },
        files: [
          "/reploom.d.ts",
          ...Object.keys(data.files).filter((id) => /\.[cm]?[jt]sx?$/.test(id)),
        ],
      }),
    };

    const errors = [];
    const host = createFiles(files);
    const decoder = new TextDecoder();

    const result = await runTscAsync(
      module,
      makeRequest(["--project", "/tsconfig.json"], { cwd: "/", json: true }),
      host,
      { stderr: (bytes) => errors.push(new TextDecoder().decode(bytes)) },
    );

    const nextBuildInfo = host.written.get(buildInfoPath) ?? buildInfo;
    buildInfo =
      nextBuildInfo !== undefined && nextBuildInfo.length * 2 <= buildInfoBudget
        ? nextBuildInfo
        : undefined;

    const diagnostics = mapTypeDiagnostics(
      result.reply.length ? parseReply(result.reply) : [],
      (path) => files[path] ?? decoder.decode(host.readFile(path)),
    );

    if (result.exitCode && !diagnostics.length)
      diagnostics.push({ text: errors.join("") || "Type checking failed" });

    const output = {
      diagnostics,
      memoryBytes: result.memoryBytes,
      buildInfoBytes: (buildInfo?.length ?? 0) * 2,
    };

    if (reuse && result.memoryBytes > maxMemoryBytes) {
      // The next realm can reuse immutable code and file signatures, never linear memory.
      try {
        reply({ ...output, checkpoint: { module, buildInfo } });
      } catch (error) {
        if (error.name !== "DataCloneError") throw error;
        reply({ ...output, checkpoint: { buildInfo } });
      }
    } else reply(output);
  } catch (error) {
    buildInfo = undefined;
    reply({ error: String(error) });
  } finally {
    busy = false;
  }
};
