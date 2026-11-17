import { createSharedTask } from "../shared/async-task.ts";
import type { CompilerConfig, ResourcePolicy } from "../project/definition.ts";
import { ownCompilerConfig } from "../project/definition.ts";
import { createAssetRepository, type AssetRepositoryOptions } from "../shared/assets.ts";
import { MODULE_ABI, PROGRAM_SCHEMA, type Compilation, type Files } from "../shared/protocol.ts";
import type { SessionServices } from "../project/session.ts";

type CompilerClient = ReturnType<typeof import("./compiler-client.ts").createCompilerClient>;

export type BrowserPlatformOptions = AssetRepositoryOptions & {
  createWorker?: () => Worker;
  typecheck?: import("./typecheck-client.ts").TypecheckOptions;
  compilerLifetime?: import("./compiler-client.ts").CompilerLifetime;
};

export type BrowserPlatform = ReturnType<typeof createBrowserPlatform>;

export function createBrowserPlatform(options: BrowserPlatformOptions) {
  const repository = createAssetRepository(options);
  const { loadAsset, loadBinaryAsset, loadManifest } = repository;
  let client: CompilerClient | undefined;
  let opening: Promise<CompilerClient> | undefined;
  let disposed = false;
  let workerUrl: string | undefined;
  const lifetime = new AbortController();
  let validation: ReturnType<typeof import("./validation.ts").createValidationServices> | undefined;

  async function getValidation() {
    const { createValidationServices } = await import("./validation.ts");
    assertOpen();
    return (validation ??= createValidationServices(repository, options.typecheck));
  }

  function assertOpen() {
    if (disposed) throw new DOMException("Browser platform disposed", "AbortError");
  }

  let loadingWorker: ReturnType<typeof createSharedTask<void>> | undefined;

  const createWorker =
    options.createWorker ??
    (() => {
      if (!workerUrl) throw new Error("Compiler worker source is not ready");
      return new Worker(workerUrl, { type: "module", name: "reploom-compiler" });
    });

  const getClient = () => {
    assertOpen();
    return (opening ??= import("./compiler-client.ts")
      .then((module) => {
        assertOpen();
        return (client = module.createCompilerClient(createWorker, options.compilerLifetime));
      })
      .catch((error) => {
        opening = undefined;
        throw error;
      }));
  };

  // Registering a preview does not fetch compiler code. A first editing intent
  // owns that cost; an idle Worker can reuse the verified immutable source URL.
  async function getCompiler(signal: AbortSignal) {
    assertOpen();
    signal.throwIfAborted();
    if (!options.createWorker && !loadingWorker) {
      const task = createSharedTask(
        async (signal) => {
          const manifest = await loadManifest(signal);
          const code = await loadAsset(manifest.compilerWorker, signal);
          signal.throwIfAborted();
          assertOpen();
          workerUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
        },
        {
          signal: lifetime.signal,
          timeoutMs: options.downloadTimeoutMs ?? 30_000,
          rejected() {
            if (loadingWorker === task) loadingWorker = undefined;
          },
        },
      );

      loadingWorker = task;
    }
    const [current] = await Promise.all([getClient(), loadingWorker?.read(signal)]);
    signal.throwIfAborted();
    assertOpen();
    return current;
  }

  async function connectCompilerPreview(
    projectId: string,
    generation: string,
    open: () => MessagePort,
    signal: AbortSignal,
  ) {
    const current = await getClient();
    assertOpen();
    if (!signal.aborted) return current.connectPreview(projectId, generation, open);
  }

  async function loadProgram(asset: import("../shared/protocol.ts").Asset, signal?: AbortSignal) {
    const output = JSON.parse(await loadAsset(asset, signal)) as Compilation;
    if (output.schema !== PROGRAM_SCHEMA || output.abi !== MODULE_ABI)
      throw new Error("Unsupported module ABI.");

    return output;
  }

  async function loadResources(assets: ResourcePolicy["assets"], signal?: AbortSignal) {
    return Object.fromEntries(
      await Promise.all(
        Object.entries(assets).map(async ([id, resource]) => [
          id,
          await loadBinaryAsset(resource, signal),
        ]),
      ),
    );
  }

  const services: SessionServices = {
    validation: {
      async tests(snapshot, paths, signal) {
        const current = await getValidation();
        return current.tests(snapshot, paths, AbortSignal.any([signal, lifetime.signal]));
      },
      async types(files, signal) {
        const current = await getValidation();
        return current.types(files, AbortSignal.any([signal, lifetime.signal]));
      },
    },
    async loadProject(example, consumer) {
      assertOpen();
      const operation = new AbortController();

      const signal = AbortSignal.any(
        [consumer, lifetime.signal, operation.signal].filter(
          (signal): signal is AbortSignal => !!signal,
        ),
      );

      try {
        const manifest = await loadManifest(signal);
        const item = manifest.projects[example];

        if (!item) throw new Error("Project not found.");

        const [files, output, assets, vendor, bootstrap, worker] = await Promise.all([
          loadAsset(item.sources, signal).then(
            (source) => Object.freeze(JSON.parse(source)) as Files,
          ),
          loadProgram(item.program, signal),
          loadResources(item.assets, signal),
          Promise.all(item.vendor.map((asset) => loadAsset(asset, signal))).then<readonly string[]>(
            Object.freeze,
          ),
          loadAsset(manifest.bootstrap, signal),
          item.worker
            ? Promise.all(item.worker.map((asset) => loadAsset(asset, signal))).then<
                readonly string[]
              >(Object.freeze)
            : undefined,
        ]);

        assertOpen();
        // Configuration is immutable for this loaded project. Preparation and every
        // revision share one parsed object, including concurrent first requests.
        let resources: { compiler: typeof manifest.compiler; config: CompilerConfig } | undefined;
        return {
          files,
          checks: item.checks,
          typecheck: !!manifest.typecheck,
          output,
          vendor,
          worker,
          assets,
          bootstrap,
          updateDelayMs: item.updateDelayMs,
          compilerAsset: manifest.compiler,
          async compilerResources(signal?: AbortSignal) {
            signal?.throwIfAborted();
            if (resources) return resources;
            const text = await loadAsset(item.configuration, signal);
            signal?.throwIfAborted();
            return (resources ??= {
              compiler: manifest.compiler,
              config: ownCompilerConfig(JSON.parse(text) as CompilerConfig),
            });
          },
        };
      } finally {
        operation.abort();
      }
    },
    compiler: {
      sourceEdits: true,
      setPriority(projectId, priority) {
        client?.setPriority(projectId, priority);
      },
      async prepare(projectId, compiler, signal) {
        const client = await getCompiler(signal);
        // The session may have unmounted while the lazy chunk was downloading.
        if (!signal.aborted) await client.prepare(projectId, compiler, signal);
      },
      async compile(input, signal) {
        const client = await getCompiler(signal);
        return client.compile(input, signal);
      },
      release(projectId) {
        client?.release(projectId);
      },
    },
    newId: () => crypto.randomUUID(),
    schedule(task, milliseconds) {
      const timer = setTimeout(task, milliseconds);
      return () => clearTimeout(timer);
    },
  };

  return {
    services,
    connectCompilerPreview,
    loadManifest,
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      validation?.dispose();
      validation = undefined;
      client?.dispose();
      client = undefined;
      opening = undefined;
      loadingWorker = undefined;
      repository.dispose();
      if (workerUrl) URL.revokeObjectURL(workerUrl);
      workerUrl = undefined;
    },
  };
}
