import { createTaskScheduler } from "../shared/scheduling.ts";
import { createCompilerService } from "./service.ts";
import { createArtifactPublisher } from "../shared/artifact-channel.ts";
import {
  PROTOCOL,
  diffProgram,
  type VersionedProgram,
  type CompilerWorkerCommand,
  type CompilerReply,
  type CompileCommand,
} from "../shared/protocol.ts";
import type { TransformEngine } from "./project-compiler.ts";

export function startCompilerWorker(
  load: (
    command: Pick<CompileCommand, "compiler" | "module">,
    options: { yieldTask(): Promise<void> },
  ) => Promise<TransformEngine & { module: WebAssembly.Module }>,
) {
  const worker = self as unknown as {
    onmessage: ((event: MessageEvent<CompilerWorkerCommand>) => void) | null;
    postMessage(data: CompilerReply): void;
  };

  const scheduler = createTaskScheduler();

  let engine: Promise<TransformEngine> | undefined;
  let identity: string | undefined;
  let activeEngine: TransformEngine | undefined;
  const inline = new Map<string, VersionedProgram>();

  const service = createCompilerService({
    now: () => performance.now(),
    yieldTask: scheduler.yieldTask,
    reply(data, output, delivery) {
      if ("id" in data) data = { ...data, memoryBytes: activeEngine?.memoryBytes?.() };
      if ("projectId" in data) {
        if (data.ok && output) {
          if (delivery === "reference") {
            inline.delete(data.projectId);
            worker.postMessage(data);
          } else {
            worker.postMessage({
              protocol: PROTOCOL,
              projectId: data.projectId,
              id: data.id,
              ok: true,
              memoryBytes: activeEngine?.memoryBytes?.(),
              patch: diffProgram(inline.get(data.projectId), output),
            });
            inline.set(data.projectId, output);
          }
          return;
        }
      }
      worker.postMessage(data);
    },
    loadEngine(command) {
      const asset = command.compiler;
      if (identity && identity !== asset.sha256)
        return Promise.reject(new Error("Compiler asset identity changed"));
      identity = asset.sha256;
      return (engine ??= Promise.resolve()
        .then(() => load(command, { yieldTask: scheduler.yieldTask }))
        .then((loaded) => {
          // Only immutable code crosses this boundary. The Instance, linear
          // memory and compiler caches die with this Worker.
          try {
            worker.postMessage({
              protocol: PROTOCOL,
              type: "module",
              compiler: asset,
              module: loaded.module,
            });
          } catch {
            /* Unsupported Module cloning falls back to compilation on wake. */
          }
          return (activeEngine = loaded);
        })
        .catch((error) => {
          engine = undefined;
          identity = undefined;
          throw error;
        }));
    },
  });

  const publisher = createArtifactPublisher(service.program);
  worker.onmessage = ({ data }) => {
    if (data?.protocol !== PROTOCOL) return;
    if (data.type === "connect-preview")
      publisher.connect(data.projectId, data.generation, data.port);
    else if (data.type === "disconnect-preview")
      publisher.disconnect(data.projectId, data.generation);
    else {
      if (data.type === "compile" && data.baseRevision === null) inline.delete(data.projectId);
      if (data.type === "dispose") {
        inline.delete(data.projectId);
        publisher.disconnect(data.projectId);
      }
      service.receive(data);
    }
  };
}
