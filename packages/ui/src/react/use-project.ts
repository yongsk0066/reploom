import { useMemo, useSyncExternalStore } from "react";
import type { ProjectSession, ProjectView } from "@yongsk0066/reploom";

export function useProject<T>(
  session: ProjectSession,
  select: (view: ProjectView) => T,
  equal?: (a: T, b: T) => boolean,
) {
  const store = useMemo(() => session.observe(select, equal), [session, select, equal]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}

export const shallow = <T extends Record<string, unknown>>(a: T, b: T) =>
  Object.keys(a).every((key) => a[key] === b[key]);
