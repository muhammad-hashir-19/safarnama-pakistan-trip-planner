// Optional: Claude reviews automatically discovered places. Open data tells us
// a place exists and roughly what it is; Claude judges whether a tourist can
// actually visit it in a few hours, writes a visitor-facing description and
// estimates visit length and best time of day.

import Anthropic from "@anthropic-ai/sdk";
import { INTERESTS } from "./data/places.js";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const INTEREST_IDS = INTERESTS.map((i) => i.id);

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["places"],
  properties: {
    places: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "worth_visiting", "reason", "description", "hours", "best_time", "interests"],
        properties: {
          id: { type: "string" },
          worth_visiting: { type: "boolean", description: "false if it's inaccessible, off-limits to foreigners, a multi-day expedition, a minor local building, or not really a sight" },
          reason: { type: "string", description: "one short phrase explaining the decision" },
          description: { type: "string", description: "1-2 sentences for a visitor: what it is and why go" },
          hours: { type: "number", description: "typical time on site, including the drive from the nearby base if it is a day trip" },
          best_time: { type: "string", enum: ["morning", "afternoon", "evening", "any"] },
          interests: { type: "array", items: { type: "string", enum: INTEREST_IDS } },
        },
      },
    },
  },
};

const SYSTEM = `You review candidate sightseeing places in Pakistan for a trip planner used by foreign visitors.
Each candidate comes from Wikidata with its type, a short description and the town it would be visited from.
Judge from your own knowledge. Be strict: mark worth_visiting=false for places that are off-limits or unsafe for foreigners, need permits most visitors can't get, need a multi-day trek, are minor/obscure, or are not really something to visit.
Keep descriptions factual; do not invent prices or opening hours.`;

let client = null;

export async function enrichPlaces(places) {
  client ??= new Anthropic();
  const input = places.map((p) => ({
    id: p.id, name: p.name, types: p.types, about: p.desc?.slice(0, 300),
    visited_from: p.hubId, km_from_base: p.distKm,
  }));
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: "user", content: `Review these ${input.length} places:\n${JSON.stringify(input, null, 1)}` }],
  });
  if (response.stop_reason === "refusal") throw new Error("Claude declined to review this batch.");
  if (response.stop_reason === "max_tokens") throw new Error("Claude's review was cut off; use a smaller batch.");
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return JSON.parse(text).places;
}
