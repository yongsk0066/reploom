// Dependency-bearing hooks follow the importing module's committed revision.
// Unchanged modules, CSS and ordinary state updates retain their dependencies.
// Each importer gets a facade; the shared React object stays untouched.
export function createRefreshReact(
  React: typeof import("react"),
  getRevision: () => number,
): typeof import("react") {
  const facade = { ...React };

  type Hook = (...args: unknown[]) => unknown;

  const hooks = facade as unknown as Record<string, Hook>;
  for (const name of [
    "useEffect",
    "useLayoutEffect",
    "useInsertionEffect",
    "useMemo",
    "useCallback",
    "useImperativeHandle",
  ] as const) {
    const original = React[name] as Hook;
    const index = name === "useImperativeHandle" ? 2 : 1;
    hooks[name] = function (...args: unknown[]) {
      if (Array.isArray(args[index])) args[index] = [getRevision(), ...args[index]];
      return original(...args);
    };
  }
  return facade;
}
