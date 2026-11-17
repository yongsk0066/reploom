import type { CompilerConfig, ResourcePayloads } from "./definition.ts";
import { createUpdateAdmission, type UpdateAdmission } from "./update-admission.ts";
import {
  transactFiles,
  readArchive,
  cloneState,
  type FileOperation,
  type ProjectArchive,
  type ManagedState,
} from "./snapshot.ts";
import {
  composeTextPatch,
  type SourceText,
  type SourceFiles,
  type TextEdit,
  type TextPatch,
} from "../shared/source-patch.ts";

export type { SourceText, SourceFiles } from "../shared/source-patch.ts";

import {
  isProgramReference,
  errorDiagnostics,
  type ExecutableProgram,
} from "../shared/protocol.ts";
import type {
  Asset,
  CompilerRequest,
  CompileResult,
  Diagnostic,
  ExecutionOutcome,
  Files,
  PreviewEvent,
  Seed,
  Snapshot,
  CompilePriority,
  TestResult,
} from "../shared/protocol.ts";

export type ProjectState =
  | { phase: "loading" | "starting" | "compiling" | "disposed" }
  | { phase: "editing"; reason: "edit" | "composition" | "restart" }
  | { phase: "ready"; outcome: Exclude<ExecutionOutcome, "error"> }
  | {
      phase: "error";
      stage: "load" | "compile" | "runtime";
      diagnostics: Diagnostic[];
      requiresRestart: boolean;
    };

// Immutable source value. Editor adapters may supply a persistent text tree;
// the core never needs an EditorView, its history, or a particular editor API.
export type ProjectView = {
  capabilities?: { tests: boolean; types: boolean };
  checks?: Partial<
    Record<
      "tests" | "types",
      {
        revision: number;
        phase: "running" | "passed" | "failed";
        diagnostics: Diagnostic[];
        tests?: TestResult[];
      }
    >
  >;
  revision: number;
  files: SourceFiles;
  active: string;
  snapshot?: Snapshot;
  state: ProjectState;
  logs: string[];
  editorReset: number;
  initialized: boolean;
  selection?: { file: string; line: number; column: number; id: string };
};

export type LoadedProject = Seed & {
  checks?: readonly string[];
  typecheck?: boolean;
  vendor: readonly import("../shared/protocol.ts").ScriptSource[];
  worker?: readonly import("../shared/protocol.ts").ScriptSource[];
  bootstrap: string;
  assets?: ResourcePayloads;
  updateDelayMs?: number;
  compilerAsset?: Asset;
  compilerResources(signal?: AbortSignal): Promise<{ compiler: Asset; config: CompilerConfig }>;
};

export interface SessionServices {
  now?(): number;
  createAdmission?(fixedDelay?: number): UpdateAdmission;
  validation?: {
    tests?(
      snapshot: Snapshot,
      paths: readonly string[],
      signal: AbortSignal,
    ): Promise<TestResult[]>;
    types?(files: Files, signal: AbortSignal): Promise<Diagnostic[]>;
  };
  loadProject(example: string, signal?: AbortSignal): Promise<LoadedProject>;
  compiler: {
    sourceEdits?: boolean;
    setPriority?(projectId: string, priority: CompilePriority): void;
    prepare?(projectId: string, compiler: Asset, signal: AbortSignal): Promise<void>;
    compile(input: CompilerRequest, signal: AbortSignal): Promise<CompileResult>;
    release(projectId: string): void;
  };
  newId(): string;
  schedule(task: () => void, milliseconds: number): () => void;
}

const initial: ProjectView = {
  revision: 0,
  files: {},
  active: "",
  state: { phase: "loading" },
  logs: [],
  editorReset: 0,
  initialized: false,
};

// Source/revision ownership, not browser I/O or translated presentation text.
export class ProjectSession {
  readonly projectId: string;
  readonly example: string;
  private readonly services: SessionServices;
  private view: ProjectView = initial;
  private listeners = new Set<() => void>();
  private revision = 0;
  private loadEpoch = 0;
  private disposed = false;
  private cancelTimer?: () => void;
  private abort?: AbortController;
  private preparation?: AbortController;
  private loading?: AbortController;
  private preparing?: Promise<void>;
  private original?: LoadedProject;
  private lastGood?: { files: SourceFiles; output: ExecutableProgram };
  // Only the last serialization per file is retained. A WeakMap keyed by text
  // trees would keep flattened strings for old trees still owned by Undo.
  private materialized?: { sources: SourceFiles; files: Files };
  private sourceRevision: number | null = null;
  private sourceEdits: Record<string, TextPatch | null> = {};
  private restartRequired = false;
  private priority: CompilePriority = "visible";
  private restoration?: ManagedState;
  private checks = new Map<"tests" | "types", AbortController>();
  private preview?: { captureState(signal: AbortSignal): Promise<ManagedState> };
  private admission = createUpdateAdmission();

  private now() {
    return this.services.now?.() ?? performance.now();
  }

  constructor(example: string, services: SessionServices) {
    this.example = example;
    this.services = services;
    this.projectId = services.newId();
  }

  getSnapshot = () => this.view;
  getServerSnapshot = () => initial;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Stable selected snapshots work with any UI, including useSyncExternalStore. */
  observe<T>(select: (view: ProjectView) => T, equal: (a: T, b: T) => boolean = Object.is) {
    let current = select(this.view);
    let subscribers = 0;
    const server = select(initial);

    const read = () => {
      const next = select(this.view);
      if (!equal(current, next)) current = next;
      return current;
    };

    return {
      getSnapshot: read,
      getServerSnapshot: () => server,
      subscribe: (listener: () => void) => {
        let previous = read();
        subscribers++;

        const unsubscribe = this.subscribe(() => {
          const next = read();
          if (!equal(previous, next)) {
            previous = next;
            listener();
          }
        });

        let subscribed = true;
        return () => {
          if (!subscribed) return;
          subscribed = false;
          unsubscribe();
          previous = server;
          if (--subscribers === 0) current = server;
        };
      },
    };
  }

  setPriority(priority: CompilePriority) {
    if (this.disposed || this.priority === priority) return;
    this.priority = priority;
    this.services.compiler.setPriority?.(this.projectId, priority);
  }

  private set(patch: Partial<ProjectView>) {
    this.view = { ...this.view, ...patch, revision: this.revision };
    for (const listener of this.listeners) listener();
  }

  private invalidate() {
    for (const controller of this.checks.values()) controller.abort();
    this.checks.clear();
    this.view = { ...this.view, checks: undefined };
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.abort?.abort();
    this.abort = undefined;
    return ++this.revision;
  }

  private show(output: ExecutableProgram, revision: number, restart = false) {
    if (!this.original) return;
    const fresh = restart || this.restartRequired || !this.view.snapshot;
    this.restartRequired = false;
    this.set({
      logs: [],
      state: { phase: "starting" },
      snapshot: {
        program: output,
        projectId: this.projectId,
        vendor: this.original.vendor,
        worker: this.original.worker,
        bootstrap: this.original.bootstrap,
        assets: this.original.assets,
        state: fresh ? this.restoration : undefined,
        revision,
        generation: fresh ? this.services.newId() : this.view.snapshot!.generation,
      },
    });
    if (fresh) this.restoration = undefined;
  }

  async start({ active, archive }: { active?: string; archive?: ProjectArchive } = {}) {
    this.disposed = false;
    const epoch = ++this.loadEpoch;
    this.loading?.abort();
    const controller = new AbortController();
    this.loading = controller;
    this.set({ state: { phase: "loading" } });
    try {
      const project = await this.services.loadProject(this.example, controller.signal);
      if (this.disposed || epoch !== this.loadEpoch) return;
      this.original = project;
      this.admission = (this.services.createAdmission ?? createUpdateAdmission)(
        project.updateDelayMs,
      );
      this.lastGood = { files: project.files, output: project.output };
      this.set({
        files: project.files,
        active: active && Object.hasOwn(project.files, active) ? active : project.output.entry,
        initialized: true,
        capabilities: {
          tests: !!project.checks?.length && !!this.services.validation?.tests,
          types: !!project.typecheck && !!this.services.validation?.types,
        },
      });
      if (archive !== undefined) this.restore(archive);
      else this.show(project.output, this.revision, true);
    } catch (error) {
      if (!this.disposed && epoch === this.loadEpoch)
        this.set({
          state: {
            phase: "error",
            stage: "load",
            diagnostics: [{ text: String(error) }],
            requiresRestart: false,
          },
        });
    } finally {
      controller.abort();
      if (this.loading === controller) this.loading = undefined;
    }
  }

  select(path: string) {
    if (!this.disposed && Object.hasOwn(this.view.files, path)) this.set({ active: path });
  }

  private async inspectionProgram(signal: AbortSignal) {
    const original = this.original!;
    if (this.lastGood?.files === this.view.files && !isProgramReference(this.lastGood.output))
      return this.lastGood.output;
    const projectId = this.services.newId();
    try {
      const resources = await original.compilerResources(signal);
      signal.throwIfAborted();

      const result = await this.services.compiler.compile(
        {
          projectId,
          revision: this.revision,
          files: this.view.files,
          ...resources,
          seed: { files: original.files, output: original.output },
          priority: "background",
        },
        signal,
      );

      if (!result.ok) throw { diagnostics: result.errors };
      if (isProgramReference(result.output))
        throw new Error("Inspection requires an owned program");
      return result.output;
    } finally {
      this.services.compiler.release(projectId);
    }
  }

  async check(kind: "tests" | "types") {
    const original = this.original;
    const services = this.services.validation;
    if (!original || this.disposed || !services || !this.view.capabilities?.[kind])
      throw new Error(`Project does not provide ${kind}`);
    this.checks.get(kind)?.abort();
    const controller = new AbortController();
    this.checks.set(kind, controller);
    const revision = this.revision;
    this.set({
      checks: { ...this.view.checks, [kind]: { revision, phase: "running", diagnostics: [] } },
    });
    let diagnostics: Diagnostic[] = [];
    let tests: TestResult[] | undefined;
    try {
      if (kind === "types")
        diagnostics = await services.types!(this.exportProject().files, controller.signal);
      else {
        const program = await this.inspectionProgram(controller.signal);
        controller.signal.throwIfAborted();
        tests = await services.tests!(
          {
            program,
            revision,
            generation: this.services.newId(),
            bootstrap: original.bootstrap,
            vendor: original.vendor,
            worker: original.worker,
            assets: original.assets,
          },
          original.checks!,
          controller.signal,
        );
        diagnostics = tests.flatMap((result) => result.diagnostics);
      }
    } catch (error) {
      if (controller.signal.aborted) throw error;
      diagnostics = errorDiagnostics(error);
    } finally {
      if (this.checks.get(kind) === controller) this.checks.delete(kind);
    }
    controller.signal.throwIfAborted();

    const result = {
      revision,
      phase: diagnostics.length ? ("failed" as const) : ("passed" as const),
      diagnostics: diagnostics.map((item) => ({ ...item, revision })),
      tests,
    };

    this.set({ checks: { ...this.view.checks, [kind]: result } });
    return result;
  }

  transaction(operations: readonly FileOperation[]) {
    if (!this.original || this.disposed) throw new Error("Project is not loaded");

    const files = transactFiles(this.view.files, operations, this.original.output.entry, [
      ...this.original.output.styles,
      ...(this.original.checks || []),
    ]);

    let active = this.view.active;
    for (const operation of operations)
      if (operation.type === "move" && operation.from === active) active = operation.to;
    this.sourceRevision = null;
    this.sourceEdits = {};
    this.materialized = undefined;
    void this.prepare();
    this.view = {
      ...this.view,
      active: Object.hasOwn(files, active) ? active : this.original.output.entry,
    };
    this.schedule(true, false, files);
  }

  exportProject(): ProjectArchive {
    if (!this.original || this.disposed) throw new Error("Project is not loaded");
    return Object.freeze({
      schema: 1,
      project: this.example,
      projectKey: this.original.output.projectKey,
      files: Object.freeze(
        Object.fromEntries(
          Object.entries(this.view.files).map(([id, source]) => [id, source.toString()]),
        ),
      ),
      active: this.view.active,
    });
  }

  bindPreview(preview: { captureState(signal: AbortSignal): Promise<ManagedState> }) {
    if (this.preview) throw new Error("Project already owns a preview controller");
    this.preview = preview;
    return () => {
      if (this.preview === preview) this.preview = undefined;
    };
  }

  async save({
    state = false,
    signal = new AbortController().signal,
  } = {}): Promise<ProjectArchive> {
    const archive = this.exportProject();
    if (!state) return archive;
    if (!this.preview || this.view.state.phase !== "ready")
      throw new Error("State capture requires a settled preview");
    const revision = this.revision;
    const captured = await this.preview.captureState(signal);
    if (signal.aborted || this.disposed || this.revision !== revision)
      throw new DOMException("Project changed during state capture", "AbortError");
    return Object.freeze({ ...archive, state: cloneState(captured) });
  }

  restore(input: unknown) {
    if (!this.original || this.disposed) throw new Error("Project is not loaded");

    const archive = readArchive(
      input,
      this.example,
      this.original.output.projectKey,
      this.original.output.entry,
      [...this.original.output.styles, ...(this.original.checks || [])],
    );

    this.restoration = archive.state;
    this.sourceRevision = null;
    this.sourceEdits = {};
    this.materialized = undefined;
    this.view = { ...this.view, active: archive.active, editorReset: this.view.editorReset + 1 };
    const prepared = this.original.files;

    const sameSource =
      Object.keys(prepared).length === Object.keys(archive.files).length &&
      Object.entries(archive.files).every(([path, code]) => prepared[path] === code);

    if (sameSource) this.lastGood = { files: prepared, output: this.original.output };
    this.schedule(true, true, sameSource ? prepared : archive.files);
  }

  reveal(diagnostic: Diagnostic) {
    const { file, line = 1, column = 0 } = diagnostic;
    if (
      this.disposed ||
      !file ||
      !Object.hasOwn(this.view.files, file) ||
      (diagnostic.revision !== undefined && diagnostic.revision !== this.revision) ||
      !Number.isSafeInteger(line) ||
      !Number.isSafeInteger(column) ||
      line < 1 ||
      column < 0
    )
      return false;
    this.set({ active: file, selection: { file, line, column, id: this.services.newId() } });
    return true;
  }

  change(path: string, code: SourceText, composing = false, edits?: readonly TextEdit[]) {
    if (this.disposed || !this.original || !Object.hasOwn(this.view.files, path)) return;
    void this.prepare();
    if (this.view.files[path] !== code) {
      const previous = this.sourceEdits[path];
      if (edits && edits.length <= 128 && previous !== null) {
        const patch = composeTextPatch(
          previous ?? { baseLength: this.view.files[path].length, edits: [] },
          edits,
        );

        this.sourceEdits[path] = patch.edits.length <= 128 ? patch : null;
      } else this.sourceEdits[path] = null;
    }

    const files =
      this.view.files[path] === code
        ? this.view.files
        : Object.freeze({ ...this.view.files, [path]: code });

    if (composing) {
      this.admission.reset();
      this.invalidate();
      this.set({ files, state: { phase: "editing", reason: "composition" } });
    } else this.schedule(false, false, files);
  }

  prepare(): Promise<void> {
    if (this.preparing) return this.preparing;
    if (
      this.disposed ||
      !this.original ||
      !this.services.compiler.prepare ||
      this.view.state.phase === "editing" ||
      this.view.state.phase === "compiling"
    )
      return Promise.resolve();
    const controller = new AbortController();
    this.preparation?.abort();
    this.preparation = controller;
    // Each editing burst can reacquire an idle compiler, without a speculative build.
    // Reader-only sessions remain free of Worker/WASM initialization cost.
    const resources = this.original.compilerResources(controller.signal);
    const asset = this.original.compilerAsset;

    const preparing = (asset ? Promise.resolve({ compiler: asset }) : resources).then(
      async ({ compiler }) => {
        if (!controller.signal.aborted)
          await this.services.compiler.prepare!(this.projectId, compiler, controller.signal);
      },
    );

    const task = Promise.all([resources, preparing])
      .then(() => {})
      .catch(() => {
        // Preparation is optional; compilation remains the error/retry boundary.
      })
      .finally(() => {
        if (this.preparing === task) this.preparing = undefined;
      });

    this.preparing = task;
    return task;
  }

  private schedule(immediate = false, restart = false, files = this.view.files) {
    const delay = this.admission.input(this.now(), immediate);
    const revision = this.invalidate();
    this.set({
      files,
      state: { phase: "editing", reason: restart ? "restart" : "edit" },
    });
    this.cancelTimer = this.services.schedule(() => {
      this.cancelTimer = undefined;
      void this.run(revision, restart);
    }, delay);
  }

  rerun() {
    if (this.original && !this.disposed) this.schedule(true, true);
  }

  reset() {
    if (!this.original || this.disposed) return;
    const revision = this.invalidate();
    this.admission.reset();
    this.materialized = undefined;
    this.restoration = undefined;
    this.sourceRevision = null;
    this.sourceEdits = {};
    this.lastGood = {
      files: this.original.files,
      output: this.original.output,
    };
    this.set({
      files: this.original.files,
      active: this.original.output.entry,
      editorReset: this.view.editorReset + 1,
    });
    this.show(this.original.output, revision, true);
  }

  private compileInput(sources: SourceFiles) {
    // Serialization belongs at the compile boundary, after debounce, IME and
    // stale-request checks. Superseded keystrokes never flatten the document.
    const operations = this.services.compiler.sourceEdits
      ? {
          baseRevision: this.sourceRevision,
          changes: Object.fromEntries(
            Object.entries(this.sourceEdits).map(([path, patch]) => [
              path,
              patch ?? sources[path].toString(),
            ]),
          ),
        }
      : undefined;

    const files = operations
      ? sources
      : Object.freeze(
          Object.fromEntries(
            Object.entries(sources).map(([path, source]) => [
              path,
              this.materialized?.sources[path] === source
                ? this.materialized.files[path]
                : source.toString(),
            ]),
          ),
        );

    if (!operations) this.materialized = { sources, files: files as Files };
    return { files, edits: operations };
  }

  private async run(revision: number, restart: boolean) {
    if (!this.original || this.disposed) return;
    this.admission.started(revision, this.now());
    const sources = this.view.files;
    if (restart && sources === this.lastGood?.files && !isProgramReference(this.lastGood.output)) {
      this.show(this.lastGood.output, revision, true);
      return;
    }
    const controller = new AbortController();
    this.abort = controller;
    this.set({ state: { phase: "compiling" } });
    try {
      const resources = await this.original.compilerResources(controller.signal);
      if (controller.signal.aborted || this.disposed || revision !== this.revision) return;

      const input = this.compileInput(sources);
      this.sourceRevision = revision;
      this.sourceEdits = {};

      const result = await this.services.compiler.compile(
        {
          projectId: this.projectId,
          revision,
          priority: this.priority,
          ...input,
          ...resources,
          seed: { files: this.original.files, output: this.original.output },
        },
        controller.signal,
      );

      if (this.disposed || controller.signal.aborted || revision !== this.revision) return;
      if (result.ok) {
        this.lastGood = { files: sources, output: result.output };
        this.show(result.output, revision, restart);
      } else {
        this.admission.settled(revision, this.now());
        this.set({
          state: {
            phase: "error",
            stage: "compile",
            diagnostics: result.errors.map((error) => ({ ...error, revision })),
            requiresRestart: this.restartRequired,
          },
        });
      }
    } catch (error) {
      this.admission.settled(revision, this.now());
      if (!this.disposed && revision === this.revision && !controller.signal.aborted)
        this.set({
          state: {
            phase: "error",
            stage: "compile",
            diagnostics: [{ text: String(error) }],
            requiresRestart: this.restartRequired,
          },
        });
    } finally {
      if (this.abort === controller) this.abort = undefined;
    }
  }

  onEvent = (event: PreviewEvent) => {
    if (this.disposed) return;
    if (event.type === "request-program") {
      if (event.generation === this.view.snapshot?.generation && event.revision === this.revision)
        this.schedule(true, false, this.lastGood?.files ?? this.view.files);
      return;
    }
    if (event.type === "restart-required") {
      const snapshot = this.view.snapshot;
      if (!snapshot || event.generation !== snapshot.generation) return;
      this.restartRequired = true;
      if (event.state && !this.restoration) this.restoration = cloneState(event.state);
      // A newer successful compilation may already be waiting behind the failed
      // execution. Move it to a fresh realm; don't wait for one more user edit.
      if (snapshot.revision > event.revision && snapshot.revision === this.revision)
        this.show(snapshot.program, snapshot.revision, true);
      return;
    }
    if (event.revision !== this.revision) return;
    if (event.type === "invalidate") {
      this.schedule(true);
      return;
    }
    if (event.type === "console") {
      this.set({ logs: [...this.view.logs, event.text].slice(-30) });
      return;
    }
    this.settlePreview(event);
  };

  private settlePreview(event: Extract<PreviewEvent, { type: "settled" | "runtime-error" }>) {
    this.admission.settled(event.revision, this.now());
    this.restartRequired ||= event.requiresRestart;

    const previousErrors =
      this.view.state.phase === "error" && this.view.state.stage === "runtime"
        ? this.view.state.diagnostics
        : [];

    if (event.type === "runtime-error" || event.outcome === "error" || event.diagnostics.length) {
      this.set({
        state: {
          phase: "error",
          stage: "runtime",
          diagnostics: [...previousErrors, ...event.diagnostics].slice(-10),
          requiresRestart: this.restartRequired,
        },
      });
    } else this.set({ state: { phase: "ready", outcome: event.outcome } });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.admission.reset();
    this.loadEpoch++;
    this.loading?.abort();
    this.loading = undefined;
    this.invalidate();
    this.preparation?.abort();
    this.preparation = undefined;
    this.preparing = undefined;
    this.services.compiler.release(this.projectId);
    this.original = undefined;
    this.restoration = undefined;
    this.preview = undefined;
    this.lastGood = undefined;
    this.materialized = undefined;
    this.sourceEdits = {};
    this.sourceRevision = null;
    // Replace the view: merging would retain optional fields such as snapshot.
    this.view = { ...initial, state: { phase: "disposed" } };
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }
}
