import { sameExecution, type Compilation } from "../shared/protocol.ts";

type GraphRecord = {
  dependencies: ReadonlySet<string>;
  invalidated: boolean;
  boundary: string | null;
  accept?: unknown;
  acceptedExports?: ReadonlySet<string>;
  importedBindings?: ReadonlyMap<string, ReadonlySet<string> | null>;
};

/** Selective acceptance is explicit: namespace, dynamic and side-effect imports stay conservative. */
export function acceptsDependency(
  record: GraphRecord,
  importer: GraphRecord | undefined,
  id: string,
) {
  const names = importer?.importedBindings?.get(id);
  return (
    !record.invalidated &&
    !!record.acceptedExports &&
    !!names?.size &&
    [...names].every((name) => record.acceptedExports!.has(name))
  );
}

/** Plan propagation from the committed graph without evaluating user code. */
export function planUpdate(
  next: Compilation,
  previous: Compilation | undefined,
  records: ReadonlyMap<string, GraphRecord>,
  failedModules: ReadonlySet<string>,
) {
  const reachable = new Set<string>();

  const visit = (id: string) => {
    if (id.startsWith("vendor:") || reachable.has(id)) return;
    const item = next.modules[id];
    if (!item) throw new Error(`File not found: ${id}`);
    reachable.add(id);
    for (const dep of [...item.dependencies, ...item.dynamicDependencies]) visit(dep);
  };

  visit(next.entry);
  for (const id of next.styles) visit(id);
  const removed = new Set([...records.keys()].filter((id) => !reachable.has(id)));

  const affected = new Set(
    [...records.keys()].filter(
      (id) =>
        !removed.has(id) &&
        (!sameExecution(next.modules[id], previous?.modules[id]) ||
          records.get(id)!.invalidated ||
          failedModules.has(id)),
    ),
  );

  if (!previous) affected.add(next.entry);
  const parents = new Map<string, Set<string>>();
  for (const [id, record] of records)
    if (!removed.has(id))
      for (const dep of new Set([
        ...record.dependencies,
        ...(next.modules[id]?.dependencies || []),
      ])) {
        if (!parents.has(dep)) parents.set(dep, new Set());
        parents.get(dep)!.add(id);
      }

  const propagate = () => {
    for (const id of affected) {
      const old = records.get(id);
      if (
        next.modules[id]?.kind === "css" ||
        (old && !old.invalidated && (old.boundary !== null || old.accept))
      )
        continue;
      for (const parent of parents.get(id) || [])
        if (!old || !acceptsDependency(old, records.get(parent), id)) affected.add(parent);
    }
  };

  propagate();
  return { removed, affected, parents, propagate };
}
