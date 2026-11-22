const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (usd) => `$${Math.round(usd).toLocaleString()}`;

let OPTIONS = null;
let lastRequest = null;
let lastPlan = null;
let map = null;
let mapLayers = null;

const DAY_COLORS = ["#0b6b45", "#d9822b", "#3a6ea5", "#b8436b", "#6a8f1f", "#8a5a9e", "#1f8a8a", "#a0522d", "#4b5bbf", "#c0392b"];
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

async function init() {
  OPTIONS = await fetch("/api/options").then((r) => r.json());
  const entry = $("#entry");
  const exit = $("#exit");
  for (const g of OPTIONS.gateways) {
    entry.add(new Option(g.name, g.id));
    exit.add(new Option(g.name, g.id));
  }
  const chips = $("#interests");
  const defaults = new Set(["mountains", "lakes", "history", "food"]);
  for (const i of OPTIONS.interests) {
    const label = document.createElement("label");
    label.innerHTML = `<input type="checkbox" name="interests" value="${esc(i.id)}" ${defaults.has(i.id) ? "checked" : ""}/><span>${esc(i.label)}</span>`;
    chips.append(label);
  }
  const start = new Date(Date.now() + 30 * 86400000);
  $("#startDate").value = start.toISOString().slice(0, 10);
  $("#trip-form").addEventListener("submit", onSubmit);
}

function readForm() {
  const f = new FormData($("#trip-form"));
  const budget = Number(f.get("budget"));
  const budgetUsd = f.get("currency") === "PKR" ? budget / OPTIONS.usdToPkr : budget;
  return {
    entry: f.get("entry"),
    exit: f.get("exit") || f.get("entry"),
    startDate: f.get("startDate"),
    days: Number(f.get("days")),
    budgetUsd: Math.round(budgetUsd),
    travelers: Number(f.get("travelers")) || 1,
    interests: f.getAll("interests"),
    pace: f.get("pace"),
    allowFlights: f.get("allowFlights") === "on",
    preferScenic: f.get("preferScenic") === "on",
  };
}

async function onSubmit(e) {
  e.preventDefault();
  const btn = $("#submit");
  btn.disabled = true;
  btn.textContent = "Planning…";
  try {
    const body = readForm();
    const res = await fetch("/api/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Planning failed");
    lastRequest = body;
    lastPlan = data;
    renderPlan(data);
  } catch (err) {
    $("#results").innerHTML = `<div class="panel error">${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Plan my trip";
  }
}

function renderPlan(plan) {
  const results = $("#results");
  results.innerHTML = "";
  results.append($("#results-tpl").content.cloneNode(true));

  // Route chips
  const stopNum = new Map();
  let n = 0;
  $("#route").innerHTML = plan.stops.map((s, i) => {
    if (!s.isReturn) stopNum.set(s.id, ++n);
    const nights = plan.nights[s.name];
    const meta = s.isReturn ? "return" : nights ? `${nights} night${nights > 1 ? "s" : ""}` : s.role === "arrival" ? "arrival" : "";
    return `${i ? '<span class="arrow">→</span>' : ""}<span class="stop-chip"><b>${stopNum.get(s.id)}</b>${esc(s.name)}${meta ? ` <small>${esc(meta)}</small>` : ""}</span>`;
  }).join("");

  const t = plan.totals;
  $("#stats").innerHTML = [
    [t.days, "days"],
    [plan.stops.filter((s) => !s.isReturn).length, "places"],
    [t.sights, "sights & experiences"],
    [`${t.travelHours} h`, `on the move (${t.roadKm.toLocaleString()} km by road)`],
  ].map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join("");

  const c = plan.costs;
  const travelers = plan.input.travelers;
  const pkr = (usd) => `≈ PKR ${Math.round(usd * plan.usdToPkr).toLocaleString()}`;
  $("#costs").innerHTML = `
    <div class="cost-main">
      <h3>${esc(c.label)} style</h3>
      <div class="total">${money(c.total)} <span class="sub">per person · ${pkr(c.total)}</span></div>
      ${travelers > 1 ? `<div class="sub">${money(c.total * travelers)} for ${travelers} travellers</div>` : ""}
      <table class="cost-lines">
        <tr><td>Accommodation</td><td>${money(c.lodging)}</td></tr>
        <tr><td>Food</td><td>${money(c.food)}</td></tr>
        <tr><td>Intercity transport, flights & jeeps</td><td>${money(c.transport)}</td></tr>
        <tr><td>Local transport</td><td>${money(c.local)}</td></tr>
        <tr><td>Entry fees</td><td>${money(c.fees)}</td></tr>
      </table>
      <p class="fine" style="margin-top:6px">${esc(plan.perPersonNote)}</p>
    </div>
    <div class="tiers">
      <div class="fine">Your budget: ${money(plan.input.budgetUsd)} per person</div>
      ${["budget", "standard", "comfort"].map((k) => {
        const x = plan.allCosts[k];
        const cls = k === plan.tier ? "on" : x.total > plan.input.budgetUsd ? "over" : "";
        return `<div class="tier ${cls}"><span><b>${esc(x.label)}</b><br><span class="fine">${esc(x.desc)}</span></span><em>${money(x.total)}</em></div>`;
      }).join("")}
    </div>`;

  if (plan.warnings.length) {
    $("#warnings").innerHTML = `<div class="warn"><ul>${plan.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>`;
  }

  const aiBtn = $("#ai-btn");
  if (!OPTIONS.ai) {
    aiBtn.disabled = true;
    $("#ai-status").textContent = "AI notes need an ANTHROPIC_API_KEY on the server.";
  }
  aiBtn.addEventListener("click", onNarrate);

  renderDays(plan);
  renderTips(plan);
  renderMap(plan, stopNum);
  setupTabs(plan);
}

function itemHtml(it) {
  if (it.kind === "travel") {
    const mode = it.modes.map((m) => ({ road: "by road", flight: "flight", "jeep+hike": "jeep + hike" })[m] || m).join(" + ");
    const via = it.via.length ? ` via ${it.via.join(", ")}` : "";
    return `<div class="item travel ${it.scenic ? "scenic" : ""}">
      <time>${esc(it.start)}–${esc(it.end)}</time>
      <div>
        <h4>${esc(it.from)} to ${esc(it.to)}</h4>
        <p>${esc(it.hours)} h ${esc(mode)}${it.km ? ` · ~${esc(it.km)} km` : ""}${esc(via)}${it.labels.length ? ` · ${esc(it.labels.join(" / "))}` : ""}</p>
        ${it.highlights.length ? `<p>On the way: ${esc(it.highlights.join(" · "))}</p>` : ""}
        ${it.notes.map((n) => `<p>⚠ ${esc(n)}</p>`).join("")}
      </div></div>`;
  }
  if (it.kind === "visit") {
    const auto = it.source !== "curated";
    return `<div class="item visit ${it.image ? "has-img" : ""}" data-id="${esc(it.id)}">
      <time>${esc(it.start)}–${esc(it.end)}</time>
      <div class="visit-body">
        <div>
          <h4>${esc(it.name)}</h4>
          <p>${esc(it.desc)}</p>
          <div class="tags">${it.tags.map((t) => `<span class="tag ${it.matched.includes(t) ? "hit" : ""}">${esc(t)}</span>`).join("")}
            ${it.fee ? `<span class="tag">entry ~${money(it.fee)}</span>` : it.feeUnknown ? '<span class="tag">entry fee: check locally</span>' : ""}
            ${auto ? `<span class="tag src" title="Found automatically from Wikidata/Wikipedia">auto-discovered</span>` : ""}
            ${it.wiki ? `<a class="tag link" href="${esc(it.wiki)}" target="_blank" rel="noopener">Wikipedia ↗</a>` : ""}</div>
        </div>
        ${it.image ? `<img src="${esc(it.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />` : ""}
      </div></div>`;
  }
  return `<div class="item ${esc(it.kind)}"><time>${it.kind === "depart" ? "✈" : "—"}</time><div><p>${esc(it.text)}</p></div></div>`;
}

function renderDays(plan) {
  const fmtDate = (d) => d ? new Date(d + "T00:00:00Z").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }) : "";
  $("#days").innerHTML = plan.days.map((d) => `
    <article class="panel day ${d.buffer ? "buffer" : ""}" id="day-${d.day}">
      <div class="day-head">
        <span class="day-num">Day ${d.day}</span>
        <h3>${esc(d.title)}</h3>
        <span class="meta">${esc(fmtDate(d.date))}${d.sleep ? ` · overnight in ${esc(d.sleep)}` : ""}</span>
      </div>
      <div class="day-body">
        <div class="narrative" data-day="${d.day}" hidden></div>
        ${d.items.map(itemHtml).join("")}
      </div>
    </article>`).join("");
}

// ---------------------------------------------------------------- hotels & food

const PRICE_LABEL = { budget: "Budget", mid: "Mid-range", upscale: "Upscale" };
const TIER_PRICE = { budget: "budget", standard: "mid", comfort: "upscale" };
let staysData = null;

function setupTabs(plan) {
  staysData = null;
  const tabs = document.querySelectorAll(".tabs .tab");
  tabs.forEach((t) => t.addEventListener("click", () => {
    tabs.forEach((x) => {
      x.classList.toggle("on", x === t);
      x.setAttribute("aria-selected", String(x === t));
    });
    const stays = t.dataset.tab === "stays";
    $("#tab-plan").hidden = stays;
    $("#tab-stays").hidden = !stays;
    if (stays) loadStays(plan);
    else map?.invalidateSize();
  }));
  for (const el of ["#stay-price", "#stay-style", "#stay-contact"]) $(el).addEventListener("change", () => renderStays(plan));
  document.querySelectorAll("[name=stayKind]").forEach((r) => r.addEventListener("change", () => renderStays(plan)));
}

// Places where the traveller sleeps, in trip order, with number of nights.
function overnightStops(plan) {
  const out = [];
  for (const s of plan.stops) {
    if (s.isReturn || out.some((o) => o.id === s.id)) continue;
    const nights = plan.nights[s.name] || 0;
    if (nights) out.push({ ...s, nights });
  }
  return out;
}

async function loadStays(plan) {
  const list = $("#stays-list");
  if (staysData) return renderStays(plan);
  list.innerHTML = '<div class="panel fine">Loading hotels and restaurants…</div>';
  const ids = overnightStops(plan).map((s) => s.id);
  try {
    const res = await fetch(`/api/stays?hubs=${encodeURIComponent(ids.join(","))}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    staysData = data;
    renderStays(plan);
  } catch (err) {
    list.innerHTML = `<div class="panel error">${esc(err.message || "Couldn't load hotels.")}</div>`;
  }
}

function waLink(phone) {
  const d = phone.replace(/\D/g, "");
  return /^923\d{9}$/.test(d) ? `https://wa.me/${d}` : null; // Pakistani mobile numbers
}

function stayCard(x, kind, hubName, planPrice) {
  const q = encodeURIComponent(`${x.name}, ${hubName}, Pakistan`);
  const links = [
    ...x.phones.map((p) => `<a class="btn-link" href="tel:${esc(p)}">📞 ${esc(p)}</a>`),
    ...x.phones.map(waLink).filter(Boolean).slice(0, 1).map((w) => `<a class="btn-link" href="${esc(w)}" target="_blank" rel="noopener">WhatsApp</a>`),
    x.website ? `<a class="btn-link" href="${esc(x.website)}" target="_blank" rel="noopener">🌐 Website</a>` : "",
    x.email ? `<a class="btn-link" href="mailto:${esc(x.email)}">✉ Email</a>` : "",
    `<a class="btn-link subtle" href="https://www.google.com/maps/search/?api=1&query=${q}" target="_blank" rel="noopener">Google Maps</a>`,
    kind === "hotels" ? `<a class="btn-link subtle" href="https://www.booking.com/searchresults.html?ss=${q}" target="_blank" rel="noopener">Booking.com</a>` : "",
  ].filter(Boolean).join("");
  const badges = [
    `<span class="tag">${esc(x.kind)}</span>`,
    `<span class="tag ${x.price === planPrice ? "hit" : ""}" title="Estimated from the type and name of the place">${esc(PRICE_LABEL[x.price])}${x.stars ? ` · ${"★".repeat(x.stars)}` : ""}</span>`,
    x.relaxing ? '<span class="tag">Relaxing</span>' : "",
    x.central ? '<span class="tag">Central</span>' : "",
    x.local ? '<span class="tag">Local food</span>' : "",
    ...(x.cuisine || []).slice(0, 3).map((c) => `<span class="tag">${esc(c)}</span>`),
    ...x.features.map((f) => `<span class="tag">${esc(f)}</span>`),
  ].join("");
  return `<article class="stay">
    <div class="stay-head">
      <h4>${esc(x.name)}</h4>
      <span class="fine">${esc(x.distKm)} km from centre</span>
    </div>
    ${x.nameLocal ? `<p class="fine" dir="auto">${esc(x.nameLocal)}</p>` : ""}
    ${x.address ? `<p class="fine">${esc(x.address)}</p>` : ""}
    ${x.hours ? `<p class="fine">Hours: ${esc(x.hours)}</p>` : ""}
    <div class="tags">${badges}</div>
    <div class="stay-links">${links}</div>
    ${x.phones.length || x.website ? "" : '<p class="fine">No contact details listed — use the search links to find them.</p>'}
  </article>`;
}

function renderStays(plan) {
  if (!staysData) return;
  const kind = document.querySelector("[name=stayKind]:checked").value;
  const price = $("#stay-price").value;
  const style = $("#stay-style").value;
  const contactOnly = $("#stay-contact").checked;
  const planPrice = TIER_PRICE[plan.tier];
  const sections = overnightStops(plan).map((s) => {
    const all = staysData.hubs[s.id]?.[kind] || [];
    const items = all.filter((x) =>
      (!price || x.price === price) &&
      (!style || x[style]) &&
      (!contactOnly || x.phones.length || x.website));
    const body = items.length
      ? `<div class="stay-grid">${items.slice(0, 24).map((x) => stayCard(x, kind, s.name, planPrice)).join("")}</div>`
      : `<p class="fine">${all.length ? "Nothing matches these filters here — try loosening them." : "No listings found on OpenStreetMap for this place yet."}</p>`;
    return `<section class="panel stay-section">
      <h3>${esc(s.name)} <span class="fine">· ${s.nights} night${s.nights > 1 ? "s" : ""} · ${items.length} of ${all.length} shown</span></h3>
      ${body}
    </section>`;
  });
  $("#stays-list").innerHTML =
    (sections.join("") || '<div class="panel fine">This trip has no overnight stays.</div>') +
    `<p class="fine stays-note">Listings ${esc(staysData.source)}. Price levels are estimates; your plan's
      ${esc(plan.costs.label)} style matches <b>${esc(PRICE_LABEL[planPrice])}</b>. Call or message ahead to confirm rates and availability.</p>`;
}

function renderTips(plan) {
  const disc = OPTIONS.discovery;
  $("#tips").innerHTML = `<div class="tips-grid">
    <div><h3>Before you go</h3><ul>${plan.tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>
    <div id="ai-tips"></div>
  </div>
  ${disc ? `<p class="fine" style="margin-top:14px">Includes ${esc(disc.added)} places found automatically from
    <a href="https://www.wikidata.org" target="_blank" rel="noopener">Wikidata</a> and
    <a href="https://en.wikipedia.org" target="_blank" rel="noopener">Wikipedia</a> (text CC BY-SA, photos via Wikimedia Commons),
    updated ${esc(new Date(disc.generatedAt).toLocaleDateString())}${disc.aiReviewed ? ", reviewed by Claude" : ""}.</p>` : ""}`;
}

// ---------------------------------------------------------------- map

const osrmCache = new Map();
async function roadGeometry(a, b) {
  const key = `${a}|${b}`;
  if (osrmCache.has(key)) return osrmCache.get(key);
  const p = (async () => {
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${a[1]},${a[0]};${b[1]},${b[0]}?overview=simplified&geometries=geojson`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      return data.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    } catch {
      return [a, b]; // straight line if the public routing server is unavailable
    }
  })();
  osrmCache.set(key, p);
  return p;
}

function renderMap(plan, stopNum) {
  if (typeof L === "undefined") {
    $("#map").innerHTML = '<p class="fine" style="padding:12px">Map library failed to load (offline?).</p>';
    return;
  }
  if (map) map.remove();
  map = L.map("map", { scrollWheelZoom: false });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  mapLayers = { byDay: new Map(), all: L.featureGroup().addTo(map) };

  // Stop pins
  for (const s of plan.stops) {
    if (s.isReturn) continue;
    const icon = L.divIcon({ className: "", html: `<div class="pin">${stopNum.get(s.id)}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
    L.marker([s.lat, s.lng], { icon, zIndexOffset: 1000 })
      .bindPopup(`<b>${esc(s.name)}</b><br>${esc(s.blurb)}`)
      .addTo(mapLayers.all);
  }

  const routeStyle = (seg) => {
    if (seg.mode === "flight") return { color: css("--flight"), weight: 3, dashArray: "8 8", opacity: 0.9 };
    if (seg.mode !== "road") return { color: css("--jeep"), weight: 4, dashArray: "2 7", opacity: 0.95 };
    return { color: seg.scenic ? css("--scenic") : css("--accent"), weight: seg.scenic ? 5 : 4, opacity: 0.85 };
  };

  for (const d of plan.days) {
    const g = L.featureGroup();
    const color = DAY_COLORS[(d.day - 1) % DAY_COLORS.length];
    for (const it of d.items) {
      if (it.kind === "visit") {
        L.circleMarker([it.lat, it.lng], { radius: 6, color: "#fff", weight: 2, fillColor: color, fillOpacity: 1 })
          .bindPopup(`<b>${esc(it.name)}</b><br>Day ${d.day}, ${esc(it.start)}<br>${esc(it.desc)}`)
          .addTo(g);
      }
      if (it.kind === "travel") {
        for (const seg of it.segments) {
          const line = L.polyline(seg.points, routeStyle(seg)).addTo(g);
          if (seg.mode === "road") {
            roadGeometry(seg.points[0], seg.points[1]).then((pts) => line.setLatLngs(pts));
          }
        }
      }
    }
    g.addTo(mapLayers.all);
    mapLayers.byDay.set(d.day, g);
  }

  map.fitBounds(mapLayers.all.getBounds().pad(0.08));

  const filter = $("#day-filter");
  filter.innerHTML = `<button type="button" class="on" data-day="all">Whole trip</button>` +
    plan.days.map((d) => `<button type="button" data-day="${d.day}">Day ${d.day}</button>`).join("");
  filter.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    filter.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    focusDay(b.dataset.day);
  });
}

function focusDay(day) {
  for (const [d, g] of mapLayers.byDay) {
    const show = day === "all" || String(d) === day;
    g.eachLayer((l) => l.setStyle?.({ opacity: show ? 0.9 : 0.12, fillOpacity: show ? 1 : 0.12 }));
  }
  if (day === "all") return map.fitBounds(mapLayers.all.getBounds().pad(0.08));
  const g = mapLayers.byDay.get(Number(day));
  const b = g.getBounds();
  if (b.isValid()) map.fitBounds(b.pad(0.3), { maxZoom: 12 });
  else {
    const dd = lastPlan.days.find((x) => x.day === Number(day));
    const stop = lastPlan.stops.find((s) => s.name === dd?.sleep) || lastPlan.stops[lastPlan.stops.length - 1];
    map.setView([stop.lat, stop.lng], 11);
  }
}

// ---------------------------------------------------------------- AI notes

async function onNarrate() {
  const btn = $("#ai-btn");
  const status = $("#ai-status");
  btn.disabled = true;
  status.textContent = "Writing your guide notes… (this can take a minute)";
  try {
    const res = await fetch("/api/narrate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(lastRequest) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "AI guide failed");
    $("#ai-overview").innerHTML = `<div class="ai-overview">${esc(data.overview)}</div>`;
    for (const d of data.days) {
      const el = document.querySelector(`.narrative[data-day="${d.day}"]`);
      if (!el) continue;
      el.hidden = false;
      el.innerHTML = `${esc(d.narrative)}${d.tips.length ? `<ul>${d.tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}`;
    }
    $("#ai-tips").innerHTML = `
      <h3>Culture & etiquette</h3><ul>${data.cultural_tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
      <h3 style="margin-top:12px">Pack</h3><ul>${data.packing.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`;
    status.textContent = "Guide notes added.";
  } catch (err) {
    status.textContent = err.message;
    btn.disabled = false;
  }
}

init();
