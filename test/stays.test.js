import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanPhone, classifyHotel, classifyRestaurant } from "../src/data/stays-classify.js";

const hub = { gateway: false };
const hotel = (name, tags = {}, distKm = 1) => ({ name, distKm, tags: { tourism: "hotel", name, ...tags } });

test("phone numbers are normalised to +92 format", () => {
  assert.deepEqual(cleanPhone("03224441915"), ["+923224441915"]);
  assert.deepEqual(cleanPhone("+92-42-35786001, +92-42-35786002"), ["+924235786001", "+924235786002"]);
  assert.deepEqual(cleanPhone("0581 1457 900; 0300-1234567"), ["+925811457900", "+923001234567"]);
  assert.deepEqual(cleanPhone(null), []);
  assert.deepEqual(cleanPhone("n/a"), []);
});

test("hotel price level and style are estimated sensibly", () => {
  assert.equal(classifyHotel(hotel("Serena Hotel"), hub).price, "upscale");
  assert.equal(classifyHotel(hotel("Pearl Continental Lahore"), hub).price, "upscale");
  assert.equal(classifyHotel(hotel("Baloch House", { tourism: "guest_house" }), hub).price, "budget");
  assert.equal(classifyHotel(hotel("City Inn"), hub).price, "budget");
  assert.equal(classifyHotel(hotel("Hotel Shalimar"), hub).price, "mid");
  assert.equal(classifyHotel(hotel("Anything", { stars: "5" }), hub).price, "upscale");
  assert.equal(classifyHotel(hotel("Eagle's Nest View Hotel"), hub).relaxing, true);
  assert.equal(classifyHotel(hotel("Downtown Hotel", {}, 0.5), { gateway: true }).central, true);
});

test("restaurants flag local food", () => {
  const r = classifyRestaurant({ name: "Butt Karahi", distKm: 1, tags: { amenity: "restaurant" } });
  assert.equal(r.local, true);
  assert.equal(r.price, "budget");
  const c = classifyRestaurant({ name: "Cafe Nostalgia", distKm: 1, tags: { amenity: "cafe", cuisine: "coffee_shop" } });
  assert.equal(c.local, false);
  assert.deepEqual(c.cuisine, ["coffee shop"]);
});
