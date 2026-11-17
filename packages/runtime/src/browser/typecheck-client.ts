import type { createAssetRepository } from "../shared/assets.ts";
import type { Files } from "../project/definition.ts";
import type { Diagnostic } from "../shared/protocol.ts";

type TypecheckReply = {
  protocol: 1;
  id: number;
  ready?: boolean;
  diagnostics?: Diagnostic[];
  memoryBytes?: number;
  error?: string;
};

export type TypecheckOptions = {
  idleMs?: number;
  timeoutMs?: number;
  maxMemoryBytes?: number;
  createWorker?: (url: string) => Worker;
};

/** A bounded lease retains immutable checker inputs; cancellation retires the active realm. */
export function createTypecheckClient(
  repository: ReturnType<typeof createAssetRepository>,
  options: TypecheckOptions = {},
) {
  let worker: Worker | undefined;
  let url: string | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;
  let disposed = false;
  const lifetime = new AbortController();

  function retire() {
    clearTimeout(idle);
    worker?.terminate();
    worker = undefined;
    if (url) URL.revokeObjectURL(url);
    url = undefined;
  }

  function exchange(
    message: object,
    signal: AbortSignal,
    transfer: Transferable[] = [],
  ): Promise<TypecheckReply> {
    signal.throwIfAborted();
    const current = worker!;
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => fail(new DOMException("Type checking exceeded its execution budget", "TimeoutError")),
        options.timeoutMs ?? 30_000,
      );

      const clear = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        current.onmessage = null;
        current.onerror = null;
        current.onmessageerror = null;
      };

      const fail = (error: unknown) => {
        clear();
        retire();
        reject(error);
      };

      const abort = () => fail(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      current.onerror = (event) => fail(new Error(event.message));
      current.onmessageerror = () => fail(new Error("Invalid type checker reply"));
      current.onmessage = ({ data }) => {
        if (data?.protocol !== 1 || data.id !== id)
          return fail(new Error("Type checker revision mismatch"));
        if (data.error) return fail(new Error(data.error));
        clear();
        resolve(data);
      };
      try {
        current.postMessage({ protocol: 1, id, ...message }, transfer);
      } catch (error) {
        fail(error);
      }
    });
  }

  return {
    async check(files: Files, consumer: AbortSignal): Promise<Diagnostic[]> {
      if (disposed) throw new DOMException("Type checker disposed", "AbortError");
      const operation = new AbortController();
      const signal = AbortSignal.any([consumer, lifetime.signal, operation.signal]);
      signal.throwIfAborted();
      clearTimeout(idle);
      try {
        if (!worker) {
          const manifest = await repository.loadManifest(signal);
          const spec = manifest.typecheck;
          if (!spec) throw new Error("Type checking was not prepared for this site");

          const [source, configuration, wasm] = await Promise.all([
            repository.loadAsset(spec.worker, signal),
            repository.loadBinaryAsset({ ...spec.configuration, type: "application/json" }, signal),
            repository.loadBinaryAsset({ ...spec.wasm, type: "application/wasm" }, signal),
          ]);

          signal.throwIfAborted();
          url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
          worker = options.createWorker
            ? options.createWorker(url)
            : new Worker(url, { type: "module", name: "reploom-typecheck" });
          const bytes = wasm.bytes.slice();
          const config = configuration.bytes.slice();

          const ready = await exchange(
            { type: "initialize", wasm: bytes, configuration: config },
            signal,
            [bytes.buffer, config.buffer],
          );

          if (!ready.ready) throw new Error("Type checker initialization failed");
        }
        const result = await exchange({ type: "check", files }, signal);
        if (!Array.isArray(result.diagnostics) || !Number.isSafeInteger(result.memoryBytes))
          throw new Error("Invalid type checker result");
        if (
          result.memoryBytes! > (options.maxMemoryBytes ?? 128 * 1024 * 1024) ||
          options.idleMs === 0
        )
          retire();
        else idle = setTimeout(retire, options.idleMs ?? 5_000);
        return result.diagnostics;
      } catch (error) {
        retire();
        throw error;
      } finally {
        operation.abort();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      retire();
    },
  };
}
