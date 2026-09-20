import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const run = promisify(execFile);
const extensionDir = new URL("../extension/", import.meta.url);

async function walk(dir, base = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = base === "" ? entry.name : `${base}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await walk(new URL(`${relative}/`, dir), relative));
    else files.push(relative);
  }
  return files.sort();
}

test("package.sh zips exactly extension/ with the manifest at the zip root", async () => {
  const out = join(tmpdir(), `ghost-store-pack-${process.pid}.zip`);
  try {
    await run("bash", [new URL("../contrib/package.sh", import.meta.url).pathname, "--out", out]);
    const { stdout } = await run("unzip", ["-Z1", out]);
    const zipped = stdout.split("\n").filter((line) => line !== "" && !line.endsWith("/")).sort();
    const shipped = await walk(extensionDir);
    assert.deepEqual(zipped, shipped);
    assert.ok(zipped.includes("manifest.json"));
    assert.ok(!zipped.some((name) => name.startsWith("extension/")));
  } finally {
    await rm(out, { force: true });
  }
});
