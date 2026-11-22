import { test } from "node:test";
import assert from "node:assert/strict";
import { planTrip, validateInput } from "../src/planner.js";
import { INTERESTS, HUBS } from "../src/data/places.js";

const gateways = HUBS.filter((h) => h.gateway).map((h) => h.id);

function rng(seed) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
}

function randomInput(r) {
  const interests = INTERESTS.map((i) => i.id).filter(() => r() < 0.3);
  const entry = gateways[Math.floor(r() * gateways.length)];
  return {
    days: 1 + Math.floor(r() * 21),
    budgetUsd: 150 + Math.floor(r() * 4000),
    entry,
    exit: r() < 0.7 ? entry : gateways[Math.floor(r() * gateways.length)],
    interests,
    pace: ["relaxed", "balanced", "packed"][Math.floor(r() * 3)],
    startDate: `2027-${String(1 + Math.floor(r() * 12)).padStart(2, "0")}-10`,
    allowFlights: r() < 0.7,
    preferScenic: r() < 0.5,
  };
}

function checkInvariants(plan, input) {
  // Exactly the requested number of days.
  assert.equal(plan.days.length, input.days);

  // Every hub is a stop at most once (the departure city may repeat the arrival city).
  const ids = plan.stops.map((s) => s.id);
  const inner = ids.slice(0, input.exit === input.entry && ids.length > 1 ? -1 : undefined);
  assert.equal(new Set(inner).size, inner.length, `hub visited twice: ${ids.join(" > ")}`);
  assert.equal(ids[0], input.entry);
  assert.equal(ids[ids.length - 1], input.exit);

  // Continuity: each travel item departs from where you currently are, and
  // every sight belongs to the hub you're in. No teleporting between cities.
  let here = input.entry;
  const visitedHubs = [];
  for (const d of plan.days) {
    for (const it of d.items) {
      if (it.kind === "travel") {
        assert.equal(it.fromId, here, `day ${d.day}: travel starts at ${it.fromId} but traveller is in ${here}`);
        here = it.toId;
      } else if (it.kind === "visit") {
        assert.equal(it.hubId, here, `day ${d.day}: ${it.name} is in ${it.hubId} but traveller is in ${here}`);
        if (visitedHubs[visitedHubs.length - 1] !== it.hubId) visitedHubs.push(it.hubId);
      }
    }
  }
  assert.equal(here, input.exit, "trip must end at the departure city");

  // Sightseeing at a hub happens in one block: never leave and come back to see more.
  const firstVisit = new Map();
  visitedHubs.forEach((h, i) => {
    if (firstVisit.has(h) && h !== input.exit) assert.fail(`returned to ${h} for more sightseeing: ${visitedHubs.join(" > ")}`);
    firstVisit.set(h, i);
  });

  // No sight appears twice.
  const sights = plan.days.flatMap((d) => d.items).filter((i) => i.kind === "visit").map((i) => i.id);
  assert.equal(new Set(sights).size, sights.length);

  assert.ok(plan.costs.total > 0);
}

test("200 random trips respect geography and day count", () => {
  const r = rng(42);
  for (let i = 0; i < 200; i++) {
    const raw = randomInput(r);
    const { errors, input } = validateInput(raw);
    assert.deepEqual(errors, []);
    const plan = planTrip(input);
    try {
      checkInvariants(plan, input);
    } catch (e) {
      e.message = `${e.message}\ninput: ${JSON.stringify(raw)}`;
      throw e;
    }
  }
});

test("winter trips skip closed valleys", () => {
  const { input } = validateInput({ days: 12, budgetUsd: 3000, interests: ["mountains", "lakes"], startDate: "2027-01-05" });
  const plan = planTrip(input);
  for (const closed of ["naran", "fairy-meadows", "kalam"]) {
    assert.ok(!plan.stops.some((s) => s.id === closed), `${closed} should be closed in January`);
  }
});

test("budget picks the most comfortable style that fits", () => {
  const { input } = validateInput({ days: 7, budgetUsd: 100000, entry: "lahore", interests: ["food", "history"] });
  assert.equal(planTrip(input).tier, "comfort");
  const tight = validateInput({ days: 7, budgetUsd: 300, entry: "lahore", interests: ["food", "history"] }).input;
  assert.equal(planTrip(tight).tier, "budget");
});

test("rejects bad input", () => {
  assert.ok(validateInput({ days: 0, budgetUsd: 100 }).errors.length);
  assert.ok(validateInput({ days: 5, budgetUsd: -1 }).errors.length);
  assert.ok(validateInput({ days: 5, budgetUsd: 100, entry: "atlantis" }).errors.length);
});
