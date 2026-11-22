// Deterministic itinerary planner.
//
// The geography is handled here in code, not by an LLM, so the plan can never
// zig-zag: stops are picked with cheapest-insertion on real road/flight travel
// times, the order is tightened with 2-opt, and every hub is visited exactly
// once (in one continuous block of days). The day-by-day schedule is then
// produced by simulating the clock: drives are split at overnight towns, and
// sights in a hub are ordered nearest-neighbour so each day stays local.

import { JUNCTIONS, TIERS, INTERESTS, GENERAL_TIPS, USD_TO_PKR } from "./data/places.js";
import { HUBS, EDGES, DISCOVERY_INFO } from "./data/index.js";

const PACE = {
  relaxed: { dayHours: 8, maxDrive: 7, daysPerStop: 3 },
  balanced: { dayHours: 10, maxDrive: 9, daysPerStop: 2 },
  packed: { dayHours: 12, maxDrive: 11, daysPerStop: 1.5 },
};
const ARRIVAL_LOSS = 4; // hours lost on day 1 (landing, immigration, rest)
const DEPARTURE_LOSS = 4; // hours kept free on the last day for the flight out
const DAY_START = 8.5; // 08:30
const EVENING = 17; // sunset-ish activities don't start before 17:00
const LOCAL_KMH = 30;
const ROAD_FACTOR = 1.35; // straight-line -> road distance
const SCENIC_WEIGHT = 0.75; // how much shorter a scenic road "feels" when preferScenic

const NODES = new Map();
for (const h of HUBS) NODES.set(h.id, { ...h, kind: "hub", stay: true });
for (const j of JUNCTIONS) NODES.set(j.id, { ...j, kind: "junction" });
const HUB_BY_ID = new Map(HUBS.map((h) => [h.id, h]));

export function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

const openIn = (months, month) => !months || !month || months.includes(month);

// ---------------------------------------------------------------- routing

function buildGraph({ month, allowFlights }) {
  const adj = new Map([...NODES.keys()].map((k) => [k, []]));
  for (const e of EDGES) {
    if (e.mode === "flight" && !allowFlights) continue;
    if (!openIn(e.months, month)) continue;
    if (!NODES.has(e.a) || !NODES.has(e.b)) throw new Error(`Edge references unknown node: ${e.a}-${e.b}`);
    const blocked = (id) => {
      const n = NODES.get(id);
      return n.kind === "hub" && !openIn(n.months, month);
    };
    // Can't pass through a closed hub (e.g. Naran in winter).
    if (blocked(e.a) || blocked(e.b)) continue;
    adj.get(e.a).push({ to: e.b, edge: e });
    adj.get(e.b).push({ to: e.a, edge: e });
  }
  return adj;
}

function dijkstra(adj, src, preferScenic) {
  const dist = new Map([[src, 0]]);
  const prev = new Map();
  const done = new Set();
  while (true) {
    let u = null;
    let best = Infinity;
    for (const [k, d] of dist) if (!done.has(k) && d < best) { best = d; u = k; }
    if (u === null) break;
    done.add(u);
    for (const { to, edge } of adj.get(u)) {
      const w = edge.hours * (preferScenic && edge.scenic ? SCENIC_WEIGHT : 1);
      const nd = best + w;
      if (nd < (dist.get(to) ?? Infinity)) {
        dist.set(to, nd);
        prev.set(to, { from: u, edge });
      }
    }
  }
  return prev;
}

class Router {
  constructor(opts) {
    this.opts = opts;
    this.adj = buildGraph(opts);
    this.trees = new Map();
    this.legs = new Map();
  }

  leg(fromId, toId) {
    const key = `${fromId}>${toId}`;
    if (this.legs.has(key)) return this.legs.get(key);
    if (!this.trees.has(fromId)) this.trees.set(fromId, dijkstra(this.adj, fromId, this.opts.preferScenic));
    const prev = this.trees.get(fromId);
    let leg = null;
    if (fromId === toId) {
      leg = { from: fromId, to: toId, segments: [], hours: 0, km: 0 };
    } else if (prev.has(toId)) {
      const segments = [];
      let cur = toId;
      while (cur !== fromId) {
        const { from, edge } = prev.get(cur);
        segments.unshift({
          from, to: cur, mode: edge.mode, hours: edge.hours, km: edge.km,
          scenic: !!edge.scenic, label: edge.label || null,
          highlights: edge.highlights || [], note: edge.note || null,
          fixedCost: edge.fixedCost || 0,
        });
        cur = from;
      }
      leg = {
        from: fromId, to: toId, segments,
        hours: segments.reduce((s, x) => s + x.hours, 0),
        km: segments.reduce((s, x) => s + x.km, 0),
      };
    }
    this.legs.set(key, leg);
    return leg;
  }

  hours(a, b) {
    const l = this.leg(a, b);
    return l ? l.hours : Infinity;
  }
}

// Split a leg into one chunk per travel day, breaking only in towns with beds.
function splitLeg(leg, maxDrive) {
  const chunks = [];
  let cur = [];
  let curHours = 0;
  let lastStay = -1; // index in `cur` after which we may stop for the night
  for (const seg of leg.segments) {
    if (cur.length && curHours + seg.hours > maxDrive && lastStay >= 0) {
      const keep = cur.slice(0, lastStay + 1);
      const rest = cur.slice(lastStay + 1);
      chunks.push(keep);
      cur = rest;
      curHours = rest.reduce((s, x) => s + x.hours, 0);
      lastStay = -1;
      for (let i = 0; i < cur.length; i++) if (NODES.get(cur[i].to).stay) lastStay = i;
    }
    cur.push(seg);
    curHours += seg.hours;
    if (NODES.get(seg.to).stay) lastStay = cur.length - 1;
  }
  if (cur.length) chunks.push(cur);
  return chunks.map((segs) => ({
    from: segs[0].from,
    to: segs[segs.length - 1].to,
    segments: segs,
    hours: segs.reduce((s, x) => s + x.hours, 0),
    km: segs.reduce((s, x) => s + x.km, 0),
  }));
}

// ---------------------------------------------------------------- scoring

// How famous a place is: discovered places carry their number of Wikipedia
// language editions; hand-picked places get a solid default.
function fame(a) {
  if (a.sitelinks) return Math.min(1.2, Math.log10(a.sitelinks) / 1.5);
  return 0.6;
}

function attractionScore(a, hub, interests) {
  if (!interests.length) return 1 + (a.mustSee ? 1 : 0) + hub.popularity + fame(a);
  const matches = a.tags.filter((t) => interests.includes(t)).length;
  if (!matches) return a.mustSee ? 0.5 + hub.popularity * 0.3 : 0.1;
  return matches + (a.mustSee ? 0.6 : 0) + hub.popularity * 0.4 + fame(a);
}

function scoredAttractions(hub, ctx) {
  return hub.attractions
    .filter((a) => openIn(a.months, ctx.month))
    .map((a) => ({ ...a, hubId: hub.id, score: attractionScore(a, hub, ctx.interests) }))
    .sort((x, y) => y.score - x.score);
}

function coreSet(hub, ctx) {
  const list = ctx.attractions.get(hub.id).filter((a) => a.score >= 0.5);
  const picked = [];
  let hours = 0;
  for (const a of list) {
    if (hours >= hub.coreHours) break;
    picked.push(a);
    hours += a.hours;
  }
  const value = picked.reduce((s, a) => s + a.score, 0);
  return { picked, hours, value };
}

// ---------------------------------------------------------------- simulation

function localHours(from, a) {
  // Long day trips already include their own driving in `hours`.
  if (a.hours >= 5) return 0.25;
  return Math.max(0.15, (haversineKm(from, a) * ROAD_FACTOR) / LOCAL_KMH);
}

function nearestNeighbourOrder(start, list) {
  const rest = [...list];
  const out = [];
  let pos = start;
  while (rest.length) {
    let bi = 0;
    let bd = Infinity;
    rest.forEach((a, i) => {
      const d = haversineKm(pos, a);
      if (d < bd) { bd = d; bi = i; }
    });
    const [a] = rest.splice(bi, 1);
    out.push(a);
    pos = a.hours >= 5 ? start : a; // you come back to base after a day trip
  }
  return out;
}

function simulate(stops, ctx) {
  const { pace } = ctx;
  const cap = (d) => pace.dayHours - (d === 1 ? ARRIVAL_LOSS : 0);
  const days = [];
  let day = { day: 1, items: [], used: 0, cap: cap(1) };
  let travelHours = 0;
  let loc = NODES.get(stops[0].hubId);
  let pos = loc;

  const nextDay = () => {
    day.sleep = loc.id;
    days.push(day);
    const d = day.day + 1;
    day = { day: d, items: [], used: 0, cap: cap(d) };
    pos = loc;
  };

  stops.forEach((stop, i) => {
    if (i > 0) {
      const leg = ctx.router.leg(stops[i - 1].hubId, stop.hubId);
      if (!leg) throw new Error(`No route ${stops[i - 1].hubId} -> ${stop.hubId}`);
      const chunks = splitLeg(leg, pace.maxDrive);
      chunks.forEach((chunk, ci) => {
        if (day.used > 0 && day.used + chunk.hours > day.cap) nextDay();
        day.items.push({ kind: "travel", hours: chunk.hours, chunk });
        day.used += chunk.hours;
        travelHours += chunk.hours;
        loc = NODES.get(chunk.to);
        pos = loc;
        if (ci < chunks.length - 1) nextDay(); // overnight stop mid-leg
      });
    }
    const ordered = nearestNeighbourOrder(loc, stop.attractions);
    for (const a of ordered) {
      let transfer = localHours(pos, a);
      if (day.used > 0 && day.used + transfer + a.hours > day.cap) {
        nextDay();
        transfer = localHours(pos, a);
      }
      day.items.push({ kind: "visit", hours: a.hours, transfer, attraction: a });
      day.used += transfer + a.hours;
      pos = a.hours >= 5 ? loc : a;
    }
  });
  days.push(day);

  const N = ctx.planDays;
  const last = days[days.length - 1];
  const fits =
    days.length < N || (days.length === N && last.used <= Math.max(0, cap(N) - DEPARTURE_LOSS));
  return { days, travelHours, fits };
}

// ---------------------------------------------------------------- selection

const PASS_THROUGH_PENALTY = 2; // hours; discourages driving back through a town you already stayed in

// Interests the current route already serves well (2+ matching sights).
function coveredInterests(stops, interests) {
  const count = new Map();
  for (const s of stops) for (const a of s.attractions) for (const t of a.tags) count.set(t, (count.get(t) || 0) + 1);
  return new Set(interests.filter((i) => (count.get(i) || 0) >= 2));
}

// How much a base adds to the trip: its best sights, scaled by how famous the
// base is (Hunza beats a town with a few local temples), plus a bonus for
// each of the traveller's interests nothing else on the route serves yet.
function hubValue(hub, core, covered, interests) {
  const fresh = interests.filter((i) => !covered.has(i) && core.picked.some((a) => a.tags.includes(i))).length;
  return core.value * (0.5 + hub.popularity) + fresh * 3;
}

function routeTravel(stops, router) {
  const stopIds = new Set(stops.map((s) => s.hubId));
  let h = 0;
  for (let i = 1; i < stops.length; i++) {
    const leg = router.leg(stops[i - 1].hubId, stops[i].hubId);
    if (!leg) return Infinity;
    h += leg.hours;
    for (const seg of leg.segments.slice(0, -1)) if (stopIds.has(seg.to)) h += PASS_THROUGH_PENALTY;
  }
  return h;
}

function twoOpt(stops, ctx) {
  // Endpoints are fixed (arrival and departure cities).
  let best = stops;
  let bestH = routeTravel(best, ctx.router);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < best.length - 2; i++) {
      for (let k = i + 1; k < best.length - 1; k++) {
        const cand = [...best.slice(0, i), ...best.slice(i, k + 1).reverse(), ...best.slice(k + 1)];
        const h = routeTravel(cand, ctx.router);
        if (h < bestH - 0.01 && simulate(cand, ctx).fits) {
          best = cand;
          bestH = h;
          improved = true;
        }
      }
    }
  }
  return best;
}

function selectStops(ctx, maxStops) {
  const { entry, exit, router } = ctx;
  const entryCore = coreSet(HUB_BY_ID.get(entry), ctx);
  let stops = [{ hubId: entry, attractions: entryCore.picked }];
  if (ctx.days > 1 || exit !== entry) stops.push({ hubId: exit, attractions: [] });
  if (exit !== entry) {
    const exitCore = coreSet(HUB_BY_ID.get(exit), ctx);
    stops[stops.length - 1].attractions = exitCore.picked;
  }
  // Even the bare arrival/departure plan must fit; trim if not.
  while (!simulate(stops, ctx).fits && stops.some((s) => s.attractions.length)) {
    const s = [...stops].reverse().find((x) => x.attractions.length);
    s.attractions = s.attractions.slice(0, -1);
  }

  const used = new Set(stops.map((s) => s.hubId));
  const candidates = HUBS.filter((h) => !used.has(h.id) && openIn(h.months, ctx.month));

  while (stops.length >= 2 && stops.length < maxStops) {
    let best = null;
    const baseTravel = routeTravel(stops, router);
    const covered = coveredInterests(stops, ctx.interests);
    for (const hub of candidates) {
      if (stops.some((s) => s.hubId === hub.id)) continue;
      const core = coreSet(hub, ctx);
      if (!core.picked.length || core.value < 1) continue;
      for (let pos = 1; pos < stops.length; pos++) {
        const trial = [...stops.slice(0, pos), { hubId: hub.id, attractions: core.picked }, ...stops.slice(pos)];
        const addedTravel = routeTravel(trial, router) - baseTravel;
        if (!Number.isFinite(addedTravel)) continue;
        const ratio = hubValue(hub, core, covered, ctx.interests) / (addedTravel + core.hours + 1);
        if (best && ratio <= best.ratio) continue;
        if (!simulate(trial, ctx).fits) continue;
        best = { ratio, trial };
      }
    }
    if (!best) break;
    stops = twoOpt(best.trial, ctx);
  }
  return stops;
}

function fillStops(stops, ctx) {
  const taken = new Set(stops.flatMap((s) => s.attractions.map((a) => a.id)));
  const pool = [];
  stops.forEach((s, idx) => {
    for (const a of ctx.attractions.get(s.hubId)) {
      if (!taken.has(a.id) && a.score >= 0.5) pool.push({ a, idx });
    }
  });
  pool.sort((x, y) => y.a.score / y.a.hours - x.a.score / x.a.hours);
  for (const { a, idx } of pool) {
    if (taken.has(a.id)) continue;
    const trial = stops.map((s, i) => (i === idx ? { ...s, attractions: [...s.attractions, a] } : s));
    if (simulate(trial, ctx).fits) {
      stops = trial;
      taken.add(a.id);
    }
  }
  return stops;
}

const stopsValue = (stops) =>
  stops.reduce((s, st) => s + st.attractions.reduce((x, a) => x + a.score, 0), 0);

// Try a few route sizes; more stops is only kept if it buys more of what the
// traveller cares about within the same number of days.
function buildStops(ctx) {
  const base = 2 + Math.max(0, Math.round((ctx.planDays - 1) / ctx.pace.daysPerStop) - 1);
  let best = null;
  for (let extra = 0; extra <= 3; extra++) {
    const max = base + extra;
    const stops = fillStops(selectStops(ctx, max), ctx);
    const value = stopsValue(stops);
    if (!best || value > best.value + 0.01) best = { stops, value };
    const spare = ctx.planDays - simulate(stops, ctx).days.length;
    if (spare < 1 || stops.length < max) break;
  }
  return best.stops;
}

const WEATHER_RISK_REGION = "Gilgit-Baltistan";

// ---------------------------------------------------------------- costs

function costOf(sim, stops, tierKey, ctx) {
  const t = TIERS[tierKey];
  let lodging = 0;
  // Sleep every night except after the last day.
  for (let i = 0; i < ctx.days - 1; i++) {
    const d = sim.days[i] || sim.days[sim.days.length - 1];
    const sleepId = d.sleep || stops[stops.length - 1].hubId;
    const node = NODES.get(sleepId);
    lodging += t.lodging * (node.lodging ?? 0.8);
  }
  const food = t.food * ctx.days;
  const local = t.local * ctx.days;
  let transport = 0;
  for (const d of sim.days) {
    for (const it of d.items) {
      if (it.kind !== "travel") continue;
      for (const seg of it.chunk.segments) {
        transport += seg.fixedCost;
        if (seg.mode === "road") transport += seg.hours * t.roadPerHour;
      }
    }
  }
  const fees = sim.days.flatMap((d) => d.items).filter((i) => i.kind === "visit")
    .reduce((s, i) => s + i.attraction.fee, 0);
  const total = lodging + food + local + transport + fees;
  const r = (x) => Math.round(x);
  return { tier: tierKey, label: t.label, desc: t.desc, lodging: r(lodging), food: r(food), local: r(local), transport: r(transport), fees: r(fees), total: r(total) };
}

// ---------------------------------------------------------------- output

const fmtTime = (h) => {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60 / 15) * 15;
  const H = mm === 60 ? hh + 1 : hh;
  const M = mm === 60 ? 0 : mm;
  return `${String(H % 24).padStart(2, "0")}:${String(M).padStart(2, "0")}`;
};

const ORDER = { morning: 0, any: 1, afternoon: 2, evening: 3 };

function renderDays(sim, stops, ctx) {
  const out = [];
  for (const d of sim.days) {
    // Within each run of sightseeing, put morning things first and sunset/dinner last.
    const items = [];
    let run = [];
    const flush = () => {
      run.sort((x, y) => ORDER[x.attraction.bestTime] - ORDER[y.attraction.bestTime]);
      items.push(...run);
      run = [];
    };
    for (const it of d.items) {
      if (it.kind === "visit") run.push(it);
      else { flush(); items.push(it); }
    }
    flush();

    let clock = DAY_START + (d.day === 1 ? ARRIVAL_LOSS : 0);
    const lastTravelIdx = items.map((x) => x.kind).lastIndexOf("travel");
    const rendered = items.map((it, idx) => {
      if (it.kind === "travel") {
        const c = it.chunk;
        const start = clock;
        clock += c.hours;
        const fromN = NODES.get(c.from);
        const toN = NODES.get(c.to);
        const modes = [...new Set(c.segments.map((s) => s.mode))];
        return {
          kind: "travel",
          start: fmtTime(start), end: fmtTime(clock),
          from: fromN.name, to: toN.name,
          fromId: c.from, toId: c.to,
          hours: Math.round(c.hours * 10) / 10,
          km: c.km,
          modes,
          scenic: c.segments.some((s) => s.scenic),
          via: c.segments.slice(0, -1).map((s) => NODES.get(s.to).name),
          highlights: c.segments.flatMap((s) => s.highlights),
          notes: c.segments.map((s) => s.note).filter(Boolean),
          labels: [...new Set(c.segments.map((s) => s.label).filter(Boolean))],
          segments: c.segments.map((s) => ({
            mode: s.mode, scenic: s.scenic,
            points: [[NODES.get(s.from).lat, NODES.get(s.from).lng], [NODES.get(s.to).lat, NODES.get(s.to).lng]],
          })),
        };
      }
      const a = it.attraction;
      clock += it.transfer;
      if (a.bestTime === "evening" && idx > lastTravelIdx && clock < EVENING) clock = EVENING;
      const start = clock;
      clock += a.hours;
      return {
        kind: "visit",
        start: fmtTime(start), end: fmtTime(clock),
        id: a.id, name: a.name, hub: HUB_BY_ID.get(a.hubId).name, hubId: a.hubId,
        lat: a.lat, lng: a.lng, hours: a.hours, fee: a.fee, tags: a.tags,
        desc: a.desc, matched: a.tags.filter((t) => ctx.interests.includes(t)),
        image: a.image || null, wiki: a.wiki || null, source: a.source || "curated", feeUnknown: !!a.feeUnknown,
      };
    });

    const sleep = d.sleep ? NODES.get(d.sleep).name : null;
    const travels = rendered.filter((r) => r.kind === "travel");
    const visits = rendered.filter((r) => r.kind === "visit");
    const placeAtStart = d.day === 1 ? NODES.get(stops[0].hubId).name : null;
    let title;
    if (travels.length) title = `${travels[0].from} → ${travels[travels.length - 1].to}`;
    else if (visits.length) title = visits[0].hub;
    else title = placeAtStart || "Free day";
    out.push({ day: d.day, title, sleep, items: rendered });
  }

  // Unused days at the end become buffer days at the departure city.
  const exitId = stops[stops.length - 1].hubId;
  const exitName = NODES.get(exitId).name;
  const usedIds = new Set(stops.flatMap((s) => s.attractions.map((a) => a.id)));
  const optional = ctx.attractions.get(exitId).filter((a) => !usedIds.has(a.id) && a.hours < 5).slice(0, 3);
  while (out.length < ctx.days) {
    out[out.length - 1].sleep = exitName;
    out.push({
      day: out.length + 1, title: `${exitName} — free / buffer day`, sleep: null, buffer: true,
      items: [{
        kind: "free",
        text: "Unplanned on purpose: rest, shop, or absorb a delay from a mountain road or a cancelled flight." +
          (optional.length ? ` If all went to plan, optional: ${optional.map((a) => a.name).join(", ")}.` : ""),
      }],
    });
  }
  // The final day ends with departure.
  const last = out[out.length - 1];
  last.sleep = null;
  last.items.push({ kind: "depart", text: `Depart from ${exitName}.` });

  if (ctx.startDate) {
    const base = new Date(ctx.startDate + "T00:00:00Z");
    for (const d of out) {
      const dt = new Date(base.getTime() + (d.day - 1) * 86400000);
      d.date = dt.toISOString().slice(0, 10);
    }
  }
  return out;
}

// ---------------------------------------------------------------- public API

export function listOptions() {
  return {
    interests: INTERESTS,
    gateways: HUBS.filter((h) => h.gateway).map((h) => ({ id: h.id, name: h.name })),
    tiers: Object.entries(TIERS).map(([id, t]) => ({ id, label: t.label, desc: t.desc })),
    paces: Object.keys(PACE),
    usdToPkr: USD_TO_PKR,
    discovery: DISCOVERY_INFO,
  };
}

export function validateInput(raw) {
  const errors = [];
  const days = Number.parseInt(raw.days, 10);
  if (!Number.isFinite(days) || days < 1 || days > 30) errors.push("days must be between 1 and 30");
  const budget = Number(raw.budgetUsd);
  if (!Number.isFinite(budget) || budget <= 0) errors.push("budgetUsd must be a positive number");
  const gateways = HUBS.filter((h) => h.gateway).map((h) => h.id);
  const entry = raw.entry || "islamabad";
  const exit = raw.exit || entry;
  if (!gateways.includes(entry)) errors.push(`entry must be one of ${gateways.join(", ")}`);
  if (!gateways.includes(exit)) errors.push(`exit must be one of ${gateways.join(", ")}`);
  const valid = new Set(INTERESTS.map((i) => i.id));
  const interests = Array.isArray(raw.interests) ? raw.interests.filter((i) => valid.has(i)) : [];
  const pace = PACE[raw.pace] ? raw.pace : "balanced";
  let startDate = null;
  let month = Number.parseInt(raw.month, 10) || null;
  if (raw.startDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.startDate)) errors.push("startDate must be YYYY-MM-DD");
    else {
      startDate = raw.startDate;
      month = Number.parseInt(raw.startDate.slice(5, 7), 10);
    }
  }
  if (month && (month < 1 || month > 12)) errors.push("month must be 1-12");
  return {
    errors,
    input: {
      days, budgetUsd: budget, entry, exit, interests, pace, month, startDate,
      travelers: Math.max(1, Number.parseInt(raw.travelers, 10) || 1),
      allowFlights: raw.allowFlights !== false,
      preferScenic: raw.preferScenic !== false,
    },
  };
}

export function planTrip(input) {
  const ctx = {
    ...input,
    pace: PACE[input.pace],
    router: new Router(input),
    attractions: new Map(HUBS.map((h) => [h.id, null])),
  };
  for (const h of HUBS) ctx.attractions.set(h.id, scoredAttractions(h, ctx));

  const warnings = [];
  ctx.planDays = input.days;
  let stops = buildStops(ctx);
  // Mountain roads close and northern flights get cancelled: keep the last
  // day free in the departure city if the route goes to Gilgit-Baltistan.
  const goesNorth = (st) => st.some((s) => HUB_BY_ID.get(s.hubId).region === WEATHER_RISK_REGION);
  if (goesNorth(stops) && input.days >= 6) {
    ctx.planDays = input.days - 1;
    const withBuffer = buildStops(ctx);
    if (goesNorth(withBuffer)) {
      stops = withBuffer;
      warnings.push("A buffer day is kept before your departure because roads and flights in Gilgit-Baltistan are weather-dependent.");
    } else {
      ctx.planDays = input.days;
    }
  }
  let sim = simulate(stops, ctx);

  const tierOrder = ["comfort", "standard", "budget"];
  let costs = Object.fromEntries(tierOrder.map((t) => [t, costOf(sim, stops, t, ctx)]));
  let tier = tierOrder.find((t) => costs[t].total <= input.budgetUsd);

  // Even budget travel is too expensive: drop the least valuable stops (less
  // driving = cheaper) until it fits or only arrival/departure remain.
  while (!tier && stops.length > 2) {
    let worst = -1;
    let worstVal = Infinity;
    for (let i = 1; i < stops.length - 1; i++) {
      const v = stops[i].attractions.reduce((s, a) => s + a.score, 0);
      if (v < worstVal) { worstVal = v; worst = i; }
    }
    const dropped = HUB_BY_ID.get(stops[worst].hubId).name;
    stops = fillStops(stops.filter((_, i) => i !== worst), ctx);
    sim = simulate(stops, ctx);
    costs = Object.fromEntries(tierOrder.map((t) => [t, costOf(sim, stops, t, ctx)]));
    tier = tierOrder.find((t) => costs[t].total <= input.budgetUsd);
    warnings.push(`Dropped ${dropped} to stay closer to your budget.`);
  }
  if (!tier) {
    tier = "budget";
    warnings.push(
      `Your budget ($${input.budgetUsd}) is below the cheapest realistic estimate for ${input.days} days ($${costs.budget.total}). Consider fewer days or a higher budget.`,
    );
  }

  // Seasonal closures the traveller might care about.
  if (input.month) {
    for (const h of HUBS) {
      if (openIn(h.months, input.month)) continue;
      const relevant = h.attractions.some((a) => a.tags.some((t) => input.interests.includes(t)) || a.mustSee);
      if (relevant) warnings.push(`${h.name} is not reachable in your travel month (snow/road closures), so it was left out.`);
    }
  }
  for (const s of stops) {
    const h = HUB_BY_ID.get(s.hubId);
    if (h.note) warnings.push(`${h.name}: ${h.note}`);
  }

  const days = renderDays(sim, stops, ctx);

  const nightsAt = new Map();
  for (const d of days) if (d.sleep) nightsAt.set(d.sleep, (nightsAt.get(d.sleep) || 0) + 1);

  const seen = new Set();
  const routeStops = [];
  stops.forEach((s, i) => {
    const h = HUB_BY_ID.get(s.hubId);
    const isReturn = i === stops.length - 1 && seen.has(h.id);
    seen.add(h.id);
    routeStops.push({
      id: h.id, name: h.name, region: h.region, lat: h.lat, lng: h.lng,
      blurb: h.blurb, note: h.note || null,
      role: i === 0 ? "arrival" : i === stops.length - 1 ? "departure" : "stop",
      isReturn,
      sights: s.attractions.length,
    });
  });

  const totalKm = sim.days.flatMap((d) => d.items).filter((i) => i.kind === "travel")
    .reduce((s, i) => s + i.chunk.km, 0);

  return {
    input,
    tier,
    costs: costs[tier],
    allCosts: costs,
    perPersonNote: "Estimates are per person in USD (approx.), excluding international flights and visa.",
    usdToPkr: USD_TO_PKR,
    stops: routeStops,
    nights: Object.fromEntries(nightsAt),
    totals: {
      days: input.days,
      travelHours: Math.round(sim.travelHours * 10) / 10,
      roadKm: Math.round(totalKm),
      sights: days.flatMap((d) => d.items).filter((i) => i.kind === "visit").length,
    },
    days,
    warnings,
    tips: GENERAL_TIPS,
  };
}
