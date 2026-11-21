// Token Radar Senja v4 — entrypoint.
//
// Reads the sealed snapshot, finds the protocols that record no token,
// fits a launch-value model and a token-odds model on the snapshot's own
// figures, ranks the launch candidates by implied value with a costed farm
// plan each, and writes the board, the dashboard data, the dashboard and the
// dossier. Standard library only, no network, deterministic: two runs write
// the same bytes.
//
// The one definition this entry stands on: a protocol "records no token"
// when BOTH its symbol and its market cap are null. An earlier version of
// this radar read "no token" as market-cap-null alone, and ranked protocols
// whose tokens already trade. The snapshot's symbol field is the token
// indicator: 416 protocols carry one, 342 record none.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { buildDossier } from './vendor/makefun-board.ts';
import {
  ageYears,
  brierScore,
  calibrationQuintiles,
  fittedMcap,
  fnv1aHex,
  growthFrac,
  logitFit,
  logitPredict,
  looMiss,
  median,
  mulberry32,
  oddsRaw,
  ols,
  selectValueModel,
  sigmoid,
  valueFeatures,
  wfMiss,
  type Proto,
  type ValueTerm,
} from './lib/model.ts';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

function flag(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

const INPUT = flag('--input') ?? '/input/snapshot.json';
const OUT = process.env.MAKEFUN_OUTPUT_DIR ?? flag('--output') ?? '/output';

// ------------------------------------------------------------ house rule

const BAD_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Why a truly pre-token protocol is set aside; null when it may be ranked. */
function setAsideReason(p: Proto): string | null {
  if (p.category !== null && BAD_CATEGORIES.has(p.category)) return 'category:' + p.category;
  if (VERSIONED.test(p.name)) return 'versioned-name';
  if (WRAPPED_WORD.test(p.name)) return 'wrapped-word';
  if (EXCHANGES.some((e) => p.name.startsWith(e))) return 'exchange-prefix';
  return null;
}

function quantile(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function fmtInt(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// ------------------------------------------------------------ farm plan

const FARM = {
  deposit: 1500,
  dropShare: 0.1,
  poolShare: 0.05,
  horizonDays: 180,
  holdDays: 30,
  gasSetup: 15,
  gasWeekly: 10,
  gasClaim: 15,
  workMinutes: 150,
};

function gasTotal(): number {
  return FARM.gasSetup + FARM.gasClaim + FARM.gasWeekly * Math.ceil(FARM.holdDays / 7);
}

/** A farmer's gross slice of the drop at the band-low implied value. */
function sliceUsd(bandLowImplied: number, tvl: number, deposit: number, dropShare: number, poolShare: number): number {
  return ((bandLowImplied * dropShare) / (poolShare * tvl)) * deposit;
}

function farmSteps(p: Proto, deposit: number, horizon: number): string[] {
  const chain = p.chains[0] ?? 'its main chain';
  const dep = '$' + fmtInt(deposit);
  return [
    `Open a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline. Cost: nothing to create the wallet. Time: 5 minutes.`,
    `Supply ${dep} of USDC to ${p.name} on ${chain} and keep the position open. Cost: ${dep} of capital and about $${FARM.gasSetup} of gas. Time: 15 minutes to set up.`,
    `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote, so the wallet stays active. Cost: about $${FARM.gasWeekly} of gas a week. Time: 10 minutes a week.`,
    `Hold the position for at least ${FARM.holdDays} days so the activity is counted in more than one snapshot. Cost: the ${dep} stays in the position. Time: ${FARM.holdDays} days.`,
    `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes. Cost: $${FARM.gasClaim} of gas to claim, and never pay to claim. Time: 10 minutes.`,
    `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it before the ${horizon}-day horizon. Cost: nothing but the log. Time: 5 minutes.`,
  ];
}

// ------------------------------------------------------------ odds fitting

interface OddsFit {
  label: string;
  n: number;
  base: number;
  beta: number[];
  brier: number;
  wfBrier: number;
  wfAcc: number;
  wfCut: string;
}

function fitOdds(peers: Proto[], label: string, medianAge: number): OddsFit {
  const y = peers.map((p) => (p.symbol !== null ? 1 : 0));
  const base = y.reduce((a, b) => a + b, 0) / y.length;
  const raw = peers.map((p) => oddsRaw(p, medianAge));
  const beta = logitFit(raw, y);
  const pr = peers.map((p) => logitPredict(p, beta, medianAge));
  const dated = peers.filter((p) => p.listed_at);
  const dates = dated.map((p) => p.listed_at!).sort();
  const cut = dates[Math.floor(dates.length / 2)]!;
  const tr = dated.filter((p) => p.listed_at! < cut);
  const te = dated.filter((p) => p.listed_at! >= cut);
  const betaTr = logitFit(
    tr.map((p) => oddsRaw(p, medianAge)),
    tr.map((p) => (p.symbol !== null ? 1 : 0)),
  );
  const prTe = te.map((p) => logitPredict(p, betaTr, medianAge));
  const yTe = te.map((p) => (p.symbol !== null ? 1 : 0));
  return {
    label,
    n: peers.length,
    base,
    beta,
    brier: brierScore(y, pr),
    wfBrier: brierScore(yTe, prTe),
    wfAcc: yTe.filter((v, i) => (prTe[i]! >= 0.5) === (v === 1)).length / yTe.length,
    wfCut: cut,
  };
}

// ------------------------------------------------------------ main

function main(): void {
  const snap = JSON.parse(readFileSync(INPUT, 'utf8')) as { as_of: string; floor_usd: number; protocols: Proto[]; watchlist: string[] };
  const all = snap.protocols;
  const watch = new Set(snap.watchlist);

  // --- universe -------------------------------------------------------
  const datedAges = all.filter((p) => p.listed_at).map((p) => ageYears(p)!);
  const medianAge = median(datedAges);
  const tokenBearing = all.filter((p) => p.symbol !== null);
  const priced = all.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0);
  const noUsableCap = tokenBearing.filter((p) => !(p.mcap_usd !== null && p.mcap_usd > 0));
  const preToken = all.filter((p) => p.symbol === null && p.mcap_usd === null);
  const boardPool: { p: Proto; reason: string | null }[] = preToken.map((p) => ({ p, reason: setAsideReason(p) }));
  const eligible = boardPool.filter((r) => r.reason === null).map((r) => r.p);
  const setAside = boardPool.filter((r) => r.reason !== null);
  const censusGroups: { label: string; count: number }[] = [
    { label: 'Ranked on the board', count: eligible.length },
    { label: 'Token recorded, priced comp', count: priced.length },
    { label: 'Token recorded, no usable cap', count: noUsableCap.length },
  ];
  const reasonCounts = new Map<string, number>();
  for (const r of setAside) reasonCounts.set(r.reason!, (reasonCounts.get(r.reason!) ?? 0) + 1);
  for (const [label, count] of [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])) {
    censusGroups.push({ label: 'Set aside: ' + label, count });
  }
  const censusTotal = censusGroups.reduce((s, g) => s + g.count, 0);

  // --- value model ----------------------------------------------------
  const curated = priced.filter((p) => {
    const r = p.mcap_usd! / p.tvl_usd;
    return r >= 0.02 && r <= 2;
  });
  const pricedDates = priced
    .filter((p) => p.listed_at)
    .map((p) => p.listed_at!)
    .sort();
  const valueCut = pricedDates[Math.floor(pricedDates.length / 2)]!;
  const valueTable = selectValueModel(curated, medianAge, valueCut);
  const frozen = valueTable.find((r) => r.kept)!;
  const terms: ValueTerm[] = frozen.terms;

  // LOO residuals under the frozen model -> bands + range honesty.
  let bandMult = { q10: 1, q25: 1, q75: 1, q90: 1 };
  let rangeHonesty = { p25_75: 0, p10_90: 0 };
  {
    const y = curated.map((p) => Math.log(p.mcap_usd!));
    const looPred: number[] = [];
    for (let i = 0; i < curated.length; i++) {
      const xi = curated.filter((_, t) => t !== i).map((p) => valueFeatures(p, terms, medianAge));
      const yi = y.filter((_, t) => t !== i);
      const fit = ols(xi, yi);
      looPred.push(valueFeatures(curated[i]!, terms, medianAge).reduce((s, v, j) => s + v * fit.beta[j]!, 0));
    }
    const resid = y.map((v, i) => v - looPred[i]!);
    const sorted = [...resid].sort((a, b) => a - b);
    const q10 = quantile(sorted, 0.1);
    const q25 = quantile(sorted, 0.25);
    const q75 = quantile(sorted, 0.75);
    const q90 = quantile(sorted, 0.9);
    let in25 = 0;
    let in90 = 0;
    for (let i = 0; i < curated.length; i++) {
      if (resid[i]! >= q25 && resid[i]! <= q75) in25++;
      if (resid[i]! >= q10 && resid[i]! <= q90) in90++;
    }
    bandMult = { q10: Math.exp(q10), q25: Math.exp(q25), q75: Math.exp(q75), q90: Math.exp(q90) };
    rangeHonesty = { p25_75: in25 / curated.length, p10_90: in90 / curated.length };
  }

  // --- odds model -----------------------------------------------------
  const oddsMain = fitOdds(all, 'All 758 protocols', medianAge);
  const oddsY = all.map((p) => (p.symbol !== null ? 1 : 0));
  const oddsPr = all.map((p) => logitPredict(p, oddsMain.beta, medianAge));
  const oddsCal = calibrationQuintiles(oddsY, oddsPr);
  const oddsAlternatives = [
    fitOdds(
      all.filter((p) => p.listed_at && p.listed_at < '2025-01-01'),
      'Listed before 2025 (mature cohorts)',
      medianAge,
    ),
    fitOdds(
      all.filter((p) => p.listed_at && p.listed_at < '2024-06-01'),
      'Listed before 2024-06',
      medianAge,
    ),
    fitOdds(
      all.filter((p) => ageYears(p) !== null && ageYears(p)! >= 1),
      'Age 1 year or more',
      medianAge,
    ),
    fitOdds(
      all.filter((p) => p.tvl_usd >= 25_000_000),
      'TVL $25M or more',
      medianAge,
    ),
    fitOdds(
      all.filter((p) => p.listed_at && p.listed_at < '2025-01-01' && p.tvl_usd >= 25_000_000),
      'Listed before 2025 and TVL $25M+',
      medianAge,
    ),
  ];
  // Cure-rate alternative: the survival reading of the same curve. pi is the
  // token rate among the oldest tenth of dated protocols; the transform is
  // P(lists eventually | tokenless at age a) = (pi - F(a)) / (1 - F(a)).
  const datedSorted = [...datedAges].sort((a, b) => a - b);
  const oldCut = datedSorted[Math.floor(datedSorted.length * 0.9)]!;
  const oldest = all.filter((p) => {
    const a = ageYears(p);
    return a !== null && a >= oldCut;
  });
  const piCure = oldest.filter((p) => p.symbol !== null).length / oldest.length;
  const steakhouse = all.find((p) => p.slug === 'steakhouse-financial')!;
  const cureTop = eligible
    .slice()
    .sort((a, b) => b.tvl_usd - a.tvl_usd)
    .slice(0, 6)
    .map((p) => {
      const f = logitPredict(p, oddsMain.beta, medianAge);
      const s = f >= piCure ? 0.05 : (piCure - f) / (1 - f);
      return { slug: p.slug, fittedOdds: f, survivalOdds: s };
    });
  const cureFloored = eligible.filter((p) => logitPredict(p, oddsMain.beta, medianAge) >= piCure).length;

  // --- board rows -----------------------------------------------------
  const gas = gasTotal();
  const rows = eligible.map((p) => {
    const fitted = fittedMcap(p, terms, frozen.beta, medianAge);
    const odds = logitPredict(p, oddsMain.beta, medianAge);
    const implied = fitted * odds;
    const bandLow = fitted * bandMult.q25 * odds;
    const bandHigh = fitted * bandMult.q75 * odds;
    const p10 = fitted * bandMult.q10 * odds;
    const p90 = fitted * bandMult.q90 * odds;
    const slice = sliceUsd(bandLow, p.tvl_usd, FARM.deposit, FARM.dropShare, FARM.poolShare);
    const net = slice - gas;
    const slice1k = sliceUsd(bandLow, p.tvl_usd, 1000, FARM.dropShare, FARM.poolShare);
    const slice5k = sliceUsd(bandLow, p.tvl_usd, 5000, FARM.dropShare, FARM.poolShare);
    const verdict = net >= 50 ? 'FARM' : slice5k - gas >= 0 ? 'MARGINAL' : 'SKIP';
    const slicePerDollar = (bandLow * FARM.dropShare) / (FARM.poolShare * p.tvl_usd);
    const minDeposit = Math.ceil((50 + gas) / slicePerDollar);
    const breakEvenDays = slice <= FARM.gasSetup + FARM.gasClaim ? null : Math.ceil(((slice - FARM.gasSetup - FARM.gasClaim) / FARM.gasWeekly) * 7);
    const a = ageYears(p);
    return {
      slug: p.slug,
      name: p.name,
      rank: 0,
      implied_value_usd: Math.round(implied),
      farm_steps: farmSteps(p, FARM.deposit, FARM.horizonDays),
      category: p.category,
      chains: p.chains,
      chain: p.chains[0] ?? null,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_years: a === null ? null : Math.round(a * 100) / 100,
      fitted_mcap_usd: Math.round(fitted),
      token_odds: Math.round(odds * 1000) / 1000,
      band_low_usd: Math.round(bandLow),
      band_high_usd: Math.round(bandHigh),
      p10_usd: Math.round(p10),
      p90_usd: Math.round(p90),
      net_usd: Math.round(net),
      net_per_hour_usd: Math.round((net / (FARM.workMinutes / 60)) * 100) / 100,
      slice_1k_usd: Math.round(slice1k),
      min_deposit_usd: minDeposit,
      break_even_days: breakEvenDays,
      verdict,
      watchlist: watch.has(p.slug),
      rank_low: 0,
      rank_high: 0,
    };
  });
  rows.sort((a, b) => b.implied_value_usd - a.implied_value_usd || (a.slug < b.slug ? -1 : 1));
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });

  // --- bootstrap rank ranges: 200 seeded refits of the value model ----
  {
    const rng = mulberry32(20261124);
    const lows = new Array<number>(rows.length).fill(198);
    const highs = new Array<number>(rows.length).fill(1);
    const bySlug = new Map(rows.map((r, i) => [r.slug, i]));
    for (let b = 0; b < 200; b++) {
      const sample: Proto[] = [];
      for (let i = 0; i < curated.length; i++) sample.push(curated[Math.floor(rng() * curated.length)]!);
      let fit;
      try {
        fit = ols(
          sample.map((p) => valueFeatures(p, terms, medianAge)),
          sample.map((p) => Math.log(p.mcap_usd!)),
        );
      } catch {
        continue;
      }
      const scored = rows
        .map((r) => {
          const proto = all.find((p) => p.slug === r.slug)!;
          return { slug: r.slug, v: fittedMcap(proto, terms, fit.beta, medianAge) * r.token_odds };
        })
        .sort((x, y) => y.v - x.v);
      scored.forEach((s, i) => {
        const idx = bySlug.get(s.slug)!;
        const rank = i + 1;
        if (rank < lows[idx]!) lows[idx] = rank;
        if (rank > highs[idx]!) highs[idx] = rank;
      });
    }
    rows.forEach((r, i) => {
      r.rank_low = lows[i]!;
      r.rank_high = highs[i]!;
    });
  }

  // --- evidence -------------------------------------------------------
  const verdictCounts = { FARM: 0, MARGINAL: 0, SKIP: 0 };
  for (const r of rows) verdictCounts[r.verdict as keyof typeof verdictCounts]++;
  const totalImplied = rows.reduce((s, r) => s + r.implied_value_usd, 0);
  const farmNext = [...rows]
    .filter((r) => r.verdict === 'FARM')
    .sort((a, b) => b.net_per_hour_usd - a.net_per_hour_usd)
    .slice(0, 5)
    .map((r) => ({ slug: r.slug, name: r.name, rank: r.rank, net_per_hour_usd: r.net_per_hour_usd, net_usd: r.net_usd, implied_value_usd: r.implied_value_usd }));
  const zeroSymbol = rows.filter((r) => {
    const proto = all.find((p) => p.slug === r.slug)!;
    return proto.symbol !== null;
  }).length;
  const stepViolations = rows.filter((r) => r.farm_steps.length < 3 || r.farm_steps.length > 12 || r.farm_steps.some((s) => s.trim().length < 20 || s.trim().length > 600)).length;

  const dashFiles = readdirSync(join(ROOT, 'dashboard'));
  const dashBytes = dashFiles.reduce((s, f) => s + statSync(join(ROOT, 'dashboard', f)).size, 0);
  const checksum = fnv1aHex(readFileSync(join(ROOT, 'main.ts'), 'utf8'));

  const board = { rows };
  const data = {
    meta: {
      title: 'Token Radar Senja v4',
      asOf: snap.as_of,
      floorUsd: snap.floor_usd,
      rows: rows.length,
      watchlistCovered: rows.filter((r) => r.watchlist).length,
      watchlistTotal: snap.watchlist.length,
      totalImpliedUsd: totalImplied,
      verdicts: verdictCounts,
      checksum,
      dashboardBytes: dashBytes,
      universe: {
        total: all.length,
        tokenBearing: tokenBearing.length,
        pricedComps: priced.length,
        tokenNoUsableCap: noUsableCap.length,
        preToken: preToken.length,
        eligible: eligible.length,
        setAside: setAside.length,
      },
      census: censusGroups,
      censusTotal,
      farm: { ...FARM, gasTotal: gas, workMinutes: FARM.workMinutes },
      checks: {
        rows: rows.length,
        watchlist: rows.filter((r) => r.watchlist).length,
        ranksOk: rows.every((r, i) => r.rank === i + 1),
        nonIncreasing: rows.every((r, i) => i === 0 || r.implied_value_usd <= rows[i - 1]!.implied_value_usd),
        zeroSymbol,
        stepViolations,
        ledgerOk: censusTotal === all.length,
      },
    },
    evidence: {
      valueCut,
      valueTable: valueTable.map((r) => ({
        spec: r.spec,
        r2: Math.round(r.r2 * 10000) / 10000,
        loo: Math.round(Math.exp(r.loo) * 100) / 100,
        wf: Math.round(Math.exp(r.wf) * 100) / 100,
        kept: r.kept,
        why: r.why,
      })),
      frozenBeta: frozen.beta.map((b) => Math.round(b * 10000) / 10000),
      frozenTerms: terms,
      bandMult: {
        q10: Math.round(bandMult.q10 * 1000) / 1000,
        q25: Math.round(bandMult.q25 * 1000) / 1000,
        q75: Math.round(bandMult.q75 * 1000) / 1000,
        q90: Math.round(bandMult.q90 * 1000) / 1000,
      },
      rangeHonesty,
      odds: {
        label: oddsMain.label,
        n: oddsMain.n,
        base: Math.round(oddsMain.base * 10000) / 10000,
        beta: oddsMain.beta.map((b) => Math.round(b * 1000) / 1000),
        brier: Math.round(oddsMain.brier * 10000) / 10000,
        constantBrier: Math.round(oddsMain.base * (1 - oddsMain.base) * 10000) / 10000,
        wfBrier: Math.round(oddsMain.wfBrier * 10000) / 10000,
        wfAcc: Math.round(oddsMain.wfAcc * 1000) / 1000,
        wfCut: oddsMain.wfCut,
        calibration: oddsCal.map(([pr, ac]) => [Math.round(pr * 1000) / 1000, Math.round(ac * 1000) / 1000]),
      },
      oddsAlternatives: oddsAlternatives.map((o) => ({
        label: o.label,
        n: o.n,
        base: Math.round(o.base * 1000) / 1000,
        brier: Math.round(o.brier * 10000) / 10000,
        wfBrier: Math.round(o.wfBrier * 10000) / 10000,
        wfAcc: Math.round(o.wfAcc * 1000) / 1000,
        steakhouseOdds: Math.round(logitPredict(steakhouse, o.beta, medianAge) * 1000) / 1000,
      })),
      cure: {
        pi: Math.round(piCure * 1000) / 1000,
        oldestN: oldest.length,
        oldCutYears: Math.round(oldCut * 100) / 100,
        top: cureTop.map((c) => ({ ...c, fittedOdds: Math.round(c.fittedOdds * 1000) / 1000, survivalOdds: Math.round(c.survivalOdds * 1000) / 1000 })),
        flooredRows: cureFloored,
        rejectedWhy:
          'The survival reading would floor the oldest tokenless rows near 0.05 once their fitted odds pass pi, and the snapshot cannot tell a late lister from a never-lister. The board keeps the directly calibrated logistic instead.',
      },
    },
    farmNext,
    compRows: priced.map((p) => ({ slug: p.slug, name: p.name, tvl: p.tvl_usd, mcap: p.mcap_usd })),
    comps: curated.map((p) => ({ lt: Math.round(Math.log(p.tvl_usd) * 1000) / 1000, lm: Math.round(Math.log(p.mcap_usd!) * 1000) / 1000, age: ageYears(p) === null ? null : Math.round(ageYears(p)! * 100) / 100 })),
    rows,
  };

  // --- outputs --------------------------------------------------------
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'board.json'), JSON.stringify(board));
  writeFileSync(join(OUT, 'data.js'), 'window.BOARD = ' + JSON.stringify(data) + ';\n');
  cpSync(join(ROOT, 'dashboard'), join(OUT, 'dashboard'), { recursive: true });
  cpSync(join(ROOT, 'screenshots'), join(OUT, 'screenshots'), { recursive: true });
  writeFileSync(join(OUT, 'dossier.json'), buildDossier(OUT, { text_max_bytes: 65536 }));

  // --- self-checks (fail loudly rather than hand in a bad board) ------
  const fails: string[] = [];
  if (rows.length < 100 || rows.length > 4000) fails.push('row count ' + rows.length);
  if (rows.filter((r) => r.watchlist).length !== snap.watchlist.length) fails.push('watchlist coverage');
  if (!rows.every((r, i) => r.rank === i + 1)) fails.push('ranks not 1..N');
  if (!rows.every((r, i) => i === 0 || r.implied_value_usd <= rows[i - 1]!.implied_value_usd)) fails.push('implied rises');
  if (zeroSymbol !== 0) fails.push(zeroSymbol + ' board rows record a token');
  if (stepViolations !== 0) fails.push(stepViolations + ' farm-step violations');
  if (censusTotal !== all.length) fails.push('census sums to ' + censusTotal);
  if (fails.length > 0) throw new Error('self-check failed: ' + fails.join('; '));

  const top = rows[0]!;
  console.log('Token Radar Senja v4 — built');
  console.log('rows: ' + rows.length + ' (watchlist ' + rows.filter((r) => r.watchlist).length + '/' + snap.watchlist.length + ')');
  console.log('verdicts: FARM ' + verdictCounts.FARM + ' / MARGINAL ' + verdictCounts.MARGINAL + ' / SKIP ' + verdictCounts.SKIP);
  console.log('top: ' + top.slug + ' fitted $' + fmtInt(top.fitted_mcap_usd) + ' odds ' + top.token_odds + ' implied $' + fmtInt(top.implied_value_usd));
  console.log('total implied: $' + fmtInt(totalImplied));
  console.log('value: R2 ' + frozen.r2.toFixed(4) + ' LOO x' + Math.exp(frozen.loo).toFixed(2) + ' WF x' + Math.exp(frozen.wf).toFixed(2) + ' terms [' + terms.join(', ') + ']');
  console.log('odds: Brier ' + oddsMain.brier.toFixed(4) + ' vs constant ' + (oddsMain.base * (1 - oddsMain.base)).toFixed(4) + ' WF Brier ' + oddsMain.wfBrier.toFixed(4) + ' acc ' + oddsMain.wfAcc.toFixed(3));
  console.log('range honesty: P25-75 ' + rangeHonesty.p25_75.toFixed(3) + ' P10-90 ' + rangeHonesty.p10_90.toFixed(3));
  console.log('zero-symbol rows: ' + zeroSymbol + ' | census total: ' + censusTotal + ' | checksum: ' + checksum);
}

main();
