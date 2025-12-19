const BASE_URL = process.env.TIBIA_MARKET_BASE_URL || "https://api.tibiamarket.top";

export function normItemName(s) {
  return String(s ?? "").trim().toLowerCase();
}

export function parseGold(input) {
  const s = String(input ?? "").trim().toLowerCase().replace(/,/g, "");
  const m = s.match(/^(\d+(\.\d+)?)(k|kk|m|b)?$/);
  if (!m) return null;
  const val = Number(m[1]);
  const suf = m[3] || "";
  const mult =
    suf === "k" ? 1e3 :
    (suf === "kk" || suf === "m") ? 1e6 :
    suf === "b" ? 1e9 :
    1;
  return Math.round(val * mult);
}

export function formatGold(n) {
  if (!Number.isFinite(n)) return "n/a";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}b`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}kk`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}k`;
  return `${Math.trunc(n)}`;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`API ${res.status} for ${url}: ${txt}`);
  }
  return res.json();
}

/* ------------------ item metadata cache ------------------ */

let itemCache = {
  loaded: false,
  nameToId: new Map(),
  idToName: new Map(),
  idToNpcSell: new Map()
};

async function loadItemMetadata() {
  if (itemCache.loaded) return;

  const data = await fetchJson(`${BASE_URL}/item_metadata`);
  if (!Array.isArray(data)) throw new Error("item_metadata not array");

  for (const row of data) {
    const id = row?.id;
    const name = row?.name;
    if (typeof id !== "number" || !name) continue;

    const norm = normItemName(name);
    itemCache.nameToId.set(norm, id);
    itemCache.idToName.set(id, norm);

    let npcSell = 0;
    if (Array.isArray(row.npc_sell) && row.npc_sell.length) {
      for (const x of row.npc_sell) {
        const p = Number(x?.price);
        if (Number.isFinite(p) && p > npcSell) npcSell = p;
      }
    }
    itemCache.idToNpcSell.set(id, npcSell);
  }

  if (!itemCache.nameToId.size) throw new Error("Failed to load item metadata");
  itemCache.loaded = true;
}

export async function getItemIdByName(name) {
  await loadItemMetadata();
  return itemCache.nameToId.get(normItemName(name)) ?? null;
}

export async function getNpcSellById(id) {
  await loadItemMetadata();
  return itemCache.idToNpcSell.get(id) ?? 0;
}

/* ------------------ market snapshot (Secura) ------------------ */

async function fetchMarketValuesForItems(serverName, itemIds) {
  const ids = itemIds.filter(n => Number.isFinite(n)).join(",");
  const url =
    `${BASE_URL}/market_values?server=${encodeURIComponent(serverName)}` +
    (ids.length ? `&item_ids=${encodeURIComponent(ids)}` : `&limit=100`);
  return fetchJson(url);
}

export async function fetchMarketSnapshotSecura(itemNames = []) {
  await loadItemMetadata();

  const ids = [];
  for (const nm of itemNames) {
    const id = itemCache.nameToId.get(normItemName(nm));
    if (typeof id === "number") ids.push(id);
  }

  const rows = await fetchMarketValuesForItems("Secura", ids);
  if (!Array.isArray(rows)) throw new Error("Unexpected /market_values response");

  const items = new Map();
  let maxTime = null;

  for (const r of rows) {
    const id = Number(r?.id);
    if (!Number.isFinite(id)) continue;

    const nameNorm = itemCache.idToName.get(id);
    if (!nameNorm) continue;

    const buy = Number.isFinite(Number(r?.buy_offer)) && Number(r.buy_offer) >= 0 ? Number(r.buy_offer) : null;
    const sell = Number.isFinite(Number(r?.sell_offer)) && Number(r.sell_offer) >= 0 ? Number(r.sell_offer) : null;

    items.set(nameNorm, { buy, sell });

    const t = Number(r?.time);
    if (Number.isFinite(t)) {
      if (maxTime == null || t > maxTime) maxTime = t;
    }
  }

  const updatedAt = (maxTime != null) ? new Date(Math.floor(maxTime * 1000)) : new Date();
  return { updatedAt, items };
}
