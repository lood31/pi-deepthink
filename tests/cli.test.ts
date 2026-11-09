import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { sessionText, tempDirectory } from "./helpers.ts";

test("CLI replays 12 synthetic sessions read-only and creates 20 unjudged review samples, separately from live", async () => {
  const root = await tempDirectory("cli");
  const input = join(root, "input");
  const output = join(root, "output");
  await mkdir(input);
  const before: string[] = [];
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  for (let i = 0; i < 12; i++) {
    const text = sessionText(8, "synthetic-" + i);
    before.push(sha(text));
    await writeFile(join(input, i + ".jsonl"), text);
  }
  const env: NodeJS.ProcessEnv = { ...process.env, PI_SCHEDULER_DATA_DIR: join(root, "isolated-data") };
  delete env.PI_SCHEDULER_CONFIG;
  const run = spawnSync(process.execPath, [resolve("replay.ts"), input, "--out", output], { encoding: "utf8", env });
  assert.equal(run.status, 0, run.stderr);
  const runs = await readdir(output);
  assert.equal(runs.length, 1);
  const runDirectory = join(output, runs[0]!);
  const summary = JSON.parse(await readFile(join(runDirectory, "summary.json"), "utf8"));
  assert.equal(summary.sessions.length, 12);
  assert.equal(summary.report.source, "replay");
  assert.equal(summary.report.interventions, 0);
  const review = await readFile(join(runDirectory, "review.md"), "utf8");
  assert.equal(review.split("\n").filter(x => x.includes("| 待判断 |")).length, 20);
  for (let i = 0; i < 12; i++) assert.equal(sha(await readFile(join(input, i + ".jsonl"), "utf8")), before[i]);
  const report = spawnSync(process.execPath, [resolve("report.ts"), runDirectory], { encoding: "utf8", env });
  assert.equal(report.status, 0, report.stderr);
  assert.ok(report.stdout.includes("已落会话介入 0"));
});
test("CLI requires explicit source/output, rejects invalid inputs and does not silently pass", async () => {
  const root = await tempDirectory("bad-cli");
  const source = join(root, "invalid.jsonl");
  await writeFile(source, "{broken");
  const run = spawnSync(process.execPath, [resolve("replay.ts"), source, "--out", join(root, "out")], {
    encoding: "utf8", env: { ...process.env, PI_SCHEDULER_DATA_DIR: join(root, "isolated-data") },
  });
  assert.equal(run.status, 1);
  const missing = spawnSync(process.execPath, [resolve("replay.ts")], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.ok(missing.stderr.includes("Usage:"));
});
