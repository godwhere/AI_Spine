import { build } from "vite";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test, expect } from "./fixtures.mjs";

test("the extracted engine uses real browser pixel ports and preserves runtime/export behavior", async ({ page, isolatedClient }) => {
  await build({ configFile: false, logLevel: "silent", build: { outDir: isolatedClient.clientRoot, emptyOutDir: false,
    lib: { entry: fileURLToPath(new URL("./engine-probe.mjs", import.meta.url)), formats: ["es"], fileName: () => "engine-probe.js" } } });
  const baseline = JSON.parse(await readFile(new URL("../../docs/evidence/architecture-p2/engine-before.json", import.meta.url), "utf8"));
  const result = await page.evaluate(async () => (await import("/engine-probe.js")).runEngineProbe());
  expect(result.maximumFootError).toBeLessThan(.5);
  expect(result.feetAfterRelease).toEqual({ left: false, right: false });
  expect(result.hasVisiblePixels).toBe(true);
  expect(result.authoredRoundTrip).toBe(true);
  expect(result.animations).toEqual(["idle", "attack", "hit", "release_test"]);
  expect(result.fingerprint).toBe(baseline.templates[22].fingerprint);
  expect(result.pngCount).toBe(result.basePartCount);
  expect(result.basePartCount).toBeGreaterThan(0);
});
