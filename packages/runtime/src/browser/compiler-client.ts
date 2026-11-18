import {
  PROTOCOL,
  applyProgramPatch,
  type Asset,
  type CompilerWorkerCommand,
  type CompilerReply,
  type CompilerRequest,
  type CompileResult,
  type Files,
  type VersionedProgram,
  type CompilePriority,
} from "../shared/protocol.ts";
import { PreviewDestinations } from "./preview-destinations.ts";
import { sourceChange } from "../shared/source-patch.ts";

export type { Diagnostic, Compilation } from "../shared/protocol.ts";

export type CompilerLifetime = { maxMemoryBytes?: number; minLifetimeMs?: number; idleMs?: number };

export function createCompilerClient(
  createWorker: () => Worker,
  limits: CompilerLifetime = {},
  routes = new PreviewDestinations(),
) {
  const maxMemoryBytes = limits.maxMemoryBytes ?? 64 * 1024 * 1024;
  const minLifetimeMs = limits.minLifetimeMs ?? 30_000;
  if (
    !Number.isFinite(maxMemoryBytes) ||
    maxMemoryBytes < 1 ||
    !Number.isFinite(minLifetimeMs) ||
    minLifetimeMs < 0
  )
    throw new Error("Invalid compiler lifetime limits");
  let born = 0;
  let pressure = false;
  const deliveries = new Map<string, number>();
  let disposed = false;
  let worker: Worker | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let prepared = false;
  let readyCompiler: string | undefined;

  const preparations = new Set<{
    projectId: string;
    compiler: string;
    finish(error?: unknown): void;
  }>();

  // A single immutable Module may outlive an idle Worker; no Instance/Memory does.
  // The last lease or a bounded timeout releases compiled machine code as well.
  let compiled: { key: string; module: WebAssembly.Module } | undefined;
  let moduleTimer: ReturnType<typeof setTimeout> | undefined;

  function forgetModule() {
    clearTimeout(moduleTimer);
    moduleTimer = undefined;
    compiled = undefined;
  }

  function cachedModule(asset: Asset) {
    return compiled?.key === asset.sha256 ? compiled.module : undefined;
  }

  // Compiled preview state belongs to the Session/runtime, not to the compiler.
  // Release its WASM and caches after editing stops; the next request seeds a
  // fresh Worker. Never evict while a caller is waiting for a result.
  const idleMilliseconds = limits.idleMs ?? 30_000;
  // A session can own a warming Worker before it has sent its first revision.
  const owners = new Set<string>();
  const sent = new Map<string, { id: string; revision: number; files?: Files; paths: string[] }>();
  const received = new Map<string, VersionedProgram>();

  const pending = new Map<
    string,
    {
      projectId: string;
      resolve(result: CompileResult): void;
      reject(error: Error): void;
      resync(): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  const destinations = routes.entries;

  const post = (command: CompilerWorkerCommand, transfer: Transferable[] = []) => {
    try {
      worker?.postMessage(command, transfer);
    } catch (error) {
      if (
        "module" in command &&
        command.module &&
        error instanceof DOMException &&
        error.name === "DataCloneError"
      ) {
        forgetModule();
        worker?.postMessage({ ...command, module: undefined });
      } else throw error;
    }
  };

  function retireWorker() {
    clearTimeout(idleTimer);
    idleTimer = undefined;
    if (worker) {
      worker.onmessage = worker.onerror = null;
      worker.terminate();
    }
    worker = undefined;
    prepared = false;
    readyCompiler = undefined;
    for (const task of preparations)
      task.finish(new DOMException("Compiler retired", "AbortError"));
    sent.clear();
    received.clear();
    deliveries.clear();
    pressure = false;
  }

  function scheduleRetirement() {
    clearTimeout(idleTimer);
    idleTimer = undefined;
    if (worker && !pending.size) idleTimer = setTimeout(retireWorker, idleMilliseconds);
  }

  function failAll(error: Error) {
    for (const task of preparations) task.finish(error);
    retireWorker();
    forgetModule();
    owners.clear();
    for (const task of pending.values()) {
      clearTimeout(task.timer);
      task.reject(error);
    }
    pending.clear();
  }

  function release(projectId: string) {
    for (const task of preparations)
      if (task.projectId === projectId) task.finish(new DOMException("Aborted", "AbortError"));
    destinations.delete(projectId);
    owners.delete(projectId);
    sent.delete(projectId);
    received.delete(projectId);
    deliveries.delete(projectId);
    post({ protocol: PROTOCOL, type: "dispose", projectId });
    for (const [id, task] of pending)
      if (task.projectId === projectId) {
        clearTimeout(task.timer);
        pending.delete(id);
        task.reject(new DOMException("Aborted", "AbortError"));
      }
    if (!owners.size && !pending.size) {
      retireWorker();
      forgetModule();
    } else scheduleRetirement();
  }

  function resynchronize(projectId: string, id: string) {
    const task = pending.get(id);
    if (!task) return;
    pending.delete(id);
    clearTimeout(task.timer);
    if (sent.get(projectId)?.id !== id) {
      task.reject(new DOMException("Superseded", "AbortError"));
    } else {
      sent.delete(projectId);
      received.delete(projectId);
      task.resync();
    }
  }

  function recordMemory(bytes = 0) {
    pressure ||= bytes > maxMemoryBytes;
  }

  function receiveEngine(data: Extract<CompilerReply, { type: string }>) {
    if (data.type === "module") {
      forgetModule();
      compiled = { key: data.compiler.sha256, module: data.module };
      moduleTimer = setTimeout(forgetModule, 5 * 60_000);
    } else if (data.error) failAll(new Error(data.error));
    else {
      readyCompiler = data.compiler.sha256;
      for (const task of preparations)
        task.finish(
          task.compiler === readyCompiler
            ? undefined
            : new Error("Compiler asset identity changed"),
        );
    }
  }

  function ensureWorker() {
    if (disposed) throw new DOMException("Compiler client disposed", "AbortError");
    clearTimeout(idleTimer);
    idleTimer = undefined;
    if (!worker) {
      const instance = createWorker();
      worker = instance;
      born = performance.now();
      for (const [projectId, destination] of destinations)
        connectDestination(projectId, destination);
      instance.onmessage = ({ data }: MessageEvent<CompilerReply>) => {
        if (worker !== instance || data.protocol !== PROTOCOL) return;
        if ("type" in data) return receiveEngine(data);
        if (!("projectId" in data) || !sent.has(data.projectId)) return;
        recordMemory(data.memoryBytes);
        if (!data.ok && data.failure === "source-resync") {
          resynchronize(data.projectId, data.id);
          return;
        }
        if (!data.ok && data.failure === "engine") {
          failAll(new Error(data.errors[0]?.text || "The compiler must restart."));
          return;
        }
        let result: CompileResult;
        if (data.ok) {
          if ("reference" in data) {
            if (pending.has(data.id))
              deliveries.set(data.projectId, sent.get(data.projectId)!.revision);
            received.delete(data.projectId);
            result = { ok: true, output: data.reference };
          } else {
            try {
              // Decode every emitted delta, even if its caller has stopped waiting.
              const next = applyProgramPatch(received.get(data.projectId), data.patch);
              received.set(data.projectId, next);
              result = { ok: true, output: next.program };
            } catch {
              resynchronize(data.projectId, data.id);
              return;
            }
          }
        } else result = { ok: false, errors: data.errors };
        const task = pending.get(data.id);
        if (!task) return;
        pending.delete(data.id);
        clearTimeout(task.timer);
        task.resolve(result);
        scheduleRetirement();
      };
      instance.onerror = () => {
        if (worker === instance) failAll(new Error("The compiler stopped. Run the project again."));
      };
    }
  }

  function prepare(projectId: string, compiler: Asset, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    ensureWorker();
    owners.add(projectId);

    const result = new Promise<void>((resolve, reject) => {
      if (readyCompiler === compiler.sha256) return resolve();
      if (readyCompiler) return reject(new Error("Compiler asset identity changed"));
      const abort = () => task.finish(signal.reason);

      const task = {
        projectId,
        compiler: compiler.sha256,
        finish(error?: unknown) {
          if (!preparations.delete(task)) return;
          signal.removeEventListener("abort", abort);
          if (error !== undefined) reject(error);
          else resolve();
        },
      };

      preparations.add(task);
      signal.addEventListener("abort", abort, { once: true });
    });

    // Warming is optional for callers that start it without awaiting completion.
    void result.catch(() => {});
    try {
      if (!prepared) {
        prepared = true;
        post({
          protocol: PROTOCOL,
          type: "prepare",
          projectId,
          compiler,
          module: cachedModule(compiler),
        });
      }
      scheduleRetirement();
    } catch (error) {
      failAll(error instanceof Error ? error : new Error(String(error)));
    }
    return result;
  }

  function connectDestination(
    projectId: string,
    destination: { generation: string; open(): MessagePort },
  ) {
    const port = destination.open();
    try {
      post(
        {
          protocol: PROTOCOL,
          type: "connect-preview",
          projectId,
          generation: destination.generation,
          port,
        },
        [port],
      );
    } catch (error) {
      port.close();
      throw error;
    }
  }

  routes.delivery = {
    opened(projectId, destination) {
      if (worker) connectDestination(projectId, destination);
    },
    acknowledge(projectId, revision) {
      if ((deliveries.get(projectId) ?? Infinity) <= revision) deliveries.delete(projectId);
    },
    ensure(projectId) {
      owners.add(projectId);
      ensureWorker();
      scheduleRetirement();
    },
    closed(projectId, generation) {
      deliveries.delete(projectId);
      post({ protocol: PROTOCOL, type: "disconnect-preview", projectId, generation });
    },
  };

  function setPriority(projectId: string, priority: CompilePriority) {
    if (owners.has(projectId)) post({ protocol: PROTOCOL, type: "priority", projectId, priority });
  }

  function compile(
    input: CompilerRequest,
    signal: AbortSignal,
    recovered = false,
  ): Promise<CompileResult> {
    if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    if (pressure && !pending.size && !deliveries.size && performance.now() - born >= minLifetimeMs)
      retireWorker();
    ensureWorker();
    owners.add(input.projectId);

    const id = crypto.randomUUID();
    const previous = sent.get(input.projectId);

    const operations =
      previous && input.edits?.baseRevision === previous.revision ? input.edits.changes : undefined;

    const files = operations
      ? undefined
      : Object.fromEntries(
          Object.entries(input.files).map(([path, source]) => [path, source.toString()]),
        );

    const changes =
      operations ??
      Object.fromEntries(
        [...new Set([...(previous?.paths || []), ...Object.keys(files!)])]
          .filter(
            (path) => !Object.hasOwn(files!, path) || previous?.files?.[path] !== files![path],
          )
          .map((path) => [path, sourceChange(previous?.files?.[path], files![path])]),
      );

    return new Promise((resolve, reject) => {
      const done = () => signal.removeEventListener("abort", cancel);

      const cancel = () => {
        const task = pending.get(id);
        if (!task) return;
        pending.delete(id);
        clearTimeout(task.timer);
        done();
        post({
          protocol: PROTOCOL,
          type: "cancel",
          projectId: input.projectId,
          id,
        });
        reject(new DOMException("Aborted", "AbortError"));
        scheduleRetirement();
      };

      signal.addEventListener("abort", cancel, { once: true });
      pending.set(id, {
        projectId: input.projectId,
        resolve: (result) => {
          done();
          resolve(result);
        },
        reject: (error) => {
          done();
          reject(error);
        },
        resync() {
          done();
          if (recovered) {
            reject(new Error("Project source resynchronization failed"));
            scheduleRetirement();
          } else resolve(compile(input, signal, true));
        },
        timer: setTimeout(
          () =>
            failAll(
              new Error("Compilation timed out. Run the project again to restart the compiler."),
            ),
          45_000,
        ),
      });
      // Explicit projection prevents UI assets from accidentally entering the seed.
      try {
        post({
          protocol: PROTOCOL,
          type: "compile",
          id,
          projectId: input.projectId,
          revision: input.revision,
          baseRevision: previous?.revision ?? null,
          changes,
          compiler: input.compiler,
          ...(!prepared ? { module: cachedModule(input.compiler) } : {}),
          priority: input.priority ?? "visible",
          ...(destinations.has(input.projectId) ? { delivery: "reference" as const } : {}),
          ...(!previous
            ? {
                seed: { files: input.seed.files, output: input.seed.output },
                config: input.config,
              }
            : {}),
        });
        sent.set(input.projectId, {
          id,
          revision: input.revision,
          files,
          paths: Object.keys(input.files),
        });
        prepared = true;
      } catch (error) {
        const task = pending.get(id);
        if (task) clearTimeout(task.timer);
        pending.delete(id);
        done();
        reject(error);
        scheduleRetirement();
      }
    });
  }

  return {
    compile,
    prepare,
    release,
    connectPreview: routes.connect.bind(routes),
    setPriority,
    dispose() {
      if (disposed) return;
      disposed = true;
      failAll(new DOMException("Compiler client disposed", "AbortError"));
      routes.dispose();
    },
  };
}
