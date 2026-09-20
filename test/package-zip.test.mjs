/**
 * The store upload is the runtime files at the repository root, and nothing
 * else: no tests, no docs, no packaging script.
 *
 * "No remote code" is easiest to hold when the bytes reviewed and the bytes that
 * run are the same, so packaging must never gain a build step that could quietly
 * add, drop, or rewrite a file. This runs the real script and compares the
 * archive's entries with the real tree.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, test } from "node:test";

const run = promisify(execFile);
const packageDir = fileURLToPath(new URL("..", import.meta.url));
const extensionDir = packageDir;

let outDir = null;
after(async () => {
  if (outDir !== null) await rm(outDir, { recursive: true, force: true });
});

/** What Chrome runs: the manifest, every script and page at the root, the icons. */
async function runtimeFiles(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(extensionDir, join(entry.parentPath, entry.name)))
    .filter((path) => path === "manifest.json" || path.startsWith("icons/")
      || (!path.includes("/") && /\.(js|html)$/.test(path)))
    .sort();
}

test("package.sh zips exactly the runtime files, rooted at the manifest", async () => {
  outDir = await mkdtemp(join(tmpdir(), "ghost-relay-package-"));
  const { stdout } = await run("bash", [join(packageDir, "contrib", "package.sh"), outDir]);
  const [zipPath, ...listed] = stdout.trim().split("\n");

  assert.match(zipPath, /ghost-browser-relay-\d+\.\d+\.\d+\.zip$/);
  assert.deepEqual(listed.sort(), await runtimeFiles(extensionDir));
  assert.ok(listed.includes("manifest.json"), "the manifest is at the archive root");
  for (const entry of listed) {
    assert.ok(!/^(test|contrib)\//.test(entry) && !entry.endsWith(".md"),
      `${entry} is not a runtime file`);
  }
});
