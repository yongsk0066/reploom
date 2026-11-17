// Differential oracle for the former Oxc -> Acorn -> MagicString pipeline.
import type { CompilerConfig } from "../../packages/runtime/src/project/definition.ts";
import type {
  Artifact,
  TransformEngine,
} from "../../packages/runtime/src/compiler/project-compiler.ts";
import type { Diagnostic } from "../../packages/runtime/src/shared/protocol.ts";
import type { OxcError } from "oxc-transform";
import { composeModuleMap } from "./module-source-map.ts";
import { linkModule, uniqueName } from "./module-linker.ts";
import { parser } from "@lezer/javascript";

type NativeEngine = Pick<typeof import("oxc-transform"), "transformSync">;

class CompilationError extends Error {
  diagnostics: Diagnostic[] = [];
}

// Stable Oxc syntax transform + our AST linker and module ABI.
const compilerVersion = "oxc-0.158.0-playground-abi2-format9";
const commentParser = parser.configure({ dialect: "ts jsx" });

function refreshReset(source: string) {
  if (!source.includes("@refresh")) return false;
  let reset = false;
  // Oxc 0.158 does not implement this directive (oxc-project/oxc#28977).
  // Read actual comments, not strings/JSX text; Lezer is already the editor's
  // parser. It only reads comments; syntax lowering and Refresh belong to Oxc.
  commentParser.parse(source).iterate({
    enter(node) {
      if (
        (node.name === "LineComment" || node.name === "BlockComment") &&
        /@refresh\s+reset\b/.test(source.slice(node.from, node.to))
      )
        reset = true;
    },
  });
  return reset;
}

function diagnostic(errors: OxcError[], file: string, source: string) {
  const list = errors.filter((error) => error.severity !== "Warning");
  if (!list.length) return;
  const error = new CompilationError(list[0].message);
  error.diagnostics = list.map((item) => {
    const prefix = new TextDecoder().decode(
      new TextEncoder().encode(source).slice(0, item.labels?.[0]?.start || 0),
    );

    const lines = prefix.split("\n");
    return {
      text: item.message,
      file,
      line: lines.length,
      column: lines.at(-1)!.length,
    };
  });
  throw error;
}

function transformModule(
  engine: NativeEngine,
  id: string,
  source: string,
  runtime: CompilerConfig["runtime"],
): Artifact {
  if (id.endsWith(".css")) return { id, kind: "css", code: source, specifiers: [], dynamic: [] };
  const json = id.endsWith(".json");
  if (!json && !/\.[jt]sx?$/.test(id)) throw new Error(`Unsupported file type: ${id}`);
  // ProjectCompiler already lowers JSON modules to JavaScript. Both the
  // reference implementation and Rust engine consume that same input contract.
  const input = source;

  const refresh = {
    register: uniqueName(input, "register"),
    signature: uniqueName(input, "signature"),
  };

  const first = engine.transformSync(id, input, {
    lang: json ? "js" : /\.tsx?$/.test(id) ? "tsx" : "jsx",
    sourceType: "module",
    target: "es2022",
    sourcemap: true,
    define: { "process.env.NODE_ENV": '"development"' },
    jsx: {
      runtime: "automatic",
      development: true,
      refresh:
        runtime === "react"
          ? {
              emitFullSignatures: true,
              refreshReg: refresh.register,
              refreshSig: refresh.signature,
            }
          : false,
    },
  });

  diagnostic(first.errors, id, input);
  let second: ReturnType<typeof linkModule>;
  try {
    second = linkModule(first.code, id, refresh, runtime !== "compute");
  } catch (cause) {
    const error = new CompilationError(String(cause));
    error.diagnostics = [{ text: String(cause), file: id }];
    throw error;
  }
  // Stream the linker map instead of materializing a second full mapping graph.
  if (second.map.version !== 3 || first.map?.version !== 3)
    throw new Error(`Unsupported source map format: ${id}`);
  const map = composeModuleMap({ ...second.map, version: 3 }, { ...first.map, version: 3 });
  // The nonce evaluator adds exactly two lines before the factory expression.
  map.mappings = ";;" + map.mappings;
  const bytes = new TextEncoder().encode(JSON.stringify(map));
  // Native encoding avoids an array/string allocation for every byte. The
  // bounded fallback supports engines without Uint8Array.toBase64.
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  let encoded: string;
  if (native) encoded = native.call(bytes);
  else {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    encoded = btoa(binary);
  }
  return {
    id,
    kind: "js",
    specifiers: second.specifiers,
    dynamic: second.dynamic,
    forceReset: runtime === "react" && !json && refreshReset(source),
    code: second.code,
    sourceMap: `data:application/json;base64,${encoded}`,
  };
}

export function createReferenceEngine(engine: NativeEngine | TransformEngine): TransformEngine {
  if ("compileModule" in engine) return engine;
  return {
    compilerVersion,
    compileModule: (id, source, runtime) => transformModule(engine, id, source, runtime),
  };
}
