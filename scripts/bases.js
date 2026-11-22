// Creates new base towns automatically for famous sites that are too far
// from every hand-entered base, and connects them to the road network.
//
//  1. Group far-away sites into clusters around the most famous one.
//  2. Pick the best-known city/town near each cluster as the base.
//  3. Skip bases in areas most governments advise foreigners against
//     (Balochistan, ex-FATA tribal districts).
//  4. Get real driving times from OSRM, corrected by a factor learned from
//     the hand-entered roads (OSRM assumes speed limits; Pakistani roads,
//     especially in the mountains, are slower).

import { haversineKm } from "../src/data/classify.js";

const UA = "pk-trip-planner/0.1 (open-source educational project)";
const OSRM = "https://router.project-osrm.org";

const CLUSTER_KM = 50; // sites this close to the seed join its cluster
const TOWN_KM = 60; // base town must be this close to the seed site
const MIN_SEED_FAME = 12; // sitelinks of the cluster's most famous site…
const MIN_CLUSTER_FAME = 30; // …or of the whole cluster
const MAX_BASES = 12;
const CONNECT_TO = 2; // new roads per base
const MOUNTAIN_LAT = 34.3; // rough line north of which roads are mountain roads

const ADVISORY = /Balochistan|Federally Administered Tribal|Waziristan|Kurram|Bajaur|Orakzai|Mohmand|Khyber District|Tirah/i;
const PROVINCES = [
  [/Gilgit-Baltistan/i, "Gilgit-Baltistan"],
  [/Azad (Jammu and )?Kashmir/i, "Azad Kashmir"],
  [/Khyber Pakhtunkhwa/i, "Khyber Pakhtunkhwa"],
  [/Islamabad Capital/i, "Capital Territory"],
  [/Sindh/i, "Sindh"],
  [/Punjab/i, "Punjab"],
];

const isTown = (types) => types.some((t) => /^(city|big city|town|million city|metropolis|largest city)$/i.test(t));

async function getJson(url, init = {}) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { ...init, headers: { "User-Agent": UA, Accept: "application/json", ...init.headers } });
      if (!res.ok) throw new Error(`${res.status}`);
      return await res.json();
    } catch (err) {
      if (i >= 4) throw new Error(`${url.slice(0, 70)}…: ${err.message}`);
      await new Promise((r) => setTimeout(r, 4000 * i));
    }
  }
}

function slug(s) {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function proposeBases(unassigned, raw, existingNodes) {
  const towns = raw.filter((r) => isTown(r.types) && !existingNodes.some((n) => haversineKm(n, r) < 20));
  const pool = [...unassigned].sort((a, b) => b.sitelinks - a.sitelinks);
  const used = new Set();
  const bases = new Map();
  for (const seed of pool) {
    if (used.has(seed.id)) continue;
    const members = pool.filter((p) => !used.has(p.id) && haversineKm(seed, p) <= CLUSTER_KM);
    const fame = members.reduce((s, p) => s + p.sitelinks, 0);
    if (seed.sitelinks < MIN_SEED_FAME && fame < MIN_CLUSTER_FAME) continue;
    let best = null;
    for (const t of towns) {
      const d = haversineKm(seed, t);
      if (d > TOWN_KM) continue;
      const score = Math.log10(t.sitelinks + 1) * 30 - d; // big, well-known town that is close
      if (!best || score > best.score) best = { town: t, score };
    }
    if (!best) continue;
    members.forEach((m) => used.add(m.id));
    const key = best.town.qid;
    if (bases.has(key)) bases.get(key).members.push(...members);
    else bases.set(key, { town: best.town, members });
  }
  return [...bases.values()]
    .sort((a, b) => b.members.reduce((s, p) => s + p.sitelinks, 0) - a.members.reduce((s, p) => s + p.sitelinks, 0))
    .slice(0, MAX_BASES);
}

// Which province is each town in, and is it in an advisory area?
export async function locateTowns(qids) {
  if (!qids.length) return new Map();
  const q = `SELECT ?town ?ancLabel WHERE {
    VALUES ?town { ${qids.map((x) => `wd:${x}`).join(" ")} }
    ?town wdt:P131* ?anc.
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
  }`;
  const data = await getJson(`https://query.wikidata.org/sparql?query=${encodeURIComponent(q)}`, {
    headers: { Accept: "application/sparql-results+json" },
  });
  const anc = new Map(qids.map((x) => [x, []]));
  for (const b of data.results.bindings) anc.get(b.town.value.split("/").pop())?.push(b.ancLabel.value);
  const out = new Map();
  for (const [qid, labels] of anc) {
    const joined = labels.join(" | ");
    const region = PROVINCES.find(([re]) => re.test(joined))?.[1] || null;
    out.set(qid, { region, advisory: ADVISORY.test(joined) });
  }
  return out;
}

async function osrmTable(source, destinations) {
  const coords = [source, ...destinations].map((p) => `${p.lng},${p.lat}`).join(";");
  const dst = destinations.map((_, i) => i + 1).join(";");
  const url = `${OSRM}/table/v1/driving/${coords}?sources=0&destinations=${dst}&annotations=duration,distance`;
  const data = await getJson(url);
  if (data.code !== "Ok") throw new Error(`OSRM: ${data.code}`);
  return destinations.map((_, i) => ({ hours: data.durations[0][i] / 3600, km: data.distances[0][i] / 1000 }));
}

const isMountain = (a, b) => Math.max(a.lat, b.lat) >= MOUNTAIN_LAT;

// Learn how much slower real travel is than OSRM's estimate, separately for
// plains and mountain roads, from the roads entered by hand.
export async function calibrate(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ratios = { plains: [], mountains: [] };
  for (const e of edges) {
    if (e.mode !== "road") continue;
    const a = byId.get(e.a);
    const b = byId.get(e.b);
    const [r] = await osrmTable(a, [b]);
    if (r.hours > 0.2) ratios[isMountain(a, b) ? "mountains" : "plains"].push(e.hours / r.hours);
    await new Promise((res) => setTimeout(res, 400));
  }
  const median = (xs, fallback) => {
    if (!xs.length) return fallback;
    const s = [...xs].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };
  return {
    plains: Math.round(median(ratios.plains, 1.2) * 100) / 100,
    mountains: Math.round(median(ratios.mountains, 1.6) * 100) / 100,
    samples: ratios.plains.length + ratios.mountains.length,
  };
}

export async function connectBase(base, nodes, factor) {
  const near = nodes
    .filter((n) => n.id !== base.id)
    .map((n) => ({ n, d: haversineKm(base, n) }))
    .filter((x) => x.d < 350)
    .sort((x, y) => x.d - y.d)
    .slice(0, 8)
    .map((x) => x.n);
  if (!near.length) return [];
  const res = await osrmTable(base, near);
  return near
    .map((n, i) => ({ n, ...res[i] }))
    .filter((x) => x.hours > 0 && Number.isFinite(x.hours))
    .sort((x, y) => x.hours - y.hours)
    // A much longer second road almost always runs through the first
    // neighbour anyway; adding it would just hide that pass-through.
    .filter((x, i, arr) => i === 0 || x.hours <= arr[0].hours * 1.6)
    .slice(0, CONNECT_TO)
    .map((x) => ({
      a: base.id,
      b: x.n.id,
      hours: Math.max(0.5, Math.round(x.hours * factor[isMountain(base, x.n) ? "mountains" : "plains"] * 4) / 4),
      km: Math.round(x.km),
      mode: "road",
      label: "Road (time estimated from OSRM)",
      auto: true,
    }));
}

export function makeHub(base, info, extract) {
  const fame = base.members.reduce((s, p) => s + p.sitelinks, 0);
  return {
    id: `auto-${slug(base.town.name)}`,
    qid: base.town.qid,
    name: base.town.name,
    region: info.region || "Pakistan",
    lat: Math.round(base.town.lat * 1e4) / 1e4,
    lng: Math.round(base.town.lng * 1e4) / 1e4,
    popularity: Math.min(0.6, 0.25 + Math.log10(fame) / 6),
    coreHours: 5,
    lodging: 0.85,
    auto: true,
    blurb:
      extract ||
      `Base for visiting ${base.members.slice(0, 3).map((m) => m.name).join(", ")}.`,
  };
}
