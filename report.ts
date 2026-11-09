import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { dataDirectory } from "./config.ts";
import type { LogRow } from "./types.ts";

export interface Report {
  from: string;
  to: string;
  source: string;
  rows: number;
  malformedRows: number;
  candidates: number;
  interventions: number;
  unconfirmed: number;
  incomplete: number;
  completeOutcomes: number;
  healthEvents: number;
  confirmedNewErrors: number;
  directionChanges: number;
  productionEvents: number;
  unknownProductionSteps: number;
  correctionProxy: Record<string, { corrected: number; evaluable: number; rate: number | null }>;
  reasons: Record<string, number>;
  modes: Record<string, number>;
  scoreDistribution: number[];
  observedTokens: number;
  usageSamples: number;
  toolSteps: number;
}
export interface ReportOptions { from?: Date; to?: Date; source?: "live" | "replay"; }

export async function logFiles(directory: string, archived = false): Promise<string[]> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const files = entries.filter(x => x.isFile() && /^scheduler-\d+-[0-9a-f-]+\.jsonl$/.test(x.name)).map(x => join(directory, x.name));
  if (archived) files.push(...await logFiles(join(directory, "archive")));
  return files.sort();
}

export async function readRows(files: string[]): Promise<{ rows: LogRow[]; malformed: number }> {
  const rows: LogRow[] = [];
  let malformed = 0;
  for (const file of files) {
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (row.schemaVersion !== 1 || typeof row.timestamp !== "string" || !Number.isFinite(Date.parse(row.timestamp))
            || typeof row.type !== "string" || typeof row.runId !== "string") throw new Error("Invalid row");
          rows.push(row as LogRow);
        } catch { malformed++; }
      }
    } finally { lines.close(); }
  }
  return { rows, malformed };
}

export function summarize(rows: LogRow[], options: ReportOptions = {}, malformed = 0): Report {
  const from = options.from ?? new Date(0);
  const to = options.to ?? new Date();
  const r: Report = {
    from: from.toISOString(), to: to.toISOString(), source: options.source ?? "all",
    rows: 0, malformedRows: malformed, candidates: 0, interventions: 0, unconfirmed: 0,
    incomplete: 0, completeOutcomes: 0, healthEvents: 0, confirmedNewErrors: 0,
    directionChanges: 0, productionEvents: 0, unknownProductionSteps: 0,
    correctionProxy: {}, reasons: {}, modes: {}, scoreDistribution: Array<number>(10).fill(0),
    observedTokens: 0, usageSamples: 0, toolSteps: 0,
  };
  const origins = new Map<string, LogRow>();
  const outcomes = new Map<string, LogRow>();
  const increment = (object: Record<string, number>, key: string) => { object[key] = (object[key] ?? 0) + 1; };
  for (const row of rows) {
    const time = Date.parse(row.timestamp);
    if (time < from.getTime() || time > to.getTime() || (options.source && row.source !== options.source)) continue;
    r.rows++;
    if (row.type === "score") {
      r.toolSteps++;
      if (typeof row.score === "number" && row.score >= 0 && row.score <= 1) r.scoreDistribution[Math.min(9, Math.floor(row.score * 10))]!++;
    }
    if (row.type === "candidate" || row.type === "intervention") {
      if (typeof row.id !== "string" || origins.has(row.id)) continue;
      origins.set(row.id, row);
      if (row.type === "candidate") r.candidates++;
      else r.interventions++;
      increment(r.modes, row.mode + ":" + row.type);
      for (const reason of Array.isArray(row.reasons) ? row.reasons : []) {
        if (typeof reason === "string") increment(r.reasons, row.type + ":" + reason);
      }
    }
    if (row.type === "delivery-unknown") r.unconfirmed++;
    if (row.type === "health") r.healthEvents++;
    if (row.type === "usage" && typeof row.tokens === "number" && row.tokens >= 0 && Number.isFinite(row.tokens)) {
      r.observedTokens += row.tokens;
      r.usageSamples++;
    }
  }
  // Outcome can arrive outside the selected period: join to its in-range origin.
  for (const row of rows) {
    if (row.type === "outcome" && typeof row.id === "string" && origins.has(row.id)) outcomes.set(row.id, row);
  }
  for (const [id, origin] of origins) {
    const row = outcomes.get(id);
    if (!row || row.complete !== true || row.observedSteps !== 5) { r.incomplete++; continue; }
    r.completeOutcomes++;
    if (row.newError === true) r.confirmedNewErrors++;
    if (row.directionChanged === true) r.directionChanges++;
    r.productionEvents += typeof row.productionEvents === "number" ? row.productionEvents : 0;
    r.unknownProductionSteps += typeof row.unknownProductionSteps === "number" ? row.unknownProductionSteps : 0;
    const key = origin.mode + ":" + origin.type;
    const cell = r.correctionProxy[key] ??= { corrected: 0, evaluable: 0, rate: null };
    if (typeof row.baselineError === "string" && typeof row.errorResolved === "boolean") {
      cell.evaluable++;
      if (row.errorResolved) cell.corrected++;
      cell.rate = cell.corrected / cell.evaluable;
    }
  }
  return r;
}

export async function reportDirectory(directory: string, options: ReportOptions = {}): Promise<Report> {
  const result = await readRows(await logFiles(directory, true));
  return summarize(result.rows, options, result.malformed);
}

export function formatReport(r: Report): string {
  return [
    "Scheduler " + r.from + " — " + r.to + " [" + r.source + "]",
    "候选 " + r.candidates + "；已落会话介入 " + r.interventions + "；未确认 " + r.unconfirmed,
    "工具步 " + r.toolSteps + "；完整五步样本 " + r.completeOutcomes + "；不完整 " + r.incomplete,
    "分数分布 [0,.1)…[.9,1]：" + r.scoreDistribution.join(", "),
    "纠错代理（同工具同目标重试且旧类错误未再出现，非因果结论）：" + (Object.keys(r.correctionProxy).length
      ? Object.entries(r.correctionProxy).map(([key, c]) => key + "=" + (c.rate === null ? "N/A" : (c.rate * 100).toFixed(1) + "%") + " (n=" + c.evaluable + ")").join("；") : "N/A"),
    "新错误样本 " + r.confirmedNewErrors + "；方向变化样本 " + r.directionChanges + "；产出事件 " + r.productionEvents + "；未知产出步 " + r.unknownProductionSteps,
    "观测 token " + (r.usageSamples ? r.observedTokens : "N/A") + "；不推断额外成本或节省",
    "触发原因：" + JSON.stringify(r.reasons),
    "坏行 " + r.malformedRows + "；健康异常事件 " + r.healthEvents,
  ].join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const directory = args[0] ? resolve(args[0]) : join(dataDirectory(), "logs");
  const days = args[1] === undefined ? null : Number(args[1]);
  if (days !== null && (!Number.isFinite(days) || days <= 0)) throw new Error("Days must be positive");
  const result = await reportDirectory(directory, {
    ...(days === null ? {} : { from: new Date(Date.now() - days * 86400000) }),
  });
  console.log(formatReport(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error("Report failed: check directory permissions and log format."); process.exitCode = 1; });
}
