import { planUpdate, acceptsDependency } from "./update-plan.ts";
import { createManagedState } from "./managed-state.ts";
import { cloneState, type ManagedState, type StateValue } from "../project/snapshot.ts";
import type { TestResult } from "../shared/protocol.ts";
import type { ModulePolicy } from "./adapters/policy.ts";
import type { ResourceAccess } from "./resources.ts";
import {
  MODULE_ABI,
  PROGRAM_SCHEMA,
  errorDiagnostics,
  type Compilation,
  type Diagnostic,
  type ModuleArtifact,
  type ModuleDebug,
} from "../shared/protocol.ts";

export type Namespace = Record<string, unknown>;

type ImportSlot = { read: () => unknown };

type Cleanup = (data: Namespace) => unknown | Promise<unknown>;

export type Signature = (
  type?: unknown,
  key?: string,
  reset?: boolean,
  hooks?: () => unknown[],
) => unknown;

export interface ModuleContext {
  checkpoint(): void;
  export(name: string, getter: () => unknown): void;
  exportAll(namespace: Namespace): void;
  importBindings(
    specifier: string,
    names: string[],
    namespace: boolean,
    sideEffect?: boolean,
  ): Promise<{ slots: ImportSlot[]; namespace?: Namespace }>;
  importDynamic(specifier: string): Promise<Namespace>;
  meta: {
    state<T extends StateValue>(key: string, initial: T): { value: T };
    resources?: ResourceAccess;
    url: string;
    hot: {
      data: Namespace;
      accept(callback?: (namespace: Namespace) => unknown): void;
      acceptExports(names: readonly string[]): void;
      dispose(callback: Cleanup): void;
      prune(callback: Cleanup): void;
      invalidate(): void;
    };
  };
  register(type: unknown, id: string): void;
  signature(): Signature;
  global(name: string, typeOnly?: boolean): unknown;
}

export type ModuleFactory = (this: undefined, context: ModuleContext) => Promise<void>;

export type FactoryLoader = (
  artifact: ModuleArtifact,
  debug?: ModuleDebug,
) => ModuleFactory | Promise<ModuleFactory>;

type NamespaceBinding = { id: string; record?: ModuleRecord };

type NamedBinding = NamespaceBinding & { names: string[]; slots: ImportSlot[] };

type Binding = NamespaceBinding | NamedBinding;

type ModuleRecord = {
  state: ReturnType<typeof createManagedState>;
  id: string;
  exports: Namespace;
  namespace?: Namespace;
  dependencies: Set<string>;
  importedBindings: Map<string, Set<string> | null>;
  acceptedExports?: Set<string>;
  registrations: Array<[unknown, string]>;
  bindings: Binding[];
  retired: boolean;
  dispose: Cleanup[];
  prune: Cleanup[];
  data: Namespace;
  disposeTask?: Promise<Diagnostic[]>;
  pruneTask?: Promise<Diagnostic[]>;
  accept?: (namespace: Namespace) => unknown;
  invalidated: boolean;
  boundary: string | null;
  finalized: boolean;
  finished: boolean;
  promise: Promise<void>;
  cleaned: Set<"dispose" | "prune">;
  abandoned: boolean;
  ownsResources: boolean;
};

type Scope = {
  phase: "staging" | "committed" | "failed";
  program: Compilation | undefined;
  graphKey: symbol;
  records: Map<string, ModuleRecord>;
  affected: Set<string>;
  diagnostics: Diagnostic[];
  retiredResources: boolean;
  cancellation: AbortController;
  disposal?: Promise<void>;
};

export type Styles = Array<{ id: string; code: string }>;

export type ApplyResult = {
  entry: Namespace;
  registrations: Array<[unknown, string]>;
  evaluated: string[];
  diagnostics: Diagnostic[];
};

export class RuntimeUpdateError extends Error {
  readonly diagnostics: Diagnostic[];
  readonly requiresRestart: boolean;
  readonly state?: ManagedState;

  constructor(
    diagnostics: Diagnostic[],
    requiresRestart: boolean,
    cause?: unknown,
    state?: ManagedState,
  ) {
    super(diagnostics.map((d) => d.text).join("\n"), { cause });
    this.diagnostics = diagnostics;
    this.requiresRestart = requiresRestart;
    this.state = state;
  }
}

export function createModuleRuntime(
  policy: ModulePolicy,
  loadFactory: FactoryLoader,
  onInvalidate: (id: string) => void = () => {},
  onDiagnostic: (diagnostics: Diagnostic[]) => void = () => {},
  scheduling?: {
    yieldTask(): Promise<void>;
    budgetMs: number;
    checkpoint?(id: string): void;
    beforeCleanup?(): Promise<void>;
  },
  resources?: ResourceAccess,
  restored: ManagedState = {},
) {
  const realm = globalThis;
  let deadline = 0;
  let program: Compilation | undefined;
  const records = new Map<string, ModuleRecord>();
  const subscribers = new Map<string, Set<NamedBinding>>();
  let failedModules = new Set<string>();
  const factories = new Map<string, { code: string; factory: ModuleFactory }>();

  const scopes = new Set<Scope>();
  const lazyScopes = new Map<Compilation, Scope>();

  const graphKeys = new WeakMap<Compilation, symbol>();
  let activeUpdate: Scope | undefined;
  let closed = false;
  let currentStyles = () => {};
  let updates: Promise<unknown> = Promise.resolve();
  const shutdown = new AbortController();
  const superseded = new Error("Deferred evaluation was superseded by a newer module graph.");

  // Removable abort listeners let completed evaluations release their shutdown
  // subscription instead of accumulating unresolved Promise reactions.
  const guard = <T>(promise: Promise<T>, scope?: Scope): Promise<T> =>
    new Promise((resolve, reject) => {
      const signals = [shutdown.signal, ...(scope ? [scope.cancellation.signal] : [])];

      const clear = () => {
        for (const signal of signals) signal.removeEventListener("abort", abort);
      };

      const abort = () => {
        clear();
        reject(signals.find((signal) => signal.aborted)!.reason);
      };

      if (signals.some((signal) => signal.aborted)) abort();
      else for (const signal of signals) signal.addEventListener("abort", abort, { once: true });
      promise.then(
        (value) => {
          clear();
          resolve(value);
        },
        (error) => {
          clear();
          reject(error);
        },
      );
    });

  const scopeFor = (graph: Compilation, affected = new Set<string>()): Scope => {
    let graphKey = graphKeys.get(graph);
    if (!graphKey) graphKeys.set(graph, (graphKey = Symbol()));

    const scope: Scope = {
      phase: "staging",
      program: graph,
      graphKey,
      records: new Map(),
      affected,
      diagnostics: [],
      retiredResources: false,
      cancellation: new AbortController(),
    };

    scopes.add(scope);
    return scope;
  };

  function releaseEvaluation(scope: Scope) {
    // Exported functions/import proxies outlive evaluation. They need bindings
    // and the scope's phase, not its completed module graph or staging records.
    // Keep only an identity token for overlapping lazy-import continuations.
    const graph = scope.program;
    if (graph && lazyScopes.get(graph) === scope) lazyScopes.delete(graph);
    scopes.delete(scope);
    scope.program = undefined;
    scope.records.clear();
    scope.affected.clear();
  }

  function namespace(scope: Scope, id: string, owner?: ModuleRecord): Namespace {
    const record = scope.records.get(id) || records.get(id);
    // Dynamic imports share the evaluated module's namespace. The record owns
    // this view, so replacing/pruning records does not grow a global registry.
    // Static binding views remain importer-owned: retired React cleanup must
    // still read the exports from its own evaluation after a replacement.
    if (!owner && record?.namespace) return record.namespace;

    const binding: Binding = {
      id,
      record,
    };

    owner?.bindings.push(binding);

    const target = () => {
      if (!owner?.retired)
        binding.record =
          (scope.phase === "staging" ? scope.records.get(id) : undefined) ||
          records.get(id) ||
          binding.record;
      return binding.record;
    };

    const view = new Proxy(Object.create(null) as Namespace, {
      get: (_, key) => (key === Symbol.toStringTag ? "Module" : target()?.exports[key as string]),
      has: (_, key) => !!target() && key in target()!.exports,
      ownKeys: () => Reflect.ownKeys(target()?.exports || {}),
      getOwnPropertyDescriptor: (_, key) =>
        key in (target()?.exports || {})
          ? {
              configurable: true,
              enumerable: true,
              get: () => target()!.exports[key as string],
            }
          : undefined,
      set: () => false,
      defineProperty: () => false,
      deleteProperty: () => false,
    });

    if (!owner && record) record.namespace = view;
    return view;
  }

  function retire(record?: ModuleRecord) {
    if (!record || record.retired) return;
    for (const binding of record.bindings) {
      binding.record = records.get(binding.id) || binding.record;
      if ("slots" in binding) {
        const dependents = subscribers.get(binding.id);
        if (dependents?.delete(binding) && dependents.size === 0) subscribers.delete(binding.id);
      }
    }
    record.retired = true;
  }

  function readers(exports: Namespace, names: string[], vendor = false): ImportSlot[] {
    return names.map((name) => ({
      read: vendor ? () => exports[name] : Object.getOwnPropertyDescriptor(exports, name)!.get!,
    }));
  }

  function namedBindings(scope: Scope, id: string, owner: ModuleRecord, names: string[]) {
    const target = (scope.records.get(id) || records.get(id))!;
    const slots = readers(target.exports, names);
    owner.bindings.push({ id, names, slots, record: target });
    return slots;
  }

  // Only committed importers subscribe; retirement detaches their frozen bindings.
  function publishBindings(published: readonly ModuleRecord[]) {
    for (const owner of published)
      for (const binding of owner.bindings)
        if ("slots" in binding) {
          let dependents = subscribers.get(binding.id);
          if (!dependents) subscribers.set(binding.id, (dependents = new Set()));
          dependents.add(binding);
        }
    for (const target of published)
      for (const binding of subscribers.get(target.id) || []) {
        if (target === binding.record) continue;
        binding.record = target;
        for (let slot = 0; slot < binding.names.length; slot++) {
          const name = binding.names[slot];
          binding.slots[slot].read =
            Object.getOwnPropertyDescriptor(target.exports, name)?.get ??
            (() => {
              throw new ReferenceError(`Missing export: ${name}`);
            });
        }
      }
  }

  async function callbacks(record: ModuleRecord, kind: "dispose" | "prune") {
    const diagnostics: Diagnostic[] = [];
    // Drain independently: one failing cleanup must not skip another resource.
    while (record[kind].length) {
      const callback = record[kind].shift()!;
      try {
        await scheduling?.beforeCleanup?.();
        await callback(record.data);
      } catch (error) {
        diagnostics.push(...errorDiagnostics(error, "cleanup", record.id));
      }
    }
    record.cleaned.add(kind);
    return diagnostics;
  }

  async function disposeRecord(record: ModuleRecord, prune = false): Promise<Diagnostic[]> {
    const existing = record.disposeTask;
    record.disposeTask ??= Promise.resolve().then(() => callbacks(record, "dispose"));
    const disposed = await record.disposeTask;
    let diagnostics = existing ? [] : disposed;
    if (prune) {
      const pruned = record.pruneTask;
      record.pruneTask ??= Promise.resolve().then(() => callbacks(record, "prune"));
      const result = await record.pruneTask;
      if (!pruned) diagnostics = [...diagnostics, ...result];
    }
    return diagnostics;
  }

  function finalize(record: ModuleRecord) {
    if (record.finalized || !record.finished) return;
    for (const name of record.acceptedExports || [])
      if (!(name in record.exports))
        throw new Error(`Accepted export does not exist: ${name} (${record.id})`);
    const classified = policy.classify(record.exports, record.id);
    record.registrations.push(...classified.registrations);
    record.boundary = classified.boundary;
    record.finalized = true;
  }

  function discard(
    scope: Scope,
    reason = new Error("Module evaluation was cancelled."),
  ): Promise<void> {
    return (scope.disposal ??= Promise.resolve().then(async () => {
      // A transaction may have already published its completed modules while a
      // fire-and-forget lazy import was still pending. Don't poison those owners.
      if (scope.phase !== "committed") scope.phase = "failed";
      for (const record of scope.records.values())
        if (records.get(record.id) !== record) {
          record.abandoned = true;
          // Unpublished candidates are abandoned completely. Previously
          // committed replacements keep their normal dispose/prune contract.
          scope.diagnostics.push(...(await disposeRecord(record, !record.retired)));
          record.state.discard();
        }
      // Release ownership before unblocking a lazy import's retry. A never-settled
      // user Promise must not keep an obsolete staging graph and its resources alive.
      scope.cancellation.abort(reason);
      releaseEvaluation(scope);
    }));
  }

  function publishLazy(scope: Scope) {
    if (closed || scope.phase === "failed" || !program || graphKeys.get(program) !== scope.graphKey)
      return false;
    if (!scope.program) return true; // Another continuation already published it.

    const ready = [...scope.records.values()].filter(
      (record) => record.finished && records.get(record.id) !== record,
    );

    for (const record of ready) finalize(record);
    const publishState = ready.map((record) => record.state.prepare());
    for (const publish of publishState) publish();
    for (const record of ready) {
      retire(records.get(record.id));
      records.set(record.id, record);
      for (const [type, id] of record.registrations) policy.register(type, id);
    }
    publishBindings(ready);
    if ([...scope.records.values()].every((record) => record.finished)) {
      scope.phase = "committed";
      releaseEvaluation(scope);
    }
    try {
      currentStyles();
    } catch (error) {
      onDiagnostic(errorDiagnostics(error, "notification"));
    }
    return true;
  }

  function resolveDynamicImport(importer: string, specifier: string) {
    if (closed) throw new Error("The project is disposed.");
    const transaction = activeUpdate?.phase === "staging" ? activeUpdate : undefined;
    const graph = transaction?.program || program;
    if (!graph) throw new Error("The project is not initialized.");
    const dependency = graph.modules[importer]?.imports[specifier];
    if (!dependency) throw new Error(`Undeclared import: ${specifier} (${importer})`);
    if (dependency.startsWith("vendor:")) return { vendor: policy.resolve(dependency, importer) };
    const scope = transaction || lazyScopes.get(graph) || scopeFor(graph);
    if (!transaction) lazyScopes.set(graph, scope);
    const owner = transaction?.records.get(importer) || records.get(importer);
    if (owner) {
      owner.dependencies.add(dependency);
      owner.importedBindings.set(dependency, null);
    }
    return { dependency, scope, transaction };
  }

  // Updates serialize publication. Dynamic evaluation never queues behind an
  // update that may be awaiting it. Imports started during evaluation join that
  // transaction; pre-existing lazy work retries if its graph was superseded.
  async function dynamicImport(importer: string, specifier: string): Promise<Namespace> {
    for (;;) {
      const target = resolveDynamicImport(importer, specifier);
      if ("vendor" in target) return target.vendor!;
      const { dependency, scope, transaction } = target;
      try {
        await evaluate(dependency, scope);
        if (scope.phase === "failed" || closed)
          throw new Error("Cannot import from a disposed module.");
        if (transaction && scope.phase === "staging") return namespace(scope, dependency);
        if (publishLazy(scope)) return namespace(scope, dependency);
        await discard(scope, superseded); // Never publish an obsolete graph.
      } catch (error) {
        if (scope.disposal) await scope.disposal;
        if (!closed && scope.cancellation.signal.reason === superseded) continue;
        if (!transaction) await discard(scope);
        throw error;
      }
    }
  }

  // Module callbacks outlive evaluation. Give them a separate lexical scope so
  // exported callbacks cannot capture the replacement operation's previous
  // record and retain a chain of obsolete module revisions.
  function createContext(
    record: ModuleRecord,
    scope: Scope,
    forceReset: boolean | undefined,
    chain: string[],
  ): ModuleContext {
    const id = record.id;

    const registerCleanup = (kind: "dispose" | "prune", callback: Cleanup) => {
      if (typeof callback !== "function") throw new TypeError("A cleanup callback is required.");
      record.ownsResources = true;
      if (record.cleaned.has(kind)) {
        void Promise.resolve()
          .then(async () => {
            await scheduling?.beforeCleanup?.();
            return callback(record.data);
          })
          .catch((error) => onDiagnostic(errorDiagnostics(error, "cleanup", id)));
      } else record[kind].push(callback);
    };

    const context: ModuleContext = {
      // A bound function captures only the budget and ID, not this evaluation's
      // record/scope. Old Refresh closures must not retain a revision chain.
      checkpoint: scheduling?.checkpoint?.bind(undefined, id) || (() => {}),
      export: (name, getter) =>
        Object.defineProperty(record.exports, name, {
          enumerable: true,
          configurable: true,
          get: getter,
        }),
      exportAll: (exports) => {
        for (const key of Object.keys(exports))
          if (key !== "default" && !(key in record.exports))
            context.export(key, () => exports[key]);
      },
      importBindings: async (specifier, names, needsNamespace, sideEffect) => {
        if (scope.phase === "failed" || record.abandoned || closed)
          throw new Error("Cannot import from a disposed module.");
        const dependency = scope.program?.modules[id]?.imports[specifier];
        if (!dependency) throw new Error(`Undeclared import: ${specifier} (${id})`);
        record.dependencies.add(dependency);
        const previousNames = record.importedBindings.get(dependency);
        record.importedBindings.set(
          dependency,
          needsNamespace || sideEffect || !names.length || previousNames === null
            ? null
            : new Set([...(previousNames || []), ...names]),
        );

        const vendor = dependency.startsWith("vendor:");
        if (!vendor) await evaluate(dependency, scope, [...chain, id]);

        const exports = vendor
          ? policy.resolve(dependency, id)
          : (scope.records.get(dependency) || records.get(dependency))!.exports;

        for (const name of names)
          if (!(name in exports)) throw new Error(`${specifier} has no export named ${name}.`);
        return {
          slots: vendor
            ? readers(exports, names, true)
            : namedBindings(scope, dependency, record, names),
          namespace: needsNamespace
            ? vendor
              ? exports
              : namespace(scope, dependency, record)
            : undefined,
        };
      },
      importDynamic: (specifier) =>
        scope.phase === "failed" || record.abandoned || closed
          ? Promise.reject(new Error("Cannot import from a disposed module."))
          : dynamicImport(id, specifier),
      meta: {
        state: record.state.cell,
        resources: resources && {
          asset: resources.asset,
          blob: resources.blob,
          worker(id, options) {
            const worker = resources.worker(id, options);
            registerCleanup("dispose", () => worker.terminate());
            return worker;
          },
        },
        url: `playground:${id}`,
        hot: {
          data: record.data,
          accept(callback = () => {}) {
            if (typeof callback !== "function")
              throw new TypeError("hot.accept supports only self-accept callbacks.");
            record.accept = callback;
          },
          acceptExports(names) {
            if (
              record.finished ||
              !Array.isArray(names) ||
              !names.length ||
              names.some((name) => typeof name !== "string")
            )
              throw new TypeError(
                "hot.acceptExports requires export names during module evaluation",
              );
            record.acceptedExports = new Set(names);
          },
          dispose: (callback) => registerCleanup("dispose", callback),
          prune: (callback) => registerCleanup("prune", callback),
          invalidate() {
            record.invalidated = true;
            if (scope.phase !== "staging") onInvalidate(id);
          },
        },
      },
      register: (type, key) => record.registrations.push([type, `${id} ${key}`]),
      signature: () => policy.signature(forceReset),
      global: (name, typeOnly = false) => {
        if (!(name in realm)) {
          if (typeOnly) return "undefined";
          throw new ReferenceError(`${name} is not defined`);
        }
        const value = Reflect.get(realm, name);
        return typeOnly ? typeof value : value;
      },
    };

    return context;
  }

  async function evaluate(id: string, scope: Scope, chain: string[] = []): Promise<void> {
    if (closed || scope.phase === "failed") throw new Error("The project is disposed.");
    const artifact = scope.program?.modules[id];
    if (!artifact) throw new Error(`File not found: ${id}`);

    const existing =
      scope.records.get(id) || (!scope.affected.has(id) ? records.get(id) : undefined);

    if (existing) {
      if (!chain.includes(id)) await guard(existing.promise, scope);
      return;
    }
    const previous = records.get(id);

    const record: ModuleRecord = {
      state: previous ? previous.state.fork() : createManagedState(restored[id]),
      id,
      exports: Object.create(null),
      dependencies: new Set(),
      importedBindings: new Map(),
      registrations: [],
      bindings: [],
      retired: false,
      dispose: [],
      prune: [],
      data: previous?.data || {},
      invalidated: false,
      boundary: null,
      finalized: false,
      finished: false,
      promise: Promise.resolve(),
      cleaned: new Set(),
      abandoned: false,
      ownsResources: false,
    };

    scope.records.set(id, record);
    record.promise = (async () => {
      if (artifact.kind === "css") {
        record.finished = true;
        return;
      }
      if (scheduling && performance.now() >= deadline) {
        await guard(scheduling.yieldTask(), scope);
        deadline = performance.now() + scheduling.budgetMs;
      }
      let factory: ModuleFactory;
      if (artifact.kind === "json" || artifact.kind === "text") {
        const value = artifact.kind === "json" ? JSON.parse(artifact.data) : artifact.data;
        factory = async (context) => context.export("default", () => value);
      } else {
        const identity = artifact.kind === "asset" ? artifact.assetId : artifact.code;
        let cached = factories.get(id);
        if (cached?.code !== identity) {
          cached = {
            code: identity,
            factory: await loadFactory(artifact, scope.program?.debug?.[id]),
          };
          factories.set(id, cached);
        }
        factory = cached.factory;
      }
      if (closed || scope.phase === "failed" || record.abandoned)
        throw new Error("The project is disposed.");
      if (previous) {
        if (previous.ownsResources) scope.retiredResources = true;
        scope.diagnostics.push(...(await disposeRecord(previous)));
      }
      await factory.call(
        undefined,
        createContext(
          record,
          scope,
          artifact.kind === "js" ? artifact.forceReset : undefined,
          chain,
        ),
      );
      record.finished = true;
    })();
    await guard(record.promise, scope);
  }

  function styles(): Styles {
    const list: Styles = [];
    const visited = new Set<string>();

    const visit = (id: string) => {
      if (visited.has(id) || !records.has(id)) return;
      visited.add(id);
      for (const dep of records.get(id)!.dependencies) visit(dep);
      const item = program?.modules[id];
      if (item?.kind === "css") list.push({ id, code: item.code });
    };

    if (program) visit(program.entry);
    for (const id of program?.styles || []) visit(id);
    for (const id of records.keys()) visit(id);
    return list;
  }

  function boundaryChanged(old: ModuleRecord | undefined, fresh: ModuleRecord) {
    return (
      fresh.finished &&
      old &&
      !old.accept &&
      old.boundary !== null &&
      (fresh.boundary !== old.boundary ||
        fresh.invalidated ||
        (policy.canAccept && !policy.canAccept(old.exports, fresh.exports)))
    );
  }

  function invalidatesParent(id: string, fresh: ModuleRecord, parent: string) {
    const old = records.get(id);
    return (
      boundaryChanged(old, fresh) ||
      (old?.acceptedExports &&
        !fresh.accept &&
        fresh.boundary === null &&
        !acceptsDependency(fresh, records.get(parent), id))
    );
  }

  async function stageUpdate(next: Compilation, scope: Scope, plan: ReturnType<typeof planUpdate>) {
    const { affected, removed, parents, propagate } = plan;
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const id of affected) if (!removed.has(id)) await evaluate(id, scope);
      await evaluate(next.entry, scope);
      for (const id of next.styles) await evaluate(id, scope);
      for (const record of scope.records.values()) finalize(record);
      for (const [id, fresh] of scope.records) {
        for (const parent of parents.get(id) || [])
          if (!affected.has(parent) && invalidatesParent(id, fresh, parent)) {
            affected.add(parent);
            expanded = true;
          }
      }
      if (expanded) propagate();
    }
    const entry = (scope.records.get(next.entry) || records.get(next.entry))!.exports;
    policy.validateEntry(entry);
    for (const id of removed) {
      const old = records.get(id)!;
      if (old.ownsResources) scope.retiredResources = true;
      scope.diagnostics.push(...(await disposeRecord(old, true)));
    }
    if (closed) throw new Error("The project is disposed.");
    return entry;
  }

  function commitUpdate(next: Compilation, scope: Scope, removed: Set<string>) {
    // Commit has no user callbacks. Once published, notification errors must
    // never dispose or roll back these records.
    const ready = [...scope.records.values()].filter((record) => record.finished);
    const publishState = ready.map((record) => record.state.prepare());
    for (const publish of publishState) publish();
    for (const id of new Set([...removed, ...ready.map((record) => record.id)]))
      retire(records.get(id));
    const notifications: Array<{ id: string; run: () => unknown }> = [];
    for (const fresh of ready) {
      const old = records.get(fresh.id);
      if (old?.accept)
        notifications.push({
          id: fresh.id,
          run: () => old.accept!(namespace(scope, fresh.id)),
        });
      records.set(fresh.id, fresh);
      if (next.modules[fresh.id].kind === "js") policy.committed(fresh.id);
    }
    publishBindings(ready);
    for (const id of removed) {
      records.delete(id);
      factories.delete(id);
      policy.removed(id);
    }
    program = next;
    scope.phase = "committed";
    activeUpdate = undefined;
    failedModules.clear();
    if (ready.length === scope.records.size) releaseEvaluation(scope);
    return { ready, notifications };
  }

  async function apply(
    next: Compilation,
    updateStyles: (styles: Styles) => void,
  ): Promise<ApplyResult> {
    if (closed) throw new Error("The project is disposed.");
    if (next.schema !== PROGRAM_SCHEMA || next.abi !== MODULE_ABI)
      throw new Error("Unsupported module ABI.");
    if (program && program.projectKey !== next.projectKey)
      throw new RuntimeUpdateError([{ text: "Project execution settings changed." }], true);
    const plan = planUpdate(next, program, records, failedModules);
    const { affected, removed } = plan;
    const scope = scopeFor(next, affected);
    activeUpdate = scope;
    let entry: Namespace;
    let committed: ReturnType<typeof commitUpdate>;
    try {
      entry = await stageUpdate(next, scope, plan);
      committed = commitUpdate(next, scope, removed);
    } catch (error) {
      failedModules = new Set([...affected, ...scope.records.keys()]);
      await discard(scope);
      activeUpdate = undefined;
      let state: ManagedState | undefined;
      try {
        state = captureCommitted();
      } catch {
        /* Invalid user state cannot be restored. */
      }
      throw new RuntimeUpdateError(
        [...errorDiagnostics(error, "evaluation"), ...scope.diagnostics],
        scope.retiredResources,
        error,
        state,
      );
    }
    const { ready, notifications } = committed;
    // Snapshot the retirement set before awaiting user-controlled cleanup.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const old of [...scopes]) {
      if (old === scope || old.program === next) continue;
      await discard(old, superseded);
      scope.diagnostics.push(...old.diagnostics);
    }
    currentStyles = () => updateStyles(styles());
    try {
      currentStyles();
    } catch (error) {
      scope.diagnostics.push(...errorDiagnostics(error, "notification"));
    }
    for (const notification of notifications)
      try {
        await guard(Promise.resolve(notification.run()));
      } catch (error) {
        scope.diagnostics.push(...errorDiagnostics(error, "notification", notification.id));
      }
    return {
      entry,
      registrations: ready.flatMap((record) => record.registrations),
      evaluated: ready
        .filter((record) => next.modules[record.id].kind === "js")
        .map((record) => record.id),
      diagnostics: scope.diagnostics,
    };
  }

  function captureCommitted(): ManagedState {
    return cloneState(
      Object.fromEntries([...records].map(([id, record]) => [id, record.state.snapshot()])),
    );
  }

  let disposal: Promise<Diagnostic[]> | undefined;
  return {
    captureState(): ManagedState {
      if (closed || activeUpdate) throw new Error("State capture requires a committed runtime");
      return captureCommitted();
    },
    async test(paths: readonly string[], container?: HTMLElement): Promise<TestResult[]> {
      if (!program || closed || activeUpdate || paths.length > 16)
        throw new Error("Tests require a committed runtime and at most 16 modules");
      const results: TestResult[] = [];
      for (const file of paths) {
        const scope = scopeFor(program);
        try {
          await evaluate(file, scope);
          const exports = (scope.records.get(file) || records.get(file))!.exports;
          if (!publishLazy(scope)) throw new Error("Test revision changed");
          if (typeof exports.test !== "function")
            throw new Error("Test modules must export test(context)");
          await guard(
            Promise.resolve(
              exports.test({
                container,
                signal: shutdown.signal,
                assert(value: unknown, message = "Assertion failed") {
                  if (!value) throw new Error(message);
                },
              }),
            ),
          );
          results.push({ file, ok: true, diagnostics: [] });
        } catch (error) {
          await discard(scope);
          results.push({
            file,
            ok: false,
            diagnostics: errorDiagnostics(error, "evaluation", file),
          });
        }
      }
      return results;
    },
    apply(next: Compilation, updateStyles: (styles: Styles) => void) {
      const task = updates.then(() => apply(next, updateStyles));
      updates = task.catch(() => {});
      return task;
    },
    dispose(): Promise<Diagnostic[]> {
      if (disposal) return disposal;
      closed = true;
      shutdown.abort(new Error("The project is disposed."));

      const owned = new Set([
        ...records.values(),
        ...[...scopes].flatMap((scope) => [...scope.records.values()]),
      ]);

      for (const scope of scopes) scope.phase = "failed";
      disposal = (async () => {
        const diagnostics: Diagnostic[] = [];
        for (const record of owned) diagnostics.push(...(await disposeRecord(record, true)));
        records.clear();
        subscribers.clear();
        factories.clear();
        policy.dispose();
        failedModules.clear();
        for (const scope of scopes) releaseEvaluation(scope);
        scopes.clear();
        lazyScopes.clear();
        program = undefined;
        activeUpdate = undefined;
        currentStyles = () => {};
        updates = Promise.resolve();
        return diagnostics;
      })();
      return disposal;
    },
  };
}
