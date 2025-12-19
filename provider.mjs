import "dotenv/config";

const BASE_URL = process.env.TIBIA_MARKET_BASE_URL || "https://api.tibiamarket.top";

export function normItemName(s) {
  return String(s ?? "").trim().toLowerCase();
}

export function formatGold(n) {
  if (!Number.isFinite(n)) return "n/a";
  return new Intl.NumberFormat("en-US").format(Math.trunc(n));
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${txt}`);
  }
  return res.json();
}

// -------------------- item metadata cache --------------------
let metaLoaded = false;
let nameToId = new Map();    // normalized name -> id
let idToName = new Map();    // id -> normalized name

// IMPORTANT: npc_buy = NPC buys from player (player sells to NPC). This is the correct "sell to NPC" price.
let idToNpcBuy = new Map();  // id -> best NPC BUY price (max across npc_buy list)

async function loadMetadata() {
  if (metaLoaded) return;

  const rows = await fetchJson(`${BASE_URL}/item_metadata`);
  if (!Array.isArray(rows)) throw new Error("item_metadata: invalid response");

  for (const r of rows) {
    const id = r?.id;
    const name = r?.name;
    if (typeof id !== "number" || !name) continue;

    const norm = normItemName(name);
    nameToId.set(norm, id);
    idToName.set(id, norm);

    // npc_buy = NPC buys from you (you can sell to NPC) -> this is the relevant price for "sell to NPC"
    let npcBuy = 0;
    if (Array.isArray(r.npc_buy) && r.npc_buy.length) {
      for (const x of r.npc_buy) {
        const p = Number(x?.price);
        if (Number.isFinite(p) && p > npcBuy) npcBuy = p;
      }
    }
    idToNpcBuy.set(id, npcBuy);
  }

  if (nameToId.size === 0) throw new Error("item_metadata: empty");
  metaLoaded = true;
}

export async function getItemIdByName(name) {
  await loadMetadata();
  return nameToId.get(normItemName(name)) ?? null;
}

export async function getNpcBuyById(id) {
  await loadMetadata();
  return idToNpcBuy.get(id) ?? 0;
}

// -------------------- market snapshot (Secura) --------------------
export async function fetchMarketSnapshotSecura(itemNames = []) {
  await loadMetadata();

  const ids = [];
  for (const nm of itemNames) {
    const id = nameToId.get(normItemName(nm));
    if (typeof id === "number") ids.push(id);
  }

  // Query only requested items to stay under rate limits
  const url =
    `${BASE_URL}/market_values?server=Secura` +
    (ids.length ? `&item_ids=${encodeURIComponent(ids.join(","))}` : `&limit=100`);

  const rows = await fetchJson(url);
  if (!Array.isArray(rows)) throw new Error("market_values: invalid response");

  const items = new Map(); // normalized name -> { buy, sell }
  let maxTime = null;

  for (const r of rows) {
    const id = Number(r?.id);
    if (!Number.isFinite(id)) continue;

    const nameNorm = idToName.get(id);
    if (!nameNorm) continue;

    const buy = Number.isFinite(Number(r?.buy_offer)) && Number(r.buy_offer) >= 0 ? Number(r.buy_offer) : null;
    const sell = Number.isFinite(Number(r?.sell_offer)) && Number(r.sell_offer) >= 0 ? Number(r.sell_offer) : null;

    items.set(nameNorm, { buy, sell });

    const t = Number(r?.time);
    if (Number.isFinite(t)) maxTime = (maxTime == null || t > maxTime) ? t : maxTime;
  }

  const updatedAt = (maxTime != null) ? new Date(Math.floor(maxTime * 1000)) : new Date();
  return { updatedAt, items };
}

// -------------------- /price helper --------------------
export async function getPriceSecuraByName(itemNameRaw) {
  await loadMetadata();

  const itemName = normItemName(itemNameRaw);
  const id = nameToId.get(itemName);

  if (!id) return { found: false, itemName, reason: "Item not found in metadata" };

  const data = await fetchJson(
    `${BASE_URL}/market_values?server=Secura&item_ids=${encodeURIComponent(String(id))}`
  );

  if (!Array.isArray(data) || data.length === 0) {
    return { found: false, itemName, reason: "No market_values data" };
  }

  const r = data[0];
  const buy = Number.isFinite(Number(r?.buy_offer)) && Number(r.buy_offer) >= 0 ? Number(r.buy_offer) : null;
  const sell = Number.isFinite(Number(r?.sell_offer)) && Number(r.sell_offer) >= 0 ? Number(r.sell_offer) : null;
  const time = Number(r?.time);
  const updatedAt = Number.isFinite(time) ? new Date(Math.floor(time * 1000)) : new Date();

  return { found: true, itemName, id, buy, sell, updatedAt };
}
