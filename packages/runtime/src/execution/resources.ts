import {
  resourceLimits,
  type ResourcePolicy,
  type ResourcePayloads,
} from "../project/definition.ts";

export interface ResourceAccess {
  asset(id: string): string;
  worker(id: string, options?: WorkerOptions): Worker;
}

/** One execution realm owns URLs and dependency-created workers. */
export function createRealmResources(
  policy?: ResourcePolicy,
  payloads: ResourcePayloads = {},
  manageWorkers = true,
) {
  const limits = resourceLimits(policy);

  const urls = new Set<string>();
  const assets = new Map<string, string>();

  const workers = new Set<Worker>();
  let closed = false;
  let mapBytes = 0;
  let mapEntries = 0;
  let inlineMaps = 0;
  const NativeWorker = globalThis.Worker;
  const terminate = NativeWorker?.prototype.terminate;
  let OwnedWorker: typeof Worker | undefined;

  const alive = () => {
    if (closed) throw new Error("Resource scope is disposed");
  };

  const ownURL = (blob: Blob) => {
    alive();
    const url = URL.createObjectURL(blob);
    urls.add(url);
    return url;
  };

  if (manageWorkers && NativeWorker) {
    OwnedWorker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        alive();
        if (!String(url).startsWith("blob:") || workers.size >= limits.workers)
          throw new Error("Declared local Worker limit exceeded");
        super(url, options);
        workers.add(this);
      }

      terminate() {
        workers.delete(this);
        super.terminate();
      }
    };
    globalThis.Worker = OwnedWorker;
  }

  const access: ResourceAccess = {
    asset(id) {
      alive();
      const existing = assets.get(id);
      if (existing) return existing;

      const declared = policy?.assets[id];
      const value = payloads[id];

      if (!declared || !value || declared.type !== value.type)
        throw new Error(`Undeclared project asset: ${id}`);
      const url = ownURL(new Blob([value.bytes], { type: value.type }));
      assets.set(id, url);
      return url;
    },
    worker(id, options) {
      if (!OwnedWorker) throw new Error("Project does not declare nested Workers");
      return new OwnedWorker(access.asset(id), options);
    },
  };

  return {
    access,
    sourceMap(sourceMap: string) {
      alive();
      const prefix = "data:application/json;base64,";
      const base64 = sourceMap.slice(prefix.length);

      const bytes =
        (base64.length / 4) * 3 - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);

      if (
        !sourceMap.startsWith(prefix) ||
        limits.debugMaps.mode === "inline" ||
        mapEntries >= limits.debugMaps.entries ||
        mapBytes + bytes > limits.debugMaps.bytes
      ) {
        inlineMaps++;
        return sourceMap;
      }

      const native = (
        Uint8Array as unknown as {
          fromBase64?: (value: string) => Uint8Array<ArrayBuffer>;
        }
      ).fromBase64;

      const data = native ? native(base64) : Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const url = ownURL(new Blob([data], { type: "application/json" }));
      mapBytes += data.byteLength;
      mapEntries++;
      return url;
    },
    stats: () => ({
      mapBytes,
      mapEntries,
      inlineMaps,
      assetURLs: assets.size,
      workers: workers.size,
    }),
    dispose() {
      if (closed) return;
      closed = true;
      // Worker termination precedes releasing the assets those Workers use.
      for (const worker of workers) terminate.call(worker);
      workers.clear();
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
      assets.clear();
      payloads = {};
      mapBytes = 0;
      mapEntries = 0;
      if (OwnedWorker && globalThis.Worker === OwnedWorker) globalThis.Worker = NativeWorker;
    },
  };
}

export type RealmResources = ReturnType<typeof createRealmResources>;
