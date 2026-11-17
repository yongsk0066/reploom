import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["json", { outputFile: `${root}test-results/playground-results.json` }]],
  outputDir: `${root}test-results/playground`,
  use: {
    baseURL: "http://127.0.0.1:4331",
    headless: true,
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  projects: ["chromium", "firefox", "webkit"].map((browserName) => ({
    name: browserName,
    use: { browserName: browserName as "chromium" | "firefox" | "webkit" },
  })),
  webServer: {
    command: "node scripts/serve.mjs artifacts/browser-site",
    cwd: root,
    url: "http://127.0.0.1:4331/regression/",
    reuseExistingServer: false,
  },
});
