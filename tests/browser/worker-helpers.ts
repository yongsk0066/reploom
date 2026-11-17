import type { Page, Worker } from "@playwright/test";

const names = new WeakMap<Worker, Promise<string>>();

// Worker roles are named explicitly. URL shapes vary with the host's bundler
// and verified Blob loading, and do not distinguish compiler/compute ownership.
export async function workersNamed(page: Page, name: string): Promise<Worker[]> {
  const selected = await Promise.all(
    page.workers().map(async (worker) => {
      let result = names.get(worker);
      if (!result) {
        result = worker.evaluate(() => self.name).catch(() => "");
        names.set(worker, result);
      }
      return (await result) === name ? worker : undefined;
    }),
  );

  return selected.filter((worker): worker is Worker => worker !== undefined);
}
