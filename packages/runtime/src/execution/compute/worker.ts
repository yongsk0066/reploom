import { createModuleRuntime, RuntimeUpdateError } from "../module-runtime.ts";
import { createModulePolicy } from "../adapters/policy.ts";
import { createWorkerEvaluator } from "../factory-evaluator.ts";
import { createRealmResources, type RealmResources } from "../resources.ts";
import { createTaskScheduler } from "../../shared/scheduling.ts";
import {
  applyProgramPatch,
  errorDiagnostics,
  type Diagnostic,
  type VersionedProgram,
} from "../../shared/protocol.ts";
import type { ManagedState } from "../../project/snapshot.ts";
import { displayValue, type ComputeCommand, type ComputeReply } from "./protocol.ts";

export type ComputeContext = {
  state: Record<string, unknown>;
  signal: AbortSignal;
  report(value: unknown): void;
};

type Run = (context: ComputeContext) => unknown | Promise<unknown>;

let received: VersionedProgram | undefined;
let runtime: ReturnType<typeof createModuleRuntime> | undefined;
let resources: RealmResources | undefined;
let evaluator: ReturnType<typeof createWorkerEvaluator> | undefined;
let active: AbortController | undefined;
let previous: Run | undefined;
let busy = false;
let closed = false;
let jobId = "";
let logs = 0;
let resultText = "";
let lastProgress = -Infinity;
const state: Record<string, unknown> = Object.create(null);
const scheduler = createTaskScheduler();

const send = (message: ComputeReply) => {
  if (!closed) postMessage(message);
};

const fatal = (error: unknown) => send({ type: "fatal", diagnostics: errorDiagnostics(error) });
addEventListener("error", (event) => {
  event.preventDefault();
  fatal(event.error || event.message);
});
addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  fatal(event.reason);
});
for (const level of ["log", "warn", "error"] as const)
  console[level] = (...args) => {
    if (logs++ < 50)
      send({
        type: "log",
        id: jobId,
        text: `[${level}] ${displayValue(args).slice(0, 4000)}`,
      });
  };

async function execute(command: Extract<ComputeCommand, { type: "run" }>) {
  if (closed || busy) return;
  busy = true;
  jobId = command.id;
  logs = 0;
  lastProgress = -Infinity;
  let diagnostics: Diagnostic[] = [];
  let ok = false;
  let recoveredState: ManagedState | undefined;
  try {
    received = applyProgramPatch(received, command.patch);
    if (!runtime) {
      resources = createRealmResources(received.program.resources, command.assets);
      evaluator = createWorkerEvaluator(resources);
      if (received.program.runtime !== "compute") throw new Error("A compute project is required.");
      const policy = createModulePolicy(globalThis.__PLAYGROUND_VENDOR__.dependencies);
      policy.validateEntry = (entry) => {
        if (typeof entry.run !== "function")
          throw new Error("The compute entry must export run(context).");
      };
      runtime = createModuleRuntime(
        policy,
        evaluator.load,
        (moduleId) => send({ type: "invalidate", moduleId }),
        (diagnostics) => send({ type: "diagnostic", diagnostics }),
        {
          yieldTask: scheduler.yieldTask,
          budgetMs: 8,
        },
        resources.access,
        command.state,
      );
    }
    evaluator!.debug.update(received.program, received.revision);
    const applied = await runtime.apply(received.program, () => {});
    evaluator!.debug.commit(received.program);
    diagnostics = applied.diagnostics;
    const run = applied.entry.run as Run;
    if (run !== previous || applied.evaluated.length) {
      const controller = (active = new AbortController());
      let lastReport: unknown;
      let reported = false;
      resultText = "";

      const value = await run({
        state,
        signal: controller.signal,
        report(value) {
          if (controller.signal.aborted || closed) return;
          reported = true;
          lastReport = value;
          const now = performance.now();
          if (now - lastProgress < 50) return;
          lastProgress = now;
          resultText = displayValue(value);
          send({ type: "progress", id: command.id, text: resultText });
        },
      });

      if (value !== undefined) resultText = displayValue(value);
      else if (reported) resultText = displayValue(lastReport);
      lastReport = undefined;
      previous = run;
    }
    ok = true;
  } catch (error) {
    previous = undefined;
    diagnostics = evaluator?.debug.locate(errorDiagnostics(error)) ?? errorDiagnostics(error);
    evaluator?.debug.rollback();
    if (error instanceof RuntimeUpdateError) recoveredState = error.state;
  } finally {
    // Registered per-run resources can observe completion as well as disposal.
    try {
      active?.abort();
    } catch (error) {
      diagnostics.push(...errorDiagnostics(error, "cleanup"));
    }
    active = undefined;
    busy = false;
    send({
      type: "settled",
      id: command.id,
      ok,
      text: resultText,
      diagnostics,
      state: recoveredState,
    });
  }
}

async function dispose() {
  if (closed) return;
  active?.abort();
  const diagnostics = (await runtime?.dispose()) || [];
  resources?.dispose();
  evaluator?.dispose();
  resources = undefined;
  previous = undefined;
  for (const key of Object.keys(state)) delete state[key];
  send({ type: "disposed", diagnostics });
  closed = true;
  scheduler.dispose();
  close();
}

addEventListener("message", ({ data }: MessageEvent<ComputeCommand>) => {
  if (data?.type === "run") void execute(data);
  else if (data?.type === "inspect") {
    void (async () => {
      try {
        if (busy || !runtime) throw new Error("Compute inspection requires a settled revision");

        const result =
          data.request.operation === "state"
            ? { state: runtime.captureState(), diagnostics: [] }
            : { tests: await runtime.test(data.request.paths), diagnostics: [] };

        send({
          type: "inspection",
          id: data.id,
          result: evaluator?.debug.inspect(result) ?? result,
        });
      } catch (error) {
        send({ type: "inspection", id: data.id, result: { diagnostics: errorDiagnostics(error) } });
      }
    })();
  } else if (data?.type === "ping") send({ type: "pong", id: data.id });
  else if (data?.type === "dispose") void dispose();
});
send({ type: "ready" });
