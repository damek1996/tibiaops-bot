import { fetchMarketSnapshotSecura, normItemName } from "./provider.mjs";
import { getItemIdByName, getNpcBuyById } from "./provider.mjs";

function parseIntComma(s) {
  if (s == null) return null;
  const cleaned = String(s).replace(/,/g, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export function normalizeLootItemName(raw) {
  let s = String(raw).trim().toLowerCase();
  s = s.replace(/^(a|an)\s+/, "");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

// Coins should be treated as fixed gold values (no market/NPC decision)
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

/**
 * Robust Party Hunt Analyzer parser.
 * Supports multiline and single-line (Discord collapsed) pastes.
 * We require supplies per player for corrected settlement.
 */
export function parsePartyAnalyzerText(text) {
  const raw = String(text ?? "");

  // ---------- Pass 1: multiline parsing ----------
  const whole = raw.replace(/\r\n/g, "\n");
  const lines = whole.split("\n").map(l => l.replace(/\t/g, "  "));

  const players = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const t = line.trim();

    const isHeaderCandidate =
      t &&
      !t.includes(":") &&
      !/^Session data/i.test(t) &&
      !/^Session:/i.test(t) &&
      !/^Loot Type:/i.test(t) &&
      !/^Looted Items:/i.test(t) &&
      !/^Killed Monsters:/i.test(t) &&
      !/^Damage/i.test(t) &&
      !/^Healing/i.test(t);

    if (isHeaderCandidate) {
      const isLeader = /\(Leader\)/i.test(t);
      const name = t.replace(/\(Leader\)/i, "").trim();
      current = { name, isLeader, supplies: null, loot: null, balance: null };
      players.push(current);
      continue;
    }

    if (!current) continue;

    const mSup = t.match(/^Supplies:\s*([-\d,]+)/i);
    if (mSup) current.supplies = parseIntComma(mSup[1]);

    const mLoot = t.match(/^Loot:\s*([-\d,]+)/i);
    if (mLoot) current.loot = parseIntComma(mLoot[1]);

    const mBal = t.match(/^Balance:\s*([-\d,]+)/i);
    if (mBal) current.balance = parseIntComma(mBal[1]);
  }

  let valid = players.filter(p => Number.isFinite(p.supplies));

  // ---------- Pass 2: single-line fallback ----------
  if (valid.length === 0) {
    const flat = raw.replace(/\s+/g, " ").trim();
    const re =
      /([A-Za-z0-9'._ -]+?)(\s*\(Leader\))?\s+Loot:\s*([-\d,]+)\s+Supplies:\s*([-\d,]+)\s+Balance:\s*([-\d,]+)/gi;

    const out = [];
    let m;
    while ((m = re.exec(flat)) !== null) {
      const name = String(m[1] ?? "").trim();
      const isLeader = !!(m[2] && m[2].toLowerCase().includes("leader"));
      const loot = parseIntComma(m[3]);
      const supplies = parseIntComma(m[4]);
      const balance = parseIntComma(m[5]);
      if (!name) continue;
      out.push({ name, isLeader, loot, supplies, balance });
    }

    valid = out.filter(p => Number.isFinite(p.supplies));
  }

  return { players: valid };
}

/**
 * Looter analyzer parser: extracts Looted Items.
 */
export function parseLooterAnalyzerText(text) {
  const whole = String(text ?? "");
  const items = [];
  const lines = whole.replace(/\r\n/g, "\n").split("\n");

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

      items.push({ name: normalizeLootItemName(m[2]), qty });
    }
  } else {
    const mBlock = whole.match(/Looted Items:\s*(.+)$/i);
    if (mBlock) {
      const tail = mBlock[1];
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

  return { items };
}

/**
 * Corrected settlement:
 * - Best liquidation per item: max(Market BUY, NPC BUY)
 * - Repays supplies and splits profit equally
 * - Produces direct payers->receivers transfers (no cash holder)
 *
 * NOTE: Requires every party member to paste a looter analyzer (even if "Looted Items: None")
 */
export async function computeCorrectedSettlementSecura({ party, lootersByName }) {
  if (!party?.players?.length) throw new Error("Party analyzer missing or no players parsed.");

  const roster = party.players.map(p => ({
    name: p.name,
    isLeader: !!p.isLeader,
    supplies: p.supplies ?? 0
  }));

  const n = roster.length;
  if (n <= 0) throw new Error("No players in party.");

  const missing = [];
  for (const p of roster) {
    if (!lootersByName.has(p.name)) missing.push(p.name);
  }
  if (missing.length) {
    throw new Error(`Missing looter paste for: ${missing.join(", ")} (paste even if 'Looted Items: None')`);
  }

  // Unique item names across all players
  const uniqueNames = new Set();
  for (const p of roster) {
    const items = lootersByName.get(p.name) ?? [];
    for (const it of items) uniqueNames.add(normItemName(it.name));
  }
  const itemNames = [...uniqueNames];

  const snap = await fetchMarketSnapshotSecura(itemNames);

  // nameNorm -> decision {unit, route, npcBuy, marketBuy}
  const itemDecision = new Map();
  const unmatchedItemNames = [];

  for (const nm of itemNames) {
    const coin = fixedCoinValue(nm);
    if (coin != null) {
      itemDecision.set(nm, { unit: coin, route: "COIN", npcBuy: coin, marketBuy: coin });
      continue;
    }

    const id = await resolveItemId(nm);
    if (id == null) {
      unmatchedItemNames.push(nm);
      continue;
    }

    // IMPORTANT: npcBuy is the price you get when you SELL to NPC
    const npcBuy = await getNpcBuyById(id);
    const marketBuy = snap.items.get(nm)?.buy ?? null;
    const buyVal = marketBuy != null ? marketBuy : 0;

    const unit = Math.max(buyVal, npcBuy);
    const route = buyVal > npcBuy ? "BUY" : "NPC";
    itemDecision.set(nm, { unit, route, npcBuy, marketBuy });
  }

  // Per-player held loot value + per-player sell instructions
  const perPlayer = [];
  let totalSupplies = 0;
  let totalHeldLoot = 0;

  const sellInstructionsByPlayer = new Map();

  for (const p of roster) {
    const items = lootersByName.get(p.name) ?? [];
    const qtyByName = new Map();
    for (const it of items) {
      const k = normItemName(it.name);
      qtyByName.set(k, (qtyByName.get(k) || 0) + (it.qty || 0));
    }

    let heldLootValue = 0;
    const sellBuy = [];
    const sellNpc = [];
    const unmatched = [];

    for (const [nameNorm, qty] of qtyByName.entries()) {
      const dec = itemDecision.get(nameNorm);
      if (!dec) {
        unmatched.push({ name: nameNorm, qty });
        continue;
      }

      heldLootValue += qty * dec.unit;

      const row = {
        name: nameNorm,
        qty,
        npcBuy: dec.npcBuy,
        marketBuy: dec.marketBuy,
        total: qty * dec.unit
      };

      if (dec.route === "BUY") sellBuy.push(row);
      else if (dec.route === "NPC") sellNpc.push(row);
      // COIN: already gold
    }

    sellBuy.sort((a, b) => b.total - a.total);
    sellNpc.sort((a, b) => b.total - a.total);

    sellInstructionsByPlayer.set(p.name, { sellBuy, sellNpc, unmatched });

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

  // fair payout from loot pot = supplies repaid + equal share
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

  // Transfers: match payers -> receivers
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
