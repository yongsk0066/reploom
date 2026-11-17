import { createModulePolicy, type Dependencies, type RuntimeAdapter } from "./policy.ts";
import { RuntimeUpdateError } from "../module-runtime.ts";
import { errorDiagnostics } from "../../shared/protocol.ts";

export type DomContext = {
  state: Record<string, unknown>;
  signal: AbortSignal;
};

type Mount = (
  container: HTMLElement,
  context: DomContext,
) => void | (() => unknown | Promise<unknown>);

// DOM examples own rendering; the adapter owns mount/listener lifetime and an
// explicit state bag. CSS-only and metadata-only edits never call mount again.
export function createDomAdapter(
  container: HTMLElement,
  dependencies: Dependencies,
): RuntimeAdapter {
  const modules = createModulePolicy(dependencies);
  modules.validateEntry = (exports) => {
    if (typeof exports.mount !== "function")
      throw new Error("The DOM entry must export mount(container, context).");
  };
  const state: Record<string, unknown> = {};
  let mounted: Mount | undefined;
  let cleanup: ReturnType<Mount>;
  let controller: AbortController | undefined;
  let closed = false;

  async function retire() {
    controller?.abort();
    controller = undefined;
    const owned = cleanup;
    cleanup = undefined;
    mounted = undefined;
    try {
      await owned?.();
    } finally {
      container.replaceChildren();
    }
  }

  return {
    modules,
    async render(result, recovering) {
      const mount = result.entry.mount as Mount;
      if (closed) throw new Error("The DOM preview is disposed.");
      if (mounted === mount && !recovering) return result.evaluated.length ? "refreshed" : "styles";
      const initial = !mounted;
      try {
        await retire();
        if (closed) throw new Error("The DOM preview is disposed.");
        controller = new AbortController();
        const returned = mount(container, { state, signal: controller.signal });
        if (returned !== undefined && typeof returned !== "function")
          throw new Error("mount must be synchronous and return a cleanup function or undefined.");
        cleanup = returned;
        mounted = mount;
        return initial ? "initial" : recovering ? "recovered" : "refreshed";
      } catch (error) {
        await retire();
        throw new RuntimeUpdateError(errorDiagnostics(error, "notification"), true, error);
      }
    },
    async dispose() {
      closed = true;
      try {
        await retire();
      } finally {
        for (const key of Object.keys(state)) delete state[key];
      }
    },
  };
}
