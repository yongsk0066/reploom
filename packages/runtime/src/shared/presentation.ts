export const defaultComputeLabels = Object.freeze({
  output: "Compute output",
  stop: "Stop computation",
  stopped: "Computation stopped. Edit the code or run it again.",
  complete: "Computation complete",
  failed: "Computation failed. Edit the code to run it in a new Worker.",
  cancelled: "Computation stopped; Worker state was reset.",
  computing: "Computing",
} as Record<
  "output" | "stop" | "stopped" | "complete" | "failed" | "cancelled" | "computing",
  string
>);

export type ComputeLabels = typeof defaultComputeLabels;

export type PreviewPresentation = { language?: string; compute?: ComputeLabels };
