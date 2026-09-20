import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const extensionUrl = new URL("../", import.meta.url);

test("manifest uses only the required standing grants and ships every icon size", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", extensionUrl), "utf8"));
  // Each of these is here because something the extension does needs it, and
  // nothing here grants reach over a page: `debugger` is branded by Chrome when
  // it attaches, `sidePanel` and `identity` show no warning at all, and the
  // chat's only network peer answers extension origins under ordinary CORS,
  // which is why there is no host grant for it either.
  assert.deepEqual(manifest.permissions, [
    "debugger", "storage", "alarms", "sidePanel", "identity",
  ]);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.equal(manifest.side_panel.default_path, "sidepanel.html");

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

test("the reused Lucide icon stays accessible and carries its license notice", async () => {
  const svg = await readFile(new URL("icons/ghost.svg", extensionUrl), "utf8");
  const notices = await readFile(new URL("THIRD_PARTY_NOTICES.md", extensionUrl), "utf8");
  assert.match(svg, /<title>Ghost<\/title>/);
  assert.match(notices, /## Lucide[\s\S]*Copyright \(c\) 2026 Lucide Icons and Contributors/);
  assert.match(
    notices,
    /Permission to use, copy, modify, and\/or distribute this software[\s\S]*USE OR PERFORMANCE OF THIS SOFTWARE\./,
  );
});
