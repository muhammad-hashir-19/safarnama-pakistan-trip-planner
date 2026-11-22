// Estimates price level and style for OpenStreetMap hotels/restaurants.
// OSM rarely has prices or star ratings in Pakistan, so this uses the kind of
// place, its name and its amenities. It's a hint, not a guarantee.

const UPSCALE = /\b(serena|pearl continental|\bpc\b|marriott|m[oö]venpick|avari|hilton|sheraton|ramada|luxus|nishat|faletti|shangri-?la|luxury|royal|grand|palace|heritage|boutique|five star|5 star|resort|emporium)\b/i;
const BUDGET = /\b(guest ?house|hostel|motel|inn|rest ?house|sarai|musafir ?khana|lodging|dormitory|backpacker|budget)\b/i;
const RELAX = /\b(resort|retreat|lodge|cottage|huts?|camp|chalet|view|valley|lake|river|garden|hills?|meadows?|eco|farm ?house|villa)\b/i;

export function cleanPhone(raw) {
  if (!raw) return [];
  return raw
    .split(/[;,/]| or /)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const digits = p.replace(/[^\d+]/g, "");
      if (/^0\d{9,10}$/.test(digits)) return `+92${digits.slice(1)}`;
      if (/^92\d{9,10}$/.test(digits)) return `+${digits}`;
      return digits.startsWith("+") ? digits : p;
    })
    .filter((p, i, a) => p.replace(/\D/g, "").length >= 7 && a.indexOf(p) === i)
    .slice(0, 3);
}

export function classifyHotel(item, hub) {
  const t = item.tags;
  const kind = t.tourism;
  const name = `${item.name} ${t.name || ""} ${t.operator || ""} ${t.brand || ""}`;
  const stars = Number.parseInt(t.stars, 10) || null;

  let price;
  if (stars) price = stars >= 4 ? "upscale" : stars >= 3 ? "mid" : "budget";
  else if (kind === "resort" || UPSCALE.test(name)) price = "upscale";
  else if (["hostel", "guest_house", "motel", "camp_site", "alpine_hut"].includes(kind) || BUDGET.test(name)) price = "budget";
  else price = "mid";

  const features = [];
  if (t.internet_access && t.internet_access !== "no") features.push("Wi-Fi");
  if (t.swimming_pool === "yes" || t.leisure === "swimming_pool") features.push("Pool");
  if (t.parking || t["parking:fee"]) features.push("Parking");
  if (t.wheelchair === "yes") features.push("Accessible");
  if (t.restaurant === "yes" || t.cuisine) features.push("Restaurant");

  const relaxing =
    kind === "resort" || kind === "chalet" || kind === "camp_site" || RELAX.test(name) ||
    features.includes("Pool") || (item.distKm > 3 && !hub.gateway);
  const central = item.distKm <= 2;

  const kindLabel = {
    hotel: "Hotel", guest_house: "Guest house", hostel: "Hostel", motel: "Motel", resort: "Resort",
    chalet: "Chalet", apartment: "Apartment", camp_site: "Campsite", alpine_hut: "Mountain hut",
  }[kind] || "Stay";

  return { kind: kindLabel, price, stars, relaxing, central, features };
}

export function classifyRestaurant(item) {
  const t = item.tags;
  const cuisine = (t.cuisine || "").split(";").map((c) => c.trim().replace(/_/g, " ")).filter(Boolean);
  const name = item.name;
  const kind = { restaurant: "Restaurant", cafe: "Café", fast_food: "Fast food", food_court: "Food court" }[t.amenity] || "Food";
  let price = t.amenity === "fast_food" || t.amenity === "food_court" ? "budget" : t.amenity === "cafe" ? "mid" : "mid";
  if (UPSCALE.test(name)) price = "upscale";
  if (/\b(dhaba|tikka|karahi|chai|tea|bbq|nihari|paye|haleem|sajji|chapli)\b/i.test(name)) price = "budget";
  const local =
    cuisine.some((c) => /pakistani|regional|indian|afghan|balti|hunza|bbq|barbecue|kebab|karahi|biryani|tea/i.test(c)) ||
    /\b(karahi|tikka|nihari|bbq|biryani|chapli|sajji|dera|dhaba|hunza|balti)\b/i.test(name);
  const features = [];
  if (t.outdoor_seating === "yes") features.push("Outdoor seating");
  if (t.delivery === "yes") features.push("Delivery");
  if (t["diet:vegetarian"] === "yes" || t["diet:vegetarian"] === "only") features.push("Vegetarian options");
  if (t.takeaway === "yes") features.push("Takeaway");
  return { kind, cuisine, price, local, relaxing: t.outdoor_seating === "yes" || /\b(view|garden|lake|river|terrace|roof ?top)\b/i.test(name), central: item.distKm <= 2, features };
}
