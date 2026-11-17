import { countPrimes } from "./primes.ts";
import settings from "./settings.json";
import clsx from "clsx";

export function run({
  state,
  report,
}: {
  state: Record<string, unknown>;
  report(value: unknown): void;
}) {
  const started = performance.now();
  report({ status: "Counting primes." });
  const count = countPrimes(settings.limit);
  state.runs = Number(state.runs || 0) + 1;
  return {
    title: clsx("Worker", "computation"),
    limit: settings.limit,
    primes: count,
    runs: state.runs,
    milliseconds: Math.round(performance.now() - started),
    documentAvailable: typeof document !== "undefined",
  };
}
