import { createRefreshReact } from "./refresh.ts";
import {
  createModulePolicy,
  type Dependencies,
  type ModulePolicy,
  type RuntimeAdapter,
} from "./policy.ts";
import type { Namespace, Signature } from "../module-runtime.ts";

export interface RefreshRuntime {
  register(type: unknown, id: string): void;
  isLikelyComponentType(type: unknown): boolean;
  createSignatureFunctionForTransform(): Signature;
  getFamilyByType(type: unknown): unknown;
  performReactRefresh(): { staleFamilies: Set<unknown> } | null;
}

export function createReactPolicy(
  dependencies: Dependencies,
  refresh: RefreshRuntime,
): ModulePolicy {
  const base = createModulePolicy(dependencies);
  const React = dependencies.react as unknown as typeof import("react");
  const epochs = new Map<string, number>();
  const facades = new Map<string, Namespace>();

  function componentMembers(value: unknown): Array<[string, unknown]> | undefined {
    if (!refresh.isLikelyComponentType(value)) return;

    const entries = Object.entries(Object.getOwnPropertyDescriptors(value)).filter(
      ([, descriptor]) => descriptor.enumerable,
    );

    if (entries.some(([, descriptor]) => !("value" in descriptor))) return;
    return entries.map(([key, descriptor]) => [key, descriptor.value]);
  }

  function compatible(previous: unknown, next: unknown, depth = 0): boolean {
    if (depth > 4) return false;
    const before = componentMembers(previous);
    const after = componentMembers(next);
    if (before && after) {
      const descriptors = Object.getOwnPropertyDescriptors(next);
      return (
        before.length === after.length &&
        before.every(([key, value]) => {
          const descriptor = descriptors[key];
          return (
            !!descriptor?.enumerable &&
            "value" in descriptor &&
            compatible(value, descriptor.value, depth + 1)
          );
        })
      );
    }
    return (
      Object.is(previous, next) && (next === null || !["object", "function"].includes(typeof next))
    );
  }

  function registrations(exports: Namespace, prefix: string, depth = 0): Array<[unknown, string]> {
    if (depth > 4) return [];
    return Object.entries(exports).flatMap(([key, value]) => {
      const members = componentMembers(value);
      return members
        ? [
            [value, `${prefix}:${key}`] as [unknown, string],
            ...registrations(Object.fromEntries(members), `${prefix}:${key}`, depth + 1),
          ]
        : [];
    });
  }

  return {
    ...base,
    resolve(specifier, importer) {
      if (specifier !== "vendor:react") return base.resolve(specifier, importer);
      if (!facades.has(importer)) {
        const facade = createRefreshReact(React, () => epochs.get(importer) || 0);
        facades.set(importer, { ...facade, default: facade });
      }
      return facades.get(importer)!;
    },
    classify(exports, id) {
      const entries = Object.entries(exports).filter(([key]) => key !== "__esModule");
      return {
        registrations: registrations(Object.fromEntries(entries), `${id} export`),
        boundary: entries.some(([, value]) => refresh.isLikelyComponentType(value))
          ? entries
              .map(([key]) => key)
              .sort()
              .join("\0")
          : null,
      };
    },
    canAccept(previous, next) {
      const keys = Object.keys(previous).filter((key) => key !== "__esModule");
      return (
        keys.length === Object.keys(next).filter((key) => key !== "__esModule").length &&
        keys.every((key) => Object.hasOwn(next, key) && compatible(previous[key], next[key]))
      );
    },
    signature(forceReset) {
      const signature = refresh.createSignatureFunctionForTransform();
      return (type, key, reset, hooks) => signature(type, key, forceReset || reset, hooks);
    },
    register: (type, id) => refresh.register(type, id),
    committed: (id) => epochs.set(id, (epochs.get(id) || 0) + 1),
    removed(id) {
      epochs.delete(id);
      facades.delete(id);
    },
    validateEntry(exports) {
      if (!Object.hasOwn(exports, "default"))
        throw new Error("The React entry must have a default export.");
    },
    dispose() {
      epochs.clear();
      facades.clear();
    },
  };
}

export function createReactAdapter(
  container: HTMLElement,
  dependencies: Dependencies,
  refresh: RefreshRuntime,
  reportError: (error: unknown) => void,
): RuntimeAdapter {
  const React = dependencies.react as unknown as typeof import("react");
  const ReactDOM = dependencies["react-dom"] as unknown as typeof import("react-dom");

  const ReactDOMClient = dependencies[
    "react-dom/client"
  ] as unknown as typeof import("react-dom/client");

  let root: import("react-dom/client").Root | undefined;
  let previous: import("react").ComponentType | undefined;
  return {
    modules: createReactPolicy(dependencies, refresh),
    render(result, recovering) {
      const App = result.entry.default as import("react").ComponentType;
      const previousFamily = previous && refresh.getFamilyByType(previous);
      for (const [type, id] of result.registrations) refresh.register(type, id);
      const family = refresh.getFamilyByType(App);
      const rootChanged = !!previous && App !== previous && (!family || family !== previousFamily);
      const initial = !root;
      root ||= ReactDOMClient.createRoot(container, {
        onUncaughtError: reportError,
      });
      const update = result.evaluated.length ? refresh.performReactRefresh() : null;
      if (initial || rootChanged || recovering)
        ReactDOM.flushSync(() =>
          root!.render(React.createElement(React.StrictMode, null, React.createElement(App))),
        );
      previous = App;
      return initial
        ? "initial"
        : recovering
          ? "recovered"
          : rootChanged || update?.staleFamilies.size
            ? "remounted"
            : result.evaluated.length
              ? "refreshed"
              : "styles";
    },
    dispose() {
      const owned = root;
      root = undefined;
      previous = undefined;
      owned?.unmount();
    },
  };
}
