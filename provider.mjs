import "dotenv/config";

export const TIBIA_MARKET_BASE_URL =
  process.env.TIBIA_MARKET_BASE_URL?.trim() || "https://api.tibiamarket.top";

// API limit: 1 request / 5 seconds
const RATE_LIMIT_MS = 5200;

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

async function fetchJson(url) {
  await throttle();
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const text = await res.text();
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

// ---- Market board (depth) ----
const marketBoardCache = new Map(); // key `${server}:${id}` -> {board, loadedAt}

export function computeInstantSellValueFromBoard(board, qty) {
  const buyers = Array.isArray(board?.buyers) ? board.buyers : [];
  if (!buyers.length) return { value: 0, filled: 0, remaining: qty, usedLevels: [] };

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

function topPriceFromSide(sideArr, descending = true) {
  const arr = Array.isArray(sideArr) ? sideArr : [];
  const levels = arr
    .map(x => ({ price: Number(x?.price ?? 0), amount: Number(x?.amount ?? 0), time: Number(x?.time ?? 0) }))
    .filter(x => Number.isFinite(x.price) && x.price > 0 && Number.isFinite(x.amount) && x.amount > 0)
    .sort((a, b) => {
      if (descending) return (b.price - a.price) || (b.time - a.time);
      return (a.price - b.price) || (b.time - a.time);
    });
  return levels[0]?.price ?? 0;
}

// IMPORTANT: market_board requires a SINGLE item_id (not item_ids)
export async function fetchMarketBoard(server, itemId) {
  const key = `${server}:${itemId}`;
  const now = Date.now();

  const c = marketBoardCache.get(key);
  if (c && (now - c.loadedAt) < 60 * 1000) return c.board;

  const url =
    `${TIBIA_MARKET_BASE_URL}/market_board` +
    `?server=${encodeURIComponent(server)}` +
    `&item_id=${encodeURIComponent(itemId)}`;

  const board = await fetchJson(url);
  marketBoardCache.set(key, { board, loadedAt: Date.now() });
  return board;
}

// Used by /price command: top BUY + top SELL derived from board
export async function getPriceSecuraByName(itemName) {
  const nameNorm = normItemName(itemName);
  const id = await getItemIdByName(nameNorm);
  if (!Number.isFinite(id)) {
    return { found: false, reason: "item not found in metadata", buy: null, sell: null, updatedAt: new Date() };
  }

  const board = await fetchMarketBoard("Secura", id);
  const buy = topPriceFromSide(board.buyers, true);     // highest buy
  const sell = topPriceFromSide(board.sellers, false);  // lowest sell
  const updatedAt = board.update_time ? new Date(Number(board.update_time) * 1000) : new Date();

  return { found: true, buy, sell, updatedAt };
}
