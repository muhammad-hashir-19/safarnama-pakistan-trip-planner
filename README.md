# Safarnama: Pakistan trip planner

A visitor enters their arrival city, dates, number of days, budget and interests. The app gives back:

- a **route** that visits each place once, in an order that follows the real roads
- a **day-by-day plan** with times, drives and sights
- a **cost estimate** in the most comfortable travel style the budget allows (Budget / Standard / Comfort)
- a **map** showing the route. Scenic roads, flights and jeep tracks are drawn differently, and you can view one day at a time.
- optional **AI guide notes** from Claude: what each day feels like, local food, etiquette, packing

## Run it

```powershell
npm install
npm start
```

Open http://localhost:3000.

To turn on the AI notes, set a Claude API key before starting:

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."; npm start
```

Run the tests:

```powershell
npm test
```

## Finding places automatically

You don't have to type sights in by hand. This command pulls them from open data:

```powershell
npm run discover
```

It takes about 3 minutes, is free, and needs no key:

1. Asks **Wikidata** for every place in Pakistan that has coordinates (about 4,800).
2. Keeps the ones a visitor can actually go to, such as mosques, forts, ruins, lakes, museums, national parks and beaches. It drops cities, airports, demolished buildings, places above 4,200 m and multi-day glacier treks (`src/data/classify.js`).
3. Ranks places by **fame**, measured by how many language editions of Wikipedia cover them.
4. Adds a short intro and a photo from **Wikipedia**.
5. Attaches each place to the nearest base town it can be visited from. Famous places further out become full day trips that include the drive.

The result goes to `src/data/discovered.json`. The app merges it with the hand-tuned places in `places.js` when it starts, and the hand-tuned entry wins when both cover the same place. Restart the server after running `discover`.

`npm run discover:ai` does the same, then has Claude review each place: is it really worth visiting, can foreigners go there, how long does a visit take. Claude also writes the visitor description. This needs an API key with credits and **has not been tested yet**.

Base towns and the roads between them are still hand-entered in `places.js`. Driving times through the mountains need to be accurate, and map distances aren't. The script lists famous places that are too far from every base (e.g. Harappa, Ranikot Fort, Hingol) as candidates for new bases.

## How it avoids zig-zag plans

The route and schedule are built by ordinary code, not by the AI. A language model can't be trusted to keep geography straight. Claude only writes descriptions of a plan that is already fixed.

1. **Road network** (`src/data/places.js`): sightseeing bases (hubs), overnight towns and road links with real driving times. Some links only open in certain months (for example Babusar Pass is open June–October). Domestic flights are optional links.
2. **Choosing places**: each sight gets a score from how well it matches your interests. Places are added with *cheapest insertion*: each one goes where it adds the least driving, and only if the whole trip still fits your days. The order is then improved with *2-opt*. Driving back through a town you already stayed in counts as a penalty.
3. **Day plan**: a clock runs through the trip. Drives longer than your pace allows are split at towns with hotels (Besham, Chilas…). Sights within a place are ordered by nearest neighbour, so each day stays local. Sunset and dinner spots go at the end of the day.
4. **Guarantees**, checked by `test/planner.test.js` on 200 random trips:
   - every place is visited in one block of days
   - each drive starts where you currently are
   - each sight is in the town you're staying in
   - the trip ends at your departure city on the right day
5. **Weather buffer**: trips to Gilgit-Baltistan keep a free day at the end, because mountain roads close and northern flights get cancelled.

## Project layout

```
server.js            Express API: /api/options, /api/plan, /api/narrate
src/planner.js       routing, place selection, scheduling, costs
src/narrate.js       Claude (claude-opus-5-5) structured-output guide notes
src/data/places.js   hubs, sights, road links, seasons, price tiers
public/              UI (plain JS + Leaflet/OpenStreetMap)
test/                planner tests
```

## Notes and limits

- **Prices are rough per-person estimates in USD**, and the PKR rate is a constant in `places.js`. Check them against current prices before relying on them.
- Road geometry on the map comes from the public OSRM demo server. If it's down, the map draws straight lines. Swap in your own OSRM or Mapbox server for production.
- The data covers about 20 places and 120 sights. Add more in `places.js`: a hub needs coordinates, `coreHours` and attractions, plus road links in `EDGES`.
- Some areas, such as near the Line of Control or some border districts, need permits for foreigners or are under travel advisories. The app shows a warning where it knows about this, but travellers should check official advice.
