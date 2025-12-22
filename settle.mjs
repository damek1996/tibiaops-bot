import {
  normItemName,
  getItemIdByName,
  getBestNpcBuyPrice,
  getNpcBuyersById,
  fetchMarketBoard,
  computeInstantSellValueFromBoard
} from "./provider.mjs";

function parseIntComma(s) {
  if (s == null) return null;
  const cleaned = String(s).replace(/,/g, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function cleanPlayerHeader(line) {
  return String(line ?? "")
    .replace(/\(Leader\)/ig, "")
    .replace(/^\s*\d+\s+/, "")
    .trim();
}

function fixedCoinValue(nameNorm) {
  if (nameNorm === "gold coin" || nameNorm === "gold coins") return 1;
  if (nameNorm === "platinum coin" || nameNorm === "platinum coins") return 100;
  if (nameNorm === "crystal coin" || nameNorm === "crystal coins") return 10000;
  return null;
}

export function parsePartyAnalyzerText(text) {
  const whole = String(text ?? "").replace(/\r\n/g, "\n");
  const lines = whole.split("\n").map(l => l.replace(/\t/g, "    "));

  const players = [];
  const seen = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (/^Session data:/i.test(line)) continue;
    if (/^Session:/i.test(line)) continue;
    if (/^Loot Type:/i.test(line)) continue;
    if (/^Loot:/i.test(line)) continue;
    if (/^Supplies:/i.test(line)) continue;
    if (/^Balance:/i.test(line)) continue;

    if (line.includes(":")) continue;

    const name = cleanPlayerHeader(line);
    if (!name) continue;
    if (/^(Market|NPC|Custom)$/i.test(name)) continue;

    let supplies = null;
    for (let j = i + 1; j < Math.min(i + 25, lines.length); j++) {
      const t = lines[j].trim();
      const mSup = t.match(/^Supplies:\s*([-\d,]+)/i);
      if (mSup) { supplies = parseIntComma(mSup[1]); break; }
      if (t && !t.includes(":") && j > i + 1) break;
    }

    if (Number.isFinite(supplies)) {
      const key = name.toLowerCase();
      if (!seen.has(key)) {
        players.push({ name, supplies });
        seen.add(key);
      }
    }
  }

  return { players };
}

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

      let name = String(m[2]).trim().toLowerCase();
      name = name.replace(/^(a|an)\s+/, "").replace(/\s+/g, " ").trim();

      items.push({ name, qty });
    }
  }

  return { items };
}

function candidateNames(norm) {
  const out = [norm];
  if (norm.endsWith("coins")) out.push(norm.replace(/coins$/, "coin"));
  if (norm.endsWith("ies")) out.push(norm.slice(0, -3) + "y");
  if (norm.endsWith("es")) out.push(norm.slice(0, -2));
  if (norm.endsWith("s")) out.push(norm.slice(0, -1));
  return [...new Set(out)].filter(Boolean);
}

async function resolveItemId(nameNorm) {
  for (const cand of candidateNames(nameNorm)) {
    const id = await getItemIdByName(cand);
    if (typeof id === "number") return id;
  }
  return null;
}

export async function computeCorrectedSettlementSecura({ party, lootersByName }) {
  if (!party?.players?.length) throw new Error("Party analyzer missing or no players parsed.");

  const roster = party.players.map(p => ({ name: p.name, supplies: p.supplies ?? 0 }));
  const missing = roster.filter(p => !lootersByName.has(p.name)).map(p => p.name);
  if (missing.length) throw new Error(`Missing looter paste for: ${missing.join(", ")}`);

  // resolve all unique items once
  const uniqueNames = new Set();
  for (const p of roster) {
    const items = lootersByName.get(p.name) ?? [];
    for (const it of items) uniqueNames.add(normItemName(it.name));
  }

  const nameToId = new Map();
  const unmatchedItemNames = [];
  for (const nm of uniqueNames) {
    const coin = fixedCoinValue(nm);
    if (coin != null) continue;
    const id = await resolveItemId(nm);
    if (id == null) unmatchedItemNames.push(nm);
    else nameToId.set(nm, id);
  }

  const perPlayer = [];
  const sellInstructionsByPlayer = new Map();

  let totalHeldLoot = 0;
  let totalSupplies = 0;

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
      const coinV = fixedCoinValue(nameNorm);
      if (coinV != null) { heldLootValue += qty * coinV; continue; }

      const id = nameToId.get(nameNorm);
      if (!id) { unmatched.push({ name: nameNorm, qty }); continue; }

      // market depth for THIS item
      const board = await fetchMarketBoard("Secura", id);
      const depth = computeInstantSellValueFromBoard(board, qty);
      const marketInstantTotal = depth.value;

      const npcBuy = await getBestNpcBuyPrice(id);
      const npcTotal = npcBuy * qty;

      const npcBuyers = await getNpcBuyersById(id);
      const bestNpc = npcBuyers?.[0]?.name ? `${npcBuyers[0].name} (${npcBuyers[0].price})` : "";

      const chooseMarket = marketInstantTotal > npcTotal;
      const chosenTotal = Math.max(marketInstantTotal, npcTotal);
      heldLootValue += chosenTotal;

      const topBuy = depth.usedLevels?.[0]?.price ?? 0;

      const row = {
        name: nameNorm, qty, itemId: id,
        chosenTotal, marketInstantTotal, npcTotal,
        npcBuy, bestNpc,
        usedLevels: depth.usedLevels ?? [],
        topBuy
      };

      if (chooseMarket) sellMarket.push(row);
      else sellNpc.push(row);
    }

    sellMarket.sort((a, b) => b.chosenTotal - a.chosenTotal);
    sellNpc.sort((a, b) => b.chosenTotal - a.chosenTotal);

    sellInstructionsByPlayer.set(p.name, { sellMarket, sellNpc, unmatched });

    totalHeldLoot += heldLootValue;
    totalSupplies += p.supplies;
    perPlayer.push({ name: p.name, supplies: p.supplies, heldLootValue });
  }

  const correctedNet = totalHeldLoot - totalSupplies;
  const share = Math.floor(correctedNet / roster.length);

  const payers = [];
  const receivers = [];
  for (const p of perPlayer) {
    p.fairPayout = p.supplies + share;
    p.delta = p.heldLootValue - p.fairPayout;
    if (p.delta > 0) payers.push({ name: p.name, amt: p.delta });
    if (p.delta < 0) receivers.push({ name: p.name, amt: -p.delta });
  }

  const transfers = [];
  let i = 0, j = 0;
  while (i < payers.length && j < receivers.length) {
    const pay = payers[i], rec = receivers[j];
    const x = Math.min(pay.amt, rec.amt);
    transfers.push({ from: pay.name, to: rec.name, amount: x });
    pay.amt -= x; rec.amt -= x;
    if (pay.amt === 0) i++;
    if (rec.amt === 0) j++;
  }

  return {
    updatedAt: new Date(),
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
