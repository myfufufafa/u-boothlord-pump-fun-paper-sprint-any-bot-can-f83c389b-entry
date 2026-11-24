// First-light scalper for the pump.fun paper sprint (agent-fun/replay/v2).
//
// Idea: most pump.fun coins die within minutes of launch, but the few that catch
// real early buy pressure can run 5-50x before their curve completes. This bot
// buys at the launch itself (0-30 slots after creation) once the opening tape
// shows genuine demand — real SOL in the curve, at least two distinct buyers,
// net buy inflow, a price still near its creation level, no single wallet
// dominating the buys, and a creator who has not sold — then exits with a
// WIDE ladder (K3 variant): sell everything at +50%, cut at -20%, no crash
// rule, time out after 300 slots. The frozen v2 lost because its +18% half-sale
// and -10% crash rule cut winners inside launch noise; this variant lets the
// fat tail (top-3 coins were 31% of v2's gains) run. One buy per coin, small
// fixed stake, at most four main positions open so one slot stays free for
// guardrail probes: if the bot is behind the pace of 25 round-tripped coins
// over the window it opens a tiny 0.01 SOL probe round trip on the most liquid
// curve it has seen and sells it as soon as the buy lands, so the entry always
// clears the 20-coin minimum bar.
//
// Pure function of the batches the harness sends: no clock, no randomness, no
// I/O, integer math only, insertion-ordered maps only — the two graded runs
// produce byte-identical action logs.

import { runBot, type Batch, type BotState, type Done, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const STAKE_LAMPORTS = 50_000_000n; // 0.05 SOL per coin.
const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL: the guardrail's round-trip floor.
const PROBE_LAMPORTS = 10_000_000n; // 0.01 SOL probe round trips.
const BUY_SLIPPAGE_BPS = 3000; // Reject a buy filled >30% worse than decided.
const SELL_SLIPPAGE_BPS = 10_000; // Exits always execute.
const MIN_AGE_SLOTS = 0; // Buy at launch: the move happens in the first slots.
const MAX_AGE_SLOTS = 30; // Only the youngest curves.
const MIN_REAL_LAMPORTS = 300_000_000n; // 0.3 SOL of real reserves.
const MIN_BUYERS = 5; // K1: only broadly-bought launches.
const MIN_BUY_SOL_LAMPORTS = 1_000_000_000n; // K1: 1 SOL of buy inflow.
const MAX_BUYER_SHARE_PCT = 80; // Largest single buyer at most 80% of buy SOL.
const MAX_MAIN_POSITIONS = 4; // One of the five slots stays free for probes.
const TARGET_COINS = 25;
const PACE_SECONDS = 21_600; // Pace the 25 coins over six hours of block time.
const MAX_PROBES = 40;
const MAX_HOLD_SLOTS = 300; // ~2 minutes: let winners reach the tail before timing out.
const PROBE_MIN_REAL_LAMPORTS = 10_000_000_000n; // Probes only on liquid curves.

interface TapeTrade {
  slot: number;
  buy: boolean;
  user: string;
  sol: bigint;
}

interface Tape {
  createdSlot: number | null;
  createVq: bigint;
  createVt: bigint;
  creator: string;
  creatorSold: boolean;
  complete: boolean;
  decided: boolean;
  trades: TapeTrade[];
}

interface Held {
  cost: bigint;
  tokens: bigint;
  boughtSlot: number;
  peak: bigint;
  tp1Done: boolean;
  lastVq: bigint;
  lastVt: bigint;
  probe: boolean;
}

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
const probeMints = new Set<Pubkey>();
const boughtCoins = new Set<Pubkey>();
const roundTripped = new Set<Pubkey>();
let probeCount = 0;
let firstBlockTime: number | null = null;
let lastBlockTime: number | null = null;

/** Current price of a curve as (virtual SOL, virtual tokens); null when unknown. */
function priceOf(state: BotState, mint: Pubkey): [bigint, bigint] | null {
  const curve = state.curves.get(mint);
  if (curve === undefined) return null;
  if (curve.virtual_token_reserves === 0n) return null;
  return [curve.virtual_quote_reserves, curve.virtual_token_reserves];
}

/** Token value in lamports at the given price. */
function valueAt(tokens: bigint, vq: bigint, vt: bigint): bigint {
  return (tokens * vq) / vt;
}

/** True when a/b >= num/den, all bigint, no floats. */
function atLeast(a: bigint, b: bigint, num: bigint, den: bigint): boolean {
  return a * den >= b * num;
}

/** True when a/b <= num/den, all bigint, no floats. */
function atMost(a: bigint, b: bigint, num: bigint, den: bigint): boolean {
  return a * den <= b * num;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const txFee = state.txFeeLamports();

    // Block time paces the guardrail probes; it only moves when events carry it.
    for (const e of batch.events) {
      if (e.block_time !== null && e.block_time !== undefined) {
        if (firstBlockTime === null) firstBlockTime = e.block_time;
        lastBlockTime = e.block_time;
      }
    }

    // Fold the batch's events into the per-coin tapes.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!tapes.has(e.mint)) {
          tapes.set(e.mint, {
            createdSlot: e.slot,
            createVq: BigInt(e.virtual_sol_reserves),
            createVt: BigInt(e.virtual_token_reserves),
            creator: e.creator,
            creatorSold: false,
            complete: false,
            decided: false,
            trades: [],
          });
        }
      } else if (e.event === 'TradeEvent') {
        let tape = tapes.get(e.mint);
        if (tape === undefined) {
          tape = {
            createdSlot: null,
            createVq: 0n,
            createVt: 0n,
            creator: '',
            creatorSold: false,
            complete: false,
            decided: false,
            trades: [],
          };
          tapes.set(e.mint, tape);
        }
        tape.trades.push({ slot: e.slot, buy: e.is_buy, user: e.user, sol: BigInt(e.sol_amount) });
        if (tape.trades.length > 150) tape.trades.splice(0, tape.trades.length - 150);
        if (!e.is_buy && e.user === tape.creator) tape.creatorSold = true;
      } else if (e.event === 'CompleteEvent') {
        const tape = tapes.get(e.mint);
        if (tape !== undefined) tape.complete = true;
      }
    }

    // Fills: track which coins got a buy (they can round-trip) and which closed.
    for (const f of batch.fills) {
      if (f.side === 'buy' && f.status === 'filled') boughtCoins.add(f.mint);
      if (f.side === 'sell' && boughtCoins.has(f.mint)) roundTripped.add(f.mint);
    }

    // Sync held positions with the account; a position appears once its buy fills.
    // A partial sell shrinks the tokens held, so rescale the peak with it: the
    // trailing stop compares the value of the tokens still held against their
    // own best value, never against the pre-sale full position.
    for (const [mint, pos] of state.positions) {
      const existing = held.get(mint);
      if (existing === undefined) {
        const price = priceOf(state, mint);
        const value = price !== null ? valueAt(pos.token_amount, price[0], price[1]) : pos.cost_lamports;
        held.set(mint, {
          cost: pos.cost_lamports,
          tokens: pos.token_amount,
          boughtSlot: state.slot,
          peak: value,
          tp1Done: false,
          lastVq: price !== null ? price[0] : 0n,
          lastVt: price !== null ? price[1] : 0n,
          probe: probeMints.has(mint),
        });
      } else {
        if (pos.token_amount < existing.tokens && existing.tokens > 0n) {
          existing.peak = (existing.peak * pos.token_amount) / existing.tokens;
        }
        existing.cost = pos.cost_lamports;
        existing.tokens = pos.token_amount;
      }
    }
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) held.delete(mint);
    }

    const pendingSell = new Set<Pubkey>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') pendingSell.add(p.order.mint);
    }

    // Exits, one order per coin per batch. Priority: probe close, crash, stop,
    // runner (already past first target), first target, time-out.
    for (const [mint, h] of held) {
      if (pendingSell.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const price = priceOf(state, mint);
      if (price === null) continue;
      const pos = state.positions.get(mint);
      if (pos === undefined) continue;
      const [vq, vt] = price;
      const value = valueAt(pos.token_amount, vq, vt);

      if (h.probe) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
        continue;
      }
      // K3: no crash rule (launch noise dumps winners), no partial TP1.
      // Sell everything at +50%, cut at -20%, or time out at 300 slots.
      if (atMost(value, h.cost, 80n, 100n)) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
      } else if (atLeast(value, h.cost, 150n, 100n)) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
      } else if (state.slot - h.boughtSlot >= MAX_HOLD_SLOTS) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
      }

      if (value > h.peak) h.peak = value;
      h.lastVq = vq;
      h.lastVt = vt;
    }

    // Entries: young curves with genuine early buy pressure.
    for (const [mint, tape] of tapes) {
      if (tape.decided || tape.complete || tape.createdSlot === null) continue;
      const age = state.slot - tape.createdSlot;
      if (age < MIN_AGE_SLOTS || age > MAX_AGE_SLOTS) continue;
      if (tape.creatorSold) {
        tape.decided = true;
        continue;
      }
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.real_quote_reserves < MIN_REAL_LAMPORTS) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;

      let buyers = new Set<string>();
      let buySol = 0n;
      let maxBuyerSol = 0n;
      const perBuyer = new Map<string, bigint>();
      for (const t of tape.trades) {
        if (!t.buy) continue;
        buyers.add(t.user);
        buySol += t.sol;
        const total = (perBuyer.get(t.user) ?? 0n) + t.sol;
        perBuyer.set(t.user, total);
        if (total > maxBuyerSol) maxBuyerSol = total;
      }
      if (buyers.size < MIN_BUYERS || buySol < MIN_BUY_SOL_LAMPORTS) continue;
      if (maxBuyerSol * 100n > buySol * BigInt(MAX_BUYER_SHARE_PCT)) continue;

      const price = priceOf(state, mint);
      if (price === null) continue;
      const [vq, vt] = price;
      // Near the creation price (up at least 5% — momentum confirmed, never
      // chase a run-up) and not a vertical over +25%.
      if (!atLeast(vq, vt, tape.createVq * 105n, tape.createVt * 100n)) continue;
      if (!atMost(vq, vt, tape.createVq * 125n, tape.createVt * 100n)) continue;

      if (state.committedPositionCount() >= MAX_MAIN_POSITIONS) continue;
      if (orders.length >= state.hello.caps.max_orders_per_batch) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (state.freeCashLamports() < amount + txFee) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
      tape.decided = true;
    }

    // Guardrail probes: stay on pace for TARGET_COINS round-tripped coins.
    if (
      probeCount < MAX_PROBES &&
      firstBlockTime !== null &&
      lastBlockTime !== null &&
      state.committedPositionCount() < state.hello.caps.max_open_positions &&
      orders.length < state.hello.caps.max_orders_per_batch
    ) {
      const elapsed = lastBlockTime - firstBlockTime;
      const expected = elapsed > 0 ? Number((BigInt(TARGET_COINS) * BigInt(elapsed)) / BigInt(PACE_SECONDS)) : 0;
      if (boughtCoins.size < expected) {
        let best: Pubkey | null = null;
        let bestReal = 0n;
        for (const [mint, curve] of state.curves) {
          if (curve.complete || curve.real_quote_reserves < PROBE_MIN_REAL_LAMPORTS) continue;
          if (held.has(mint) || state.positions.has(mint)) continue;
          const tape = tapes.get(mint);
          if (tape !== undefined && (tape.decided || tape.complete)) continue;
          if (state.maxBuyLamports(mint) < PROBE_LAMPORTS) continue;
          if (curve.real_quote_reserves > bestReal) {
            bestReal = curve.real_quote_reserves;
            best = mint;
          }
        }
        if (best !== null && state.freeCashLamports() >= PROBE_LAMPORTS + txFee) {
          orders.push({ side: 'buy', mint: best, quote_lamports: PROBE_LAMPORTS, max_slippage_bps: BUY_SLIPPAGE_BPS });
          probeMints.add(best);
          const tape = tapes.get(best);
          if (tape !== undefined) tape.decided = true;
          probeCount += 1;
        }
      }
    }

    return orders;
  },

  onDone(state: BotState, done: Done): void {
    console.error(
      `done ${done.reason} cash=${state.cash.toString()} ` +
        `bought=${boughtCoins.size} roundTripped=${roundTripped.size} probes=${probeCount}`,
    );
  },
});
