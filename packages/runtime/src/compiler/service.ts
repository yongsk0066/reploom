import { modulePayload } from "../shared/protocol.ts";
import {
  createProjectCompiler,
  type CompileJob,
  type TransformEngine,
} from "./project-compiler.ts";
import {
  PROTOCOL,
  diffProgram,
  programReference,
  errorDiagnostics,
  type CompileCommand,
  type CompilerCommand,
  type CompilerReply,
  type VersionedProgram,
  type CompileFailure,
} from "../shared/protocol.ts";
import { applySourceChanges } from "../shared/source-patch.ts";
import { createArtifactStore, sharedCacheLimits, type CacheLimits } from "./artifact-cache.ts";

type Request = Pick<CompileCommand, "id" | "projectId" | "revision" | "delivery">;

type Initialization = Pick<CompileCommand, "compiler" | "module" | "config" | "seed">;

type Project = {
  revision: number;
  files: Record<string, string>;
  initial?: Initialization;
  compiler?: ReturnType<typeof createProjectCompiler>;
  output?: VersionedProgram;
  pending?: Request;
  active?: { request: Request; job: CompileJob };
  priority: "focused" | "visible" | "background";
  service: number;
};

/** Realm-independent coordinator. Owns jobs and publication, never editor/DOM. */
export function createCompilerService(
  services: {
    loadEngine(command: Pick<CompileCommand, "compiler" | "module">): Promise<TransformEngine>;
    reply(reply: CompilerReply, output?: VersionedProgram, delivery?: "reference"): void;
    yieldTask(): Promise<void>;
    now(): number;
  },
  cacheLimits: CacheLimits = sharedCacheLimits,
) {
  const projects = new Map<string, Project>();
  const artifacts = createArtifactStore(cacheLimits);
  let running = false;
  let disposed = false;

  const nextProject = () => {
    let next: Project | undefined;
    for (const project of projects.values())
      if ((project.pending || project.active) && (!next || project.service < next.service))
        next = project;
    return next;
  };

  const cancel = (project: Project) => {
    project.active?.job.dispose();
    project.active = undefined;
  };

  const remove = (id: string) => {
    const project = projects.get(id);
    if (!project) return;
    cancel(project);
    project.compiler?.dispose();
    projects.delete(id);
  };

  const fail = (request: Request, error: unknown, failure: CompileFailure) =>
    services.reply({
      protocol: PROTOCOL,
      projectId: request.projectId,
      id: request.id,
      ok: false,
      failure,
      errors: errorDiagnostics(error),
    });

  async function initializeProject(project: Project, projectId: string) {
    if (project.compiler) return true;
    try {
      const initial = project.initial!;
      const engine = await services.loadEngine(initial);
      if (disposed || projects.get(projectId) !== project) return false;
      project.compiler = createProjectCompiler(
        engine,
        initial.config!,
        initial.seed,
        undefined,
        artifacts.scope(),
      );
      project.initial = undefined;
    } catch (error) {
      if (projects.get(projectId) === project) {
        if (project.pending) fail(project.pending, error, "engine");
        remove(projectId);
      }
      return false;
    }
    return true;
  }

  async function advanceProject(project: Project, projectId: string) {
    if (project.pending) {
      cancel(project);
      project.active = {
        request: project.pending,
        job: project.compiler!.createJob(project.files, true),
      };
      project.pending = undefined;
    }
    const active = project.active;
    if (!active) return;
    const begin = services.now();
    try {
      const step = await active.job.step();
      if (project.active !== active || projects.get(projectId) !== project || disposed) return;
      if (step.done) {
        const next = {
          revision: active.request.revision,
          program: step.value,
        };

        services.reply(
          {
            protocol: PROTOCOL,
            projectId: active.request.projectId,
            id: active.request.id,
            ok: true,
            ...(active.request.delivery === "reference"
              ? { reference: programReference(next.program) }
              : { patch: diffProgram(project.output, next) }),
          },
          next,
          active.request.delivery,
        );
        project.output = next;
        project.active = undefined;
      }
    } catch (error) {
      if (project.active === active && projects.get(projectId) === project && !disposed) {
        fail(
          active.request,
          error,
          error instanceof Error && "fatal" in error && error.fatal === true ? "engine" : "compile",
        );
        cancel(project);
      }
    } finally {
      // Superseded work still consumed service; cancellation cannot earn
      // free priority over another project waiting for the same Instance.
      const weight = { focused: 4, visible: 2, background: 1 }[project.priority];
      project.service += Math.max(0.1, services.now() - begin) / weight;
    }
  }

  async function pump() {
    if (running || disposed) return;
    running = true;
    try {
      await services.yieldTask();
      let deadline = services.now() + 4;
      while (!disposed) {
        // Weighted elapsed service approximates fairness. JSPI can yield inside
        // a module; the single Instance admits another job at module boundaries.
        const project = nextProject();
        if (!project) break;
        const request = project.pending || project.active!.request;
        if (!project.compiler && !(await initializeProject(project, request.projectId))) continue;
        await advanceProject(project, request.projectId);
        if (services.now() >= deadline) {
          await services.yieldTask();
          deadline = services.now() + 4;
        }
      }
    } finally {
      running = false;
      if (!disposed && nextProject()) void pump();
    }
  }

  function receiveCompile(data: CompileCommand) {
    let project = projects.get(data.projectId);
    if (data.baseRevision === null) {
      remove(data.projectId);
      project = {
        revision: -1,
        files: Object.create(null),
        initial: {
          compiler: data.compiler,
          module: data.module,
          config: data.config,
          seed: data.seed,
        },
        priority: data.priority,
        service: nextProject()?.service ?? 0,
      };
      projects.set(data.projectId, project);
    } else if (!project || project.revision !== data.baseRevision) {
      fail(data, new Error("Source revision requires resynchronization"), "source-resync");
      return;
    }
    if (!project) return;
    try {
      // Every source patch applies in FIFO order, including cancelled revisions.
      project.files = applySourceChanges(project.files, data.changes);
    } catch (error) {
      fail(data, error, "source-resync");
      return;
    }
    if (!project.pending && !project.active) {
      const floor = nextProject()?.service;
      if (floor !== undefined) project.service = Math.max(project.service, floor);
    }
    project.revision = data.revision;
    project.priority = data.priority;
    project.pending = {
      id: data.id,
      projectId: data.projectId,
      revision: data.revision,
      delivery: data.delivery,
    };
    cancel(project);
    void pump();
  }

  return {
    program: (projectId: string) => projects.get(projectId)?.output,
    stats() {
      let sourceCharacters = 0;
      let emittedCharacters = 0;
      for (const project of projects.values()) {
        for (const source of Object.values(project.files)) sourceCharacters += source.length;
        for (const module of Object.values(project.output?.program.modules || {}))
          emittedCharacters += modulePayload(module).length;
        for (const debug of Object.values(project.output?.program.debug || {}))
          emittedCharacters += debug.sourceMap.length;
      }
      return {
        projects: projects.size,
        cache: artifacts.stats(),
        sourceCharacters,
        emittedCharacters,
      };
    },
    receive(data: CompilerCommand) {
      if (disposed || data?.protocol !== PROTOCOL) return;
      if (data.type === "prepare") {
        void services.loadEngine(data).catch(() => {});
        return;
      }
      let project = projects.get(data.projectId);
      if (data.type === "dispose") {
        remove(data.projectId);
        return;
      }
      if (data.type === "priority") {
        if (project) project.priority = data.priority;
        return;
      }
      if (data.type === "cancel") {
        if (project?.pending?.id === data.id) project.pending = undefined;
        if (project?.active?.request.id === data.id) cancel(project);
        return;
      }
      receiveCompile(data);
    },
    dispose() {
      disposed = true;
      for (const id of projects.keys()) remove(id);
    },
  };
}
