import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { LiveController } from "../live.ts";
import { logFiles, readRows } from "../report.ts";
import { tempDirectory } from "./helpers.ts";
import type { ExtensionContext, ToolCallEvent, ToolResultEvent, TurnEndEvent } from "@earendil-works/pi-coding-agent";

async function setup() {
  const directory = await tempDirectory("live");
  process.env.PI_SCHEDULER_DATA_DIR = directory;
  delete process.env.PI_SCHEDULER_CONFIG;
  const entries: unknown[] = [];
  const notices: string[] = [];
  const context = {
    model: { provider: "fake", id: "test" }, thinkingLevel: "high",
    sessionManager: { getSessionId: () => "s", getLeafId: () => "root", getBranch: () => entries, getEntries: () => entries },
    ui: { notify: (text: string) => notices.push(text) },
  } as unknown as ExtensionContext;
  const live = new LiveController();
  await live.start(context);
  return { live, context, entries, notices, directory };
}
function boundary(id = "c1", override: Record<string, unknown> = {}): TurnEndEvent {
  return {
    type: "turn_end", turnIndex: 1, outcome: "completed", entries: [], continue: false,
    context: { canContinue: true }, messageEntryId: "a1", toolResultEntryIds: ["r1"],
    message: { role: "assistant", stopReason: "toolUse", provider: "fake", model: "test",
      content: [{ type: "toolCall", id, name: "write", arguments: { path: "a.ts" } }],
      usage: { totalTokens: 10 } },
    toolResults: [{ role: "toolResult", toolCallId: id, toolName: "write", isError: false,
      content: [{ type: "text", text: "Successfully wrote file" }] }],
    ...override,
  } as unknown as TurnEndEvent;
}
test("real pi 1.5.0 loader discovers exactly the manifest entry and registers events/command without a model call", async () => {
  const cwd = process.cwd();
  const isolated = await tempDirectory("pi-loader");
  const packageRoot = process.env.PI_SCHEDULER_TEST_PI_ROOT ?? resolve("node_modules/@earendil-works/pi-coding-agent");
  const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  assert.equal(packageJson.version, "1.5.0");
  const loader = await import(pathToFileURL(resolve(packageRoot, "dist/core/extensions/loader.js")).href);
  const loaded = await loader.discoverAndLoadExtensions([cwd], cwd, isolated);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  assert.equal(extension.commands.has("scheduler"), true);
  for (const event of ["session_start", "tool_call", "tool_result", "turn_start", "turn_end",
    "model_select", "session_tree", "session_compact", "agent_settled", "session_shutdown"]) {
    assert.equal(extension.handlers.has(event), true, event);
  }
  assert.equal(extension.tools.size, 0); // observer does not register/execute new tools
});
test("live defaults to shadow, observes calls, and never modifies events", async () => {
  const { live, context, directory } = await setup();
  const call = { type: "tool_call", toolCallId: "c1", toolName: "write", input: { path: "a.ts" } } as ToolCallEvent;
  live.observeCall(call);
  live.observeResult({ type: "tool_result", toolCallId: "c1", toolName: "write", input: { path: "a.ts" }, isError: false,
    content: [{ type: "text", text: "Successfully wrote file" }], details: undefined } as ToolResultEvent);
  const event = boundary();
  const before = structuredClone(event);
  assert.equal(await live.boundary(event, context), undefined);
  assert.deepEqual(event, before);
  assert.ok((await live.status()).includes("shadow"));
  await live.close(context);
  const rows = (await readRows(await logFiles(resolve(directory, "logs")))).rows;
  assert.equal(rows.filter(r => r.type === "candidate").length, 1);
  assert.equal(rows.filter(r => r.type === "intervention").length, 0);
  assert.ok(!(await live.report(7)).includes("100.0%"));
});
test("boundary appends at most one message, preserves other drafts, never forces continuation, and confirms persisted delivery", async () => {
  const { live, context, entries, directory } = await setup();
  await live.setMode("deep");
  const other = { type: "custom_message", customType: "other-plugin", content: "keep me", display: false };
  const event = boundary("c2", { entries: [other] });
  const result = (await live.boundary(event, context))!;
  assert.equal(result.entries?.length, 2);
  assert.equal(result.entries?.[0], other);
  assert.equal(result.continue, undefined);
  entries.push({ ...result.entries![1], id: "persisted", parentId: "root" });
  await live.confirm(context);
  await live.close(context);
  const rows = (await readRows(await logFiles(resolve(directory, "logs")))).rows;
  assert.equal(rows.filter(r => r.type === "intervention").length, 1);
  assert.equal(rows.find(r => r.type === "intervention")?.action, "deep");
  assert.equal(await live.boundary(boundary("c2"), context), undefined); // same tool event cannot duplicate
});
test("completed text, aborted/error or cannot-continue boundary does not inject; nested tool is ignored", async () => {
  for (const override of [{ outcome: "aborted" }, { outcome: "error" }, { context: { canContinue: false } },
    { message: { role: "assistant", stopReason: "stop", content: [], usage: { totalTokens: 1 } }, toolResults: [] }]) {
    const { live, context } = await setup();
    await live.setMode("deep");
    assert.equal(await live.boundary(boundary("x", override), context), undefined);
    await live.close(context);
  }
  const { live, context } = await setup();
  live.observeCall({ type: "tool_call", toolCallId: "parent/1", parentToolCallId: "parent", toolName: "write", input: { path: "secret" } } as ToolCallEvent);
  await live.boundary(boundary("none", { message: { role: "assistant", stopReason: "stop", content: [], usage: { totalTokens: 0 } }, toolResults: [] }), context);
  assert.equal(live.runtime?.step, 0);
  await live.close(context);
});
test("successful compaction/tree/model resets windows; invalid config and handler errors fail open", async () => {
  const { live, context } = await setup();
  await live.boundary(boundary(), context);
  assert.equal(live.runtime?.step, 1);
  await live.restart(context, "compaction");
  assert.equal(live.runtime?.step, 0);
  await live.guard(context, () => { throw new Error("test"); });
  assert.ok((await live.status()).includes("failed"));
  await assert.rejects(live.setMode("deep"));
  assert.equal(await live.boundary(boundary("c2"), context), undefined);
  await live.close(context);
  const bad = await setup();
  const config = resolve(bad.directory, "broken.json");
  await writeFile(config, '{"defaults":{"window":0}}');
  process.env.PI_SCHEDULER_CONFIG = config;
  const invalid = new LiveController();
  await invalid.start(bad.context);
  assert.ok((await invalid.status()).includes("failed"));
  assert.equal(await invalid.boundary(boundary(), bad.context), undefined);
  delete process.env.PI_SCHEDULER_CONFIG;
  await bad.live.close(bad.context);
});
