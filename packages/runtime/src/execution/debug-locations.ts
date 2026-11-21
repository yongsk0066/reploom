import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import type {
  Compilation,
  Diagnostic,
  InspectionResult,
  ModuleArtifact,
  ModuleDebug,
} from "../shared/protocol.ts";

type Location = {
  file: string;
  code: string;
  sourceMap: string;
  revision: number;
  url?: string;
  release?: () => void;
  active?: boolean;
  pending?: boolean;
};

export function createDebugLocations() {
  const locations = new Map<number, Location>();
  const urls = new Map<string, number>();
  let revision = 0;
  let decoded: { sourceMap: string; map: TraceMap } | undefined;

  function trim() {
    const optional = [...locations].filter(([, location]) => !location.active && !location.pending);
    let retained = optional.reduce(
      (total, [, location]) => total + (location.code.length + location.sourceMap.length) * 2,
      0,
    );
    while (optional.length > 32 || retained > 4 * 1024 * 1024) {
      const [version, removed] = optional.shift()!;
      const size = (removed.code.length + removed.sourceMap.length) * 2;
      retained -= size;
      if (removed.url) urls.delete(removed.url);
      removed.release?.();
      if (decoded?.sourceMap === removed.sourceMap) decoded = undefined;
      locations.delete(version);
    }
  }

  function locate(diagnostics: Diagnostic[]): Diagnostic[] {
    return diagnostics.map((diagnostic) => {
      for (const match of diagnostic.text.matchAll(
        /((?:playground:|blob:)[^\s()]+?):(\d+):(\d+)/g,
      )) {
        const version = urls.get(match[1]) ?? Number(match[1].match(/\?v=(\d+)$/)?.[1]);
        const location = locations.get(version);
        if (!location) continue;
        try {
          if (decoded?.sourceMap !== location.sourceMap)
            decoded = {
              sourceMap: location.sourceMap,
              map: new TraceMap(
                JSON.parse(
                  new TextDecoder().decode(
                    Uint8Array.from(
                      atob(location.sourceMap.slice(location.sourceMap.indexOf(",") + 1)),
                      (c) => c.charCodeAt(0),
                    ),
                  ),
                ),
              ),
            };

          const original = originalPositionFor(decoded.map, {
            line: Number(match[2]),
            column: Math.max(0, Number(match[3]) - 1),
          });

          if (original.line !== null)
            return {
              ...diagnostic,
              file: location.file,
              line: original.line,
              column: original.column ?? 0,
              revision: location.revision,
            };
        } catch {
          continue;
        }
      }
      return diagnostic;
    });
  }

  return {
    update(program: Compilation, nextRevision: number) {
      revision = nextRevision;
      for (const location of locations.values()) {
        const module = program.modules[location.file];
        if (module?.kind !== "js" || module.code !== location.code) continue;
        const sourceMap = program.debug?.[location.file]?.sourceMap ?? "";
        location.sourceMap = sourceMap;
        location.revision = revision;
      }
    },
    register(version: number, artifact: ModuleArtifact, debug?: ModuleDebug) {
      if (artifact.kind !== "js") return;

      const location = {
        file: artifact.id,
        code: artifact.code,
        sourceMap: debug?.sourceMap ?? "",
        revision,
        pending: true,
      };

      locations.set(version, location);
      trim();
    },
    alias(version: number, url: string, release: () => void) {
      const location = locations.get(version);
      if (!location) return;
      location.url = url;
      location.release = release;
      urls.set(url, version);
    },
    commit(program: Compilation) {
      const latest = new Map<string, Location>();
      for (const location of locations.values()) {
        const module = program.modules[location.file];
        if (module?.kind === "js" && module.code === location.code)
          latest.set(location.file, location);
      }
      for (const location of locations.values()) {
        location.active = latest.get(location.file) === location;
        location.pending = false;
      }
      trim();
    },
    rollback() {
      for (const location of locations.values()) location.pending = false;
      trim();
    },
    locate,
    inspect(result: InspectionResult): InspectionResult {
      if (!result.tests?.some((test) => test.diagnostics.length) && !result.diagnostics.length)
        return result;
      return {
        ...result,
        diagnostics: locate(result.diagnostics),
        tests: result.tests?.map((test) =>
          test.diagnostics.length ? { ...test, diagnostics: locate(test.diagnostics) } : test,
        ),
      };
    },
    dispose() {
      for (const location of locations.values()) location.release?.();
      locations.clear();
      urls.clear();
      decoded = undefined;
    },
  };
}
