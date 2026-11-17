export let value = import.meta.hot.data.value ?? 0;

const listeners = new Set<() => void>();

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const timer = setInterval(() => {
  value++;
  for (const listener of listeners) listener();
}, 1000);

import.meta.hot.dispose((data) => {
  data.value = value;
  clearInterval(timer);
  listeners.clear();
});
