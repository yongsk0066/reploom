import { createSharedTask } from "./async-task.ts";
import { PROTOCOL, MODULE_ABI, type Asset } from "./protocol.ts";
import type { BinaryAsset, ResourcePolicy } from "../project/definition.ts";

export type { Asset } from "./protocol.ts";

export const MANIFEST_SCHEMA = 2;

export type Manifest = {
  schema: number;
  protocol: number;
  moduleABI: number;
  buildId: string;
  compilerVersion: string;
  dependencies: Record<string, string>;
  bootstrap: Asset;
  compiler: Asset;
  compilerWorker: Asset;
  wasm: Asset;
  licenses: Asset;
  typecheck?: { worker: Asset; wasm: Asset; configuration: Asset; license: Asset; version: string };
  projects: Record<
    string,
    {
      title: string;
      checks?: readonly string[];
      sources: Asset;
      program: Asset;
      assets: ResourcePolicy["assets"];
      vendor: readonly Asset[];
      worker?: readonly Asset[];
      configuration: Asset;
      updateDelayMs?: number;
    }
  >;
};

export type AssetRepositoryOptions = {
  manifestUrl: string | URL;
  assetBaseUrl?: string | URL;
  fetch?: typeof globalThis.fetch;
  downloadTimeoutMs?: number;
};

function immutableJSON(bytes: ArrayBuffer) {
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const pending = [value];
  let size = 0;
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "string") size += item.length * 2;
    else if (item && typeof item === "object") {
      size += 64;
      for (const [key, entry] of Object.entries(item)) {
        size += key.length * 2 + 16;
        pending.push(entry);
      }
      Object.freeze(item);
    } else size += 8;
  }
  return { value, size };
}

/** A repository owns its requests and bounded immutable asset cache. */
export function createAssetRepository(options: AssetRepositoryOptions) {
  let manifest: ReturnType<typeof createSharedTask<Manifest>> | undefined;
  let disposed = false;
  let cachedBytes = 0;
  let cachedEntries = 0;
  const maxCacheBytes = 8 * 1024 * 1024;
  const maxCacheEntries = 32;
  const lifetime = new AbortController();
  const request = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  type CachedAsset = {
    task: ReturnType<typeof createSharedTask<unknown>>;
    bytes: number;
    settled: boolean;
  };

  const assets = new Map<string, CachedAsset>();

  const assertOpen = () => {
    if (disposed) throw new DOMException("Asset repository disposed", "AbortError");
  };

  const manifestURL = () => new URL(options.manifestUrl, globalThis.location?.href);

  function assetURL(value: string) {
    const base = new URL(options.assetBaseUrl ?? ".", manifestURL());
    if (!base.pathname.endsWith("/")) throw new Error("assetBaseUrl must end in /");
    const url = new URL(value, base);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.origin !== base.origin ||
      !url.pathname.startsWith(base.pathname)
    )
      throw new Error("Asset URL is outside its repository");
    return url.href;
  }

  function evict(key: string, item: CachedAsset) {
    if (assets.get(key) !== item) return;
    cachedBytes -= item.bytes;
    if (item.settled) cachedEntries--;
    assets.delete(key);
  }

  function trim() {
    for (const [key, item] of assets) {
      if (cachedBytes <= maxCacheBytes && cachedEntries <= maxCacheEntries) break;
      if (item.settled) evict(key, item);
    }
  }

  function loadManifest(signal?: AbortSignal) {
    assertOpen();
    signal?.throwIfAborted();
    if (!manifest) {
      const task = createSharedTask(
        async (signal) => {
          const response = await request(manifestURL(), {
            cache: "no-store",
            credentials: "omit",
            signal,
          });

          if (!response.ok) throw new Error("Could not load the project manifest");
          const value = await response.json();
          signal.throwIfAborted();
          assertOpen();
          if (
            value.schema !== MANIFEST_SCHEMA ||
            value.protocol !== PROTOCOL ||
            value.moduleABI !== MODULE_ABI
          )
            throw new Error("Incompatible project manifest; reload the page");
          return value as Manifest;
        },
        {
          signal: lifetime.signal,
          timeoutMs: options.downloadTimeoutMs ?? 30_000,
          rejected() {
            if (manifest === task) manifest = undefined;
          },
        },
      );

      manifest = task;
    }
    return manifest.read(signal);
  }

  function loadVerified(
    asset: Asset,
    format: "text" | "json" | "binary" | "script",
    type: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    assertOpen();
    signal?.throwIfAborted();
    const url = assetURL(asset.url);
    const key = `${asset.sha256}:${format}:${type}`;
    const cached = assets.get(key);
    if (cached) {
      assets.delete(key);
      assets.set(key, cached);
      return cached.task.read(signal);
    }
    const entry: CachedAsset = { task: undefined!, bytes: 0, settled: false };
    entry.task = createSharedTask(
      async (signal) => {
        const response = await request(url, { credentials: "omit", signal });
        if (!response.ok) throw new Error(`Could not load asset: ${asset.url}`);
        const bytes = await response.arrayBuffer();

        const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("");

        signal.throwIfAborted();
        assertOpen();
        if (hash !== asset.sha256) throw new Error("Asset integrity mismatch; reload the page");

        const decoded = format === "json" ? immutableJSON(bytes) : undefined;

        const value = decoded
          ? decoded.value
          : format === "script"
            ? new Blob([bytes], { type: "text/javascript" })
            : format === "binary"
              ? { bytes: new Uint8Array(bytes), type }
              : new TextDecoder().decode(bytes);

        const size =
          decoded?.size ?? (typeof value === "string" ? value.length * 2 : bytes.byteLength);

        // Oversized results belong to their consumers, not the settled cache.
        if (size > maxCacheBytes) {
          assets.delete(key);
          return value;
        }
        entry.bytes = size;
        entry.settled = true;
        cachedBytes += entry.bytes;
        cachedEntries++;
        trim();
        return value;
      },
      {
        signal: lifetime.signal,
        timeoutMs: options.downloadTimeoutMs ?? 30_000,
        rejected: () => evict(key, entry),
      },
    );
    assets.set(key, entry);
    return entry.task.read(signal);
  }

  return {
    loadManifest,
    loadAsset: (asset: Asset, signal?: AbortSignal) =>
      loadVerified(asset, "text", "", signal) as Promise<string>,
    loadJSONAsset: <T>(asset: Asset, signal?: AbortSignal) =>
      loadVerified(asset, "json", "", signal) as Promise<T>,
    loadScriptAsset: (asset: Asset, signal?: AbortSignal) =>
      loadVerified(asset, "script", "", signal) as Promise<Blob>,
    loadBinaryAsset: (asset: Asset & { type: string }, signal?: AbortSignal) =>
      loadVerified(asset, "binary", asset.type, signal) as Promise<BinaryAsset>,
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      assets.clear();
      cachedBytes = 0;
      cachedEntries = 0;
      manifest = undefined;
    },
  };
}
