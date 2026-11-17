/** Admission owns timing only. Revisions, cancellation and publication stay in the session. */
export interface UpdateAdmission {
  input(now: number, immediate: boolean): number;
  started(revision: number, now: number): void;
  settled(revision: number, now: number): void;
  reset(): void;
}

export function createUpdateAdmission(fixedDelay?: number): UpdateAdmission {
  let first: number | undefined;
  let last: number | undefined;
  let interval = 0;
  let cost = 4;
  let running: { revision: number; start: number } | undefined;
  return {
    input(now, immediate) {
      if (immediate) {
        first = last = undefined;
        return 0;
      }
      if (fixedDelay !== undefined) return fixedDelay;
      const continuing = first !== undefined || running !== undefined;
      if (last !== undefined) {
        const gap = Math.max(0, now - last);
        interval = gap <= 250 ? (interval ? interval * 0.5 + gap * 0.5 : gap) : 0;
      }
      first ??= now;
      last = now;
      const trailing = continuing ? Math.min(120, Math.max(40, interval * 1.25, cost * 2)) : 40;
      return Math.max(0, Math.min(trailing, first + 240 - now));
    },
    started(revision, now) {
      first = undefined;
      running = { revision, start: now };
    },
    settled(revision, now) {
      if (running?.revision !== revision) return;
      cost = cost * 0.75 + Math.min(200, Math.max(0, now - running.start)) * 0.25;
      running = undefined;
      if (first === undefined) {
        last = undefined;
        interval = 0;
      }
    },
    reset() {
      first = last = undefined;
      interval = 0;
      running = undefined;
    },
  };
}
