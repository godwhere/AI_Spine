import { test as base, expect } from "@playwright/test";
import { buildIsolatedClient, startIsolatedWorkbench } from "../support/isolated-workbench.mjs";

export const test = base.extend({
  storageFormat: [Number(process.env.ISPINE_BROWSER_FORMAT || 1), { option: true }],
  isolatedClient: [async ({}, use) => {
    const client = await buildIsolatedClient();
    try { await use(client); } finally { await client.close(); }
  }, { scope: "worker" }],
  workbench: async ({ isolatedClient, storageFormat }, use) => {
    const server = await startIsolatedWorkbench({ clientRoot: isolatedClient.clientRoot, storageFormat });
    expect(server.openedOrigins).toEqual([server.origin]);
    try { await use(server); } finally { await server.close(); }
  },
  page: async ({ page, workbench }, use) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // A real browser still must not contact an account or remote asset service.
    await page.context().route("**/*", (route) => {
      const url = new URL(route.request().url());
      return url.origin === workbench.origin || ["data:", "blob:"].includes(url.protocol) ? route.continue() : route.abort();
    });
    await page.goto(workbench.origin);
    await use(page);
    expect(errors).toEqual([]);
  },
});
export { expect };
