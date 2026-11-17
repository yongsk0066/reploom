import { validateFiles, type Files } from "./definition.ts";
import type { SourceFiles } from "../shared/source-patch.ts";

export type StateValue =
  | null
  | boolean
  | number
  | string
  | StateValue[]
  | { [key: string]: StateValue };

export type ManagedState = Record<string, Record<string, StateValue>>;

export type ProjectArchive = Readonly<{
  schema: 1;
  project: string;
  projectKey: string;
  files: Files;
  active: string;
  state?: ManagedState;
}>;

export type FileOperation =
  | { type: "write"; path: string; source: string }
  | { type: "remove"; path: string }
  | { type: "move"; from: string; to: string };

function validateContainer(value: object) {
  if (
    Array.isArray(value) &&
    (value.length > 4096 ||
      Object.keys(value).length !== value.length ||
      Object.keys(value).some((key) => !/^(0|[1-9][0-9]*)$/.test(key)))
  )
    throw new Error("Managed state requires dense JSON arrays");
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== null && prototype !== Object.prototype)
    throw new Error("Managed state requires plain objects");
}

export function cloneState<T extends StateValue | ManagedState>(input: T): T {
  let remaining = 131072;
  let entries = 4096;
  const ancestors = new Set<object>();

  function copy(value: unknown, depth: number): StateValue {
    if (--entries < 0 || depth > 32) throw new Error("Managed state is too large or deep");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      if ((remaining -= value.length) < 0)
        throw new Error("Managed state exceeds 128 Ki characters");
      return value;
    }
    if (typeof value !== "object" || !value || ancestors.has(value))
      throw new Error("Managed state must contain finite JSON values without cycles");
    validateContainer(value);
    ancestors.add(value);

    const output: StateValue[] | Record<string, StateValue> = Array.isArray(value)
      ? []
      : Object.create(null);

    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable) continue;
      if (!("value" in descriptor) || (remaining -= key.length) < 0)
        throw new Error("Managed state cannot contain accessors or oversized keys");
      Object.defineProperty(output, key, {
        value: copy(descriptor.value, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    ancestors.delete(value);
    return output;
  }

  return copy(input, 0) as T;
}

export function transactFiles(
  source: SourceFiles,
  operations: readonly FileOperation[],
  entry: string,
  required: readonly string[] = [],
): SourceFiles {
  if (operations.length > 128) throw new Error("Too many file operations");
  const files = Object.assign(Object.create(null), source) as Record<string, SourceFiles[string]>;
  for (const operation of operations) {
    if (operation.type === "write") files[operation.path] = operation.source;
    else if (operation.type === "remove") {
      if (!Object.hasOwn(files, operation.path)) throw new Error(`Missing file: ${operation.path}`);
      delete files[operation.path];
    } else if (operation.type === "move") {
      if (!Object.hasOwn(files, operation.from) || Object.hasOwn(files, operation.to))
        throw new Error("Move requires an existing source and an unused destination");
      files[operation.to] = files[operation.from];
      delete files[operation.from];
    } else throw new Error("Invalid file operation");
  }
  validateFiles(
    Object.fromEntries(Object.entries(files).map(([id, value]) => [id, value.toString()])),
    entry,
  );
  for (const id of required)
    if (!Object.hasOwn(files, id)) throw new Error(`Required project file: ${id}`);
  return Object.freeze(files);
}

export function readArchive(
  input: unknown,
  project: string,
  projectKey: string,
  entry: string,
  required: readonly string[] = [],
): ProjectArchive {
  if (!input || typeof input !== "object") throw new Error("Invalid project archive");
  const value = input as ProjectArchive;
  if (
    value.schema !== 1 ||
    value.project !== project ||
    value.projectKey !== projectKey ||
    !value.files ||
    typeof value.files !== "object"
  )
    throw new Error("Archive does not match the prepared project");
  validateFiles(value.files, entry);
  for (const id of required)
    if (!Object.hasOwn(value.files, id)) throw new Error(`Required project file: ${id}`);
  return Object.freeze({
    schema: 1,
    project,
    projectKey,
    files: Object.freeze({ ...value.files }),
    active: Object.hasOwn(value.files, value.active) ? value.active : entry,
    ...(value.state ? { state: validateManagedState(value.state) } : {}),
  });
}

export function validateManagedState(input: ManagedState): ManagedState {
  const state = cloneState(input);
  if (!state || Array.isArray(state) || typeof state !== "object")
    throw new Error("Invalid managed state");
  for (const [id, values] of Object.entries(state)) {
    if (!id.startsWith("/") || !values || Array.isArray(values) || typeof values !== "object")
      throw new Error("Invalid module state");
  }
  return state;
}
