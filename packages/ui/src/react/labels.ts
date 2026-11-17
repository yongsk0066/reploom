import type { ProjectState } from "@yongsk0066/reploom";

export type PlaygroundLabels = {
  tools: string;
  files: string;
  path: string;
  addFile: string;
  moveFile: string;
  removeFile: string;
  projectSnapshot: string;
  includeState: string;
  saveProject: string;
  restoreSaved: string;
  openProject: string;
  runTests: string;
  checkTypes: string;
  loading: string;
  rerun: string;
  reset: string;
  resetDescription: string;
  confirmReset: string;
  cancel: string;
  rerunHint: string;
  view: string;
  code: string;
  split: string;
  expand: string;
  collapse: string;
  help: string;
  file: string;
  preview: string;
  edit: string;
  editorFallback: string;
  source(path: string): string;
  console(count: number): string;
  hint(runtime: "react" | "dom" | "compute"): string;
  status(state: ProjectState): string;
};

export const defaultLabels: Readonly<PlaygroundLabels> = Object.freeze({
  tools: "Project tools",
  files: "Files",
  path: "Destination path",
  addFile: "Add file",
  moveFile: "Move selected file",
  removeFile: "Remove selected file",
  projectSnapshot: "Save and restore",
  includeState: "Include explicitly registered state",
  saveProject: "Save project",
  restoreSaved: "Restore saved project",
  openProject: "Open project archive",
  runTests: "Run isolated tests",
  checkTypes: "Check types",
  loading: "Loading example…",
  rerun: "Run again",
  reset: "Reset source",
  resetDescription:
    "Restore the original files and restart the preview? Your edits and current preview state will be lost.",
  confirmReset: "Restore original",
  cancel: "Cancel",
  rerunHint: "Restart the preview with your current code. Preview state will reset.",
  view: "View",
  code: "Code",
  split: "Both",
  expand: "Expand",
  collapse: "Collapse",
  help: "Live updates",
  file: "File",
  preview: "Preview",
  edit: "Edit code",
  editorFallback: "The code editor could not load. A plain text editor is available.",
  source: (path) => `${path} code`,
  console: (count) => `Console (${count})`,
  hint: (runtime) =>
    runtime === "compute"
      ? "Runs in a separate Worker. Stopping or timing out resets Worker state."
      : runtime === "dom"
        ? "Edits preserve the explicit state bag. Run again resets it."
        : "Compatible edits preserve component state. Changing hooks may remount components.",
  status(state) {
    switch (state.phase) {
      case "loading":
        return "Loading example…";
      case "starting":
        return "Applying changes…";
      case "compiling":
        return "Compiling changes…";
      case "disposed":
        return "Example closed.";
      case "editing":
        return state.reason === "composition"
          ? "Waiting for composition to finish…"
          : state.reason === "restart"
            ? "Restarting…"
            : "Waiting for edits…";
      case "error":
        return state.requiresRestart
          ? "Resources retired. Edit the code to restart the preview."
          : state.stage === "load"
            ? "Could not load the example."
            : state.stage === "compile"
              ? "Compilation failed. The last working preview is preserved."
              : "The example reported a runtime error.";
      case "ready":
        return {
          initial: "Running",
          styles: "Styles updated; state preserved",
          refreshed: "Changes applied",
          remounted: "Component remounted; some state may have reset",
          recovered: "Recovered from error",
          computed: "Computation complete",
          cancelled: "Computation stopped",
        }[state.outcome];
    }
  },
});
