import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConfigFile, ConfigPatch, SchedulerConfig } from "./types.ts";

export const defaults: SchedulerConfig = {
  weights: { U: .30, R: .25, P: .15, A: .30 },
  lightThreshold: .35, deepThreshold: .60,
  maxInterval: 12, minInterval: 2, decay: .7, decaySteps: 3,
  window: 6, retentionDays: 90,
  riskRules: [
    { id: "delete", level: 1, field: "command", pattern: "(?:^|[\\s;&|])(?:rm|rmdir|del|erase|rd|remove-item)(?:\\s|$)" },
    { id: "delete-tool", level: 1, field: "tool", pattern: "(?:^|_)(?:delete|remove|unlink)(?:_|$)" },
    { id: "overwrite-tool", level: 1, field: "tool", pattern: "^(?:write|write_file|overwrite_file)$" },
    { id: "overwrite-shell", level: 1, field: "command", pattern: "(?:^|[^>])>(?!>)|\\b(?:set-content|out-file|tee)\\b|\\bsed\\s+-[^\\s]*i" },
    { id: "push", level: 1, field: "command", pattern: "\\bgit(?:\\s+-[^\\s]+)*\\s+push\\b" },
    { id: "external-tool", level: 1, field: "tool", pattern: "(?:^|_)(?:send|publish|post_message|create_issue|create_pull_request)(?:_|$)" },
    { id: "external-shell", level: 1, field: "command", pattern: "\\b(?:curl|wget)\\b[^\\n]*(?:--data|-d\\s|-F\\s|--upload-file|-T\\s|-X\\s*(?:POST|PUT|PATCH|DELETE))|\\b(?:send-mailmessage|sendmail)\\b|\\bgh\\s+(?:issue|pr)\\s+(?:create|comment)\\b|\\binvoke-restmethod\\b[^\\n]*-method\\s+(?:post|put|patch|delete)" },
    { id: "credentials", level: 1, field: "path", pattern: "(?:^|/)(?:\\.ssh|\\.aws|\\.azure|\\.gnupg|credentials|secrets?)(?:/|$)|(?:^|/)(?:\\.env(?:\\.[^/]*)?|auth\\.json|credentials(?:\\.json)?|id_rsa|id_ed25519)$|\\.(?:pem|key|p12|pfx)$" },
    { id: "credentials-shell", level: 1, field: "command", pattern: "(?:[/.\\\\]|^)(?:\\.ssh|\\.aws|\\.env(?:[.\\s]|$)|auth\\.json|credentials|id_rsa|id_ed25519)|\\.(?:pem|key|p12|pfx)(?:[\\s'\"]|$)" },
    { id: "configuration", level: .5, field: "path", pattern: "(?:^|/)(?:[^/]*config[^/]*|settings\\.json|\\.[^/]+rc)$" },
    { id: "dependency-file", level: .5, field: "path", pattern: "(?:^|/)(?:package(?:-lock)?\\.json|[^/]*lock(?:\\.yaml)?|requirements[^/]*\\.txt|pyproject\\.toml|cargo\\.toml|go\\.mod)$" },
    { id: "dependency-command", level: .5, field: "command", pattern: "\\b(?:npm|pnpm|yarn|pip|uv|cargo)\\s+(?:install|add|remove|update|uninstall)\\b" },
  ],
};

export function dataDirectory(): string {
  return process.env.PI_SCHEDULER_DATA_DIR || join(homedir(), ".pi", "agent", "scheduler");
}

export function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex").slice(0, 24);
}

const keys = new Set(Object.keys(defaults));
function validatePatch(value: unknown): asserts value is ConfigPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Config patch must be an object");
  for (const key of Object.keys(value)) if (!keys.has(key)) throw new Error("Unknown config key: " + key);
}

export function validate(c: SchedulerConfig): SchedulerConfig {
  if (!c.weights || Object.keys(c.weights).sort().join() !== "A,P,R,U") throw new Error("Four weights required");
  const weights = Object.values(c.weights);
  if (weights.some(x => typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > 1)
    || Math.abs(weights.reduce((a, b) => a + b, 0) - 1) > 1e-9) throw new Error("Weights must sum to 1");
  for (const key of ["lightThreshold", "deepThreshold", "decay"] as const) {
    if (typeof c[key] !== "number" || !Number.isFinite(c[key]) || c[key] < 0 || c[key] > 1) throw new Error("Invalid " + key);
  }
  if (c.lightThreshold >= c.deepThreshold) throw new Error("Thresholds must be ordered");
  for (const key of ["maxInterval", "minInterval", "decaySteps", "window", "retentionDays"] as const) {
    if (!Number.isSafeInteger(c[key]) || c[key] < 1 || c[key] > 10000) throw new Error("Invalid " + key);
  }
  if (!Array.isArray(c.riskRules) || c.riskRules.length > 100) throw new Error("Invalid risk rules");
  const ids = new Set<string>();
  for (const r of c.riskRules) {
    if (!r || typeof r.id !== "string" || !/^[a-zA-Z0-9:_-]{1,64}$/.test(r.id) || ids.has(r.id)
      || ![0, .5, 1].includes(r.level) || !["tool", "path", "command"].includes(r.field)
      || typeof r.pattern !== "string" || r.pattern.length > 512) throw new Error("Invalid risk rule");
    ids.add(r.id);
    new RegExp(r.pattern, "i");
  }
  return c;
}

export function resolveConfig(file: ConfigFile = {}, model = "unknown"): SchedulerConfig {
  if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("Config must be an object");
  for (const key of Object.keys(file)) if (!["defaults", "models"].includes(key)) throw new Error("Unknown config section");
  if (file.defaults !== undefined) validatePatch(file.defaults);
  if (file.models !== undefined && (!file.models || typeof file.models !== "object" || Array.isArray(file.models))) {
    throw new Error("Invalid model overrides");
  }
  for (const patch of Object.values(file.models ?? {})) {
    validatePatch(patch);
    validate({ ...structuredClone(defaults), ...file.defaults, ...patch });
  }
  return validate({ ...structuredClone(defaults), ...file.defaults, ...file.models?.[model] });
}

export async function loadConfig(path = process.env.PI_SCHEDULER_CONFIG || join(dataDirectory(), "config.json")): Promise<ConfigFile> {
  try {
    const file: ConfigFile = JSON.parse(await readFile(path, "utf8"));
    resolveConfig(file);
    return file;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !process.env.PI_SCHEDULER_CONFIG
      && path === join(dataDirectory(), "config.json")) return {};
    throw error;
  }
}
