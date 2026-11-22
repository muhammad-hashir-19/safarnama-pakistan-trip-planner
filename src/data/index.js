// Merges hand-tuned places (places.js) with automatically discovered ones
// (discovered.json, produced by `npm run discover`). Hand-tuned entries win
// when both describe the same place.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HUBS as CURATED, EDGES as CURATED_EDGES, JUNCTIONS } from "./places.js";
import { haversineKm } from "./classify.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(here, "discovered.json");

const STOP = new Set(["the", "of", "and", "mosque", "masjid", "fort", "lake", "tomb", "park", "national", "museum", "garden", "gardens", "valley", "shrine", "temple", "palace"]);
const tokens = (s) =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w));

function sameName(a, b) {
  const ta = tokens(a);
  const tb = new Set(tokens(b));
  return ta.some((w) => tb.has(w) || [...tb].some((x) => x.slice(0, 5) === w.slice(0, 5)));
}

export function loadDiscovered() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return null;
  }
}

export function mergeHubs(curated, discovered) {
  if (!discovered) return curated;
  const byHub = new Map();
  for (const p of discovered.places) {
    if (p.include === false) continue; // AI review said "not worth it"
    if (!byHub.has(p.hubId)) byHub.set(p.hubId, []);
    byHub.get(p.hubId).push(p);
  }
  // Bases created automatically (scripts/bases.js) start with no sights of their own.
  const autoHubs = (discovered.hubs || [])
    .filter((h) => !curated.some((c) => c.id === h.id))
    .map((h) => ({ ...h, attractions: [] }));
  const all = [...curated, ...autoHubs].map((hub) => {
    const extra = [];
    for (const p of byHub.get(hub.id) || []) {
      const dup = hub.attractions.some((a) => {
        const d = haversineKm(a, p);
        if (d < 0.4 || (d < 8 && sameName(a.name, p.name))) return true;
        // Part of a big hand-picked site visit (e.g. Sirkap is covered by "Taxila").
        return a.hours >= 4 && d < 4 && a.tags.includes("history") && p.tags.includes("history");
      });
      if (dup) continue;
      extra.push({
        id: p.id,
        name: p.name,
        lat: p.lat,
        lng: p.lng,
        hours: p.hours,
        tags: p.tags,
        fee: 0,
        feeUnknown: true,
        bestTime: p.bestTime,
        months: p.months || undefined,
        mustSee: p.heritage || p.sitelinks >= 20,
        sitelinks: p.sitelinks,
        desc: p.desc || "",
        image: p.image,
        wiki: p.wiki,
        source: p.ai ? "wikidata+ai" : "wikidata",
      });
    }
    return { ...hub, attractions: [...hub.attractions, ...extra] };
  });
  // An auto base with nothing to see (e.g. every site was a duplicate) is useless.
  return all.filter((h) => !h.auto || h.attractions.length);
}

const discovered = loadDiscovered();
export const HUBS = mergeHubs(CURATED, discovered);
const nodeIds = new Set([...HUBS.map((h) => h.id), ...JUNCTIONS.map((j) => j.id)]);
// Roads to/from an auto base that was dropped above are dropped too.
export const EDGES = [...CURATED_EDGES, ...(discovered?.edges || [])].filter(
  (e) => nodeIds.has(e.a) && nodeIds.has(e.b),
);
export const DISCOVERY_INFO = discovered
  ? {
      generatedAt: discovered.generatedAt,
      aiReviewed: discovered.aiReviewed,
      added: HUBS.reduce((s, h) => s + h.attractions.filter((a) => a.source).length, 0),
      newBases: HUBS.filter((h) => h.auto).map((h) => h.name),
    }
  : null;
