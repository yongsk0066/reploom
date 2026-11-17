import type { FactoryLoader, ModuleFactory } from "./module-runtime.ts";
import type { RealmResources } from "./resources.ts";
import { createDebugLocations } from "./debug-locations.ts";
import type { ScriptSource } from "../shared/protocol.ts";

// Classic factories avoid native ESM's permanent per-URL module cache.
export function createFactoryEvaluator(
  document: Document,
  nonce: string,
  resources?: RealmResources,
) {
  function inline(code: string) {
    const script = document.createElement("script");
    script.nonce = nonce;
    script.textContent = code;
    try {
      document.head.append(script);
    } finally {
      script.remove();
      // Parsing has transferred the source to the JS engine. Debuggers may
      // retain its originating element after removal; the element no longer
      // needs a second copy of the code and inline source map in a Text node.
      script.textContent = "";
    }
  }

  const probe = `__reploom_source_${nonce.replaceAll("-", "")}`;
  const probeURL = `playground:/${probe}`;
  inline(`globalThis[${JSON.stringify(probe)}]=new Error().stack;\n//# sourceURL=${probeURL}`);
  const located = String(Reflect.get(globalThis, probe)).includes(probeURL);
  Reflect.deleteProperty(globalThis, probe);
  const pending = new Set<(error?: Error) => void>();
  const vendorURLs = new Set<string>();
  let disposed = false;

  function run(
    code: ScriptSource,
    identify?: (url: string, release: () => void) => void,
  ): void | Promise<void> {
    if (disposed) throw new Error("Evaluator disposed");
    if (located) {
      if (typeof code === "string") return inline(code);
      return code.text().then((text) => run(text, identify));
    }
    // WebKit mutes opaque-frame inline errors and ignores their sourceURL.
    // A same-realm Blob script has a real source URL and reports full errors.
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");

      const url = URL.createObjectURL(
        typeof code === "string" ? new Blob([code], { type: "text/javascript" }) : code,
      );

      const release = () => URL.revokeObjectURL(url);
      if (identify) identify(url, release);
      else vendorURLs.add(url);

      const finish = (error?: Error) => {
        pending.delete(finish);
        script.onload = script.onerror = null;
        script.remove();
        if (error) {
          release();
          vendorURLs.delete(url);
        }
        if (error) reject(error);
        else resolve();
      };

      pending.add(finish);
      script.nonce = nonce;
      script.src = url;
      script.onload = () => finish();
      script.onerror = () => finish(new Error("Factory script could not load"));
      document.head.append(script);
    });
  }

  const evaluator = createRegisteredEvaluator(run, resources);
  return {
    ...evaluator,
    async runAll(sources: readonly ScriptSource[]) {
      const scripts = located
        ? await Promise.all(
            sources.map((source) => (typeof source === "string" ? source : source.text())),
          )
        : sources;

      for (const script of scripts) await run(script);
    },
    dispose() {
      disposed = true;
      for (const finish of pending) finish(new Error("Evaluator disposed"));
      for (const url of vendorURLs) URL.revokeObjectURL(url);
      vendorURLs.clear();
      evaluator.dispose();
    },
  };
}

// A classic Worker can import a temporary local script without eval or a native
// ESM cache entry for each revision. The creating opaque iframe owns its CSP.
export function createWorkerEvaluator(resources?: RealmResources) {
  const importScript = (
    globalThis as unknown as { importScripts(url: string): void }
  ).importScripts.bind(globalThis);

  return createRegisteredEvaluator((code, identify) => {
    const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    const release = () => URL.revokeObjectURL(url);
    identify?.(url, release);
    try {
      importScript(url);
    } finally {
      if (!identify) release();
    }
  }, resources);
}

function createRegisteredEvaluator(
  run: (
    code: ScriptSource,
    identify?: (url: string, release: () => void) => void,
  ) => void | Promise<void>,
  resources?: RealmResources,
) {
  let version = 0;
  const debugLocations = createDebugLocations();

  // Opaque blob Workers need not be secure contexts: randomUUID is unavailable
  // there. getRandomValues is available; generate a namespace once, not per edit.
  const prefix = Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) =>
    n.toString(16).padStart(8, "0"),
  ).join("");

  const load: FactoryLoader = async (artifact, debug) => {
    if (artifact.kind === "asset") {
      if (!resources) throw new Error("Asset owner is missing");
      const url = resources.access.asset(artifact.assetId);
      return async (context) => context.export("default", () => url);
    }
    if (artifact.kind !== "js") throw new Error(`Module is not executable: ${artifact.id}`);
    const current = ++version;
    const key = `__playground_factory_${prefix}_${current}`;
    debugLocations.register(current, artifact, debug);
    let factory: ModuleFactory | undefined;
    Reflect.set(globalThis, key, (value: ModuleFactory) => {
      factory = value;
    });
    try {
      const sourceMap =
        debug?.sourceMap && (resources?.sourceMap(debug.sourceMap) ?? debug.sourceMap);

      // Keep these two prefix lines aligned with the compiler's source map.
      const task = run(
        `"use strict";\nglobalThis[${JSON.stringify(key)}](\n${artifact.code}\n);\n${sourceMap ? `//# sourceMappingURL=${sourceMap}\n` : ""}//# sourceURL=playground:${artifact.id}?v=${current}\n`,
        (url, release) => debugLocations.alias(current, url, release),
      );

      if (task) await task;
      if (typeof factory !== "function")
        throw new Error(`Could not register module factory: ${artifact.id}`);
      return factory;
    } finally {
      Reflect.deleteProperty(globalThis, key);
    }
  };

  return { run, load, debug: debugLocations, dispose: debugLocations.dispose };
}
