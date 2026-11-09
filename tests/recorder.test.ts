import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, utimes, stat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Recorder } from "../recorder.ts";
import { Runtime } from "../runtime.ts";
import { reportDirectory } from "../report.ts";
import { tempDirectory } from "./helpers.ts";
test("serial append records all rows, flush, privacy-safe format and report tolerates a torn final row", async () => {
  const directory = await tempDirectory("records");
  const recorder = new Recorder({ directory, retentionDays: 90 });
  await recorder.open();
  const engine = new Runtime({ source: "live", sessionId: "s", branch: "b", model: "x/y" }, {}, recorder);
  await Promise.all(Array.from({ length: 100 }, (_, i) => recorder.write(engine.row("test", { n: i }))));
  await recorder.flush();
  const lines = (await readFile(recorder.file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(lines.length, 100);
  assert.deepEqual(lines.map(r => r.n), Array.from({ length: 100 }, (_, i) => i));
  await writeFile(recorder.file, '{"torn":', { flag: "a" });
  const report = await reportDirectory(directory);
  assert.equal(report.malformedRows, 1);
  assert.equal(report.rows, 100);
});
test("90-day retention archives only explicitly named plugin files, never deletes", async () => {
  const directory = await tempDirectory("archive");
  const old = join(directory, "scheduler-1-12345678-abcd.jsonl");
  const unrelated = join(directory, "other.jsonl");
  await writeFile(old, "old-data");
  await writeFile(unrelated, "private-data");
  const past = new Date(Date.now() - 100 * 86400000);
  await utimes(old, past, past);
  await utimes(unrelated, past, past);
  const recorder = new Recorder({ directory, retentionDays: 90 });
  await recorder.open();
  assert.equal(recorder.healthy, true);
  assert.equal(await readFile(join(directory, "archive", "scheduler-1-12345678-abcd.jsonl"), "utf8"), "old-data");
  assert.equal(await readFile(unrelated, "utf8"), "private-data");
  await assert.rejects(stat(old));
});
test("write failure and bounded timeout disable recording without rejecting the caller", async () => {
  for (const append of [
    async () => { throw new Error("disk-full"); },
    async () => new Promise<never>(() => {}),
  ]) {
    const directory = await tempDirectory("failed");
    const recorder = new Recorder({ directory, retentionDays: 90, timeoutMs: 10, append });
    await recorder.open();
    const engine = new Runtime({ source: "live", sessionId: "s", branch: "b", model: "x/y" }, {}, recorder);
    assert.equal(await recorder.write(engine.row("score")), false);
    assert.equal(recorder.healthy, false);
    await recorder.flush();
  }
});
test("open fails safely when its directory is a file; concurrent recorders isolate files", async () => {
  const root = await tempDirectory("isolation");
  const file = join(root, "file");
  await writeFile(file, "not-a-directory");
  const failed = new Recorder({ directory: file, retentionDays: 90 });
  await failed.open();
  assert.equal(failed.healthy, false);
  const directory = join(root, "logs");
  await mkdir(directory);
  const a = new Recorder({ directory, retentionDays: 90 });
  const b = new Recorder({ directory, retentionDays: 90 });
  assert.notEqual(a.file, b.file);
});
