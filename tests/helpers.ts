import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { LogRow, RowSink } from "../types.ts";
export class MemorySink implements RowSink {
  healthy = true;
  rows: LogRow[] = [];
  async write(row: LogRow): Promise<boolean> { if (!this.healthy) return false; this.rows.push(row); return true; }
  async flush(): Promise<void> {}
}
export async function tempDirectory(name: string): Promise<string> {
  const root = resolve(".tmp", "tests");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, name + "-"));
}
export function sessionText(count = 8, sessionId = "synthetic", parallel = false): string {
  const entries: unknown[] = [{ type: "session", version: 3, id: sessionId }];
  let parentId: string | null = null;
  const append = (id: string, message: unknown) => {
    entries.push({ type: "message", id, parentId, message }); parentId = id;
  };
  for (let i = 0; i < count; i++) {
    const ids = parallel ? ["c" + i + "a", "c" + i + "b"] : ["c" + i];
    append("a" + i, {
      role: "assistant", provider: "fake", model: "test", stopReason: "toolUse",
      content: ids.map(id => ({ type: "toolCall", id, name: i % 3 === 0 ? "write" : "read", arguments: { path: "a.ts" } })),
      usage: { totalTokens: 10 },
    });
    for (const id of [...ids].reverse()) append("r" + id, {
      role: "toolResult", toolCallId: id, toolName: i % 3 === 0 ? "write" : "read", isError: false,
      content: [{ type: "text", text: i % 3 === 0 ? "Successfully wrote file" : "hello" }],
    });
  }
  return entries.map(e => JSON.stringify(e)).join("\n") + "\n";
}
