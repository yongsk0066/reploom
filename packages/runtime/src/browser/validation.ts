import { createTypecheckClient, type TypecheckOptions } from "./typecheck-client.ts";
import { PreviewBridge } from "./preview-bridge.ts";
import type { Snapshot, TestResult } from "../shared/protocol.ts";
import type { createAssetRepository } from "../shared/assets.ts";
import type { Files } from "../project/definition.ts";

export function createValidationLane() {
  let busy = false;
  const queue: Array<{ start(): void }> = [];

  function pump() {
    if (!busy) queue.shift()?.start();
  }

  return <T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      if (queue.length >= 8) return reject(new Error("Validation queue is full"));

      const abort = () => {
        const index = queue.indexOf(task);
        if (index >= 0) queue.splice(index, 1);
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };

      const task = {
        start() {
          busy = true;
          void Promise.resolve()
            .then(() => {
              signal.throwIfAborted();
              return run();
            })
            .then(resolve, reject)
            .finally(() => {
              signal.removeEventListener("abort", abort);
              busy = false;
              pump();
            });
        },
      };

      signal.addEventListener("abort", abort, { once: true });
      queue.push(task);
      pump();
    });
}

export function createValidationServices(
  repository: ReturnType<typeof createAssetRepository>,
  options?: TypecheckOptions,
) {
  const checker = createTypecheckClient(repository, options);
  const lifetime = new AbortController();
  const types = createValidationLane();
  const tests = createValidationLane();
  return {
    types(files: Files, consumer: AbortSignal) {
      const signal = AbortSignal.any([consumer, lifetime.signal]);
      return types(() => checker.check(files, signal), signal);
    },
    tests(snapshot: Snapshot, paths: readonly string[], consumer: AbortSignal) {
      const signal = AbortSignal.any([consumer, lifetime.signal]);
      return tests(() => runIsolatedTests(snapshot, paths, signal), signal);
    },
    dispose() {
      lifetime.abort();
      checker.dispose();
    },
  };
}

export async function runIsolatedTests(
  snapshot: Snapshot,
  paths: readonly string[],
  signal: AbortSignal,
): Promise<TestResult[]> {
  signal.throwIfAborted();
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-10000px;top:0;width:800px;height:600px;contain:strict";
  host.setAttribute("aria-hidden", "true");
  host.inert = true;
  document.body.append(host);
  let bridge: PreviewBridge | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => reject(new Error("Isolated test preview timed out")), 15_000);
      bridge = new PreviewBridge(host, "Isolated tests", (event) => {
        if (event.type === "settled") {
          if (event.outcome === "error" || event.diagnostics.length)
            reject(new Error(event.diagnostics.map((d) => d.text).join("\n")));
          else resolve();
        } else if (event.type === "runtime-error")
          reject(new Error(event.diagnostics.map((d) => d.text).join("\n")));
      });
      bridge.update({
        ...snapshot,
        projectId: undefined,
        generation: crypto.randomUUID(),
        state: undefined,
      });
    });
    clearTimeout(timer);
    return (await bridge!.inspect({ operation: "tests", paths }, signal)).tests!;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    await bridge?.dispose(false);
    host.remove();
  }
}
