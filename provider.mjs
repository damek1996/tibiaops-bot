import "dotenv/config";

export const TIBIA_MARKET_BASE_URL =
  process.env.TIBIA_MARKET_BASE_URL?.trim() || "https://api.tibiamarket.top";

// market_values is typically more permissive than market_board.
// We'll still throttle conservatively.
const RATE_LIMIT_MS = 1200; // ~1 req / 1.2s

let lastRequestAt = 0;
async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, RATE_LIMIT_MS - (now - lastRequestAt));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

export function normItemName(name) {
  return String(name ?? "")
    .toLowerCase()
    .trim()
    .replace(/^(a|an)\s+/, "")
    .replace(/\s+/g, " ");
}

export function formatGold(n) {
  return new Intl.NumberFormat("en-US").format(Math.trunc(n));
}

async function fetchJson(url, attempt = 1) {
  await throttle();
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const text = await res.text();

  // Basic backoff on 429
  if (res.status === 429 && attempt <= 5) {
    const delay = 1500 * attempt;
    await new Promise(r => setTimeout(r, delay));
    return fetchJson(url, attempt + 1);
  }

  if (!res.ok) throw new Error(`API ${res.status} for ${url}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 200)}`);
  }
}

// ---- Metadata cache ----
let metadataCache = null;
let metadataLoadedAt = 0;

export async function loadItemMetadata() {
  const now = Date.now();
  if (metadataCache && (now - metadataLoadedAt) < 24 * 60 * 60 * 1000) return metadataCache;

  const url = `${TIBIA_MARKET_BASE_URL}/item_metadata`;
  const arr = await fetchJson(url);
  if (!Array.isArray(arr)) throw new Error("item_metadata did not return an array");

  metadataCache = arr;
  metadataLoadedAt = now;
  return metadataCache;
}

export async function getItemIdByName(nameNorm) {
  const meta = await loadItemMetadata();
  const target = normItemName(nameNorm);
  const found = meta.find(x => normItemName(x?.name) === target);
  return found?.id ?? null;
}

// NPC BUY = NPC buys from player (you sell to NPC)
export async function getNpcBuyersById(itemId) {
  const meta = await loadItemMetadata();
  const it = meta.find(x => x?.id === itemId);
  if (!it) return [];

  const buyers = Array.isArray(it.npc_buy) ? it.npc_buy : [];
  return buyers
    .map(b => ({
      name: String(b?.name ?? "").trim(),
      price: Number(b?.price ?? b?.amount ?? b?.value ?? 0)
    }))
    .filter(x => x.name && Number.isFinite(x.price) && x.price > 0)
    .sort((a, b) => b.price - a.price);
}

export async function getBestNpcBuyPrice(itemId) {
  const buyers = await getNpcBuyersById(itemId);
  return buyers[0]?.price ?? 0;
}

// ---- market_values (bulk) ----
const marketValuesCache = new Map(); // key `${server}:${id}` -> { buy_offer, timeMs }

export async function fetchMarketBuyOffers(server, itemIds) {
  const now = Date.now();
  const out = new Map();

  // return cached where fresh
  const need = [];
  for (const id of itemIds) {
    const key = `${server}:${id}`;
    const c = marketValuesCache.get(key);
    if (c && (now - c.timeMs) < 60 * 1000) out.set(id, c.buy_offer);
    else need.push(id);
  }
  if (!need.length) return out;

  // chunk item_ids
  const CHUNK = 100;
  for (let i = 0; i < need.length; i += CHUNK) {
    const chunk = need.slice(i, i + CHUNK);
    const url =
      `${TIBIA_MARKET_BASE_URL}/market_values` +
      `?server=${encodeURIComponent(server)}` +
      `&item_ids=${encodeURIComponent(chunk.join(","))}` +
      `&skip=0&limit=${chunk.length}`;

    const arr = await fetchJson(url);
    if (!Array.isArray(arr)) throw new Error("market_values did not return an array");

    for (const row of arr) {
      const id = Number(row?.id);
      if (!Number.isFinite(id)) continue;

      const buy_offer = Number(row?.buy_offer ?? 0);
      const key = `${server}:${id}`;
      marketValuesCache.set(key, { buy_offer: Number.isFinite(buy_offer) ? buy_offer : 0, timeMs: Date.now() });
      out.set(id, Number.isFinite(buy_offer) ? buy_offer : 0);
    }
  }

  // ensure all requested ids present
  for (const id of need) if (!out.has(id)) out.set(id, 0);

  return out;
}

// /price command: show market BUY offer (from market_values) + NPC best buy
export async function getPriceSecuraByName(itemName) {
  const nameNorm = normItemName(itemName);
  const id = await getItemIdByName(nameNorm);
  if (!Number.isFinite(id)) {
    return { found: false, reason: "item not found in metadata", buy: null, npc: null, updatedAt: new Date() };
  }

  const offers = await fetchMarketBuyOffers("Secura", [id]);
  const buy = offers.get(id) ?? 0;
  const npc = await getBestNpcBuyPrice(id);
  return { found: true, buy, npc, updatedAt: new Date() };
}
