// Optional AI layer: Claude turns the planner's fixed itinerary into friendly
// day-by-day guidance. It never chooses places or order — the deterministic
// planner already did that — so the route stays geographically sound.

import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["overview", "days", "cultural_tips", "packing"],
  properties: {
    overview: { type: "string", description: "3-5 sentence overview of the trip's shape and highlights." },
    days: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["day", "narrative", "tips"],
        properties: {
          day: { type: "integer" },
          narrative: { type: "string", description: "2-4 sentences describing the day as a local guide would." },
          tips: { type: "array", items: { type: "string" }, description: "1-3 practical tips specific to that day." },
        },
      },
    },
    cultural_tips: { type: "array", items: { type: "string" } },
    packing: { type: "array", items: { type: "string" } },
  },
};

const SYSTEM = `You are an experienced Pakistani travel guide writing for a foreign visitor.
You receive an itinerary that has already been planned and checked for travel times and geography.
Rules:
- Do not add, remove, reorder or swap any place, drive or day. Describe only what is in the plan.
- Do not invent prices, opening hours or phone numbers. If something should be verified, say so.
- Be warm, concrete and practical: what to eat locally, what to expect on the road, altitude, dress, etiquette.
- Be honest about safety and road conditions without being alarmist.
- Keep each day's narrative to 2-4 sentences.`;

let client = null;
export function aiAvailable() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
}

function compactPlan(plan) {
  return {
    days_total: plan.input.days,
    travel_month: plan.input.month,
    interests: plan.input.interests,
    pace: plan.input.pace,
    style: plan.costs.label,
    route: plan.stops.map((s) => s.name),
    days: plan.days.map((d) => ({
      day: d.day,
      date: d.date,
      sleep: d.sleep,
      items: d.items.map((i) =>
        i.kind === "travel"
          ? `${i.start} travel ${i.from} -> ${i.to} (${i.hours} h, ${i.modes.join("+")}${i.highlights.length ? `; sights on the way: ${i.highlights.join(", ")}` : ""})`
          : i.kind === "visit"
            ? `${i.start} ${i.name} (${i.hub})`
            : i.text,
      ),
    })),
  };
}

export async function narratePlan(plan) {
  client ??= new Anthropic();
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: SCHEMA },
    },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `Write the guide text for this itinerary:\n\n${JSON.stringify(compactPlan(plan), null, 1)}`,
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("The AI declined to write this guide. The plan itself is still valid.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("The AI response was cut off. Try a shorter trip or retry.");
  }
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return JSON.parse(text);
}
