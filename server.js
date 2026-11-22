import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { planTrip, validateInput, listOptions } from "./src/planner.js";
import { narratePlan, aiAvailable } from "./src/narrate.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// Load ANTHROPIC_API_KEY etc. from a local .env file if there is one (Node 20.12+).
try {
  process.loadEnvFile(path.join(here, ".env"));
} catch {
  // no .env file — fine
}
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(here, "public")));

// Hotels & restaurants per base (from `npm run stays`).
let STAYS = null;
try {
  STAYS = JSON.parse(fs.readFileSync(path.join(here, "src", "data", "stays.json"), "utf8"));
} catch {
  console.log("(No hotel data yet — run `npm run stays` to fetch it)");
}

app.get("/api/stays", (req, res) => {
  if (!STAYS) return res.status(404).json({ error: "Hotel data hasn't been fetched yet (run npm run stays)." });
  const ids = String(req.query.hubs || "").split(",").filter(Boolean).slice(0, 20);
  const hubs = Object.fromEntries(ids.filter((id) => STAYS.hubs[id]).map((id) => [id, STAYS.hubs[id]]));
  res.json({ source: STAYS.source, generatedAt: STAYS.generatedAt, hubs });
});

app.get("/api/options", (_req, res) => {
  res.json({ ...listOptions(), ai: aiAvailable() });
});

app.post("/api/plan", (req, res) => {
  const { errors, input } = validateInput(req.body || {});
  if (errors.length) return res.status(400).json({ error: errors.join("; ") });
  try {
    res.json(planTrip(input));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not build a plan for these settings." });
  }
});

// Re-plans from the same inputs (so the client can't inject a fake itinerary)
// and asks Claude for the narrative.
app.post("/api/narrate", async (req, res) => {
  if (!aiAvailable()) return res.status(501).json({ error: "AI guide is not configured (set ANTHROPIC_API_KEY)." });
  const { errors, input } = validateInput(req.body || {});
  if (errors.length) return res.status(400).json({ error: errors.join("; ") });
  try {
    const plan = planTrip(input);
    res.json(await narratePlan(plan));
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return res.status(429).json({ error: "AI is busy, try again in a minute." });
    if (err instanceof Anthropic.AuthenticationError) return res.status(502).json({ error: "AI key was rejected." });
    if (err instanceof Anthropic.APIError) {
      console.error(err.status, err.error?.error?.message ?? err.message);
      const reason = err.error?.error?.message;
      return res.status(502).json({ error: `AI service error (${err.status ?? "network"})${reason ? `: ${reason}` : "."}` });
    }
    console.error(err);
    res.status(500).json({ error: err.message || "AI guide failed." });
  }
});

export default app;

// On Vercel the app is imported by api/index.js and run as a serverless
// function; everywhere else, start a normal server.
if (!process.env.VERCEL) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`Pakistan travel guide running at http://localhost:${port}`);
    if (!aiAvailable()) console.log("(AI narrative disabled — set ANTHROPIC_API_KEY to enable it)");
  });
}
