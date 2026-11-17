// Public, framework-independent entry point. Importing it creates no resources.
export { ProjectSession } from "./project/session.ts";

export { createUpdateAdmission } from "./project/update-admission.ts";

export type { UpdateAdmission } from "./project/update-admission.ts";

export type {
  ProjectState,
  ProjectView,
  SourceText,
  SourceFiles,
  SessionServices,
  LoadedProject,
} from "./project/session.ts";

export { defineProject } from "./project/definition.ts";

export type {
  ProjectArchive,
  FileOperation,
  ManagedState,
  StateValue,
} from "./project/snapshot.ts";

export type {
  ProjectDefinition,
  ResourceOptions,
  ResourcePolicy,
  ResourcePayloads,
} from "./project/definition.ts";

export type { TextEdit, TextPatch } from "./shared/source-patch.ts";

export type {
  Compilation,
  ExecutableProgram,
  Snapshot,
  Diagnostic,
  CompilePriority,
  TestResult,
} from "./shared/protocol.ts";
