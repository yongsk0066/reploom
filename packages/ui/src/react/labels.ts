import type { ProjectState } from "@yongsk0066/reploom";

import type { ComputeLabels } from "@yongsk0066/reploom/browser";

export type PlaygroundLabels = {
  settings: string;
  lineNumbers: string;
  lineWrap: string;
  fontSize: string;
  theme: string;
  whenEditing: string;
  always: string;
  off: string;
  on: string;
  fit: string;
  siteDefault: string;
  large: string;
  larger: string;
  light: string;
  dark: string;
  resetDisplay: string;
  copySource: string;
  copied: string;
  copyFailed: string;
  lastWorking: string;
  clearConsole: string;
  checks: string;
  runningCheck: string;
  passedCheck: string;
  failedCheck: string;
  fileExists: string;
  fileRejected: string;
  archiveTooLarge: string;
  compute: ComputeLabels;
  removeNamed(path: string): string;
  omitted(count: number): string;
  share: string;
  shareLink: string;
  copyLink: string;
  openLink: string;
  linkCopied: string;
  copyManually: string;
  shareFailed: string;
  shareTooLarge: string;
  close: string;
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
  settings: "Display settings",
  lineNumbers: "Line numbers",
  lineWrap: "Wrap long lines",
  fontSize: "Code text size",
  theme: "Color theme",
  whenEditing: "While editing",
  always: "Always show",
  off: "Off",
  on: "On",
  fit: "Fit available width",
  siteDefault: "Site default",
  large: "Large",
  larger: "Larger",
  light: "Light",
  dark: "Dark",
  resetDisplay: "Reset display settings",
  copySource: "Copy file",
  copied: "File copied",
  copyFailed: "Select the code and copy it.",
  lastWorking: "Showing last working result",
  clearConsole: "Clear console",
  checks: "Checks",
  runningCheck: "Checking…",
  passedCheck: "Passed",
  failedCheck: "Failed",
  fileExists: "A file already uses this name.",
  fileRejected: "Use a supported project filename. A project can contain up to 32 files.",
  archiveTooLarge: "Choose a project file smaller than 5 MiB.",
  compute: {
    output: "Compute output",
    stop: "Stop computation",
    stopped: "Computation stopped. Edit the code or run it again.",
    complete: "Computation complete",
    failed: "Computation failed. Edit the code to run it in a new Worker.",
    cancelled: "Computation stopped; Worker state was reset.",
    computing: "Computing",
  },
  removeNamed: (path) => "Delete " + path,
  omitted: (count) => count + " earlier or excess messages omitted.",
  share: "Share example",
  shareLink: "Project link",
  copyLink: "Copy link",
  openLink: "Open shared example",
  linkCopied: "Link copied.",
  copyManually: "Select and copy the link.",
  shareFailed: "Could not create the link.",
  shareTooLarge: "This project is too large for a link. Save it as a file.",
  close: "Close",
  tools: "Project tools",
  files: "Files",
  path: "New file path",
  addFile: "Add file",
  moveFile: "Move selected file",
  removeFile: "Remove selected file",
  projectSnapshot: "Save and restore",
  includeState: "Include saved preview state",
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
