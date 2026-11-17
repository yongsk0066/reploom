import { validateManagedState, type ManagedState } from "../project/snapshot.ts";
import { createFactoryEvaluator } from "./factory-evaluator.ts";
import {
  PROTOCOL,
  applyProgramPatch,
  errorDiagnostics,
  type Diagnostic,
  type ExecutionOutcome,
  type PreviewCommand,
  type PreviewReply,
  type VersionedProgram,
} from "../shared/protocol.ts";
import type { Styles } from "./module-runtime.ts";
import type { PreviewExecution } from "./adapters/policy.ts";
import { createRealmResources, type RealmResources } from "./resources.ts";
import { ArtifactUnavailable, createArtifactReceiver } from "../shared/artifact-channel.ts";

function format(value: unknown, depth = 0): string {
  if (typeof value === "string") return value.slice(0, 2000);
  if (value === null || typeof value !== "object") return String(value).slice(0, 2000);
  if (depth > 1) return Array.isArray(value) ? "[…]" : "{…}";
  try {
    return (
      "{" +
      Object.entries(Object.getOwnPropertyDescriptors(value))
        .slice(0, 12)
        .map(
          ([key, desc]) =>
            `${key}: ${"value" in desc ? format(desc.value, depth + 1) : "[Getter]"}`,
        )
        .join(", ") +
      "}"
    );
  } catch {
    return "[Object]";
  }
}

function recoveryFrom(error: unknown): { requiresRestart: boolean; state?: ManagedState } {
  if (
    !error ||
    typeof error !== "object" ||
    !("requiresRestart" in error) ||
    !error.requiresRestart
  )
    return { requiresRestart: false };
  if ("state" in error && error.state) {
    try {
      return { requiresRestart: true, state: validateManagedState(error.state as ManagedState) };
    } catch {
      /* Invalid user state cannot cross the recovery boundary. */
    }
  }
  return { requiresRestart: true };
}

const initialize = (event: MessageEvent) => {
  if (
    event.source !== parent ||
    event.data?.type !== "playground:init" ||
    event.data.protocol !== PROTOCOL ||
    typeof event.data.generation !== "string" ||
    event.ports.length !== 1
  )
    return;
  removeEventListener("message", initialize);

  const generation: string = event.data.generation;
  const port = event.ports[0];

  let resources: RealmResources | undefined;
  const artifacts = createArtifactReceiver();
  let fetching = false;
  let evaluator = createFactoryEvaluator(document, generation);
  let received: VersionedProgram | undefined;
  let revision = -1;
  let running = false;
  let closed = false;
  let failed = false;
  let reports = 0;
  let budgetFaults = 0;
  let execution: PreviewExecution | undefined;
  const styles = new Map<string, HTMLStyleElement>();
  const styleAnchor = document.createComment("playground styles");
  document.head.append(styleAnchor);

  type Payload<T> = T extends unknown ? Omit<T, "protocol" | "generation"> : never;

  const send = (message: Payload<PreviewReply>) => {
    if (!closed) port.postMessage({ ...message, protocol: PROTOCOL, generation });
  };

  const reportError = (error: unknown) => {
    error = execution?.normalizeError?.(error) ?? error;
    failed = true;
    const budgetFault = error instanceof Error && error.name === "ExecutionBudgetError";
    // Repeated unhandled faults can come from an untracked interval/animation.
    // Retire that realm so obsolete callbacks cannot defeat editor recovery.
    const requiresRestart = budgetFault && ++budgetFaults >= 2;
    send({
      type: "runtime-error",
      revision,
      diagnostics: evaluator.debug.locate(errorDiagnostics(error)),
      requiresRestart,
    });
    return budgetFault;
  };

  const onError = (event: ErrorEvent) => {
    if (reportError(event.error || event.message)) event.preventDefault();
  };

  const onRejection = (event: PromiseRejectionEvent) => {
    if (reportError(event.reason)) event.preventDefault();
  };

  addEventListener("error", onError);
  addEventListener("unhandledrejection", onRejection);

  const originals = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };

  for (const level of ["log", "warn", "error"] as const)
    console[level] = (...args: unknown[]) => {
      if (closed || reports++ >= 100) return;

      const text = `[${level}] ${args
        .slice(0, 12)
        .map((value) => format(value))
        .join(" ")}`.slice(0, 4000);

      originals[level].call(console, text);
      send({ type: "console", revision, text });
    };

  const updateStyles = (list: Styles) => {
    const keep = new Set(list.map((item) => item.id));
    for (const [id, element] of styles)
      if (!keep.has(id)) {
        element.remove();
        styles.delete(id);
      }
    let cursor = styleAnchor.nextSibling;
    for (const item of list) {
      let element = styles.get(item.id);
      if (!element) {
        element = document.createElement("style");
        styles.set(item.id, element);
      }
      if (element.textContent !== item.code) element.textContent = item.code;
      if (cursor !== element) document.head.insertBefore(element, cursor);
      cursor = element.nextSibling;
    }
  };

  const execute = async (data: Extract<PreviewCommand, { type: "initialize" | "apply" }>) => {
    if (running) return; // The bridge sends one revision at a time.
    let next: VersionedProgram;
    try {
      next = applyProgramPatch(received, data.patch);
    } catch {
      send({ type: "resync" });
      return;
    }
    if (received && next.revision <= received.revision && data.patch.baseRevision !== null) return;
    received = next;
    revision = next.revision;
    running = true;
    reports = 0;
    const recovering = failed;
    failed = false;
    let outcome: ExecutionOutcome = "error";
    let diagnostics: Diagnostic[] = [];
    let requiresRestart = false;
    let state: ManagedState | undefined;
    try {
      if (!execution) {
        if (data.type !== "initialize") {
          throw new Error("The preview needs to restart. Run the project again.");
        }
        // The compute adapter owns its primary Worker; user code and its nested
        // Worker quota live inside that Worker's own resource scope.
        resources = createRealmResources(
          next.program.resources,
          data.assets,
          next.program.runtime !== "compute",
        );
        evaluator = createFactoryEvaluator(document, generation, resources);
        await evaluator.runAll(data.vendor);
        const vendor = globalThis.__PLAYGROUND_VENDOR__;
        if (vendor.kind !== next.program.runtime) throw new Error("Runtime adapter mismatch.");
        execution = vendor.createExecution(document.getElementById("root")!, {
          initial: next.program,
          state: data.state,
          loadFactory: evaluator.load,
          updateStyles,
          reportError,
          worker: data.worker,
          assets: data.assets,
          resources: resources.access,
          onConsole: (text) => send({ type: "console", revision, text }),
          onInvalidate: (id) => send({ type: "invalidate", revision, id }),
          onDiagnostic: (errors) =>
            send({
              type: "runtime-error",
              revision,
              diagnostics: evaluator.debug.locate(errors),
              requiresRestart: false,
            }),
        });
      }
      evaluator.debug.update(next.program, revision);
      const result = await execution.apply(next.program, recovering, revision);
      evaluator.debug.commit(next.program);
      if (closed) return;
      diagnostics = evaluator.debug.locate(result.diagnostics);
      outcome = result.outcome;
      if (failed) outcome = "error";
      else budgetFaults = 0;
    } catch (error) {
      diagnostics = evaluator.debug.locate(errorDiagnostics(error));
      evaluator.debug.rollback();
      failed = true;
      const recovery = recoveryFrom(error);
      requiresRestart = !execution || recovery.requiresRestart;
      state = recovery.state;
    } finally {
      running = false;
      send({
        type: "settled",
        revision,
        outcome,
        diagnostics,
        requiresRestart,
        state,
      });
    }
  };

  const dispose = async () => {
    if (closed) return;
    closed = true;
    artifacts.dispose();
    const diagnostics: Diagnostic[] = [];
    try {
      diagnostics.push(...((await execution?.dispose()) || []));
    } catch (error) {
      diagnostics.push(...errorDiagnostics(error, "cleanup"));
    }
    resources?.dispose();
    evaluator.dispose();
    resources = undefined;
    for (const element of styles.values()) element.remove();
    styles.clear();
    styleAnchor.remove();
    removeEventListener("error", onError);
    removeEventListener("unhandledrejection", onRejection);
    Object.assign(console, originals);
    port.postMessage({
      protocol: PROTOCOL,
      generation,
      type: "disposed",
      diagnostics,
    } satisfies PreviewReply);
    port.close();
  };

  const executeReference = async (data: Extract<PreviewCommand, { type: "apply-reference" }>) => {
    if (fetching || running || closed) return;
    fetching = true;
    try {
      const patch = await artifacts.get(data.revision, received?.revision ?? null);
      if (closed) return;
      if (
        patch.projectKey !== data.reference.projectKey ||
        patch.compilerVersion !== data.reference.compilerVersion
      )
        throw new Error("Artifact identity does not match the authorized revision");
      const envelope = { protocol: PROTOCOL, generation, patch };
      await execute(
        data.initialize
          ? { ...envelope, type: "initialize", ...data.initialize }
          : { ...envelope, type: "apply" },
      );
    } catch (error) {
      if (closed) return;
      if (error instanceof ArtifactUnavailable && error.reason === "missing")
        send({ type: "request-program", revision: data.revision });
      else
        send({
          type: "settled",
          revision: data.revision,
          outcome: error instanceof ArtifactUnavailable ? "cancelled" : "error",
          diagnostics: error instanceof ArtifactUnavailable ? [] : errorDiagnostics(error),
          requiresRestart: !(error instanceof ArtifactUnavailable),
        });
    } finally {
      fetching = false;
    }
  };

  port.onmessage = ({ data, ports }: MessageEvent<PreviewCommand>) => {
    if (closed || data?.protocol !== PROTOCOL || data.generation !== generation) return;
    if (data.type === "dispose") void dispose();
    else if (data.type === "inspect") {
      void (async () => {
        try {
          if (running || fetching || failed || !execution || data.revision !== revision)
            throw new Error("Inspection requires the settled revision");
          const result = await execution.inspect(data.request);
          if (!closed && data.revision === revision)
            send({ type: "inspection", id: data.id, revision, result });
        } catch (error) {
          send({
            type: "inspection",
            id: data.id,
            revision: data.revision,
            result: { diagnostics: errorDiagnostics(error) },
          });
        }
      })();
    } else if (data.type === "connect-artifacts" && ports.length === 1) artifacts.connect(ports[0]);
    else if (data.type === "apply-reference") void executeReference(data);
    else if (data.type === "cancel" && data.revision === revision) execution?.cancel?.();
    else if (data.type === "apply" || data.type === "initialize") void execute(data);
  };
  send({ type: "ready" });
};

addEventListener("message", initialize);
