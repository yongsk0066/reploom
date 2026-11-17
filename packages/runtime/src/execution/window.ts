import { createExecutionBudget } from "./budget.ts";
import { createModuleRuntime } from "./module-runtime.ts";
import { createTaskScheduler } from "../shared/scheduling.ts";
import { errorDiagnostics, type Diagnostic } from "../shared/protocol.ts";
import type { ExecutionEnvironment, PreviewExecution, RuntimeAdapter } from "./adapters/policy.ts";

export function createWindowExecution(
  adapter: RuntimeAdapter,
  environment: ExecutionEnvironment,
): PreviewExecution {
  if (environment.initial.execution.mode !== "window")
    throw new Error("A Window execution budget is required.");
  const budget = createExecutionBudget(environment.initial.execution.taskMs);
  const scheduler = createTaskScheduler();

  const runtime = createModuleRuntime(
    adapter.modules,
    environment.loadFactory,
    environment.onInvalidate,
    environment.onDiagnostic,
    {
      yieldTask: scheduler.yieldTask,
      budgetMs: 8,
      checkpoint: budget.checkpoint,
      beforeCleanup: budget.beforeCleanup,
    },
    environment.resources,
    environment.state,
  );

  return {
    async inspect(request) {
      return request.operation === "state"
        ? { state: runtime.captureState(), diagnostics: [] }
        : {
            tests: await runtime.test(request.paths, document.getElementById("root")!),
            diagnostics: [],
          };
    },
    normalizeError: budget.normalizeError,
    async apply(program, recovering) {
      const result = await runtime.apply(program, environment.updateStyles);
      return {
        outcome: await adapter.render(result, recovering),
        diagnostics: result.diagnostics,
      };
    },
    async dispose() {
      const diagnostics: Diagnostic[] = [];
      try {
        await budget.beforeCleanup();
        try {
          await adapter.dispose();
        } catch (error) {
          diagnostics.push(...errorDiagnostics(error, "cleanup"));
        }
        try {
          diagnostics.push(...(await runtime.dispose()));
        } catch (error) {
          diagnostics.push(...errorDiagnostics(error, "cleanup"));
        }
        return diagnostics;
      } finally {
        budget.dispose();
        scheduler.dispose();
      }
    },
  };
}
