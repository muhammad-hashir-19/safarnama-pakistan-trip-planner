// Automatically discovers sightseeing places in Pakistan from open data,
// instead of typing them in by hand.
//
//   node scripts/discover.js          # Wikidata + Wikipedia only (free, no key)
//   node scripts/discover.js --ai     # also let Claude review/enrich each place
//
// Sources:
//   * Wikidata SPARQL: every item located in Pakistan with coordinates, its
//     types (mosque, fort, lake…), photo, and number of Wikipedia language
//     editions ("sitelinks") — a good proxy for how famous a place is.
//   * Wikipedia: a 1-2 sentence intro for each place.
//
// Output: src/data/discovered.json, which the planner merges with the
// hand-tuned data in places.js (hand-tuned entries win on duplicates).

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HUBS, JUNCTIONS, EDGES } from "../src/data/places.js";
import { proposeBases, locateTowns, calibrate, connectBase, makeHub } from "./bases.js";
import { classify, haversineKm } from "../src/data/classify.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "..", "src", "data", "discovered.json");
const UA = "pk-trip-planner/0.1 (open-source educational project)";
const MIN_SITELINKS = 3;

// How far (straight line) from a base a place can be and still be visited
// from it. Mountain roads are slow, so the limits are tighter there.
const RADIUS_KM = { plains: 45, mountains: 30 };
const DAYTRIP_RADIUS_KM = { plains: 110, mountains: 60 }; // only for famous places
const MOUNTAIN_REGIONS = /Gilgit-Baltistan|Khyber Pakhtunkhwa|Azad Kashmir/;

const SPARQL = `
SELECT ?item ?itemLabel ?itemDescription ?coord ?sitelinks ?article ?image (MAX(?elev) AS ?elevation)
       (GROUP_CONCAT(DISTINCT ?typeLabel; separator="|") AS ?types) WHERE {
  ?item wdt:P17 wd:Q843; wdt:P625 ?coord; wikibase:sitelinks ?sitelinks.
  FILTER(?sitelinks >= ${MIN_SITELINKS})
  OPTIONAL { ?item wdt:P31 ?type. ?type rdfs:label ?typeLabel. FILTER(LANG(?typeLabel)="en") }
  OPTIONAL { ?article schema:about ?item; schema:isPartOf <https://en.wikipedia.org/>. }
  OPTIONAL { ?item wdt:P18 ?image. }
  OPTIONAL { ?item wdt:P2044 ?elev. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} GROUP BY ?item ?itemLabel ?itemDescription ?coord ?sitelinks ?article ?image`;

async function getJson(url, init = {}, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { ...init, headers: { "User-Agent": UA, Accept: "application/json", ...init.headers } });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      if (i >= tries) throw new Error(`${url.slice(0, 80)}…: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5000 * i));
    }
  }
}

async function fetchWikidata() {
  console.log("Querying Wikidata (can take ~1 minute)…");
  const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(SPARQL)}`;
  const data = await getJson(url, { headers: { Accept: "application/sparql-results+json" } });
  const seen = new Map();
  for (const b of data.results.bindings) {
    const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(b.coord.value);
    if (!m) continue;
    const id = b.item.value.split("/").pop();
    const prev = seen.get(id);
    const row = {
      qid: id,
      name: b.itemLabel.value,
      wdDesc: b.itemDescription?.value || "",
      lat: Number(m[2]),
      lng: Number(m[1]),
      sitelinks: Number(b.sitelinks.value),
      types: b.types.value ? b.types.value.split("|") : [],
      wiki: b.article?.value || null,
      elevation: b.elevation ? Number(b.elevation.value) : null,
      image: b.image ? `${b.image.value.replace("http://", "https://")}?width=480` : null,
    };
    // Items with several coordinates appear more than once; keep the first.
    if (!prev) seen.set(id, row);
  }
  return [...seen.values()];
}

async function fetchExtracts(places) {
  const withWiki = places.filter((p) => p.wiki);
  const titles = withWiki.map((p) => decodeURIComponent(p.wiki.split("/wiki/")[1]).replace(/_/g, " "));
  const byTitle = new Map();
  console.log(`Fetching Wikipedia intros for ${titles.length} places…`);
  for (let i = 0; i < titles.length; i += 20) {
    const batch = titles.slice(i, i + 20);
    const url = "https://en.wikipedia.org/w/api.php?" + new URLSearchParams({
      action: "query", format: "json", prop: "extracts", exintro: "1", explaintext: "1",
      exsentences: "2", exlimit: "20", redirects: "1", titles: batch.join("|"),
    });
    let data;
    try {
      data = await getJson(url, {}, 5);
    } catch (err) {
      console.warn(`  skipped a batch of intros (${err.message}); using Wikidata descriptions instead`);
      continue;
    } finally {
      await new Promise((r) => setTimeout(r, 1500)); // be polite to Wikipedia
    }
    // A redirect means the article is about something broader (e.g. a lake
    // redirecting to its valley), so its intro would describe the wrong thing.
    const redirected = new Set((data.query.redirects || []).map((r) => r.to));
    const normalized = new Map((data.query.normalized || []).map((r) => [r.to, r.from]));
    for (const page of Object.values(data.query.pages || {})) {
      if (!page.extract || redirected.has(page.title)) continue;
      byTitle.set(normalized.get(page.title) || page.title, cleanExtract(page.extract));
    }
  }
  withWiki.forEach((p, i) => { p.extract = byTitle.get(titles[i]) || null; });
}

// Drop "(Urdu: …, romanized: …)" style asides that are noise for visitors.
function cleanExtract(text) {
  let t = text.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3; i++) {
    t = t.replace(/\s*\((?:[^()]*?)(?:[؀-ۿༀ-࿿]|romani[sz]ed|lit\.|transl\.|Urdu|Punjabi|Sindhi|Pashto|Balti|Wakhi|Hindko|pronounced)(?:[^()]*?)\)/g, "");
  }
  return t.replace(/\s+([,.])/g, "$1").trim();
}

// Get a ready-made thumbnail URL for each place from its Wikipedia article.
// (commons.wikimedia.org isn't reachable from every network; Wikipedia's
// thumbnail host is.)
async function resolveImages(places) {
  const titleOf = (p) => decodeURIComponent(p.wiki.split("/wiki/")[1]).replace(/_/g, " ");
  const withWiki = places.filter((p) => p.wiki);
  console.log(`Fetching photos for ${withWiki.length} places from Wikipedia…`);
  const thumbs = new Map();
  for (let i = 0; i < withWiki.length; i += 50) {
    const batch = withWiki.slice(i, i + 50).map(titleOf);
    const url = "https://en.wikipedia.org/w/api.php?" + new URLSearchParams({
      action: "query", format: "json", prop: "pageimages", piprop: "thumbnail", pithumbsize: "320",
      pilimit: "50", titles: batch.join("|"),
    });
    try {
      const data = await getJson(url, {}, 5);
      const norm = new Map((data.query.normalized || []).map((r) => [r.to, r.from]));
      for (const page of Object.values(data.query.pages || {})) {
        const src = page.thumbnail?.source;
        if (src) thumbs.set(norm.get(page.title) || page.title, src.split("?")[0]);
      }
    } catch (err) {
      console.warn(`  skipped a batch of photos (${err.message})`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  for (const p of places) p.image = p.wiki ? thumbs.get(titleOf(p)) || null : null;
}

function slug(s) {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function assignHub(place, hubs = HUBS) {
  let best = null;
  for (const h of hubs) {
    const d = haversineKm(h, place);
    // A valley whose point sits on a base *is* that base (e.g. "Hunza Valley").
    const isValley = place.types.some((t) => /valley/i.test(t));
    if (d < 25 && isValley) return null;
    const terrain = MOUNTAIN_REGIONS.test(h.region) && h.id !== "peshawar" ? "mountains" : "plains";
    const famous = place.sitelinks >= 10 && !isValley;
    const limit = famous ? DAYTRIP_RADIUS_KM[terrain] : RADIUS_KM[terrain];
    if (d <= limit && (!best || d < best.d)) best = { hub: h.id, d };
  }
  return best;
}

async function aiEnrich(places) {
  const { enrichPlaces } = await import("../src/enrich.js");
  console.log(`Asking Claude to review ${places.length} places…`);
  const BATCH = 40;
  for (let i = 0; i < places.length; i += BATCH) {
    const batch = places.slice(i, i + BATCH);
    const reviews = await enrichPlaces(batch);
    for (const r of reviews) {
      const p = batch.find((x) => x.id === r.id);
      if (!p) continue;
      p.ai = true;
      p.include = r.worth_visiting;
      if (r.worth_visiting) {
        p.desc = r.description;
        p.hours = r.hours;
        p.bestTime = r.best_time;
        if (r.interests.length) p.tags = r.interests;
      }
    }
    console.log(`  reviewed ${Math.min(i + BATCH, places.length)}/${places.length}`);
  }
}

async function createBases(unassigned, raw) {
  const existing = [...HUBS, ...JUNCTIONS];
  const proposals = proposeBases(unassigned, raw, existing);
  if (!proposals.length) return { hubs: [], edges: [], skipped: [] };
  console.log(`Checking ${proposals.length} possible new bases…`);
  const where = await locateTowns(proposals.map((p) => p.town.qid));
  const skipped = [];
  const safe = proposals.filter((p) => {
    const w = where.get(p.town.qid);
    if (w?.advisory) skipped.push(`${p.town.name} (${p.members[0].name})`);
    return w && !w.advisory;
  });
  await fetchExtracts(safe.map((p) => p.town));

  console.log("Calibrating drive times against the hand-entered roads…");
  const factor = await calibrate(existing, EDGES);
  console.log(`  real time ≈ OSRM × ${factor.plains} on plains, × ${factor.mountains} in mountains (${factor.samples} roads)`);

  const hubs = [];
  const edges = [];
  const nodes = [...existing];
  for (const p of safe) {
    const hub = makeHub(p, where.get(p.town.qid), p.town.extract);
    const roads = await connectBase(hub, nodes, factor);
    if (!roads.length) continue;
    hubs.push(hub);
    edges.push(...roads);
    nodes.push(hub);
    await new Promise((r) => setTimeout(r, 500));
  }
  return { hubs, edges, skipped };
}

async function main() {
  const useAi = process.argv.includes("--ai");
  const useBases = !process.argv.includes("--no-bases");
  if (useAi) {
    try { process.loadEnvFile(path.join(here, "..", ".env")); } catch { /* no .env */ }
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("--ai needs ANTHROPIC_API_KEY (in .env or the environment).");
  }
  const raw = await fetchWikidata();
  console.log(`Wikidata returned ${raw.length} located items in Pakistan.`);

  const sights = [];
  for (const r of raw) {
    const c = classify(r.types, r.name, r.wdDesc, r.elevation);
    if (!c) continue;
    sights.push({ ...r, ...c });
  }
  // Drop sub-features of a more famous place (e.g. "Great Bath, Mohenjo-daro").
  sights.sort((a, b) => b.sitelinks - a.sitelinks);
  const kept = [];
  for (const s of sights) {
    const lower = s.name.toLowerCase();
    const dup = kept.find((k) => {
      const d = haversineKm(k, s);
      return d < 0.15 || (d < 3 && (lower.includes(k.name.toLowerCase()) || k.name.toLowerCase().includes(lower)));
    });
    if (!dup) kept.push(s);
  }
  sights.length = 0;
  sights.push(...kept);
  console.log(`${sights.length} look like places a visitor can go to.`);

  await fetchExtracts(sights);
  // Wikipedia sometimes tells us a place no longer exists.
  const gone = /\b(demolished|no longer exists|was destroyed|razed|submerged)\b/i;
  for (let i = sights.length - 1; i >= 0; i--) if (gone.test(sights[i].extract || "")) sights.splice(i, 1);

  const assigned = [];
  let unassigned = [];
  const assignTo = (place, hubs) => {
    const hub = assignHub(place, hubs);
    if (!hub) return false;
    if (hub.d > 35) {
      // Far but famous: make it a day trip that includes the drive there and back.
      const drive = (2 * hub.d * 1.35) / 45;
      place.hours = Math.max(5, Math.round((place.hours + drive) * 2) / 2);
      place.bestTime = "morning";
    }
    assigned.push({ ...place, hubId: hub.hub, distKm: Math.round(hub.d) });
    return true;
  };
  for (const s of sights) {
    const desc = s.extract || (s.wdDesc ? s.wdDesc[0].toUpperCase() + s.wdDesc.slice(1) + "." : "");
    const place = {
      id: `wd-${slug(s.name)}-${s.qid.toLowerCase()}`,
      qid: s.qid,
      name: s.name,
      lat: Math.round(s.lat * 1e4) / 1e4,
      lng: Math.round(s.lng * 1e4) / 1e4,
      hours: s.hours,
      tags: s.tags,
      bestTime: s.bestTime,
      sitelinks: s.sitelinks,
      heritage: s.heritage,
      months: s.months,
      elevation: s.elevation,
      desc,
      image: s.image,
      wiki: s.wiki,
      types: s.types,
    };
    if (!assignTo(place, HUBS)) unassigned.push(place);
  }

  // ---- New base towns for famous sites that no base covers.
  const { hubs: newHubs, edges: newEdges, skipped } = useBases ? await createBases(unassigned, raw) : { hubs: [], edges: [], skipped: [] };
  unassigned = unassigned.filter((p) => !assignTo(p, newHubs));
  // Keep a new base only if it has enough to see; otherwise undo it.
  const MIN_BASE_FAME = 25;
  for (const h of [...newHubs]) {
    const mine = assigned.filter((p) => p.hubId === h.id);
    if (mine.reduce((s, p) => s + p.sitelinks, 0) >= MIN_BASE_FAME) continue;
    newHubs.splice(newHubs.indexOf(h), 1);
    for (const p of mine) {
      assigned.splice(assigned.indexOf(p), 1);
      unassigned.push(p);
    }
  }
  const keptIds = new Set([...HUBS, ...JUNCTIONS, ...newHubs].map((n) => n.id));
  for (let i = newEdges.length - 1; i >= 0; i--) {
    if (!keptIds.has(newEdges[i].a) || !keptIds.has(newEdges[i].b)) newEdges.splice(i, 1);
  }

  await resolveImages(assigned);
  if (useAi) await aiEnrich(assigned);

  assigned.sort((a, b) => b.sitelinks - a.sitelinks);
  const out = {
    generatedAt: new Date().toISOString(),
    sources: ["Wikidata (CC0)", "Wikipedia (CC BY-SA)"],
    aiReviewed: useAi,
    hubs: newHubs,
    edges: newEdges,
    skippedForSafety: skipped,
    places: assigned,
    unassigned: unassigned.sort((a, b) => b.sitelinks - a.sitelinks).map(({ name, lat, lng, sitelinks, types }) => ({ name, lat, lng, sitelinks, types })),
  };
  await fs.writeFile(OUT, JSON.stringify(out, null, 1));

  const perHub = {};
  for (const p of assigned) perHub[p.hubId] = (perHub[p.hubId] || 0) + 1;
  console.log(`\nSaved ${assigned.length} places near your bases to ${path.relative(process.cwd(), OUT)}`);
  console.log(Object.entries(perHub).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k}: ${v}`).join("\n"));
  if (newHubs.length) console.log(`\nNew bases: ${newHubs.map((h) => `${h.name} (${h.region})`).join(", ")}`);
  if (skipped.length) console.log(`Not added because of travel advisories: ${skipped.join(", ")}`);
  console.log(`\n${unassigned.length} places are too far from any base (most famous: ${unassigned.slice(0, 8).map((u) => u.name).join(", ")}).`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
