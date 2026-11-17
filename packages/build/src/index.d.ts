import type { ProjectDefinition } from "@yongsk0066/reploom";
import type { Manifest } from "@yongsk0066/reploom/browser";

export interface PrepareOptions {
  projects: readonly ProjectDefinition[];
  /** Directory containing the consumer's package.json and installed dependencies. */
  projectRoot?: string;
  /** Output directory on disk. Relative paths resolve against projectRoot. */
  outDir: string;
  /** Root-relative URL directory at which the output will be served. */
  publicBase?: string;
  /** Root for project resources; defaults to projectRoot/public. */
  publicDir?: string;
  /** Opt-in local tsrs checker. Install @tsrs/wasm and dependency type packages in projectRoot. */
  typecheck?: boolean | { packages?: readonly string[]; compilerOptions?: Record<string, unknown> };
}

export function prepareProjects(options: PrepareOptions): Promise<Manifest>;
