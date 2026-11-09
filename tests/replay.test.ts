import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSession, replayText, reviewTable } from "../replay.ts";
import { normalize } from "../signals.ts";
import { Runtime } from "../runtime.ts";
import { defaults } from "../config.ts";
import { MemorySink, sessionText } from "./helpers.ts";

test("branched history replays the selected path, never abandoned siblings", async () => {
  const base = sessionText(1);
  const original = parseSession(base);
  const branch = { type: "message", id: "new", parentId: "a0",
    message: { role: "toolResult", toolCallId: "c0", toolName: "write", isError: true, content: [{ type: "text", text: "Permission denied" }] } };
  const text = base + JSON.stringify(branch) + "\n";
  assert.deepEqual(parseSession(text).entries.map(e => e.id), ["a0", "new"]);
  assert.equal(parseSession(text, original.leaf).leaf, "rc0");
  const sink = new MemorySink();
  const r = await replayText(text, sink);
  assert.equal(r.steps, 1);
  assert.equal((sink.rows.find(r => r.type === "score")?.observation as { error: string }).error, "permission");
});
test("offline and live normalized events yield identical scheduler decisions", async () => {
  const source = sessionText(8, "s", true);
  const sink = new MemorySink();
  await replayText(source, sink);
  const liveSink = new MemorySink();
  const live = new Runtime({ source: "live", sessionId: "s", branch: "b", model: "fake/test" }, {}, liveSink);
  for (let i = 0; i < 8; i++) {
    await live.process(["a", "b"].map(suffix => normalize({
      id: "c" + i + suffix, name: i % 3 === 0 ? "write" : "read", input: { path: "a.ts" },
    }, { id: "", isError: false, content: i % 3 === 0 ? "Successfully wrote file" : "hello" }, defaults)));
  }
  const scores = (rows: MemorySink["rows"]) => rows.filter(r => r.type === "score")
    .map(r => [r.U, r.R, r.P, r.A, r.rawScore, r.score, r.proposedAction]);
  assert.deepEqual(scores(sink.rows), scores(liveSink.rows));
  assert.equal(live.step, 16);
});
test("model and compaction boundaries reset windows; missing results remain incomplete", async () => {
  const prefix = sessionText(1);
  const tail = [
    { type: "compaction", id: "compact", parentId: "rc0" },
    { type: "model_change", id: "model", parentId: "compact", provider: "fake", modelId: "other" },
    { type: "message", id: "aa", parentId: "model", message: { role: "assistant", provider: "fake", model: "other", stopReason: "toolUse",
      content: [{ type: "toolCall", id: "missing", name: "write", arguments: { path: "b" } }] } },
  ].map(x => JSON.stringify(x)).join("\n");
  const sink = new MemorySink();
  const r = await replayText(prefix + tail, sink);
  assert.equal(r.steps, 1);
  assert.ok(r.warnings.some(x => x.startsWith("missing-tool-result:")));
  assert.ok(sink.rows.some(r => r.type === "outcome" && r.complete === false));
});
test("invalid JSON, old versions, duplicate IDs, dangling parents, unknown leaves are rejected", () => {
  const source = sessionText(1);
  for (const text of ["{bad", source.replace('"version":3', '"version":2'),
    source + JSON.stringify({ type: "custom", id: "a0", parentId: "rc0" }),
    source + JSON.stringify({ type: "custom", id: "bad", parentId: "missing" })]) {
    assert.throws(() => parseSession(text));
  }
  assert.throws(() => parseSession(source, "missing"));
});
test("review table samples at most 20 deterministically and leaves all judgments unfilled", async () => {
  const sink = new MemorySink();
  await replayText(sessionText(80), sink);
  const a = reviewTable(sink.rows);
  const b = reviewTable([...sink.rows].reverse());
  assert.equal(a, b);
  assert.equal(a.split("\n").filter(x => x.includes("| 待判断 |")).length, 20);
  assert.ok(!a.includes("hello"));
});
