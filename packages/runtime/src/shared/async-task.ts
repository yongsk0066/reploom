type Waiter<T> = { resolve(value: T): void; reject(error: unknown): void; clear(): void };

/** One producer, detachable consumers, and cancellation when the last consumer leaves. */
export function createSharedTask<T>(
  run: (signal: AbortSignal) => Promise<T>,
  options: { signal: AbortSignal; timeoutMs: number; rejected?(error: unknown): void },
) {
  const controller = new AbortController();
  const waiters = new Set<Waiter<T>>();
  let result: { value: T } | { error: unknown } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function finish(outcome: NonNullable<typeof result>) {
    if (result) return;
    result = outcome;
    clearTimeout(timer);
    options.signal.removeEventListener("abort", ownerAbort);
    if ("error" in outcome) options.rejected?.(outcome.error);
    for (const waiter of waiters) {
      waiter.clear();
      if ("error" in outcome) waiter.reject(outcome.error);
      else waiter.resolve(outcome.value);
    }
    waiters.clear();
  }

  function cancel(reason: unknown) {
    finish({ error: reason });
    controller.abort(reason);
  }

  const ownerAbort = () => cancel(options.signal.reason);
  if (options.signal.aborted) ownerAbort();
  else {
    options.signal.addEventListener("abort", ownerAbort, { once: true });
    timer = setTimeout(
      () => cancel(new DOMException("Asset download timed out", "TimeoutError")),
      options.timeoutMs,
    );
    void Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return run(controller.signal);
      })
      .then(
        (value) => finish({ value }),
        (error) => cancel(error),
      );
  }

  return {
    read(signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (result)
        return "error" in result ? Promise.reject(result.error) : Promise.resolve(result.value);
      return new Promise((resolve, reject) => {
        const waiter: Waiter<T> = {
          resolve,
          reject,
          clear: () => signal?.removeEventListener("abort", abort),
        };

        const abort = () => {
          waiter.clear();
          waiters.delete(waiter);
          reject(signal!.reason);
          if (!waiters.size) cancel(signal!.reason);
        };

        waiters.add(waiter);
        signal?.addEventListener("abort", abort, { once: true });
      });
    },
  };
}
