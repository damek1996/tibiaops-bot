import "dotenv/config";

// ===== Config =====
export const TIBIA_MARKET_BASE_URL =
  process.env.TIBIA_MARKET_BASE_URL?.trim() || "https://api.tibiamarket.top";

// API rate limit you hit: ~1 request / 5 seconds
const RATE_LIMIT_MS = 5200;

// Simple in-process throttling
let lastRequestAt = 0;
async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, RATE_LIMIT_MS - (now - lastRequestAt));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

// Small in-memory caches to reduce calls
let metadataCache = null; // item_metadata result array
let metadataLoadedAt = 0;

const marketSnapshotCache = new Map(); // key=server -> {updatedAt, items: Map(nameNorm -> {buy,sell,raw}), loadedAt}
const marketBoardCache = new Map(); // key=`${server}:${itemId}` -> {board, loadedAt}

// ===== Helpers =====
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

async function fetchJson(url) {
  await throttle();
  const res = await fetch(url, {
    headers: { "accept": "application/json" }
  });
  const text = await res.text();
  if (!res.ok) {
    // include body for debugging
    throw new Error(`API ${res.status} for ${url}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 200)}`);
  }
}

// ===== Item metadata (IDs + NPC buyers) =====
export async function loadItemMetadata() {
  // refresh every 6 hours
  const now = Date.now();
  if (metadataCache && (now - metadataLoadedAt) < 6 * 60 * 60 * 1000) return metadataCache;

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

  // exact match against normalized name
  const found = meta.find(x => normItemName(x?.name) === target);
  return found?.id ?? null;
}

export async function getNpcBuyById(itemId) {
  const meta = await loadItemMetadata();
  const it = meta.find(x => x?.id === itemId);
  if (!it) return 0;

  // IMPORTANT:
  // We want "NPC BUY" meaning: NPC buys from players (you SELL to NPC).
  // Your metadata structure typically contains npc_buy[] and npc_sell[] arrays.
  // npc_buy should be the NPC buying from players (we use highest price available).
  const buyers = Array.isArray(it.npc_buy) ? it.npc_buy : [];
  if (!buyers.length) return 0;

  // pick maximum buy price
  let best = 0;
  for (const b of buyers) {
    const p = Number(b?.price ?? b?.amount ?? b?.value ?? 0);
    if (Number.isFinite(p) && p > best) best = p;
  }
  return best;
}

export async function getNpcBuyersById(itemId) {
  const meta = await loadItemMetadata();
  const it = meta.find(x => x?.id === itemId);
  if (!it) return [];

  const buyers = Array.isArray(it.npc_buy) ? it.npc_buy : [];
  // Normalize into {name, price}
  return buyers
    .map(b => ({
      name: String(b?.name ?? "").trim(),
      price: Number(b?.price ?? b?.amount ?? b?.value ?? 0)
    }))
    .filter(x => x.name && Number.isFinite(x.price) && x.price > 0)
    .sort((a, b) => b.price - a.price);
}

// ===== Market values snapshot =====
// Pulls all market_values pages for Secura and builds a name->buy/sell map
async function fetchMarketValuesPaged(server) {
  const all = [];
  let skip = 0;
  const limit = 100;

  // careful: this API is rate-limited; paging is expensive.
  // we keep it cached and refresh only every 5 minutes.
  while (true) {
    const url =
      `${TIBIA_MARKET_BASE_URL}/market_values` +
      `?server=${encodeURIComponent(server)}` +
      `&skip=${skip}&limit=${limit}`;

    const page = await fetchJson(url);
    if (!Array.isArray(page)) throw new Error("market_values did not return array");

    all.push(...page);
    if (page.length < limit) break;
    skip += limit;

    // hard-stop safety
    if (skip > 20000) break;
  }

  return all;
}

export async function fetchMarketSnapshotSecura() {
  return fetchMarketSnapshot("Secura");
}

export async function fetchMarketSnapshot(server) {
  const key = String(server);
  const cached = marketSnapshotCache.get(key);
  const now = Date.now();

  // refresh every 5 minutes
  if (cached && (now - cached.loadedAt) < 5 * 60 * 1000) return cached;

  const rows = await fetchMarketValuesPaged(server);

  // Build map: nameNorm -> current best buy/sell offers
  // We need item names; market_values response is per id, so we map id -> name using metadata.
  const meta = await loadItemMetadata();
  const idToName = new Map(meta.map(x => [x.id, normItemName(x.name)]));

  const items = new Map();
  let latestTime = 0;

  for (const r of rows) {
    const id = r?.id;
    const nameNorm = idToName.get(id);
    if (!nameNorm) continue;

    const buy = Number(r?.buy_offer ?? 0);
    const sell = Number(r?.sell_offer ?? 0);
    const t = Number(r?.time ?? 0);
    if (Number.isFinite(t) && t > latestTime) latestTime = t;

    items.set(nameNorm, {
      buy: Number.isFinite(buy) ? buy : 0,
      sell: Number.isFinite(sell) ? sell : 0,
      raw: r
    });
  }

  const snap = {
    updatedAt: latestTime ? new Date(latestTime * 1000) : new Date(),
    items,
    loadedAt: now
  };

  marketSnapshotCache.set(key, snap);
  return snap;
}

export async function getPriceSecuraByName(itemName) {
  const nameNorm = normItemName(itemName);
  const snap = await fetchMarketSnapshotSecura();
  const found = snap.items.get(nameNorm);
  if (!found) return { found: false, reason: "item not found", buy: null, sell: null, updatedAt: snap.updatedAt };
  return { found: true, buy: found.buy, sell: found.sell, updatedAt: snap.updatedAt };
}

// ===== Market depth (market_board) =====
export async function fetchMarketBoard(server, itemId) {
  const key = `${server}:${itemId}`;
  const cached = marketBoardCache.get(key);
  const now = Date.now();

  // cache depth 60 seconds (enough for settlement)
  if (cached && (now - cached.loadedAt) < 60 * 1000) return cached.board;

  const url =
    `${TIBIA_MARKET_BASE_URL}/market_board` +
    `?server=${encodeURIComponent(server)}&item_ids=${encodeURIComponent(itemId)}`;

  const board = await fetchJson(url);

  // board schema you posted:
  // { id, sellers:[{amount,price,time}], buyers:[...], update_time }
  marketBoardCache.set(key, { board, loadedAt: now });
  return board;
}

// Consume BUY depth for qty, return expected proceeds selling instantly
export function computeInstantSellValueFromBoard(board, qty) {
  const buyers = Array.isArray(board?.buyers) ? board.buyers : [];
  if (!buyers.length) return { value: 0, filled: 0, remaining: qty, usedLevels: [] };

  // Sort by price desc, then time desc
  const levels = buyers
    .map(x => ({
      price: Number(x?.price ?? 0),
      amount: Number(x?.amount ?? 0),
      time: Number(x?.time ?? 0)
    }))
    .filter(x => Number.isFinite(x.price) && x.price > 0 && Number.isFinite(x.amount) && x.amount > 0)
    .sort((a, b) => (b.price - a.price) || (b.time - a.time));

  let remaining = qty;
  let value = 0;
  const usedLevels = [];

  for (const lvl of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, lvl.amount);
    if (take <= 0) continue;

    value += take * lvl.price;
    usedLevels.push({ price: lvl.price, amount: take });
    remaining -= take;
  }

  return { value, filled: qty - remaining, remaining, usedLevels };
}
