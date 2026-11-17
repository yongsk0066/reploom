import { cloneState, type StateValue } from "../project/snapshot.ts";

type Cell = { value: StateValue; version: number };

type Entry = { cell: Cell; observed: boolean; written: boolean; handle?: { value: StateValue } };

export class StateConflict extends Error {
  readonly key: string;

  constructor(key: string) {
    super(
      `Managed state changed during module evaluation: ${key}. Retry the edit against the current state.`,
    );
    this.key = key;
  }
}

function equal(a: StateValue, b: StateValue): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) =>
        Object.hasOwn(b, key) &&
        equal((a as Record<string, StateValue>)[key], (b as Record<string, StateValue>)[key]),
    )
  );
}

type Parent = {
  snapshot(): Record<string, StateValue>;
  lookup(key: string): Cell | undefined;
};

/** Staging owns private values; publication transfers cells only after every module validates. */
export function createManagedState(initial: Record<string, StateValue> = {}, parent?: Parent) {
  let previous = parent;
  let base = previous ? previous.snapshot() : cloneState(initial);
  const versions = new Map(Object.keys(base).map((key) => [key, previous?.lookup(key)?.version]));
  const entries = new Map<string, Entry>();
  let staged = true;

  const store = {
    lookup: (key: string) => entries.get(key)?.cell,
    cell<T extends StateValue>(key: string, initial: T): { value: T } {
      if (!key || key.length > 256) throw new Error("State keys require 1–256 characters");
      let entry = entries.get(key);
      if (!entry) {
        if (entries.size >= 128) throw new Error("A module supports at most 128 state cells");
        entry = {
          cell: { value: cloneState(Object.hasOwn(base, key) ? base[key] : initial), version: 0 },
          observed: false,
          written: false,
        };
        entries.set(key, entry);
      }
      const owned = entry;
      return (owned.handle ??= {
        get value() {
          if (staged) owned.observed = true;
          return owned.cell.value as T;
        },
        set value(value: T) {
          if (staged) owned.written = true;
          owned.cell.value = value;
          owned.cell.version++;
        },
      }) as { value: T };
    },
    fork() {
      return createManagedState({}, store);
    },
    prepare(): () => void {
      const transfers: Array<{ entry: Entry; target?: Cell; value: StateValue; replace: boolean }> =
        [];

      for (const [key, entry] of entries) {
        const target = previous?.lookup(key);
        const value = cloneState(entry.cell.value);

        const changed =
          target &&
          (target.version !== versions.get(key) || !equal(cloneState(target.value), base[key]));

        if (changed && (entry.observed || entry.written)) throw new StateConflict(key);
        transfers.push({
          entry,
          target,
          value,
          replace: entry.written || (entry.observed && !equal(value, base[key])),
        });
      }
      return () => {
        for (const { entry, target, value, replace } of transfers) {
          if (target) {
            if (replace) {
              target.value = value;
              target.version++;
            }
            entry.cell = target;
          }
        }
        staged = false;
        previous = undefined;
        base = {};
        versions.clear();
      };
    },
    discard() {
      previous = undefined;
      base = {};
      versions.clear();
      staged = false;
    },
    snapshot(): Record<string, StateValue> {
      return cloneState(
        Object.fromEntries([...entries].map(([key, entry]) => [key, entry.cell.value])),
      );
    },
  };

  return store;
}
