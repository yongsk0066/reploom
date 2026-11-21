import { useLayoutEffect, useState, useSyncExternalStore, type RefObject } from "react";

export type DisplayPreferences = {
  numbers: "editing" | "always" | "off";
  wrap: "auto" | "on" | "off";
  fontSize: "base" | "large" | "larger";
  theme: "site" | "light" | "dark";
};

export const defaults: DisplayPreferences = Object.freeze({
  numbers: "editing",
  wrap: "auto",
  fontSize: "base",
  theme: "site",
});

const key = "reploom.display.v1";

const choices = {
  numbers: ["editing", "always", "off"],
  wrap: ["auto", "on", "off"],
  fontSize: ["base", "large", "larger"],
  theme: ["site", "light", "dark"],
} as const;

function decode(raw: string | null): DisplayPreferences {
  const result = { ...defaults };
  const values = raw ? JSON.parse(raw) : null;
  if (values && typeof values === "object") {
    for (const name of Object.keys(choices) as (keyof DisplayPreferences)[]) {
      if ((choices[name] as readonly string[]).includes(values[name]))
        Object.assign(result, { [name]: values[name] });
    }
  }
  return result;
}

const listeners = new Set<() => void>();
let current = defaults;

function notify() {
  for (const listener of listeners) listener();
}

function read() {
  try {
    const next = decode(window.localStorage.getItem(key));
    if (
      (Object.keys(defaults) as (keyof DisplayPreferences)[]).every(
        (name) => next[name] === current[name],
      )
    )
      return;
    current = next;
    notify();
  } catch {
    /* Storage may be unavailable in an embedded document. */
  }
}

function storage(event: StorageEvent) {
  if (event.key === null || event.key === key) read();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener("storage", storage);
    read();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener("storage", storage);
  };
}

function change(next: DisplayPreferences) {
  current = next;
  try {
    window.localStorage.setItem(key, JSON.stringify(next));
  } catch {
    /* In-memory preferences remain usable. */
  }
  notify();
}

export function useDisplayPreferences() {
  return [
    useSyncExternalStore(
      subscribe,
      () => current,
      () => defaults,
    ),
    change,
  ] as const;
}

export function useNarrowLayout(host: RefObject<HTMLElement | null>) {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = host.current!;
    // CSS owns the breakpoint, including when a desktop host changes its article width.
    const read = () => setNarrow(getComputedStyle(el).getPropertyValue("--_narrow").trim() === "1");
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [host]);
  return narrow;
}
