import type { Action, Decision, ScheduleState, SchedulerConfig, Snapshot } from "./types.ts";

export function initialState(step = 0): ScheduleState {
  return { lastIntervention: -Infinity, lastDeep: step };
}

export function commit(state: ScheduleState, action: Action, step: number): ScheduleState {
  if (action === "pass") return state;
  return {
    lastIntervention: step,
    lastDeep: action === "deep" ? step : state.lastDeep,
  };
}

/** Pure decision. No state is advanced until the caller commits an intervention. */
export function decide(s: Snapshot, state: ScheduleState, c: SchedulerConfig): Decision {
  for (const value of [s.U, s.R, s.P, s.A]) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("Invalid signal");
  }
  const rawScore = s.U * c.weights.U + s.R * c.weights.R + s.P * c.weights.P + s.A * c.weights.A;
  const sinceDeep = s.step - state.lastDeep;
  const score = sinceDeep > 0 && sinceDeep <= c.decaySteps && state.lastDeep > 0
    ? rawScore * c.decay : rawScore;
  const hard: string[] = [];
  if (s.R === 1) hard.push("risk:max", ...s.riskReasons);
  if (s.sameErrorStreak >= 2) hard.push("error:repeated");
  if (sinceDeep >= c.maxInterval) hard.push("interval:max");
  if (hard.length) return { rawScore, score, action: "deep", hard: true, reasons: hard };
  const action: Action = score >= c.deepThreshold ? "deep" : score >= c.lightThreshold ? "light" : "pass";
  const reasons = action === "pass" ? [] : [
    "score:" + action,
    ...(["U", "R", "P", "A"] as const).filter(k => s[k] > 0).map(k => "signal:" + k),
  ];
  if (action !== "pass" && s.step - state.lastIntervention < c.minInterval) {
    return { rawScore, score, action: "pass", hard: false, reasons: ["hysteresis:min-interval"] };
  }
  return { rawScore, score, action, hard: false, reasons };
}
