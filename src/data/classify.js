// Turns Wikidata "instance of" labels into planner fields: which interests a
// place matches, how long a visit takes, and the best time of day.

export function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Order matters: the first matching rule sets hours/bestTime; tags from every
// matching rule are combined.
const RULES = [
  { match: /archaeological|ruins|ancient city|excavation/, tags: ["history"], hours: 2.5, bestTime: "morning" },
  // Parks are huge and Wikidata gives one point for them, so treat them as a
  // normal (not day-trip) visit: only kept if that point is close to a base.
  { match: /national park|nature reserve|wildlife|sanctuary|protected area/, tags: ["nature", "wildlife", "hiking"], hours: 3.5, bestTime: "morning" },
  { match: /valley/, tags: ["nature", "mountains", "photography"], hours: 4, bestTime: "morning" },
  { match: /mountain pass/, tags: ["mountains", "photography", "adventure"], hours: 3, bestTime: "morning" },
  { match: /plateau|meadow|pasture/, tags: ["nature", "mountains", "photography"], hours: 4, bestTime: "morning" },
  { match: /island/, tags: ["beaches", "adventure"], hours: 5, bestTime: "morning" },
  { match: /fort|castle|citadel|palace|city gate|haveli/, tags: ["history", "architecture"], hours: 1.5, bestTime: "morning" },
  { match: /museum|gallery/, tags: ["history", "culture"], hours: 2, bestTime: "morning" },
  { match: /mosque|masjid/, tags: ["religious", "architecture"], hours: 1, bestTime: "afternoon" },
  { match: /temple|gurdwara|church|cathedral|shrine|dargah|stupa|monastery|buddhist|sufi/, tags: ["religious", "history", "culture"], hours: 1, bestTime: "any" },
  { match: /mausoleum|tomb|necropolis|cemetery/, tags: ["history", "architecture"], hours: 1, bestTime: "afternoon" },
  { match: /lake|reservoir|lagoon/, tags: ["lakes", "nature", "photography"], hours: 2, bestTime: "afternoon" },
  { match: /waterfall|spring/, tags: ["nature", "photography"], hours: 1.5, bestTime: "any" },
  { match: /beach/, tags: ["beaches", "relaxation"], hours: 2, bestTime: "evening" },
  { match: /bazaar|market/, tags: ["shopping", "food", "culture"], hours: 2, bestTime: "any" },
  { match: /zoo|botanical/, tags: ["wildlife", "nature"], hours: 2, bestTime: "morning" },
  { match: /garden|park/, tags: ["nature", "relaxation"], hours: 1.5, bestTime: "evening" },
  { match: /monument|memorial|minaret|tower/, tags: ["history", "architecture"], hours: 1, bestTime: "any" },
  { match: /bridge/, tags: ["architecture", "photography"], hours: 0.5, bestTime: "any" },
  { match: /tourist attraction|landmark|viewpoint/, tags: ["photography"], hours: 1.5, bestTime: "any" },
];

// Things that are on Wikidata but aren't sights (even if also tagged as one).
const EXCLUDE = /\b(city|town|village|human settlement|district|tehsil|union council|division|province|capital|neighbo|suburb|cantonment|airport|aerodrome|airbase|university|college|school|hospital|stadium|cricket|station|attack|bombing|battle|siege|earthquake|disaster|accident|crash|language|ecoregion|highway|road|railway|canal|power station|company|organization|legislature|mountain range|river|stream|circle of latitude|meridian|border|hotel)\b/;

// Glaciers and deserts are excluded above: Wikidata gives a single point for
// something tens of km wide, and most glaciers are multi-day treks.
export function classify(types, name = "", desc = "", elevation = null) {
  const t = types.map((x) => x.toLowerCase());
  const joined = t.join(" | ");
  if (!t.length || EXCLUDE.test(joined)) return null;
  // Bare mountains are rarely somewhere you "visit" for a few hours.
  if (t.every((x) => /mountain|summit|peak|hill/.test(x))) return null;

  // Very high places are expedition/trek territory, not a few hours' visit.
  if (elevation && elevation > 4200 && !t.some((x) => /mountain pass/.test(x))) return null;

  const hits = RULES.filter((r) => t.some((x) => r.match.test(x)));
  if (!hits.length) return null;
  const tags = [...new Set(hits.flatMap((r) => r.tags))];
  const heritage = /world heritage/.test(joined) || /unesco/i.test(desc);
  if (heritage && !tags.includes("history")) tags.push("history");
  if (/sufi|shrine/.test(`${joined} ${name.toLowerCase()}`) && !tags.includes("culture")) tags.push("culture");
  // Snow closes high places in winter.
  const months = elevation >= 3000 ? [6, 7, 8, 9, 10] : elevation >= 2400 ? [5, 6, 7, 8, 9, 10] : null;
  return { tags, hours: hits[0].hours, bestTime: hits[0].bestTime, heritage, months };
}
