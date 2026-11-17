import type {
  CompilerConfig,
  Files,
  RuntimeKind,
  ExecutionLimits,
  ResourcePolicy,
  ResourcePayloads,
} from "../project/definition.ts";
import type { SourceChange, SourceFiles } from "./source-patch.ts";
import type { ManagedState } from "../project/snapshot.ts";

export type { Files } from "../project/definition.ts";

// Reploom wire contract, independent of bundler-private helpers or a dev server.
export const PROTOCOL = 8 as const;

export const MODULE_ABI = 4 as const;

export const PROGRAM_SCHEMA = 8 as const;

export type Asset = { url: string; sha256: string };

export type Diagnostic = {
  text: string;
  file?: string;
  line?: number;
  column?: number;
  phase?: "cleanup" | "evaluation" | "notification";
  revision?: number;
};

export type ModuleContent =
  | { kind: "js"; code: string; forceReset?: boolean }
  | { kind: "css"; code: string }
  | { kind: "json"; data: string }
  | { kind: "asset"; assetId: string };

export type ModuleArtifact = Readonly<
  ModuleContent & {
    id: string;
    imports: Readonly<Record<string, string>>;
    dependencies: readonly string[];
    dynamicDependencies: readonly string[];
  }
>;

export type ModuleDebug = Readonly<{ sourceMap: string }>;

// Debug metadata can change without executing the module again.
export function sameExecution(a: ModuleArtifact | undefined, b: ModuleArtifact | undefined) {
  if (a === b) return a !== undefined;
  return (
    !!a &&
    !!b &&
    a.kind === b.kind &&
    (a.kind === "js" && b.kind === "js"
      ? a.code === b.code && a.forceReset === b.forceReset
      : a.kind === "css" && b.kind === "css"
        ? a.code === b.code
        : a.kind === "json" && b.kind === "json"
          ? a.data === b.data
          : a.kind === "asset" && b.kind === "asset" && a.assetId === b.assetId) &&
    sameImports(a.imports, b.imports)
  );
}

function sameImports(a: Record<string, string>, b: Record<string, string>) {
  if (a === b) return true;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
  );
}

export type Compilation = {
  schema: typeof PROGRAM_SCHEMA;
  abi: typeof MODULE_ABI;
  compilerVersion: string;
  entry: string;
  styles: readonly string[];
  runtime: RuntimeKind;
  execution: ExecutionLimits;
  resources?: ResourcePolicy;
  projectKey: string;
  modules: Record<string, ModuleArtifact>;
  debug?: Readonly<Record<string, ModuleDebug>>;
  transformed: string[];
};

export type VersionedProgram = { revision: number; program: Compilation };

export type ProgramReference = Omit<Compilation, "modules" | "debug"> & {
  delivery: "worker";
};

export type ExecutableProgram = Compilation | ProgramReference;

export const isProgramReference = (program: ExecutableProgram): program is ProgramReference =>
  "delivery" in program;

export function programReference(program: Compilation): ProgramReference {
  const { modules: _, debug: __, ...header } = program;
  return { ...header, delivery: "worker" };
}

export type ProgramPatch = Omit<Compilation, "modules" | "debug"> & {
  baseRevision: number | null;
  revision: number;
  changed: Record<string, ModuleArtifact>;
  removed: string[];
  debug?: Record<string, ModuleDebug | null>;
};

export function diffProgram(
  previous: VersionedProgram | undefined,
  next: VersionedProgram,
): ProgramPatch {
  const before = previous?.program;

  const full =
    !before ||
    before.compilerVersion !== next.program.compilerVersion ||
    before.projectKey !== next.program.projectKey;

  const changed = Object.fromEntries(
    Object.entries(next.program.modules).filter(([id, value]) => {
      const old = before?.modules[id];
      return full || !old || !sameExecution(old, value);
    }),
  );

  const debug: Record<string, ModuleDebug | null> = Object.create(null);
  for (const id of new Set([
    ...Object.keys(before?.debug || {}),
    ...Object.keys(next.program.debug || {}),
  ])) {
    const value = next.program.debug?.[id];
    if (full || before?.debug?.[id]?.sourceMap !== value?.sourceMap) debug[id] = value ?? null;
  }
  const { modules: _, debug: __, ...header } = next.program;
  return {
    ...header,
    revision: next.revision,
    baseRevision: full ? null : previous!.revision,
    changed,
    debug,
    removed: full ? [] : Object.keys(before.modules).filter((id) => !next.program.modules[id]),
  };
}

export function applyProgramPatch(
  previous: VersionedProgram | undefined,
  patch: ProgramPatch,
): VersionedProgram {
  if (
    patch.schema !== PROGRAM_SCHEMA ||
    patch.abi !== MODULE_ABI ||
    !validRevision(patch.revision) ||
    (patch.baseRevision !== null && patch.revision <= patch.baseRevision) ||
    (patch.baseRevision !== null &&
      (previous?.revision !== patch.baseRevision ||
        previous.program.compilerVersion !== patch.compilerVersion ||
        previous.program.projectKey !== patch.projectKey))
  ) {
    throw new Error("Module revision mismatch. A full synchronization is required.");
  }

  const modules = Object.assign(
    Object.create(null) as Record<string, ModuleArtifact>,
    patch.baseRevision === null ? {} : previous!.program.modules,
    patch.changed,
  );

  for (const id of patch.removed) delete modules[id];
  const debug = applyDebugPatch(previous, patch, modules);
  return {
    revision: patch.revision,
    program: {
      schema: PROGRAM_SCHEMA,
      abi: MODULE_ABI,
      compilerVersion: patch.compilerVersion,
      entry: patch.entry,
      styles: patch.styles,
      runtime: patch.runtime,
      execution: patch.execution,
      resources: patch.resources,
      projectKey: patch.projectKey,
      transformed: patch.transformed,
      modules,
      debug: Object.freeze(debug),
    },
  };
}

function applyDebugPatch(
  previous: VersionedProgram | undefined,
  patch: ProgramPatch,
  modules: Record<string, ModuleArtifact>,
) {
  const debug: Record<string, ModuleDebug> = Object.assign(
    Object.create(null),
    patch.baseRevision === null ? {} : previous!.program.debug,
  );

  for (const [id, value] of Object.entries(patch.debug || {})) {
    if (value === null) delete debug[id];
    else {
      if (modules[id]?.kind !== "js" || typeof value.sourceMap !== "string")
        throw new Error("Invalid debug artifact");
      debug[id] = Object.freeze({ ...value });
    }
  }
  for (const id of patch.removed) delete debug[id];
  return Object.freeze(debug);
}

export type Seed = { files: Files; output: Compilation };

export type CompilerRequest = {
  projectId: string;
  revision: number;
  files: SourceFiles;
  edits?: {
    baseRevision: number | null;
    changes: Record<string, SourceChange>;
  };
  compiler: Asset;
  config: CompilerConfig;
  seed: Seed;
  priority?: CompilePriority;
};

export type CompilePriority = "focused" | "visible" | "background";

export type CompileResult =
  | { ok: true; output: ExecutableProgram }
  | { ok: false; errors: Diagnostic[] };

export type CompileFailure = "source-resync" | "compile" | "engine";

export type CompileCommand = {
  protocol: typeof PROTOCOL;
  type: "compile";
  id: string;
  projectId: string;
  revision: number;
  baseRevision: number | null;
  changes: Record<string, SourceChange>;
  compiler: Asset;
  module?: WebAssembly.Module;
  priority: CompilePriority;
  seed?: Seed;
  config?: CompilerConfig;
  delivery?: "reference";
};

export type CompilerCommand =
  | CompileCommand
  | {
      protocol: typeof PROTOCOL;
      type: "prepare";
      projectId: string;
      compiler: Asset;
      module?: WebAssembly.Module;
    }
  | {
      protocol: typeof PROTOCOL;
      type: "priority";
      projectId: string;
      priority: CompilePriority;
    }
  | { protocol: typeof PROTOCOL; type: "cancel"; projectId: string; id: string }
  | { protocol: typeof PROTOCOL; type: "dispose"; projectId: string };

export type CompilerReply =
  | {
      protocol: typeof PROTOCOL;
      type: "prepared";
      compiler: Asset;
      error?: string;
    }
  | {
      protocol: typeof PROTOCOL;
      type: "module";
      compiler: Asset;
      module: WebAssembly.Module;
    }
  | ({
      protocol: typeof PROTOCOL;
      projectId: string;
      id: string;
      memoryBytes?: number;
    } & (
      | { ok: true; patch: ProgramPatch }
      | { ok: true; reference: ProgramReference }
      | { ok: false; failure: CompileFailure; errors: Diagnostic[] }
    ));

export type CompilerWorkerCommand =
  | CompilerCommand
  | {
      protocol: typeof PROTOCOL;
      type: "connect-preview";
      projectId: string;
      generation: string;
      port: MessagePort;
    }
  | {
      protocol: typeof PROTOCOL;
      type: "disconnect-preview";
      projectId: string;
      generation: string;
    };

export type ArtifactRequest = {
  type: "get";
  revision: number;
  baseRevision: number | null;
};

export type ArtifactReply =
  | { type: "artifact"; patch: ProgramPatch }
  | { type: "missing" | "superseded"; revision: number };

export type Snapshot = {
  program: ExecutableProgram;
  revision: number;
  projectId?: string;
  generation: string;
  vendor: readonly string[];
  worker?: readonly string[];
  bootstrap: string;
  assets?: ResourcePayloads;
  state?: ManagedState;
};

export type ExecutionOutcome =
  | "initial"
  | "refreshed"
  | "styles"
  | "remounted"
  | "recovered"
  | "computed"
  | "cancelled"
  | "error";

export type TestResult = { file: string; ok: boolean; diagnostics: Diagnostic[] };

export type Inspection = { operation: "state" } | { operation: "tests"; paths: readonly string[] };

export type InspectionResult = {
  state?: ManagedState;
  tests?: TestResult[];
  diagnostics: Diagnostic[];
};

export type RuntimeEvent =
  | {
      type: "settled";
      revision: number;
      outcome: ExecutionOutcome;
      diagnostics: Diagnostic[];
      requiresRestart: boolean;
      state?: ManagedState;
    }
  | {
      type: "runtime-error";
      revision: number;
      diagnostics: Diagnostic[];
      requiresRestart: boolean;
      state?: ManagedState;
    }
  | { type: "console"; revision: number; text: string }
  | { type: "invalidate"; revision: number; id: string };

type Envelope = { protocol: typeof PROTOCOL; generation: string };

// A failed realm is a lifetime fact, even when its revision is already stale.
export type PreviewEvent =
  | RuntimeEvent
  | {
      type: "restart-required";
      generation: string;
      revision: number;
      state?: ManagedState;
    }
  | { type: "request-program"; generation: string; revision: number };

export type PreviewCommand = Envelope &
  (
    | {
        type: "initialize";
        vendor: readonly string[];
        worker?: readonly string[];
        assets?: ResourcePayloads;
        state?: ManagedState;
        patch: ProgramPatch;
      }
    | { type: "apply"; patch: ProgramPatch }
    | { type: "connect-artifacts" }
    | {
        type: "apply-reference";
        revision: number;
        reference: ProgramReference;
        initialize?: {
          vendor: readonly string[];
          worker?: readonly string[];
          assets?: ResourcePayloads;
          state?: ManagedState;
        };
      }
    | { type: "inspect"; id: string; revision: number; request: Inspection }
    | { type: "cancel"; revision: number }
    | { type: "dispose" }
  );

export type PreviewReply = Envelope &
  (
    | RuntimeEvent
    | { type: "ready" }
    | { type: "inspection"; id: string; revision: number; result: InspectionResult }
    | { type: "disposed"; diagnostics: Diagnostic[] }
    | { type: "resync" }
    | { type: "request-program"; revision: number }
  );

function validRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function errorDiagnostics(
  error: unknown,
  phase?: Diagnostic["phase"],
  file?: string,
): Diagnostic[] {
  // User-thrown values must never inject non-cloneable fields into the port.
  try {
    if (
      error &&
      typeof error === "object" &&
      "diagnostics" in error &&
      Array.isArray(error.diagnostics)
    ) {
      const diagnostics: Diagnostic[] = [];
      for (const item of error.diagnostics.slice(0, 10)) {
        if (!item || typeof item !== "object" || typeof item.text !== "string") continue;
        diagnostics.push({
          text: item.text.slice(0, 4000),
          file: typeof item.file === "string" ? item.file : file,
          line: typeof item.line === "number" ? item.line : undefined,
          column: typeof item.column === "number" ? item.column : undefined,
          revision: validRevision(item.revision) ? item.revision : undefined,
          phase: ["cleanup", "evaluation", "notification"].includes(item.phase)
            ? item.phase
            : phase,
        });
      }
      if (diagnostics.length) return diagnostics;
    }
    let text = String(error);
    if (error instanceof Error) {
      // Firefox/WebKit stacks contain frames without the error's message.
      const stack = error.stack;
      if (typeof stack === "string" && stack)
        text = stack.startsWith(text) ? stack : `${text}\n${stack}`;
    }
    return [{ text: text.slice(0, 4000), phase, file }];
  } catch {
    return [{ text: "Could not read error details.", phase, file }];
  }
}
