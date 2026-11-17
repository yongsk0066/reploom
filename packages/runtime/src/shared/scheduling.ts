// A real task boundary lets input/cancellation messages run. A microtask would
// not. Reuse one channel when native prioritized scheduling is unavailable;
// nested timers otherwise acquire the browser's minimum timer delay.
export function createTaskScheduler() {
  let channel: MessageChannel | undefined;
  let waiting: (() => void)[] = [];
  let closed = false;
  return {
    yieldTask(): Promise<void> {
      if (closed) return Promise.resolve();

      const scheduler = (
        globalThis as typeof globalThis & {
          scheduler?: { yield?: () => Promise<void> };
        }
      ).scheduler;

      if (typeof scheduler?.yield === "function") return scheduler.yield();
      if (!channel) {
        channel = new MessageChannel();
        channel.port1.onmessage = () => {
          const ready = waiting;
          waiting = [];
          for (const resolve of ready) resolve();
        };
      }
      return new Promise((resolve) => {
        waiting.push(resolve);
        if (waiting.length === 1) channel!.port2.postMessage(null);
      });
    },
    dispose() {
      closed = true;
      if (channel) {
        channel.port1.onmessage = null;
        channel.port1.close();
        channel.port2.close();
        channel = undefined;
      }
      // Release callers already crossing a boundary; their scope/revision guard
      // decides whether work may continue. Disposal must not strand promises.
      const ready = waiting;
      waiting = [];
      for (const resolve of ready) resolve();
    },
  };
}
