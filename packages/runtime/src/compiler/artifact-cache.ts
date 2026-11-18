import { modulePayload } from "../shared/protocol.ts";
import type { Artifact } from "./project-compiler.ts";

export type CacheLimits = { bytes: number; entries: number };

export const projectCacheLimits = { bytes: 16 * 1024 * 1024, entries: 32 };

export const sharedCacheLimits = { bytes: 32 * 1024 * 1024, entries: 256 };

type Entry = {
  id: string;
  source: string;
  artifact: Artifact;
  bytes: number;
  owner: Scope;
};

type Scope = {
  entries: Map<string, Entry>;
  bytes: number;
};

export interface ArtifactCache {
  get(id: string, source: string): Artifact | undefined;
  set(id: string, source: string, artifact: Artifact): void;
  prune(files: Readonly<Record<string, unknown>>): void;
  clear(): void;
  stats(): { retainedBytes: number; entries: number };
}

/** Optional pure transforms only. Published graphs and source bases have other owners. */
export function createArtifactStore(limits: CacheLimits = sharedCacheLimits) {
  const lru = new Map<Entry, true>();
  let bytes = 0;
  let evictions = 0;

  const remove = (entry: Entry) => {
    lru.delete(entry);
    entry.owner.entries.delete(entry.id);
    entry.owner.bytes -= entry.bytes;
    bytes -= entry.bytes;
  };

  const touch = (entry: Entry) => {
    entry.owner.entries.delete(entry.id);
    entry.owner.entries.set(entry.id, entry);
    lru.delete(entry);
    lru.set(entry, true);
  };

  return {
    stats: () => ({ retainedBytes: bytes, entries: lru.size, evictions }),
    scope(local: CacheLimits = projectCacheLimits): ArtifactCache {
      // Object identity isolates compiler/configuration lifetimes without a
      // second registry retaining empty or disposed project scopes.
      const owner: Scope = { entries: new Map(), bytes: 0 };
      return {
        get(id, source) {
          const entry = owner.entries.get(id);
          if (!entry || entry.source !== source) return;
          touch(entry);
          return entry.artifact;
        },
        set(id, source, artifact) {
          const previous = owner.entries.get(id);
          if (previous) remove(previous);

          const size =
            2 *
            (id.length +
              source.length +
              modulePayload(artifact).length +
              (artifact.kind === "js" ? artifact.sourceMap?.length || 0 : 0) +
              artifact.specifiers.reduce((n, s) => n + s.length, 0) +
              artifact.dynamic.reduce((n, s) => n + s.length, 0));

          if (size > Math.min(local.bytes, limits.bytes) || local.entries < 1 || limits.entries < 1)
            return;
          const entry: Entry = { id, source, artifact, bytes: size, owner };
          owner.entries.set(id, entry);
          lru.set(entry, true);
          owner.bytes += size;
          bytes += size;
          while (owner.bytes > local.bytes || owner.entries.size > local.entries) {
            remove(owner.entries.values().next().value!);
            evictions++;
          }
          while (bytes > limits.bytes || lru.size > limits.entries) {
            remove(lru.keys().next().value!);
            evictions++;
          }
        },
        prune(files) {
          for (const entry of owner.entries.values())
            if (!Object.hasOwn(files, entry.id)) remove(entry);
        },
        clear() {
          for (const entry of owner.entries.values()) remove(entry);
        },
        stats: () => ({
          retainedBytes: owner.bytes,
          entries: owner.entries.size,
        }),
      };
    },
  };
}
