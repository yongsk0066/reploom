import { isScriptFile } from "./module-language.ts";

export type Files = Readonly<Record<string, string>>;

export type RuntimeKind = "react" | "dom" | "compute";

export type ExecutionOptions = { taskMs?: number; timeoutMs?: number };

export type ExecutionLimits =
  | { mode: "window"; taskMs: number }
  | { mode: "worker"; timeoutMs: number };

export function executionLimits(runtime: RuntimeKind, limits?: ExecutionOptions): ExecutionLimits {
  if (runtime === "compute") {
    if (limits?.taskMs !== undefined)
      throw new Error("Compute projects declare their execution budget with timeoutMs.");
    const timeoutMs = limits?.timeoutMs ?? 2000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 50 || timeoutMs > 10000)
      throw new Error("Compute timeout must be between 50 and 10000ms.");
    return Object.freeze({ mode: "worker", timeoutMs });
  }
  if (limits?.timeoutMs !== undefined)
    throw new Error("React and DOM projects declare their execution budget with taskMs.");
  const taskMs = limits?.taskMs ?? 32;
  if (!Number.isFinite(taskMs) || taskMs < 8 || taskMs > 5000)
    throw new Error("Synchronous execution budget must be between 8 and 5000ms.");
  return Object.freeze({ mode: "window", taskMs });
}

export type Dependency = { version: string; kind?: "module" | "css" };

export type ResourceOptions = {
  assets?: Readonly<Record<string, { url: string; type: string }>>;
  workers?: number;
  debugMaps?: {
    mode?: "external" | "inline";
    bytes?: number;
    entries?: number;
  };
};

export type ResourcePolicy = {
  assets: Readonly<Record<string, { url: string; sha256: string; type: string }>>;
  workers: number;
  debugMaps: { mode: "external" | "inline"; bytes: number; entries: number };
};

export type BinaryAsset = { bytes: Uint8Array<ArrayBuffer>; type: string };

export type ResourcePayloads = Readonly<Record<string, Blob | BinaryAsset>>;

export function resourceLimits(input?: ResourceOptions) {
  const workers = input?.workers ?? 0;

  const debugMaps = {
    // Native DevTools resource loaders do not consistently support Blob maps.
    // Keep standard inline maps unless a custom debugging client opts in.
    mode: "inline" as "external" | "inline",
    bytes: 8 * 1024 * 1024,
    entries: 128,
    ...input?.debugMaps,
  };

  if (
    !Number.isSafeInteger(workers) ||
    workers < 0 ||
    workers > 8 ||
    !["external", "inline"].includes(debugMaps.mode) ||
    !Number.isSafeInteger(debugMaps.bytes) ||
    debugMaps.bytes < 0 ||
    debugMaps.bytes > 32 * 1024 * 1024 ||
    !Number.isSafeInteger(debugMaps.entries) ||
    debugMaps.entries < 0 ||
    debugMaps.entries > 1024
  )
    throw new Error("Invalid project resource limits");
  return { workers, debugMaps };
}

export type ProjectDefinition = {
  id: string;
  title: string;
  checks?: readonly string[];
  runtime: RuntimeKind;
  entry: string;
  files: Files;
  dependencies?: Readonly<Record<string, Dependency>>;
  styles?: readonly string[];
  updateDelayMs?: number;
  execution?: ExecutionOptions;
  resources?: ResourceOptions;
};

// Resolved at publication, reused unchanged by the browser compiler. No package
// lookup, network service or framework-specific dependency names in the compiler.
export type CompilerConfig = Readonly<{
  key: string;
  runtime: RuntimeKind;
  entry: string;
  styles: readonly string[];
  imports: Readonly<Record<string, string>>;
  dependencyFiles: Files;
  execution?: ExecutionLimits;
  resources?: ResourcePolicy;
}>;

/** Own the preparation contract; no caller-owned object enters a compiler lifetime. */
export function ownCompilerConfig(input: CompilerConfig): CompilerConfig {
  return Object.freeze({
    ...input,
    imports: Object.freeze({ ...input.imports }),
    styles: Object.freeze([...input.styles]),
    dependencyFiles: Object.freeze({ ...input.dependencyFiles }),
    execution: input.execution && Object.freeze({ ...input.execution }),
    resources:
      input.resources &&
      Object.freeze({
        ...input.resources,
        assets: Object.freeze(
          Object.fromEntries(
            Object.entries(input.resources.assets).map(([id, asset]) => [
              id,
              Object.freeze({ ...asset }),
            ]),
          ),
        ),
        debugMaps: Object.freeze({ ...input.resources.debugMaps }),
      }),
  });
}

export function validateFiles(files: Files, entry: string) {
  const paths = Object.keys(files);
  if (
    paths.length > 32 ||
    paths.some(
      (p) =>
        !/^\/[\w./-]+$/.test(p) ||
        p.startsWith("/__") ||
        p.split("/").some((part) => part === "." || part === "..") ||
        p.includes("//"),
    ) ||
    Object.values(files).some((code) => typeof code !== "string") ||
    Object.values(files).reduce((n, code) => n + code.length, 0) > 1_000_000
  )
    throw new Error(
      "Projects require normalized paths, at most 32 files, and at most 1,000,000 UTF-16 code units.",
    );
  if (!Object.hasOwn(files, entry)) throw new Error(`Entry file required: ${entry}`);
}

export function defineProject(input: ProjectDefinition): Readonly<ProjectDefinition> {
  if (
    !/^[\w-]+$/.test(input.id) ||
    !input.title ||
    !["react", "dom", "compute"].includes(input.runtime)
  )
    throw new Error("Invalid project ID, title, or runtime.");
  validateFiles(input.files, input.entry);
  if (
    (input.checks?.length ?? 0) > 16 ||
    input.checks?.some((id) => !Object.hasOwn(input.files, id) || !isScriptFile(id))
  )
    throw new Error("Checks must name at most 16 source modules");
  for (const path of input.styles || [])
    if (!path.endsWith(".css") || !Object.hasOwn(input.files, path))
      throw new Error(`Style file not found: ${path}`);
  const delay = input.updateDelayMs;
  if (delay !== undefined && (!Number.isFinite(delay) || delay < 0 || delay > 2000))
    throw new Error("Edit debounce must be between 0 and 2000ms.");

  const dependencies = Object.fromEntries(
    Object.entries(input.dependencies || {}).map(([name, dep]) => {
      if (
        !/^(?:@[\w.-]+\/)?[\w.-]+(?:\/[\w./-]+)*$/.test(name) ||
        name.split("/").some((part) => part === "." || part === "..") ||
        !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(dep.version) ||
        (dep.kind !== undefined && !["module", "css"].includes(dep.kind))
      )
        throw new Error(`Dependencies require exact versions: ${name}`);
      return [name, Object.freeze({ ...dep })];
    }),
  );

  return Object.freeze({
    ...input,
    files: Object.freeze({ ...input.files }),
    checks: Object.freeze([...(input.checks || [])]),
    dependencies: Object.freeze(dependencies),
    styles: Object.freeze([...(input.styles || [])]),
    updateDelayMs: delay,
    execution: executionLimits(input.runtime, input.execution),
    resources: defineResources(input.resources, input.files),
  });
}

function defineResources(options: ResourceOptions | undefined, files: Files) {
  const resources = resourceLimits(options);
  const assetEntries = Object.entries(options?.assets || {});
  if (assetEntries.length > 32) throw new Error("Too many project assets");
  for (const [id, asset] of assetEntries) {
    if (
      !/^\/[\w./-]+$/.test(id) ||
      id.startsWith("/__") ||
      id.includes("//") ||
      Object.hasOwn(files, id) ||
      !/^\/[\w./-]+$/.test(asset.url) ||
      id.includes("..") ||
      id.split("/").includes(".") ||
      asset.url.includes("..") ||
      asset.url.split("/").includes(".") ||
      asset.url.startsWith("//") ||
      !/^[\w.+-]+\/[\w.+-]+$/.test(asset.type)
    )
      throw new Error(`Invalid declared asset: ${id}`);
  }
  return Object.freeze({
    ...resources,
    debugMaps: Object.freeze(resources.debugMaps),
    assets: Object.freeze(
      Object.fromEntries(assetEntries.map(([id, asset]) => [id, Object.freeze({ ...asset })])),
    ),
  });
}
