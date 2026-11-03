// Planted: a default test that starts a browser. scripts/ci/default-tests.mjs must refuse it (the workflow
// readme-fresh-run and default-tests.test.mjs both run the gate on this folder and expect a failure).
import { test } from "node:test";

const launchBrowser = async () => ({ close: async () => {} });

test("planted: a default test that launches a browser", async () => {
  const browser = await launchBrowser("chromium");
  await browser.close();
});
