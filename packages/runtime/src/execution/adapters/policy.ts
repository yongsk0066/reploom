import type {
  ApplyResult,
  Namespace,
  Signature,
  FactoryLoader,
  Styles,
} from "../module-runtime.ts";
import type { ExecutionOutcome, Compilation, Diagnostic } from "../../shared/protocol.ts";
import type { RuntimeKind } from "../../project/definition.ts";
import type { ResourcePayloads } from "../../project/definition.ts";
import type { ResourceAccess } from "../resources.ts";
import type { ManagedState } from "../../project/snapshot.ts";
import type { Inspection, InspectionResult } from "../../shared/protocol.ts";

export type Registration = [unknown, string];

export type Dependencies = Readonly<Record<string, Namespace>>;

export interface ModulePolicy {
  resolve(specifier: string, importer: string): Namespace;
  classify(
    exports: Namespace,
    id: string,
  ): { boundary: string | null; registrations: Registration[] };
  canAccept?(previous: Namespace, next: Namespace): boolean;
  signature(forceReset?: boolean): Signature;
  register(type: unknown, id: string): void;
  committed(id: string): void;
  removed(id: string): void;
  validateEntry(exports: Namespace): void;
  dispose(): void;
}

export interface RuntimeAdapter {
  modules: ModulePolicy;
  render(result: ApplyResult, recovering: boolean): ExecutionOutcome | Promise<ExecutionOutcome>;
  dispose(): void | Promise<void>;
}

export type ExecutionResult = {
  outcome: ExecutionOutcome;
  diagnostics: Diagnostic[];
};

export interface PreviewExecution {
  inspect(request: Inspection): Promise<InspectionResult>;
  apply(program: Compilation, recovering: boolean, revision?: number): Promise<ExecutionResult>;
  normalizeError?(error: unknown): unknown;
  cancel?(): void;
  dispose(): Promise<Diagnostic[]>;
}

export type ExecutionEnvironment = {
  state?: ManagedState;
  initial: Compilation;
  loadFactory: FactoryLoader;
  updateStyles(styles: Styles): void;
  reportError(error: unknown): void;
  onDiagnostic(diagnostics: Diagnostic[]): void;
  onInvalidate(id: string): void;
  onConsole(text: string): void;
  worker?: readonly import("../../shared/protocol.ts").ScriptSource[];
  assets?: ResourcePayloads;
  resources?: ResourceAccess;
};

export type RuntimeVendor = {
  kind: RuntimeKind;
  dependencies: Dependencies;
  createExecution(container: HTMLElement, environment: ExecutionEnvironment): PreviewExecution;
};

declare global {
  var __PLAYGROUND_VENDOR__: RuntimeVendor;
}

export function createModulePolicy(dependencies: Dependencies): ModulePolicy {
  return {
    resolve(specifier) {
      const name = specifier.slice("vendor:".length);
      if (!Object.hasOwn(dependencies, name)) throw new Error(`Undeclared dependency: ${name}`);
      return dependencies[name];
    },
    classify: () => ({ boundary: null, registrations: [] }),
    signature: () => (type) => type,
    register() {},
    committed() {},
    removed() {},
    validateEntry() {},
    dispose() {},
  };
}
