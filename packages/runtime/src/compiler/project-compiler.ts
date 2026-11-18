import { moduleLanguage, isScriptFile } from "../project/module-language.ts";
import {
  validateFiles,
  executionLimits,
  ownCompilerConfig,
  type CompilerConfig,
} from "../project/definition.ts";
import {
  MODULE_ABI,
  PROGRAM_SCHEMA,
  type ModuleContent,
  type ModuleArtifact,
  type Compilation,
  type Files,
  type Seed,
} from "../shared/protocol.ts";
import { createArtifactStore, projectCacheLimits, type ArtifactCache } from "./artifact-cache.ts";

export interface TransformEngine {
  memoryBytes?(): number;
  readonly compilerVersion: string;
  compileModule(id: string, source: string, runtime: CompilerConfig["runtime"]): Artifact;
  compileModuleAsync?(
    id: string,
    source: string,
    runtime: CompilerConfig["runtime"],
    cancelled: () => boolean,
  ): Promise<Artifact>;
}

export type Artifact = ModuleContent & {
  id: string;
  specifiers: string[];
  dynamic: string[];
  sourceMap?: string;
};

function immutableModule(
  content: ModuleContent & { id: string },
  imports: Record<string, string> = {},
  dependencies: string[] = [],
  dynamicDependencies: string[] = [],
): ModuleArtifact {
  return Object.freeze({
    ...content,
    imports: Object.freeze(imports),
    dependencies: Object.freeze(dependencies),
    dynamicDependencies: Object.freeze(dynamicDependencies),
  });
}

function transformModule(
  engine: TransformEngine,
  id: string,
  source: string,
  runtime: CompilerConfig["runtime"],
): Artifact {
  if (moduleLanguage(id) === "text")
    return { id, kind: "text", data: source, specifiers: [], dynamic: [] };
  if (id.endsWith(".css")) return { id, kind: "css", code: source, specifiers: [], dynamic: [] };
  if (id.endsWith(".json"))
    return {
      id,
      kind: "json",
      data: compactJSON(source),
      specifiers: [],
      dynamic: [],
    };
  const input = moduleInput(id, source);
  return engine.compileModule(id, input, runtime);
}

function moduleInput(id: string, source: string) {
  if (!isScriptFile(id)) throw new Error(`Unsupported file type: ${id}`);
  return source;
}

function compactJSON(source: string) {
  JSON.parse(source);
  // Strip only whitespace outside strings. Parsing and re-stringifying would
  // erase -0; embedding pretty JSON verbatim would inflate code and source maps.
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  const whitespace = (code: number) => code === 32 || code === 9 || code === 10 || code === 13;
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    if (quoted) {
      if (code === 92) i++;
      else if (code === 34) quoted = false;
    } else if (code === 34) quoted = true;
    else if (whitespace(code)) {
      if (start < i) parts.push(source.slice(start, i));
      do i++;
      while (whitespace(source.charCodeAt(i)));
      start = i--;
    }
  }
  if (start < source.length) parts.push(source.slice(start));
  return parts.join("");
}

export function createProjectCompiler(
  engine: TransformEngine,
  input: CompilerConfig,
  seed?: Seed,
  limits = projectCacheLimits,
  cache: ArtifactCache = createArtifactStore(limits).scope(limits),
) {
  const config = ownCompilerConfig(input);
  const version = engine.compilerVersion;
  // A completed transform is pure and independent of a program's publication.
  // Keep at most one source version per path, with explicit byte/entry bounds.
  // Cancellation retains useful work, never a suspended AST or a partial graph.
  const jobs = new Set<CompileJob>();
  // Resolution depends on the file names, not on other modules' source text.
  // Weak keys keep this reuse inside the transform cache's eviction lifetime.
  const linked = new WeakMap<Artifact, { shape: object; module: ModuleArtifact }>();
  let fileNames = new Set<string>();
  let shape = {};
  const staticModules: Compilation["modules"] = Object.create(null);
  for (const [id, code] of Object.entries(config.dependencyFiles))
    staticModules[id] = immutableModule({ id, kind: "css", code });
  for (const id of Object.keys(config.resources?.assets || {}))
    staticModules[id] = immutableModule({ id, kind: "asset", assetId: id });
  let transforms = 0;
  let hits = 0;
  let disposed = false;
  if (
    seed?.output.schema === PROGRAM_SCHEMA &&
    seed.output.compilerVersion === version &&
    seed.output.projectKey === config.key
  ) {
    for (const [id, source] of Object.entries(seed.files)) {
      const artifact = seed.output.modules[id];
      if (artifact)
        cache.set(id, source, {
          ...artifact,
          sourceMap: seed.output.debug?.[id]?.sourceMap,
          specifiers: Object.keys(artifact.imports).filter((s) =>
            artifact.dependencies.includes(artifact.imports[s]),
          ),
          dynamic: Object.keys(artifact.imports).filter((s) =>
            artifact.dynamicDependencies.includes(artifact.imports[s]),
          ),
        });
    }
  }

  function* build(
    files: Files,
  ): Generator<{ id: string; source: string } | undefined, Compilation, Artifact> {
    validateFiles(files, config.entry);
    const names = Object.keys(files);
    if (names.length !== fileNames.size || names.some((id) => !fileNames.has(id))) {
      fileNames = new Set(names);
      shape = {};
    }
    const currentShape = shape;

    const modules: Compilation["modules"] = Object.create(null);
    const debug: Record<string, { sourceMap: string }> = Object.create(null);
    const transformed: string[] = [];

    const resolve = (specifier: string, importer: string) => {
      if (Object.hasOwn(config.imports, specifier)) return config.imports[specifier];
      if (!specifier.startsWith(".") && !specifier.startsWith("/"))
        throw new Error(`Undeclared dependency: ${specifier}`);
      const url = new URL(specifier, `https://project.invalid${importer}`);
      if (url.origin !== "https://project.invalid" || url.search || url.hash)
        throw new Error(`Unsupported import path: ${specifier}`);
      const id = url.pathname;
      if (!Object.hasOwn(files, id) && !Object.hasOwn(config.resources?.assets || {}, id))
        throw new Error(`File not found: ${id} (${importer})`);
      return id;
    };

    for (const [id, source] of Object.entries(files)) {
      const cached = cache.get(id, source);
      const artifact = cached ?? (yield { id, source });
      if (artifact.sourceMap) debug[id] = Object.freeze({ sourceMap: artifact.sourceMap });
      if (!cached) {
        transformed.push(id);
        transforms++;
        // Commit pure work even when import resolution or later modules fail.
        cache.set(id, source, artifact);
      } else hits++;
      let resolved = linked.get(artifact);
      if (resolved?.shape !== currentShape) {
        const imports = Object.fromEntries(
          [...artifact.specifiers, ...artifact.dynamic].map((s) => [s, resolve(s, id)]),
        );

        const { specifiers: _, dynamic: __, sourceMap: ___, ...content } = artifact;
        resolved = {
          shape: currentShape,
          module: immutableModule(
            content,
            imports,
            artifact.specifiers.map((s) => imports[s]),
            artifact.dynamic.map((s) => imports[s]),
          ),
        };
        linked.set(artifact, resolved);
      }
      modules[id] = resolved.module;
      yield;
    }
    Object.assign(modules, staticModules);
    return {
      schema: PROGRAM_SCHEMA,
      abi: MODULE_ABI,
      compilerVersion: version,
      entry: config.entry,
      styles: config.styles.filter((id) => Object.hasOwn(modules, id)),
      runtime: config.runtime,
      execution: executionLimits(config.runtime, config.execution),
      resources: config.resources,
      projectKey: config.key,
      modules,
      debug: Object.freeze(debug),
      transformed,
    };
  }

  function createJob(
    files: Files,
    cooperative = false,
    cancelled: () => boolean = () => false,
  ): CompileJob {
    if (disposed) throw new Error("Compiler is disposed");
    // The caller may apply the next source patch while this job is suspended.
    const snapshot = Object.freeze({ ...files });
    cache.prune(snapshot);
    let generator: ReturnType<typeof build> | undefined = build(snapshot);

    const advance = (artifact: Artifact): IteratorResult<void, Compilation> => {
      if (!generator || cancelled()) {
        job.dispose();
        throw new DOMException("Aborted", "AbortError");
      }
      const step = generator.next(artifact);
      if (step.done) job.dispose();
      return step as IteratorResult<void, Compilation>;
    };

    const job: CompileJob = {
      step() {
        if (!generator || cancelled()) {
          job.dispose();
          throw new DOMException("Aborted", "AbortError");
        }
        try {
          const step = generator.next(undefined as never);
          if (step.done) job.dispose();
          else if (step.value) {
            const { id, source } = step.value;
            if (cooperative && engine.compileModuleAsync && isScriptFile(id)) {
              const input = moduleInput(id, source);
              return engine
                .compileModuleAsync(id, input, config.runtime, () => !generator || cancelled())
                .then(advance, (error) => {
                  job.dispose();
                  throw error;
                });
            }
            return advance(transformModule(engine, id, source, config.runtime));
          }
          return step as IteratorResult<void, Compilation>;
        } catch (error) {
          job.dispose();
          throw error;
        }
      },
      dispose() {
        generator?.return(undefined as never);
        generator = undefined;
        jobs.delete(job);
      },
    };

    jobs.add(job);
    return job;
  }

  return {
    createJob,
    stats: () => ({
      ...cache.stats(),
      transforms,
      hits,
      jobs: jobs.size,
    }),
    compile(files: Files): Compilation {
      const job = createJob(files);
      let step = job.step() as IteratorResult<void, Compilation>;
      while (!step.done) step = job.step() as IteratorResult<void, Compilation>;
      return step.value;
    },
    async compileAsync(
      files: Files,
      scheduling: {
        yieldTask: () => Promise<void>;
        cancelled: () => boolean;
        budgetMs?: number;
      },
    ): Promise<Compilation> {
      const job = createJob(files, true, scheduling.cancelled);
      const budget = scheduling.budgetMs ?? 4;
      let deadline = performance.now() + budget;
      try {
        for (;;) {
          if (scheduling.cancelled()) throw new DOMException("Aborted", "AbortError");
          const step = await job.step();
          if (step.done) return step.value;
          if (performance.now() >= deadline) {
            await scheduling.yieldTask();
            deadline = performance.now() + budget;
          }
        }
      } finally {
        job.dispose();
      }
    },
    dispose() {
      disposed = true;
      for (const job of jobs) job.dispose();
      cache.clear();
    },
  };
}

export interface CompileJob {
  /** One module, or final graph validation/publication. Never a time guarantee. */
  step(): IteratorResult<void, Compilation> | Promise<IteratorResult<void, Compilation>>;
  dispose(): void;
}
