import { fetchMarketSnapshotSecura, normItemName } from "./provider.mjs";
import { getItemIdByName, getNpcBuyById } from "./provider.mjs";

function parseIntComma(s) {
  if (s == null) return null;
  const cleaned = String(s).replace(/,/g, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function stripLeadingJunkName(name) {
  return String(name ?? "")
    .replace(/^\s*\d+\s+/, "")          // "472 Gregorianeg" -> "Gregorianeg"
    .replace(/^\s*[-–—•.]+\s*/, "")     // "- Name" -> "Name"
    .trim();
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

/**
 * Party analyzer parser: only used for roster + supplies + (optional) balances.
 * For our corrected logic, supplies are mandatory.
 */
export function parsePartyAnalyzerText(text) {
  const whole = String(text ?? "").replace(/\r\n/g, "\n");
  const lines = whole.split("\n").map(l => l.replace(/\t/g, "    ").trimEnd());

  const players = [];

  for (let i = 0; i < lines.length; i++) {
    const headerRaw = lines[i].trim();
    if (isNonPlayerHeading(headerRaw)) continue;

    const isLeader = /\(Leader\)/i.test(headerRaw);
    const nameClean = stripLeadingJunkName(headerRaw.replace(/\(Leader\)/i, ""));
    if (!nameClean) continue;
    if (/^(Loot|Supplies|Balance)$/i.test(nameClean)) continue;

    let supplies = null;
    let balance = null;

    for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
      const t = lines[j].trim();

      const mSup = t.match(/^Supplies:\s*([-\d,]+)/i);
      if (mSup) supplies = parseIntComma(mSup[1]);

      const mBal = t.match(/^Balance:\s*([-\d,]+)/i);
      if (mBal) balance = parseIntComma(mBal[1]);

      // stop if next player header begins
      if (j > i + 1 && !t.includes(":") && !isNonPlayerHeading(t)) break;
    }

    if (Number.isFinite(supplies)) {
      players.push({ name: nameClean, isLeader, supplies, balance });
    }
  }

  return { players };
}

/**
 * Looter analyzer parser: "Looted Items:" block.
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
    // Fallback if pasted in one line
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
 * Core requirement:
 * - Total loot is recalculated from looted items using max(Market BUY, NPC BUY).
 * - Coins have fixed value.
 * - Supplies are repaid, remaining profit split equally.
 * - Output direct payer->receiver transfers (no cash holder).
 * - Output per-player sell instructions (Market BUY vs NPC BUY).
 */
export async function computeCorrectedSettlementSecura({ party, lootersByName }) {
  if (!party?.players?.length) throw new Error("Party analyzer missing or no players parsed.");

  const roster = party.players.map(p => ({
    name: p.name,
    supplies: p.supplies ?? 0
  }));

  const n = roster.length;
  if (n <= 0) throw new Error("No players in party.");

  // Require looter input for everyone (even None) so totals are deterministic
  const missing = roster.filter(p => !lootersByName.has(p.name)).map(p => p.name);
  if (missing.length) {
    throw new Error(`Missing looter paste for: ${missing.join(", ")} (paste even if "Looted Items: None")`);
  }

  // Build unique item list for one market snapshot call
  const uniqueNames = new Set();
  for (const p of roster) {
    const items = lootersByName.get(p.name) ?? [];
    for (const it of items) uniqueNames.add(normItemName(it.name));
  }
  const itemNames = [...uniqueNames];

  const snap = await fetchMarketSnapshotSecura(itemNames);

  // Decide valuation route per item name
  const itemDecision = new Map(); // nameNorm -> {route, unit, marketBuy, npcBuy}
  const unmatchedItemNames = [];

  for (const nm of itemNames) {
    const coin = fixedCoinValue(nm);
    if (coin != null) {
      itemDecision.set(nm, { route: "COIN", unit: coin, marketBuy: coin, npcBuy: coin });
      continue;
    }

    const id = await resolveItemId(nm);
    if (id == null) {
      unmatchedItemNames.push(nm);
      continue;
    }

    const npcBuy = await getNpcBuyById(id);           // SELL TO NPC price
    const marketBuy = snap.items.get(nm)?.buy ?? null; // Market BUY offer
    const buyVal = marketBuy != null ? marketBuy : 0;

    const unit = Math.max(buyVal, npcBuy);
    const route = buyVal > npcBuy ? "BUY" : "NPC";

    itemDecision.set(nm, { route, unit, marketBuy, npcBuy });
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

    const sellBuy = [];
    const sellNpc = [];
    const unmatched = [];

    for (const [nameNorm, qty] of qtyByName.entries()) {
      const dec = itemDecision.get(nameNorm);
      if (!dec) {
        unmatched.push({ name: nameNorm, qty });
        continue;
      }

      // Coins: count value but do not put into "sell" lists
      if (dec.route === "COIN") {
        heldLootValue += qty * dec.unit;
        continue;
      }

      const unitValue = dec.unit;
      heldLootValue += qty * unitValue;

      const row = {
        name: nameNorm,
        qty,
        marketBuy: dec.marketBuy ?? 0,
        npcBuy: dec.npcBuy ?? 0,
        unit: unitValue,
        total: qty * unitValue
      };

      if (dec.route === "BUY") sellBuy.push(row);
      else sellNpc.push(row);
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

  // Fair payout for each player = supplies repaid + equal share of net
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

  // Generate transfers payer -> receiver
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
