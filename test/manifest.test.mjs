import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const extensionUrl = new URL("../extension/", import.meta.url);

test("manifest uses only the required standing grants and ships every icon size", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", extensionUrl), "utf8"));
  assert.deepEqual(manifest.permissions, ["debugger", "storage", "alarms"]);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.optional_permissions, undefined);

  const expected = { 16: "icons/ghost-16.png", 32: "icons/ghost-32.png", 48: "icons/ghost-48.png", 128: "icons/ghost-128.png" };
  assert.deepEqual(manifest.icons, expected);
  assert.deepEqual(manifest.action.default_icon, { 16: expected[16], 32: expected[32] });

  for (const [sizeText, path] of Object.entries(expected)) {
    const png = await readFile(new URL(path, extensionUrl));
    assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
    assert.equal(png.readUInt32BE(16), Number(sizeText));
    assert.equal(png.readUInt32BE(20), Number(sizeText));
  }
});

test("the real-browser smoke names its harness and preserves popup authorization", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", extensionUrl), "utf8"));
  const smoke = await readFile(new URL("../contrib/smoke.mjs", extensionUrl), "utf8");
  assert.equal(packageJson.scripts.smoke, "bun contrib/smoke.mjs");
  assert.equal(smoke.split("\n", 1)[0], "#!/usr/bin/env bun");
  assert.match(smoke, /bun packages\/chromium-extension\/contrib\/smoke\.mjs/);
  assert.match(smoke, /in-process relay harness/);
  assert.doesNotMatch(smoke, /real ghostd/);
  assert.match(smoke, /ordinary popup page renders without exposing relay settings/);
  assert.match(smoke, /rendered\.token === 0/);
  assert.doesNotMatch(smoke, /rendered\.token === 64/);
  assert.match(smoke, /ghost-relay-smoke-screenshots-/);
  assert.match(smoke, /process\.env\.OMARCHY_SCREENSHOT_DIR = screenshotDir/);
  assert.match(smoke, /delete process\.env\.OMARCHY_SCREENSHOT_DIR/);
  assert.match(smoke, /process\.env\.OMARCHY_SCREENSHOT_DIR = callerScreenshotDir/);
  assert.match(smoke, /removeScratchDirectory\(screenshotDir, "ghost-relay-smoke-screenshots-"\)/);
  assert.match(smoke, /"Runtime\.enable"[\s\S]*"Page\.navigate"/);
  assert.match(smoke, /diagnostics\.exceptions\.length === 0/);
  assert.match(smoke, /process\.on\("SIGINT"[\s\S]*requestSignalCleanup\("SIGINT", 130\)/);
  assert.match(smoke, /process\.on\("SIGTERM"[\s\S]*requestSignalCleanup\("SIGTERM", 143\)/);
  assert.match(smoke, /--wait-for-cleanup-signal/);
  assert.match(smoke, /cleanupPromise \?\?= runCleanup\(\)/);
  assert.match(smoke, /markBodyFinished\(\);[\s\S]*await cleanupSmoke\(\)/);
  assert.match(smoke, /writeSync\(2,/);
});

test("the reused Lucide icon stays accessible and carries its license notice", async () => {
  const svg = await readFile(new URL("icons/ghost.svg", extensionUrl), "utf8");
  const notices = await readFile(new URL("../../../THIRD_PARTY_NOTICES.md", extensionUrl), "utf8");
  assert.match(svg, /<title>Ghost<\/title>/);
  assert.match(notices, /## Lucide[\s\S]*Copyright \(c\) 2026 Lucide Icons and Contributors/);
  assert.match(
    notices,
    /Permission to use, copy, modify, and\/or distribute this software[\s\S]*USE OR PERFORMANCE OF THIS SOFTWARE\./,
  );
});
