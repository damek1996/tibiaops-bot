import { fetchMarketSnapshotSecura, normItemName } from "./provider.mjs";
import { getItemIdByName, getNpcBuyById } from "./provider.mjs";

function parseIntComma(s) {
  if (s == null) return null;
  const cleaned = String(s).replace(/,/g, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function stripLeadingJunkName(name) {
  // Handles "472 Gregorianeg" / "067 Parcel Macius" etc.
  // Remove leading numbers, dots, dashes, extra spaces.
  return String(name ?? "")
    .replace(/^\s*\d+\s+/, "")
    .replace(/^\s*[-–—•.]+\s*/, "")
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
 * Party Hunt Analyzer parser:
 * - Parses total loot/supplies/balance from header
 * - Parses players with per-player Loot/Supplies/Balance
 * - Strips leading numeric prefixes from names
 */
export function parsePartyAnalyzerText(text) {
  const whole = String(text ?? "").replace(/\r\n/g, "\n");
  const lines = whole.split("\n").map(l => l.replace(/\t/g, "    ").trimEnd());

  // Header totals (optional but useful)
  let totalLoot = null;
  let totalSupplies = null;
  let totalBalance = null;

  for (const line of lines) {
    const t = line.trim();
    const mLoot = t.match(/^Loot:\s*([-\d,]+)/i);
    if (mLoot && totalLoot == null) totalLoot = parseIntComma(mLoot[1]);

    const mSup = t.match(/^Supplies:\s*([-\d,]+)/i);
    if (mSup && totalSupplies == null) totalSupplies = parseIntComma(mSup[1]);

    const mBal = t.match(/^Balance:\s*([-\d,]+)/i);
    if (mBal && totalBalance == null) totalBalance = parseIntComma(mBal[1]);

    // stop once we have header totals and hit first player name
    // (not strictly required)
  }

  const players = [];
  for (let i = 0; i < lines.length; i++) {
    const headerRaw = lines[i].trim();
    if (isNonPlayerHeading(headerRaw)) continue;

    const isLeader = /\(Leader\)/i.test(headerRaw);
    const nameClean = stripLeadingJunkName(headerRaw.replace(/\(Leader\)/i, ""));

    if (!nameClean) continue;
    if (/^(Loot|Supplies|Balance)$/i.test(nameClean)) continue;

    let loot = null, supplies = null, balance = null;

    for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
      const t = lines[j].trim();
      const mLoot = t.match(/^Loot:\s*([-\d,]+)/i);
      if (mLoot) loot = parseIntComma(mLoot[1]);

      const mSup = t.match(/^Supplies:\s*([-\d,]+)/i);
      if (mSup) supplies = parseIntComma(mSup[1]);

      const mBal = t.match(/^Balance:\s*([-\d,]+)/i);
      if (mBal) balance = parseIntComma(mBal[1]);

      // stop if next player header begins
      if (j > i + 1 && !t.includes(":") && !isNonPlayerHeading(t)) break;
    }

    // For settlement we need at least Balance and Supplies; but sometimes only Supplies is present.
    if (Number.isFinite(supplies) || Number.isFinite(balance)) {
      players.push({
        name: nameClean,
        isLeader,
        loot,
        supplies,
        balance
      });
    }
  }

  // Final filter: must have Supplies AND Balance for settlement-by-balance mode
  const valid = players.filter(p => Number.isFinite(p.supplies) && Number.isFinite(p.balance));

  return {
    totalLoot,
    totalSupplies,
    totalBalance,
    players: valid
  };
}

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
 * Settlement based on PARTY BALANCES (this matches Tibia's Hunt Analyzer split logic).
 * Equal split:
 *  target = totalBalance / N
 *  delta_i = balance_i - target
 * payers -> receivers
 */
export function computeBalanceSettlement(party) {
  if (!party?.players?.length) throw new Error("Party missing or no players parsed.");

  const players = party.players.map(p => ({
    name: p.name,
    supplies: p.supplies,
    balance: p.balance
  }));

  const n = players.length;

  // total balance: use header if available, else sum player balances
  const totalBalance =
    Number.isFinite(party.totalBalance)
      ? party.totalBalance
      : players.reduce((a, p) => a + (p.balance || 0), 0);

  const target = Math.floor(totalBalance / n);

  const payers = [];
  const receivers = [];

  for (const p of players) {
    const delta = p.balance - target;
    p.target = target;
    p.delta = delta;
    if (delta > 0) payers.push({ name: p.name, amt: delta });
    if (delta < 0) receivers.push({ name: p.name, amt: -delta });
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

  return { totalBalance, target, players, transfers };
}

/**
 * Build per-player sell decisions (BUY vs NPC BUY) from looter items.
 * This is separate from settlement logic.
 */
export async function computeSellDecisionsSecura(lootersByName) {
  const uniqueNames = new Set();
  for (const [, items] of lootersByName.entries()) {
    for (const it of items ?? []) uniqueNames.add(normItemName(it.name));
  }
  const itemNames = [...uniqueNames];

  const snap = await fetchMarketSnapshotSecura(itemNames);

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

    const npcBuy = await getNpcBuyById(id);
    const marketBuy = snap.items.get(nm)?.buy ?? null;
    const buyVal = marketBuy != null ? marketBuy : 0;

    const unit = Math.max(buyVal, npcBuy);
    const route = buyVal > npcBuy ? "BUY" : "NPC";

    itemDecision.set(nm, { unit, route, npcBuy, marketBuy });
  }

  // Per player lists
  const sellInstructionsByPlayer = new Map();
  for (const [playerName, items] of lootersByName.entries()) {
    const qtyByName = new Map();
    for (const it of items ?? []) {
      const k = normItemName(it.name);
      qtyByName.set(k, (qtyByName.get(k) || 0) + (it.qty || 0));
    }

    const sellBuy = [];
    const sellNpc = [];
    const unmatched = [];

    for (const [nameNorm, qty] of qtyByName.entries()) {
      const dec = itemDecision.get(nameNorm);
      if (!dec) {
        unmatched.push({ name: nameNorm, qty });
        continue;
      }

      // coins: skip sell instructions
      if (dec.route === "COIN") continue;

      const row = { name: nameNorm, qty, npcBuy: dec.npcBuy, marketBuy: dec.marketBuy };
      if (dec.route === "BUY") sellBuy.push(row);
      else sellNpc.push(row);
    }

    sellBuy.sort((a, b) => (b.marketBuy || 0) - (a.marketBuy || 0));
    sellNpc.sort((a, b) => (b.npcBuy || 0) - (a.npcBuy || 0));

    sellInstructionsByPlayer.set(playerName, { sellBuy, sellNpc, unmatched });
  }

  return { updatedAt: snap.updatedAt, sellInstructionsByPlayer, unmatchedItemNames: [...new Set(unmatchedItemNames)] };
}
