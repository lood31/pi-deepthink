import { test } from "node:test";
import assert from "node:assert/strict";
import { commit, decide, initialState } from "../scheduler.ts";
import { defaults } from "../config.ts";
import type { Snapshot } from "../types.ts";

const snapshot = (patch: Partial<Snapshot> = {}): Snapshot => ({
  step: 6, U: 0, R: 0, P: 0, A: 0, sameErrorStreak: 0,
  facts: [], riskReasons: [], observation: {} as Snapshot["observation"], ...patch,
});
test("thresholds are inclusive and defaults preserve experiment weights", () => {
  assert.deepEqual(defaults.weights, { U: .3, R: .25, P: .15, A: .3 });
  const c = { ...defaults, weights: { U: 1, R: 0, P: 0, A: 0 } };
  for (const [U, action] of [[.3499, "pass"], [.35, "light"], [.5999, "light"], [.6, "deep"]] as const) {
    assert.equal(decide(snapshot({ U }), initialState(), c).action, action);
  }
});
test("three hard triggers bypass cooldown and decay", () => {
  const state = { lastIntervention: 5, lastDeep: 5 };
  assert.equal(decide(snapshot({ R: 1 }), state, defaults).action, "deep");
  assert.equal(decide(snapshot({ sameErrorStreak: 2 }), state, defaults).action, "deep");
  assert.equal(decide(snapshot({ step: 12 }), initialState(), defaults).action, "deep");
  assert.equal(decide(snapshot({ step: 11 }), initialState(), defaults).action, "pass");
});
test("cooldown and post-deep decay exact boundaries", () => {
  const c = { ...defaults, weights: { U: 1, R: 0, P: 0, A: 0 } };
  const state = commit(initialState(), "deep", 4);
  assert.equal(decide(snapshot({ step: 5, U: .8 }), state, c).action, "pass");
  assert.equal(decide(snapshot({ step: 6, U: .8 }), state, c).action, "light");
  assert.equal(decide(snapshot({ step: 7, U: .8 }), state, c).score, .8 * .7);
  assert.equal(decide(snapshot({ step: 8, U: .8 }), state, c).action, "deep");
  assert.equal(commit(state, "light", 9).lastDeep, 4);
  assert.equal(commit(state, "pass", 9), state);
});
test("invalid signals fail explicitly without mutating state", () => {
  const state = initialState();
  assert.throws(() => decide(snapshot({ U: NaN }), state, defaults));
  assert.deepEqual(state, initialState());
});
