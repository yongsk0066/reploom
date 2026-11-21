import {
  diffProgram,
  errorDiagnostics,
  type Compilation,
  type Diagnostic,
  type VersionedProgram,
  type InspectionResult,
} from "../../shared/protocol.ts";
import { defaultComputeLabels, type ComputeLabels } from "../../shared/presentation.ts";
import { validateManagedState } from "../../project/snapshot.ts";
import { RuntimeUpdateError } from "../module-runtime.ts";
import type { ComputeCommand, ComputeReply } from "./protocol.ts";
import type {
  ExecutionEnvironment,
  ExecutionResult,
  PreviewExecution,
} from "../adapters/policy.ts";

type Job = {
  id: string;
  next: VersionedProgram;
  resolve(result: ExecutionResult): void;
  reject(error: unknown): void;
};

export function createComputeExecution(
  container: HTMLElement,
  environment: ExecutionEnvironment,
): PreviewExecution {
  if (!environment.worker?.length) throw new Error("Compute Worker assets are required.");
  const limits = environment.initial.execution;
  if (limits.mode !== "worker") throw new Error("A Worker execution budget is required.");
  const timeoutMs = limits.timeoutMs;

  const status = document.createElement("p");
  const output = document.createElement("pre");
  const stop = document.createElement("button");

  status.setAttribute("role", "status");
  let labels = environment.computeLabels ?? defaultComputeLabels;
  let message: "stopped" | "complete" | "failed" | "cancelled" | "computing" | undefined;

  function show(key: NonNullable<typeof message>) {
    message = key;
    status.textContent = labels[key];
  }

  function setComputeLabels(next?: ComputeLabels) {
    labels = next ?? defaultComputeLabels;
    output.setAttribute("aria-label", labels.output);
    stop.textContent = labels.stop;
    if (message) show(message);
  }

  setComputeLabels(labels);
  stop.type = "button";

  stop.disabled = true;
  container.append(status, stop, output);
  container.style.cssText = "font:14px/1.6 system-ui;padding:20px;overflow-wrap:anywhere";
  output.style.cssText = "white-space:pre-wrap;max-height:320px;overflow:auto";
  let worker: Worker | undefined;
  let restoration = environment.state;
  let url: string | undefined;
  let ready = false;
  let closed = false;
  let revision = 0;
  let lastId = "";
  let acknowledged: VersionedProgram | undefined;
  let job: Job | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pingSequence = 0;
  let pendingPing: number | undefined;
  let finishDispose: ((diagnostics: Diagnostic[]) => void) | undefined;
  let inspection:
    | { id: string; finish(result?: InspectionResult, error?: unknown): void }
    | undefined;

  function release() {
    inspection?.finish(undefined, new Error("Compute Worker retired"));
    clearTimeout(timer);
    pendingPing = undefined;
    worker?.terminate();
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
    }
    worker = undefined;
    if (url) URL.revokeObjectURL(url);
    url = undefined;
    ready = false;
    acknowledged = undefined;
  }

  function fail(diagnostics: Diagnostic[]) {
    const pending = job;
    job = undefined;
    restoration = undefined;
    release();
    // release() clears the timeout too; settle a graceful shutdown if its
    // Worker crashed instead of leaving the shutdown Promise pending.
    finishDispose?.(diagnostics);
    show("stopped");
    stop.disabled = true;
    const error = new RuntimeUpdateError(diagnostics, false);
    if (pending) pending.reject(error);
    else if (!closed) environment.reportError(error);
  }

  function monitorIdle() {
    clearTimeout(timer);
    pendingPing = undefined;
    // No timer inside the Worker, no polling in user hot loops. One round trip
    // per idle interval detects unmanaged callbacks after run() has returned.
    timer = setTimeout(
      () => {
        if (closed || job || !worker) return;
        if (document.visibilityState !== "visible") return monitorIdle();
        const id = (pendingPing = ++pingSequence);
        worker.postMessage({ type: "ping", id } satisfies ComputeCommand);
        timer = setTimeout(() => {
          if (closed || job || pendingPing !== id) return;
          // Background timer throttling is not evidence of a hung Worker.
          if (document.visibilityState !== "visible") return monitorIdle();
          fail([
            {
              text: "Worker became unresponsive after completion and was terminated. Clean up pending timers and asynchronous tasks.",
            },
          ]);
        }, timeoutMs);
      },
      Math.max(500, timeoutMs / 2),
    );
  }

  function dispatch() {
    if (!worker || !ready || !job) return;
    clearTimeout(timer);
    pendingPing = undefined;
    const current = job;
    timer = setTimeout(() => {
      if (job !== current) return;
      fail([
        {
          text: `Computation exceeded the ${timeoutMs}ms time limit. The Worker was terminated and its state was reset.`,
        },
      ]);
    }, timeoutMs);
    worker.postMessage({
      type: "run",
      id: current.id,
      patch: diffProgram(acknowledged, current.next),
      ...(!acknowledged ? { assets: environment.assets, state: restoration } : {}),
    } satisfies ComputeCommand);
    restoration = undefined;
  }

  function settleJob(data: Extract<ComputeReply, { type: "settled" }>) {
    const pending = job!;
    job = undefined;
    clearTimeout(timer);
    acknowledged = pending.next;
    stop.disabled = true;
    if (data.ok) {
      show("complete");
      output.textContent = data.text.slice(0, 32_000);
      pending.resolve({
        outcome: "computed",
        diagnostics: data.diagnostics.length
          ? errorDiagnostics({ diagnostics: data.diagnostics })
          : [],
      });
      monitorIdle();
    } else {
      // A failed computation may have untracked tasks. Retire the Worker
      // so editing/recovery cannot revive them; keep the host/editor alive.
      release();
      restoration = data.state ? validateManagedState(data.state) : undefined;
      show("failed");
      pending.reject(
        new RuntimeUpdateError(errorDiagnostics({ diagnostics: data.diagnostics }), false),
      );
    }
  }

  function receive(data: ComputeReply) {
    switch (data.type) {
      case "inspection":
        if (inspection?.id === data.id) inspection.finish(data.result);
        return;
      case "pong":
        if (!job && data.id === pendingPing) monitorIdle();
        return;
      case "ready":
        if (ready) return;
        ready = true;
        dispatch();
        return;
      case "fatal":
        fail(errorDiagnostics({ diagnostics: data.diagnostics }));
        return;
      case "diagnostic":
        environment.onDiagnostic(errorDiagnostics({ diagnostics: data.diagnostics }));
        return;
      case "invalidate":
        if (typeof data.moduleId === "string") environment.onInvalidate(data.moduleId);
        return;
      case "log":
        if (data.id === lastId && typeof data.text === "string")
          environment.onConsole(data.text.slice(0, 4000));
        return;
      case "progress":
        if (job && data.id === job.id && typeof data.text === "string")
          output.textContent = data.text.slice(0, 32_000);
        return;
      case "settled":
        if (
          job &&
          data.id === job.id &&
          typeof data.text === "string" &&
          typeof data.ok === "boolean" &&
          Array.isArray(data.diagnostics)
        )
          settleJob(data);
    }
  }

  function start() {
    url = URL.createObjectURL(new Blob([...environment.worker!], { type: "text/javascript" }));
    const owned = (worker = new Worker(url, { name: "reploom-compute" }));
    timer = setTimeout(() => fail([{ text: "Could not start the compute Worker." }]), 5000);
    owned.onerror = (event) => {
      event.preventDefault();
      if (worker === owned) fail([{ text: event.message || "Compute Worker error" }]);
    };
    owned.onmessage = ({ data }: MessageEvent<ComputeReply>) => {
      if (worker !== owned || !data || typeof data !== "object") return;
      if (data?.type === "disposed") {
        finishDispose?.(data.diagnostics);
        return;
      }
      if (closed) return;
      receive(data);
    };
  }

  function cancel() {
    const pending = job;
    job = undefined;
    release();
    stop.disabled = true;
    show("cancelled");
    pending?.resolve({ outcome: "cancelled", diagnostics: [] });
  }

  stop.addEventListener("click", cancel);
  return {
    setComputeLabels,
    inspect(request) {
      if (!worker || job || closed || inspection)
        return Promise.reject(new Error("Compute inspection requires an idle Worker"));
      const id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => inspection?.finish(undefined, new Error("Compute inspection timed out")),
          timeoutMs,
        );

        inspection = {
          id,
          finish(result, error) {
            clearTimeout(timer);
            inspection = undefined;
            if (error) reject(error);
            else resolve(result!);
          },
        };
        worker!.postMessage({ type: "inspect", id, request } satisfies ComputeCommand);
      });
    },
    apply(program: Compilation, _recovering, sourceRevision) {
      if (closed) return Promise.reject(new Error("The compute preview is disposed."));
      if (job) cancel();
      show("computing");
      stop.disabled = false;
      return new Promise((resolve, reject) => {
        job = {
          id: crypto.randomUUID(),
          next: { revision: sourceRevision ?? ++revision, program },
          resolve,
          reject,
        };
        lastId = job.id;
        try {
          if (!worker) start();
          else dispatch();
        } catch (error) {
          fail([{ text: String(error) }]);
        }
      });
    },
    cancel,
    async dispose() {
      closed = true;
      clearTimeout(timer);
      pendingPing = undefined;
      stop.removeEventListener("click", cancel);
      if (job) {
        cancel();
        container.replaceChildren();
        return [];
      }

      const diagnostics = worker
        ? await new Promise<Diagnostic[]>((resolve) => {
            finishDispose = resolve;
            timer = setTimeout(() => resolve([]), 200);
            worker!.postMessage({ type: "dispose" } satisfies ComputeCommand);
          })
        : [];

      finishDispose = undefined;
      release();
      container.replaceChildren();
      return diagnostics;
    },
  };
}
