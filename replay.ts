import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { hash, loadConfig, resolveConfig } from "./config.ts";
import { normalize } from "./signals.ts";
import { Runtime } from "./runtime.ts";
import { Recorder } from "./recorder.ts";
import { readRows, logFiles, summarize } from "./report.ts";
import type { ConfigFile, LogRow, RowSink, ToolCall, ToolResult } from "./types.ts";

interface Entry { type: string; id: string; parentId: string | null; [key: string]: unknown; }
export interface SessionPath { sessionId: string; leaf: string; entries: Entry[]; }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return value as Record<string, unknown>;
}

type SessionRecord = Record<string, unknown>;
function json(text: string): SessionRecord {
  try { return object(JSON.parse(text)); }
  catch { throw new Error("Invalid session JSON"); }
}

/** Pure validating parser: malformed input intentionally throws to the caller/CLI file guard.
 * No SessionManager.open(): that API may migrate the source on disk. */
export function parseSession(text: string, leaf?: string): SessionPath {
  const lines = text.split(/\r?\n/).filter(x => x.trim());
  if (!lines.length) throw new Error("Empty session");
  const header = json(lines[0]!);
  if (header.type !== "session" || header.version !== 3 || typeof header.id !== "string") throw new Error("Only pi session v3 is supported");
  const entries = new Map<string, Entry>();
  let last: string | undefined;
  for (const line of lines.slice(1)) {
    const row = json(line);
    if (typeof row.id !== "string" || typeof row.type !== "string" || !(row.parentId === null || typeof row.parentId === "string")) {
      throw new Error("Invalid entry metadata");
    }
    if (entries.has(row.id)) throw new Error("Duplicate entry ID");
    if (typeof row.parentId === "string" && !entries.has(row.parentId)) throw new Error("Missing parent entry");
    entries.set(row.id, { ...row, type: row.type, id: row.id, parentId: row.parentId });
    last = row.id;
  }
  const chosen = leaf ?? last;
  if (!chosen || !entries.has(chosen)) throw new Error("No valid selected leaf");
  const path: Entry[] = [];
  const visited = new Set<string>();
  let cursor: string | null = chosen;
  while (cursor) {
    if (visited.has(cursor)) throw new Error("Cyclic session branch");
    visited.add(cursor);
    const entry = entries.get(cursor);
    if (!entry) throw new Error("Missing parent entry");
    path.push(entry);
    cursor = entry.parentId;
  }
  return { sessionId: header.id, leaf: chosen, entries: path.reverse() };
}

export interface ReplayResult { sessionId: string; branch: string; steps: number; warnings: string[]; }
export async function replayText(text: string, sink: RowSink, config: ConfigFile = {}, leaf?: string): Promise<ReplayResult> {
  const path = parseSession(text, leaf);
  const warnings: string[] = [];
  let engine: Runtime | null = null;
  let model = "unknown";
  let steps = 0;
  let batch: { calls: ToolCall[]; results: Map<string, ToolResult>; eligible: boolean } | null = null;
  const ensure = (): Runtime => engine ??= new Runtime({ source: "replay", sessionId: path.sessionId, branch: path.leaf, model }, config, sink);
  const flush = async () => {
    if (!batch) return;
    const current = batch;
    batch = null;
    const observations = [];
    for (const call of current.calls) {
      const result = current.results.get(call.id);
      if (!result) { warnings.push("missing-tool-result:" + hash(call.id)); continue; }
      observations.push(normalize(call, result, ensure().config));
    }
    steps += observations.length;
    const gap = observations.length !== current.calls.length;
    if (gap) await ensure().reset("missing-tool-result-before");
    await ensure().process(observations, current.eligible && !gap);
    // Available results remain visible, but no five-step sample may bridge unknown input.
    if (gap) await ensure().reset("missing-tool-result-after");
  };
  const changeModel = async (next: string) => {
    if (next === model) return;
    await flush();
    if (engine) await engine.close("model-change");
    engine = null;
    model = next;
  };
  for (const entry of path.entries) {
    if (entry.type === "model_change") {
      if (typeof entry.provider !== "string" || typeof entry.modelId !== "string") throw new Error("Invalid model entry");
      await changeModel(entry.provider + "/" + entry.modelId);
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      await flush();
      await ensure().reset(entry.type);
    } else if (entry.type === "custom_message") {
      if (entry.customType === "intervention-scheduler") warnings.push("contains-prior-intervention");
    } else if (entry.type === "message") {
      const message = object(entry.message);
      if (message.role === "assistant") {
        await flush();
        if (typeof message.provider === "string" && typeof message.model === "string") {
          await changeModel(message.provider + "/" + message.model);
        }
        const calls: ToolCall[] = [];
        for (const value of Array.isArray(message.content) ? message.content : []) {
          const block = object(value);
          if (block.type !== "toolCall") continue;
          if (typeof block.id !== "string" || typeof block.name !== "string") throw new Error("Invalid tool call");
          calls.push({ id: block.id, name: block.name, input: object(block.arguments), entryId: entry.id });
        }
        if (new Set(calls.map(c => c.id)).size !== calls.length) throw new Error("Duplicate tool call ID");
        batch = { calls, results: new Map(), eligible: message.stopReason === "toolUse" };
        const usage = message.usage ? object(message.usage) : null;
        if (usage && typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens) && usage.totalTokens >= 0) {
          await ensure().log("usage", { tokens: usage.totalTokens });
        }
        if (!calls.length) { await flush(); await ensure().settle("assistant-ended"); }
      } else if (message.role === "toolResult") {
        if (!batch || typeof message.toolCallId !== "string" || !batch.calls.some(c => c.id === message.toolCallId)) {
          warnings.push("orphan-tool-result:" + hash(entry.id));
          continue;
        }
        if (typeof message.isError !== "boolean" || !Array.isArray(message.content)) throw new Error("Invalid tool result");
        if (batch.results.has(message.toolCallId)) throw new Error("Duplicate tool result");
        batch.results.set(message.toolCallId, {
          id: message.toolCallId, isError: message.isError,
          content: message.content.filter((b: unknown) => b && typeof b === "object" && "type" in b && b.type === "text")
            .map((b: { text?: unknown }) => typeof b.text === "string" ? b.text : "").join("\n"),
          details: message.details,
        });
      } else if (message.role === "user") {
        await flush();
        if (engine) await ensure().settle("user-boundary");
      } else if (message.role !== "system" && message.role !== "custom") {
        throw new Error("Unsupported message role");
      }
    } else if (!["thinking_level_change", "context_edit", "usage", "custom", "label", "session_info"].includes(entry.type)) {
      warnings.push("unknown-entry:" + hash(entry.type));
    }
  }
  await flush();
  if (engine) await ensure().close("replay-ended");
  if (!sink.healthy) throw new Error("Replay recording failed");
  return { sessionId: path.sessionId, branch: path.leaf, steps, warnings: [...new Set(warnings)] };
}

export function reviewTable(rows: LogRow[]): string {
  const candidates = rows.filter(r => r.type === "candidate").sort((a, b) =>
    hash([a.sessionId, a.branch, a.entryId, a.step]).localeCompare(hash([b.sessionId, b.branch, b.entryId, b.step]))).slice(0, 20);
  const escape = (v: unknown) => String(v ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
  return ["# 介入点人工抽查（未填写不是验收通过）", "", "| 会话 | 分支 | entry ID | 步 | 分数 | 原因 | 判断（该停/不该停/待判断） | 备注 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...candidates.map(r => "| " + [r.sessionId, r.branch, r.entryId, r.step, r.score,
      Array.isArray(r.reasons) ? r.reasons.join(", ") : "", "待判断", ""].map(escape).join(" | ") + " |"),
  ].join("\n") + "\n";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const out = args.indexOf("--out");
  const leaf = args.indexOf("--leaf");
  if (out < 1 || !args[out + 1] || args[out + 1]!.startsWith("--") || args[0]!.startsWith("--")
    || (leaf >= 0 && (!args[leaf + 1] || args[leaf + 1]!.startsWith("--")))) {
    throw new Error("Usage: npm run replay -- <session.jsonl|directory> --out <directory> [--leaf <id>]");
  }
  const input = resolve(args[0]!);
  const output = join(resolve(args[out + 1]!), "replay-" + randomUUID());
  const files: string[] = [];
  if (input.endsWith(".jsonl")) files.push(input);
  else {
    for (const entry of await readdir(input, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join(input, entry.name));
    }
  }
  if (!files.length) throw new Error("No JSONL session files in explicit input directory");
  const config = await loadConfig();
  const sink = new Recorder({ directory: output, retentionDays: resolveConfig(config).retentionDays });
  await sink.open();
  const results: ReplayResult[] = [];
  const failures: string[] = [];
  for (const file of files.sort()) {
    // Validate a complete file before writing rows: never aggregate a partially corrupt session.
    try {
      const text = await readFile(file, "utf8");
      const staged: LogRow[] = [];
      const memory: RowSink = { healthy: true, async write(row) { staged.push(row); return true; }, async flush() {} };
      const result = await replayText(text, memory, config, leaf >= 0 ? args[leaf + 1] : undefined);
      for (const row of staged) if (!await sink.write(row)) throw new Error("Output I/O failed");
      results.push(result);
    } catch { failures.push("input:" + hash(file) + " invalid or unreadable; excluded"); }
  }
  await sink.flush();
  if (!sink.healthy) throw new Error("Replay output unavailable");
  const logs = await readRows(await logFiles(output));
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "summary.json"), JSON.stringify({ sessions: results, excluded: failures, report: summarize(logs.rows, { source: "replay" }) }, null, 2));
  await writeFile(join(output, "review.md"), reviewTable(logs.rows));
  console.log("回放会话 " + results.length + "；排除 " + failures.length + "；输出 " + output);
  if (failures.length) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error && error.message.startsWith("Usage:") ? error.message
    : "Replay failed: use explicit pi v3 session paths, a writable output directory, and valid configuration."); process.exitCode = 1; });
}
