// Fetches hotels and restaurants around every base from OpenStreetMap.
//
//   node scripts/stays.js
//
// Output: src/data/stays.json  { [hubId]: { hotels: [...], restaurants: [...] } }
// Data © OpenStreetMap contributors (ODbL). Many listings have no phone or
// website in OSM; the app adds Google Maps / Booking.com search links for those.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HUBS } from "../src/data/index.js";
import { classifyHotel, classifyRestaurant, cleanPhone } from "../src/data/stays-classify.js";
import { haversineKm } from "../src/data/classify.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "..", "src", "data", "stays.json");
const UA = "pk-trip-planner/0.1 (open-source educational project)";
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const MAX_PER_KIND = 60;

const BIG_CITIES = new Set(["islamabad", "lahore", "karachi", "peshawar", "multan", "auto-hyderabad"]);

async function overpass(query) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const url = OVERPASS[attempt % OVERPASS.length];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: query }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

const pick = (t, ...keys) => {
  for (const k of keys) if (t[k]) return t[k];
  return null;
};

function address(t) {
  const parts = [pick(t, "addr:housenumber"), pick(t, "addr:street"), pick(t, "addr:city")].filter(Boolean);
  return parts.length ? parts.join(", ") : pick(t, "addr:full");
}

function toItem(el, hub) {
  const t = el.tags || {};
  const name = pick(t, "name:en", "name", "brand");
  if (!name) return null;
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  let website = pick(t, "website", "contact:website", "url");
  if (website && !/^https?:\/\//i.test(website)) website = `https://${website}`;
  return {
    osm: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    name,
    nameLocal: t.name && t.name !== name ? t.name : null,
    lat, lng,
    distKm: Math.round(haversineKm(hub, { lat, lng }) * 10) / 10,
    phones: cleanPhone(pick(t, "phone", "contact:phone", "contact:mobile", "mobile")),
    website,
    email: pick(t, "email", "contact:email"),
    address: address(t),
    hours: t.opening_hours || null,
    tags: t,
  };
}

async function fetchHub(hub) {
  const r = BIG_CITIES.has(hub.id) ? 9000 : 14000;
  const q = `[out:json][timeout:90];
(
  nwr["tourism"~"^(hotel|guest_house|hostel|motel|resort|chalet|apartment|camp_site|alpine_hut)$"]["name"](around:${r},${hub.lat},${hub.lng});
  nwr["amenity"~"^(restaurant|cafe|fast_food|food_court)$"]["name"](around:${r},${hub.lat},${hub.lng});
);
out center tags;`;
  const data = await overpass(q);
  const hotels = [];
  const restaurants = [];
  const seen = new Set();
  for (const el of data.elements) {
    const item = toItem(el, hub);
    if (!item) continue;
    const key = item.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (item.tags.tourism) hotels.push({ ...item, ...classifyHotel(item, hub) });
    else restaurants.push({ ...item, ...classifyRestaurant(item, hub) });
  }
  // Listings you can actually contact first, then closer ones.
  const rank = (x) => (x.phones.length ? 0 : 2) + (x.website ? 0 : 1) + x.distKm / 20;
  const finish = (arr) => arr.sort((a, b) => rank(a) - rank(b)).slice(0, MAX_PER_KIND).map(({ tags, ...rest }) => rest);
  return { hotels: finish(hotels), restaurants: finish(restaurants) };
}

async function main() {
  const out = { generatedAt: new Date().toISOString(), source: "© OpenStreetMap contributors (ODbL)", hubs: {} };
  for (const hub of HUBS) {
    try {
      const res = await fetchHub(hub);
      out.hubs[hub.id] = res;
      const c = (a) => `${a.length} (${a.filter((x) => x.phones.length || x.website).length} with contact)`;
      console.log(`${hub.name.padEnd(32)} hotels ${c(res.hotels)}, restaurants ${c(res.restaurants)}`);
    } catch (err) {
      console.warn(`${hub.name}: skipped (${err.message})`);
    }
    await new Promise((r) => setTimeout(r, 2500)); // Overpass asks for gentle use
  }
  await fs.writeFile(OUT, JSON.stringify(out, null, 1));
  console.log(`\nSaved to ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
