import fetch from "node-fetch";

const BASE_URL = "https://api.tibiamarket.top";

/* ------------------ helpers ------------------ */

export function normItemName(s) {
  return s.trim().toLowerCase();
}

export function parseGold(input) {
  const s = input.trim().toLowerCase().replace(/,/g, "");
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
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}b`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}kk`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}k`;
  return `${n}`;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${txt}`);
  }
  return res.json();
}

/* ------------------ item metadata ------------------ */

let itemCache = {
  loaded: false,
  nameToId: new Map(),
  idToName: new Map()
};

async function loadItemMetadata() {
  if (itemCache.loaded) return;

  const data = await fetchJson(`${BASE_URL}/item_metadata`);
  if (!Array.isArray(data)) throw new Error("item_metadata not array");

  for (const row of data) {
    if (typeof row.id !== "number" || !row.name) continue;
    const norm = normItemName(row.name);
    itemCache.nameToId.set(norm, row.id);
    itemCache.idToName.set(row.id, norm);
  }

  if (!itemCache.nameToId.size) {
    throw new Error("Failed to load item metadata");
  }

  itemCache.loaded = true;
}

/* ------------------ market fetch ------------------ */

export async function fetchMarketSnapshotSecura(itemNames = []) {
  await loadItemMetadata();

  const ids = [];
  for (const name of itemNames) {
    const id = itemCache.nameToId.get(normItemName(name));
    if (typeof id === "number") ids.push(id);
  }

  // SINGLE API CALL – SAFE
  const url =
    `${BASE_URL}/market_values?server=Secura` +
    (ids.length ? `&item_ids=${ids.join(",")}` : "&limit=100");

  const rows = await fetchJson(url);
  if (!Array.isArray(rows)) throw new Error("market_values not array");

  const items = new Map();
  let maxTime = null;

  for (const r of rows) {
    const id = Number(r.id);
    if (!Number.isFinite(id)) continue;

    const nameNorm = itemCache.idToName.get(id);
    if (!nameNorm) continue;

    const buy = Number.isFinite(r.buy_offer) && r.buy_offer >= 0 ? r.buy_offer : null;
    const sell = Number.isFinite(r.sell_offer) && r.sell_offer >= 0 ? r.sell_offer : null;

    items.set(nameNorm, { buy, sell });

    if (Number.isFinite(r.time)) {
      if (!maxTime || r.time > maxTime) maxTime = r.time;
    }
  }

  return {
    updatedAt: maxTime ? new Date(maxTime * 1000) : new Date(),
    items
  };
}
