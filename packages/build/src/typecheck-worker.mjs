import { makeRequest, runTscAsync, parseReply } from "@tsrs/wasm/core";
import { createTypecheckFiles } from "./typecheck-files.mjs";

let module;
let createFiles;
let compilerOptions;
let busy = false;

self.onmessage = async ({ data }) => {
  const { id, protocol } = data;
  const reply = (value) => postMessage({ protocol: 1, id, ...value });
  if (protocol !== 1 || busy)
    return reply({ error: "Invalid or overlapping type checker request" });
  busy = true;
  try {
    if (data.type === "initialize") {
      module = await WebAssembly.compile(data.wasm);
      const configuration = JSON.parse(new TextDecoder().decode(data.configuration));
      createFiles = createTypecheckFiles(configuration.files);
      compilerOptions = configuration.compilerOptions;
      reply({ ready: true });
      return;
    }
    if (data.type !== "check" || !module) throw new Error("Type checker is not initialized");

    const files = {
      ...data.files,
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
          incremental: false,
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
    const diagnosticSources = new Map();

    const result = await runTscAsync(
      module,
      makeRequest(["--project", "/tsconfig.json"], { cwd: "/", json: true }),
      host,
      { stderr: (bytes) => errors.push(new TextDecoder().decode(bytes)) },
    );

    const diagnostics = (result.reply.length ? parseReply(result.reply) : [])
      .slice(0, 100)
      .map((item) => {
        let source = files[item.fileName];
        if (typeof source !== "string" && item.fileName) {
          source = diagnosticSources.get(item.fileName);
          if (source === undefined) {
            try {
              source = decoder.decode(host.readFile(item.fileName));
              diagnosticSources.set(item.fileName, source);
            } catch {
              source = "";
            }
          }
        }

        const lines = (typeof source === "string" ? source.slice(0, item.pos || 0) : "").split(
          "\n",
        );

        return {
          text: `TS${item.code}: ${item.text}`,
          file: item.fileName,
          line: lines.length,
          column: lines.at(-1).length,
        };
      });

    if (result.exitCode && !diagnostics.length)
      diagnostics.push({ text: errors.join("") || "Type checking failed" });
    reply({ diagnostics, memoryBytes: result.memoryBytes });
  } catch (error) {
    reply({ error: String(error) });
  } finally {
    busy = false;
  }
};
