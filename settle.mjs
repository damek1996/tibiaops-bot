import { fetchMarketSnapshotSecura, normItemName } from "./provider.mjs";
import { getItemIdByName, getNpcSellById } from "./provider.mjs";

function parseIntComma(s) {
  if (!s) return 0;
  const cleaned = String(s).replace(/,/g, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

export function normalizeLootItemName(raw) {
  let s = String(raw).trim().toLowerCase();
  s = s.replace(/^(a|an)\s+/, "");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function candidateNames(norm) {
  const out = [norm];

  if (norm.endsWith("coins")) out.push(norm.replace(/coins$/, "coin"));
  if (norm.endsWith("ies")) out.push(norm.slice(0, -3) + "y");
  if (norm.endsWith("es")) out.push(norm.slice(0, -2));
  if (norm.endsWith("s")) out.push(norm.slice(0, -1));

  if (norm === "gold coins") out.push("gold coin");
  if (norm === "platinum coins") out.push("platinum coin");
  if (norm === "crystal coins") out.push("crystal coin");

  return [...new Set(out)].filter(Boolean);
}

export function parseAnalyzerText(text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");

  let loot = null;
  let supplies = null;
  let balance = null;

// Works even if Discord collapses everything into one line
const whole = String(text);

// Match fields anywhere, not only at line-start
const mLootAny = whole.match(/(?:^|\s)Loot:\s*([-\d,]+)/i);
if (mLootAny) loot = parseIntComma(mLootAny[1]);

const mSupAny = whole.match(/(?:^|\s)Supplies:\s*([-\d,]+)/i);
if (mSupAny) supplies = parseIntComma(mSupAny[1]);

const mBalAny = whole.match(/(?:^|\s)Balance:\s*([-\d,]+)/i);
if (mBalAny) balance = parseIntComma(mBalAny[1]);


  const items = [];

// Try normal multiline first
let idx = lines.findIndex(l => /^Looted Items:/i.test(l.trim()));
if (idx >= 0) {
  for (let i = idx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (/^none/i.test(trimmed)) continue;

    const m = trimmed.match(/^(\d+)\s*x\s+(.+)$/i);
    if (!m) continue;

    const qty = Number(m[1]);
    if (!Number.isFinite(qty) || qty <= 0) continue;

    const name = normalizeLootItemName(m[2]);
    items.push({ name, qty });
  }
} else {
  // Fallback: single-line paste (items appear after "Looted Items:")
  const mBlock = whole.match(/Looted Items:\s*(.+)$/i);
  if (mBlock) {
    const tail = mBlock[1];

    // Extract repeated patterns like "9x a gold coin" "3x cheese"
    const re = /(\d+)\s*x\s+([^0-9]+?)(?=(\s+\d+\s*x\s+)|$)/gi;
    let mm;
    while ((mm = re.exec(tail)) !== null) {
      const qty = Number(mm[1]);
      const nameRaw = (mm[2] ?? "").trim();
      if (!qty || !nameRaw) continue;
      items.push({ name: normalizeLootItemName(nameRaw), qty });
    }
  }
}

return { loot, supplies, balance, items };

async function resolveItemId(nameNorm) {
  for (const cand of candidateNames(nameNorm)) {
    const id = await getItemIdByName(cand);
    if (typeof id === "number") return { id, matchedName: cand };
  }
  return { id: null, matchedName: null };
}

export async function computeSettlementSecura(players) {
  const unique = new Set();
  for (const p of players) for (const it of p.items) unique.add(normItemName(it.name));
  const itemNames = [...unique];

  const snap = await fetchMarketSnapshotSecura(itemNames);

  const itemMeta = new Map(); // nm -> { npcSell, marketBuy, unit, route }
  for (const nm of itemNames) {
    const { id } = await resolveItemId(nm);
    const npcSell = id != null ? await getNpcSellById(id) : 0;
    const marketBuy = snap.items.get(nm)?.buy ?? null;

    const buyVal = marketBuy != null ? marketBuy : 0;
    const unit = Math.max(buyVal, npcSell);
    const route = buyVal > npcSell ? "SELL_TO_MARKET_BUY" : "SELL_TO_NPC";

    itemMeta.set(nm, { npcSell, marketBuy, unit, route });
  }

  const perPlayer = [];
  let totalSupplies = 0;
  let totalLootValue = 0;

  for (const p of players) {
    let lootValue = 0;
    for (const it of p.items) {
      const key = normItemName(it.name);
      const meta = itemMeta.get(key);
      if (!meta) continue;
      lootValue += it.qty * meta.unit;
    }

    const supplies = Number.isFinite(p.supplies) ? p.supplies : 0;
    const net = lootValue - supplies;

    totalSupplies += supplies;
    totalLootValue += lootValue;

    perPlayer.push({
      role: p.role,
      discordName: p.discordName,
      lootValue,
      supplies,
      net,
      lootReported: Number.isFinite(p.loot) ? p.loot : null,
      items: p.items
    });
  }

  const n = perPlayer.length || 1;
  const totalNet = totalLootValue - totalSupplies;
  const share = Math.floor(totalNet / n);

  let lootHolder = perPlayer[0];
  for (const p of perPlayer) {
    if (p.lootReported != null && lootHolder.lootReported != null) {
      if (p.lootReported > lootHolder.lootReported) lootHolder = p;
    } else if (p.lootReported != null && lootHolder.lootReported == null) {
      lootHolder = p;
    } else if (p.lootReported == null && lootHolder.lootReported == null) {
      if (p.lootValue > lootHolder.lootValue) lootHolder = p;
    }
  }

  const payers = [];
  const receivers = [];
  for (const p of perPlayer) {
    const delta = p.net - share;
    if (delta > 0) payers.push({ name: p.discordName, amt: delta });
    if (delta < 0) receivers.push({ name: p.discordName, amt: -delta });
  }

  const transfers = [];
  let i = 0, j = 0;
  while (i < payers.length && j < receivers.length) {
    const pay = payers[i];
    const rec = receivers[j];
    const x = Math.min(pay.amt, rec.amt);
    transfers.push({ from: pay.name, to: rec.name, amount: x });
    pay.amt -= x;
    rec.amt -= x;
    if (pay.amt === 0) i++;
    if (rec.amt === 0) j++;
  }

  const lhCounts = new Map();
  for (const it of lootHolder.items) {
    const key = normItemName(it.name);
    lhCounts.set(key, (lhCounts.get(key) || 0) + it.qty);
  }

  const sellNpc = [];
  const sellBuy = [];
  for (const [key, qty] of lhCounts.entries()) {
    const meta = itemMeta.get(key);
    if (!meta) continue;

    const row = {
      name: key,
      qty,
      npcSell: meta.npcSell,
      marketBuy: meta.marketBuy,
      total: qty * meta.unit
    };

    if (meta.route === "SELL_TO_MARKET_BUY") sellBuy.push(row);
    else sellNpc.push(row);
  }

  sellNpc.sort((a, b) => b.total - a.total);
  sellBuy.sort((a, b) => b.total - a.total);

  return {
    updatedAt: snap.updatedAt,
    totalSupplies,
    totalLootValue,
    totalNet,
    share,
    perPlayer,
    transfers,
    lootHolder: lootHolder.discordName,
    sellNpc,
    sellBuy
  };
}
