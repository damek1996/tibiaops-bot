import {
  fetchMarketSnapshotSecura,
  fetchMarketBoard,
  computeInstantSellValueFromBoard,
  normItemName,
  getItemIdByName,
  getNpcBuyById,
  getNpcBuyersById
} from "./provider.mjs";

// ===== Parsing helpers =====
function parseIntComma(s) {
  if (s == null) return null;
  const cleaned = String(s).replace(/,/g, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function stripLeadingJunkName(name) {
  return String(name ?? "")
    .replace(/^\s*\d+\s+/, "")
    .replace(/\(Leader\)/ig, "")
    .trim();
}

function isNonPlayerHeading(t) {
  const s = t.trim();
  if (!s) return true;
  if (s.includes(":")) return true;
  if (/^Session data/i.test(s)) return true;
  if (/^Session:/i.test(s)) return true;
  if (/^Loot Type/i.test(s)) return true;
  if (/^Looted Items/i.test(s)) return true;
  if (/^Killed Monsters/i.test(s)) return true;
  if (/^Damage/i.test(s)) return true;
  if (/^Healing/i.test(s)) return true;
  if (/^(Market|NPC|Custom)$/i.test(s)) return true;
  return false;
}

export function normalizeLootItemName(raw) {
  let s = String(raw).trim().toLowerCase();
  s = s.replace(/^(a|an)\s+/, "");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function fixedCoinValue(nameNorm) {
  if (nameNorm === "gold coin" || nameNorm === "gold coins") return 1;
  if (nameNorm === "platinum coin" || nameNorm === "platinum coins") return 100;
  if (nameNorm === "crystal coin" || nameNorm === "crystal coins") return 10000;
  return null;
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

async function resolveItemId(nameNorm) {
  for (const cand of candidateNames(nameNorm)) {
    const id = await getItemIdByName(cand);
    if (typeof id === "number") return id;
  }
  return null;
}

// ===== Party analyzer parser =====
export function parsePartyAnalyzerText(text) {
  const whole = String(text ?? "").replace(/\r\n/g, "\n");
  const lines = whole.split("\n").map(l => l.replace(/\t/g, "    ").trimEnd());

  const players = [];

  for (let i = 0; i < lines.length; i++) {
    const headerRaw = lines[i].trim();
    if (isNonPlayerHeading(headerRaw)) continue;

    const nameClean = stripLeadingJunkName(headerRaw);
    if (!nameClean) continue;
    if (/^(Loot|Supplies|Balance)$/i.test(nameClean)) continue;

    let supplies = null;

    for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
      const t = lines[j].trim();

      const mSup = t.match(/^Supplies:\s*([-\d,]+)/i);
      if (mSup) supplies = parseIntComma(mSup[1]);

      if (j > i + 1 && !t.includes(":") && !isNonPlayerHeading(t)) break;
    }

    if (Number.isFinite(supplies)) players.push({ name: nameClean, supplies });
  }

  return { players };
}

// ===== Looter analyzer parser =====
export function parseLooterAnalyzerText(text) {
  const whole = String(text ?? "");
  const items = [];
  const lines = whole.replace(/\r\n/g, "\n").split("\n");

  const idx = lines.findIndex(l => /^Looted Items:/i.test(l.trim()));
  if (idx >= 0) {
    for (let i = idx + 1; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      if (/^none/i.test(trimmed)) continue;

      const m = trimmed.match(/^(\d+)\s*x\s+(.+)$/i);
      if (!m) continue;

      const qty = Number(m[1]);
      if (!Number.isFinite(qty) || qty <= 0) continue;

      items.push({ name: normalizeLootItemName(m[2]), qty });
    }
  }

  return { items };
}

/**
 * Market valuation rule:
 * - For settlement: value per item = max(instant market liquidation via BUY depth, NPC BUY).
 * - If BUY depth cannot fill entire qty, remaining is valued at next levels; if still unfilled -> 0 for remainder.
 * - Coins: fixed values.
 *
 * Additional guidance:
 * - If market chosen: show "instant sell expected" and also "suggested offer price" = BUY (instant) + optionally SELL (list).
 */
export async function computeCorrectedSettlementSecura({ party, lootersByName }) {
  if (!party?.players?.length) throw new Error("Party analyzer missing or no players parsed.");

  const roster = party.players.map(p => ({
    name: p.name,
    supplies: p.supplies ?? 0
  }));

  const n = roster.length;
  if (n <= 0) throw new Error("No players in party.");

  const missing = roster.filter(p => !lootersByName.has(p.name)).map(p => p.name);
  if (missing.length) {
    throw new Error(`Missing looter paste for: ${missing.join(", ")} (paste even if "Looted Items: None")`);
  }

  // One snapshot for buy/sell offers + month averages etc (from raw)
  const snap = await fetchMarketSnapshotSecura();

  // Resolve item IDs for all unique names
  const uniqueNames = new Set();
  for (const p of roster) {
    const items = lootersByName.get(p.name) ?? [];
    for (const it of items) uniqueNames.add(normItemName(it.name));
  }
  const itemNames = [...uniqueNames];

  const itemInfo = new Map(); // nameNorm -> {id, npcBuy, npcBuyers, snapRow}
  const unmatchedItemNames = [];

  for (const nm of itemNames) {
    const coin = fixedCoinValue(nm);
    if (coin != null) {
      itemInfo.set(nm, { id: null, npcBuy: coin, npcBuyers: [], snapRow: null, isCoin: true });
      continue;
    }

    const id = await resolveItemId(nm);
    if (id == null) {
      unmatchedItemNames.push(nm);
      continue;
    }

    const npcBuy = await getNpcBuyById(id);
    const npcBuyers = await getNpcBuyersById(id);

    const snapRow = snap.items.get(nm)?.raw ?? null;
    itemInfo.set(nm, { id, npcBuy, npcBuyers, snapRow, isCoin: false });
  }

  // Per-player valuation and sell instructions
  const sellInstructionsByPlayer = new Map();
  const perPlayer = [];

  let totalSupplies = 0;
  let totalHeldLoot = 0;

  for (const p of roster) {
    const items = lootersByName.get(p.name) ?? [];
    const qtyByName = new Map();
    for (const it of items) {
      const k = normItemName(it.name);
      qtyByName.set(k, (qtyByName.get(k) || 0) + (it.qty || 0));
    }

    let heldLootValue = 0;

    const sellMarket = [];
    const sellNpc = [];
    const unmatched = [];

    for (const [nameNorm, qty] of qtyByName.entries()) {
      const info = itemInfo.get(nameNorm);

      if (!info) {
        unmatched.push({ name: nameNorm, qty });
        continue;
      }

      // Coins
      if (info.isCoin) {
        heldLootValue += qty * info.npcBuy;
        continue;
      }

      const { id, npcBuy, npcBuyers, snapRow } = info;

      // Instant market liquidation using depth (buyers)
      let depth = null;
      let marketInstantValue = 0;
      let usedLevels = [];
      try {
        // Only fetch depth when it actually matters:
        // - qty >= 10 OR npcBuy close to market OR you want accurate settlement
        // For now: always for non-coins (correctness).
        depth = await fetchMarketBoard("Secura", id);
        const r = computeInstantSellValueFromBoard(depth, qty);
        marketInstantValue = r.value;
        usedLevels = r.usedLevels;
      } catch {
        // fallback to top-of-book if depth fails
        const buyOffer = Number(snapRow?.buy_offer ?? 0);
        marketInstantValue = Math.max(0, buyOffer) * qty;
      }

      const npcValue = (npcBuy || 0) * qty;

      // Choose best liquidation
      const chooseMarket = marketInstantValue > npcValue;
      const chosenValue = Math.max(marketInstantValue, npcValue);
      heldLootValue += chosenValue;

      // Offer guidance
      const buyOffer = Number(snapRow?.buy_offer ?? 0);
      const sellOffer = Number(snapRow?.sell_offer ?? 0);
      const monthAvgBuy = Number(snapRow?.month_average_buy ?? 0);
      const monthAvgSell = Number(snapRow?.month_average_sell ?? 0);

      const bestNpc = npcBuyers?.[0]?.name ? `${npcBuyers[0].name} (${npcBuyers[0].price})` : "";

      const row = {
        name: nameNorm,
        qty,
        itemId: id,
        chosen: chooseMarket ? "MARKET_BUY_DEPTH" : "NPC",
        chosenTotal: chosenValue,
        marketInstantTotal: marketInstantValue,
        npcTotal: npcValue,
        buyOffer,
        sellOffer,
        monthAvgBuy,
        monthAvgSell,
        npcBuy,
        bestNpc,
        usedLevels // for depth explanation
      };

      if (chooseMarket) sellMarket.push(row);
      else sellNpc.push(row);
    }

    sellMarket.sort((a, b) => b.chosenTotal - a.chosenTotal);
    sellNpc.sort((a, b) => b.chosenTotal - a.chosenTotal);

    sellInstructionsByPlayer.set(p.name, { sellMarket, sellNpc, unmatched });

    totalSupplies += p.supplies;
    totalHeldLoot += heldLootValue;

    perPlayer.push({
      name: p.name,
      supplies: p.supplies,
      heldLootValue
    });
  }

  const correctedNet = totalHeldLoot - totalSupplies;
  const share = Math.floor(correctedNet / n);

  // fair payout = supplies refunded + equal profit share
  const payers = [];
  const receivers = [];

  for (const p of perPlayer) {
    const fairPayout = p.supplies + share;
    const delta = p.heldLootValue - fairPayout;

    p.fairPayout = fairPayout;
    p.delta = delta;

    if (delta > 0) payers.push({ name: p.name, amt: delta });
    if (delta < 0) receivers.push({ name: p.name, amt: -delta });
  }

  // payer -> receiver transfers
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

  return {
    updatedAt: snap.updatedAt,
    totalHeldLoot,
    totalSupplies,
    correctedNet,
    share,
    perPlayer,
    transfers,
    sellInstructionsByPlayer,
    unmatchedItemNames: [...new Set(unmatchedItemNames)]
  };
}
