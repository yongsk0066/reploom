import { readFile, writeFile, mkdir, readdir, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { hostABI } from "../crates/compiler/engine.mjs";
import { compilerInputs } from "./compiler-inputs.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const base = path.join(root, "crates/compiler");

const remaps = [
  [os.homedir(), "/build"],
  [process.env.CARGO_HOME || path.join(os.homedir(), ".cargo"), "/cargo"],
  [process.env.RUSTUP_HOME || path.join(os.homedir(), ".rustup"), "/rustup"],
  [os.tmpdir(), "/tmp"],
  [root.replace(/\/$/, ""), "/reploom"],
].map(([from, to]) => `--remap-path-prefix=${from}=${to}`);

const rustFlags = process.env.CARGO_ENCODED_RUSTFLAGS
  ? process.env.CARGO_ENCODED_RUSTFLAGS.split("\u001f")
  : (process.env.RUSTFLAGS || "").split(/\s+/).filter(Boolean);

const run = (cmd, args) =>
  execFileSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: [...rustFlags, ...remaps].join("\u001f") },
  });

run("cargo", [
  "build",
  "--locked",
  "--manifest-path",
  path.join(base, "Cargo.toml"),
  "--target",
  "wasm32-unknown-unknown",
  "--release",
  "--lib",
]);
const lock = await readFile(path.join(base, "Cargo.lock"), "utf8");
const version = lock.match(/name = "wasm-bindgen"\nversion = "([^"]+)"/)[1];
let bindgen = process.env.REPLOOM_WASM_BINDGEN;
if (!bindgen) {
  try {
    if (
      execFileSync("wasm-bindgen", ["--version"], {
        encoding: "utf8",
      }).trim() === `wasm-bindgen ${version}`
    )
      bindgen = "wasm-bindgen";
  } catch {}
  if (!bindgen)
    for (const dir of [
      path.join(os.homedir(), "Library/Caches/.wasm-pack"),
      path.join(os.homedir(), ".cache/.wasm-pack"),
    ]) {
      for (const item of await readdir(dir).catch(() => [])) {
        const candidate = path.join(dir, item, "wasm-bindgen");
        try {
          await access(candidate);
          if (
            execFileSync(candidate, ["--version"], {
              encoding: "utf8",
            }).trim() === `wasm-bindgen ${version}`
          ) {
            bindgen = candidate;
            break;
          }
        } catch {}
      }
      if (bindgen) break;
    }
}
if (!bindgen) throw Error(`Install wasm-bindgen-cli ${version}, or set REPLOOM_WASM_BINDGEN`);

const target = path.join(base, "target");
const artifacts = path.join(base, "artifacts");

await mkdir(artifacts, { recursive: true });
// Normalize transitive wasm-bindgen metadata, then retain the explicit host ABI.
run(bindgen, [
  path.join(target, "wasm32-unknown-unknown/release/playground_compiler.wasm"),
  "--target",
  "web",
  "--out-dir",
  path.join(target, "bindgen"),
]);
const intermediate = path.join(target, "bindgen/playground_compiler_bg.wasm");
const module = await WebAssembly.compile(await readFile(intermediate));
const roots = ["memory", "abi_version", "alloc", "dealloc", "compile_module", "free_result"];
await writeFile(
  path.join(target, "roots.json"),
  JSON.stringify(
    WebAssembly.Module.exports(module).map((e) => ({
      name: e.name,
      export: e.name,
      ...(roots.includes(e.name) ? { root: true } : {}),
    })),
  ),
);
const output = path.join(artifacts, "compiler.wasm");
run("wasm-metadce", [intermediate, "--graph-file", path.join(target, "roots.json"), "-o", output]);
run("wasm-opt", [output, "-O3", "--converge", "--strip-debug", "-o", output]);

const bytes = await readFile(output);
const built = await WebAssembly.compile(bytes);

const imports = WebAssembly.Module.imports(built);
const exports = WebAssembly.Module.exports(built);

if (exports.length !== roots.length || !exports.every((e) => roots.includes(e.name)))
  throw Error("Unexpected compiler exports");
if (
  !imports.every(
    (i) =>
      i.kind === "function" &&
      ((i.module === "playground" && i.name === "checkpoint") ||
        (i.module === "./playground_compiler_bg.js" &&
          i.name.startsWith("__wbg___wbindgen_throw_"))),
  )
)
  throw Error("Unexpected compiler imports");
const hash = (data) => createHash("sha256").update(data).digest("hex");
const sources = {};
for (const file of await compilerInputs(base))
  sources[file] = hash(await readFile(path.join(base, file)));
await writeFile(
  path.join(artifacts, "manifest.json"),
  JSON.stringify(
    {
      hostABI,
      sha256: hash(bytes),
      bytes: bytes.length,
      sources,
      imports,
      exports,
      tools: {
        rust: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim(),
        bindgen: version,
        binaryen: execFileSync("wasm-opt", ["--version"], {
          encoding: "utf8",
        }).trim(),
      },
      pathRemapping: ["/build", "/cargo", "/rustup", "/tmp", "/reploom"],
    },
    null,
    2,
  ) + "\n",
);
console.log("Compiler WASM:", bytes.length, "bytes");

await import("./compiler-notices.mjs");
