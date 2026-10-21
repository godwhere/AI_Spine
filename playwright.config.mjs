import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  outputDir: process.env.ISPINE_BROWSER_OUTPUT || "/tmp/ispine-browser-results",
  reporter: "list",
  use: { channel: "chrome", headless: true, viewport: { width: 1440, height: 1000 }, trace: "retain-on-failure" },
});
