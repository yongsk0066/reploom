import type { Diagnostic, ProgramPatch } from "../../shared/protocol.ts";
import type { ResourcePayloads } from "../../project/definition.ts";
import type { Inspection, InspectionResult } from "../../shared/protocol.ts";
import type { ManagedState } from "../../project/snapshot.ts";

export type ComputeCommand =
  | {
      type: "run";
      id: string;
      patch: ProgramPatch;
      assets?: ResourcePayloads;
      state?: ManagedState;
    }
  | { type: "inspect"; id: string; request: Inspection }
  | { type: "ping"; id: number }
  | { type: "dispose" };

export type ComputeReply =
  | { type: "inspection"; id: string; result: InspectionResult }
  | { type: "ready" }
  | { type: "pong"; id: number }
  | { type: "progress" | "log"; id: string; text: string }
  | {
      type: "settled";
      id: string;
      ok: boolean;
      text: string;
      diagnostics: Diagnostic[];
      state?: ManagedState;
    }
  | { type: "fatal"; diagnostics: Diagnostic[] }
  | { type: "diagnostic"; diagnostics: Diagnostic[] }
  | { type: "invalidate"; moduleId: string }
  | { type: "disposed"; diagnostics: Diagnostic[] };

// Formatting happens in the compute Worker. Only bounded strings cross back to
// the UI; no getters/toJSON or unbounded structured-clone result are requested.
export function displayValue(value: unknown): string {
  let remaining = 300;

  function visit(value: unknown, depth: number): unknown {
    if (--remaining < 0 || depth > 5) return "[…]";
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "string") return value.slice(0, 2000);
    if (typeof value !== "object") return String(value);
    if (ArrayBuffer.isView(value)) {
      if (value instanceof DataView) return `[DataView ${value.byteLength} bytes]`;

      const view = value as unknown as {
        length: number;
        [key: number]: unknown;
      };

      return Array.from({ length: Math.min(view.length, 32) }, (_, i) => visit(view[i], depth + 1));
    }

    const result: Record<string, unknown> | unknown[] = Array.isArray(value)
      ? []
      : Object.create(null);

    let count = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (++count > 32 || remaining < 0) break;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      const child = "value" in descriptor ? visit(descriptor.value, depth + 1) : "[Getter]";
      if (Array.isArray(result)) result.push(child);
      else result[key] = child;
    }
    return result;
  }

  try {
    return JSON.stringify(visit(value, 0), null, 2).slice(0, 32_000);
  } catch {
    return "[Unserializable value]";
  }
}
