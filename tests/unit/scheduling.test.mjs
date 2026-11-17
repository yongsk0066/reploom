import test from "node:test";
import assert from "node:assert/strict";
import { createTaskScheduler } from "../../packages/runtime/src/shared/scheduling.ts";

test("fallback yields a task, reuses its ports and settles queued callers on disposal", async () => {
  const Original = globalThis.MessageChannel;
  let channels = 0;
  globalThis.MessageChannel = class extends Original {
    constructor() {
      super();
      channels++;
    }
  };
  const scheduler = createTaskScheduler();
  try {
    let settled = false;
    const first = scheduler.yieldTask().then(() => (settled = true));
    await Promise.resolve();
    assert.equal(settled, false, "a microtask is not a task yield");
    await first;
    for (let i = 0; i < 20; i++) await scheduler.yieldTask();
    assert.equal(channels, 1);
    const pending = [scheduler.yieldTask(), scheduler.yieldTask()];
    scheduler.dispose();
    await Promise.all(pending);
    await scheduler.yieldTask();
    assert.equal(channels, 1, "disposed work cannot create another channel");
  } finally {
    scheduler.dispose();
    globalThis.MessageChannel = Original;
  }
});
