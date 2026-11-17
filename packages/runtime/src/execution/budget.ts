import type { Diagnostic } from "../shared/protocol.ts";

export class ExecutionBudgetError extends Error {
  readonly diagnostics: Diagnostic[];

  constructor(milliseconds: number, file: string) {
    super(
      `Synchronous execution budget of ${milliseconds}ms exceeded. Move long computations to a Worker or split the work into tasks.`,
    );
    this.name = "ExecutionBudgetError";
    this.diagnostics = [{ text: this.message, file, phase: "evaluation" }];
  }
}

// A turn includes its microtasks. Reset only from a real task, never at function
// return or await: resolved-Promise loops must not receive unlimited new budgets.
export function createExecutionBudget(
  milliseconds: number,
  clock: () => number = performance.now.bind(performance),
) {
  const channel = new MessageChannel();
  const waiting = new Set<() => void>();
  let active = false;
  let closed = false;
  let deadline = 0;
  let steps = 0;
  let exceeded: ExecutionBudgetError | undefined;

  const reset = () => {
    active = false;
    exceeded = undefined;
    steps = 0;
    for (const resolve of waiting) resolve();
    waiting.clear();
  };

  channel.port1.onmessage = reset;
  const stopped = new Error("Execution has ended.");
  return {
    // WebKit can redact an opaque frame's ErrorEvent to "Script error.".
    // Keep the owned failure for this turn only, without parsing that message.
    normalizeError(error: unknown): unknown {
      return exceeded || error;
    },
    checkpoint(file: string) {
      if (closed) throw stopped;
      if (exceeded) throw exceeded;
      if (!active) {
        active = true;
        deadline = clock() + milliseconds;
        channel.port2.postMessage(null);
      }
      // Avoid a clock read on every loop iteration. This is a cooperative
      // budget, not a preemptive upper bound on native calls or OS scheduling.
      if ((++steps & 63) !== 0) return;
      if (clock() >= deadline) {
        exceeded = new ExecutionBudgetError(milliseconds, file);
        throw exceeded;
      }
    },
    beforeCleanup(): Promise<void> {
      return exceeded && !closed
        ? new Promise((resolve) => waiting.add(resolve))
        : Promise.resolve();
    },
    dispose() {
      closed = true;
      channel.port1.onmessage = null;
      channel.port1.close();
      channel.port2.close();
      reset();
    },
  };
}
