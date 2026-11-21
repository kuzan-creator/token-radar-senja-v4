// Token Radar Senja v4 — model library.
//
// Everything here is fitted at runtime from the snapshot the caller hands in:
// no coefficient, no peer list and no threshold below is taken from any other
// entry or from a hand-kept list. The value model is an OLS fit of
// log(market cap) on log(TVL) over the priced comps, with extra terms kept
// only when they lower the held-out miss in BOTH leave-one-out and a
// walk-forward split (forward selection, term order quad, age, growth,
// chains). The odds model is a logistic fit of "records a token" (symbol
// non-null) on log TVL, no-token age, 7-day growth and log chain count.

export interface Proto {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export const AS_OF = '2026-11-14';
const AS_OF_MS = Date.parse(AS_OF + 'T00:00:00Z');
const DAY_MS = 86400000;

/** Years between a protocol's listed_at and the snapshot date; null when unknown. */
export function ageYears(p: Proto): number | null {
  if (!p.listed_at) return null;
  return (AS_OF_MS - Date.parse(p.listed_at + 'T00:00:00Z')) / DAY_MS / 365.25;
}

/** Median of a non-empty number array (averages the two middles when even). */
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

export function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function sdPop(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length) || 1;
}

/** 7-day growth as a fraction, nulls read as flat, clamped to +/-50%. */
export function growthFrac(p: Proto): number {
  if (p.change_7d === null || p.change_7d === undefined) return 0;
  return Math.max(-0.5, Math.min(0.5, p.change_7d / 100));
}

export function logChains(p: Proto): number {
  return Math.log(Math.max(1, p.chains.length));
}

// ------------------------------------------------------------ linear algebra

/** Solve A x = b by Gauss elimination with partial pivoting. */
export function solveLinear(aIn: number[][], bIn: number[]): number[] {
  const n = aIn.length;
  const m = aIn.map((row, i) => [...row, bIn[i]!]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[piv]![c]!)) piv = r;
    if (Math.abs(m[piv]![c]!) < 1e-12) throw new Error('singular matrix');
    const tmp = m[c]!;
    m[c] = m[piv]!;
    m[piv] = tmp;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r]![c]! / m[c]![c]!;
      for (let k = c; k <= n; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

export interface OlsResult {
  beta: number[];
  r2: number;
  pred: number[];
}

/** Ordinary least squares of y on the rows of x. */
export function ols(x: number[][], y: number[]): OlsResult {
  const n = x.length;
  const k = x[0]!.length;
  const xtx: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const xty: number[] = new Array<number>(k).fill(0);
  for (let t = 0; t < n; t++) {
    for (let i = 0; i < k; i++) {
      xty[i]! += x[t]![i]! * y[t]!;
      for (let j = 0; j < k; j++) xtx[i]![j]! += x[t]![i]! * x[t]![j]!;
    }
  }
  const beta = solveLinear(xtx, xty);
  const pred = x.map((row) => row.reduce((s, v, i) => s + v * beta[i]!, 0));
  const ybar = mean(y);
  const ssRes = y.reduce((s, v, i) => s + (v - pred[i]!) ** 2, 0);
  const ssTot = y.reduce((s, v) => s + (v - ybar) ** 2, 0);
  return { beta, r2: 1 - ssRes / ssTot, pred };
}

function medAbsErr(y: number[], pred: number[]): number {
  return median(y.map((v, i) => Math.abs(v - pred[i]!)));
}

// ------------------------------------------------------------ value model

export type ValueTerm = 'quad' | 'age' | 'growth' | 'chains';

/** Feature row for a protocol under a term set. medianAge fills null ages. */
export function valueFeatures(p: Proto, terms: ValueTerm[], medianAge: number): number[] {
  const lt = Math.log(p.tvl_usd);
  const row: number[] = [1, lt];
  if (terms.includes('quad')) {
    const c = lt - 20;
    row.push(c * c);
  }
  if (terms.includes('age')) {
    const a = ageYears(p);
    row.push(Math.min(a === null ? medianAge : a, 6));
  }
  if (terms.includes('growth')) row.push(growthFrac(p));
  if (terms.includes('chains')) row.push(logChains(p));
  return row;
}

export interface ValueEval {
  spec: string;
  terms: ValueTerm[];
  beta: number[];
  r2: number;
  loo: number;
  wf: number;
  kept: boolean;
  why: string;
}

/** Leave-one-out median absolute log error of a term set on the peers. */
export function looMiss(peers: Proto[], terms: ValueTerm[], medianAge: number): number {
  const y = peers.map((p) => Math.log(p.mcap_usd!));
  const errs: number[] = [];
  for (let i = 0; i < peers.length; i++) {
    const xi = peers.filter((_, t) => t !== i).map((p) => valueFeatures(p, terms, medianAge));
    const yi = y.filter((_, t) => t !== i);
    const fit = ols(xi, yi);
    const pr = valueFeatures(peers[i]!, terms, medianAge).reduce((s, v, j) => s + v * fit.beta[j]!, 0);
    errs.push(Math.abs(y[i]! - pr));
  }
  return median(errs);
}

/** Walk-forward median absolute log error: train before the cut, test on/after it. */
export function wfMiss(peers: Proto[], terms: ValueTerm[], medianAge: number, cut: string): number {
  const dated = peers.filter((p) => p.listed_at);
  const tr = dated.filter((p) => p.listed_at! < cut);
  const te = dated.filter((p) => p.listed_at! >= cut);
  const fit = ols(
    tr.map((p) => valueFeatures(p, terms, medianAge)),
    tr.map((p) => Math.log(p.mcap_usd!)),
  );
  const pred = te.map((p) => valueFeatures(p, terms, medianAge).reduce((s, v, j) => s + v * fit.beta[j]!, 0));
  return medAbsErr(
    te.map((p) => Math.log(p.mcap_usd!)),
    pred,
  );
}

/**
 * Forward selection with the two-test gate: start from log TVL alone, try
 * each term in order, keep it only when it lowers BOTH the LOO miss and the
 * walk-forward miss. Every named spec is also evaluated for the evidence table.
 */
export function selectValueModel(peers: Proto[], medianAge: number, cut: string): ValueEval[] {
  const y = peers.map((p) => Math.log(p.mcap_usd!));
  const x0 = peers.map((p) => valueFeatures(p, [], medianAge));
  const base = ols(x0, y);
  const named: { name: string; terms: ValueTerm[] }[] = [
    { name: 'const + log TVL', terms: [] },
    { name: 'const + log TVL + quad', terms: ['quad'] },
    { name: 'const + log TVL + quad + age', terms: ['quad', 'age'] },
    { name: 'const + log TVL + quad + age + growth', terms: ['quad', 'age', 'growth'] },
    { name: 'const + log TVL + quad + age + chains', terms: ['quad', 'age', 'chains'] },
    { name: 'const + log TVL + age', terms: ['age'] },
    { name: 'const + log TVL + growth', terms: ['growth'] },
  ];
  const rows: ValueEval[] = named.map(({ name, terms }) => {
    const fit = ols(
      peers.map((p) => valueFeatures(p, terms, medianAge)),
      y,
    );
    return {
      spec: name,
      terms,
      beta: fit.beta,
      r2: fit.r2,
      loo: looMiss(peers, terms, medianAge),
      wf: wfMiss(peers, terms, medianAge, cut),
      kept: false,
      why: '',
    };
  });
  // Greedy gate walk: quad, then age, then growth, then chains. Only the
  // final survivor is marked kept; the baseline is the starting point.
  let cur = rows[0]!;
  cur.why = 'Baseline: log TVL alone.';
  const ladder = [rows[1]!, rows[2]!, rows[3]!, rows[4]!];
  for (const next of ladder) {
    if (next.loo < cur.loo && next.wf < cur.wf) {
      cur = next;
    } else {
      next.why =
        next.loo >= cur.loo && next.wf >= cur.wf
          ? 'Tested, not kept: does not win both tests.'
          : next.loo >= cur.loo
            ? 'Tested, not kept: loses leave-one-out.'
            : 'Tested, not kept: loses walk-forward.';
    }
  }
  cur.kept = true;
  cur.why = 'Kept (frozen): wins both tests over every earlier step.';
  for (const r of [rows[5]!, rows[6]!]) {
    r.why =
      r.loo < rows[0]!.loo && r.wf < rows[0]!.wf
        ? 'Tested: beats the baseline on both tests, but loses to the kept model on both.'
        : 'Tested, not kept: does not beat the baseline on both tests.';
  }
  return rows;
}

/** Fitted market cap for a protocol under a fitted term set. */
export function fittedMcap(p: Proto, terms: ValueTerm[], beta: number[], medianAge: number): number {
  const row = valueFeatures(p, terms, medianAge);
  return Math.exp(row.reduce((s, v, i) => s + v * beta[i]!, 0));
}

// ------------------------------------------------------------ odds model

export function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, z))));
}

/** Raw odds features: log TVL, age, growth, log chains. */
export function oddsRaw(p: Proto, medianAge: number): number[] {
  const a = ageYears(p);
  return [Math.log(p.tvl_usd), Math.min(a === null ? medianAge : a, 6), growthFrac(p), logChains(p)];
}

/**
 * Logistic fit by gradient descent on standardised features (population sd),
 * fixed iterations and step so the run is byte-identical. Returns the raw
 * (unstandardised) coefficients, intercept first.
 */
export function logitFit(raw: number[][], y: number[], iters = 3000, lr = 0.3, l2 = 0.5): number[] {
  const k = raw[0]!.length;
  const mu = raw[0]!.map((_, j) => mean(raw.map((r) => r[j]!)));
  const sd = raw[0]!.map((_, j) => sdPop(raw.map((r) => r[j]!)));
  const x = raw.map((r) => [1, ...r.map((v, j) => (v - mu[j]!) / sd[j]!)]);
  const n = x.length;
  let beta = new Array<number>(k + 1).fill(0);
  for (let it = 0; it < iters; it++) {
    const g = new Array<number>(k + 1).fill(0);
    for (let t = 0; t < n; t++) {
      const z = x[t]!.reduce((s, v, j) => s + v * beta[j]!, 0);
      const r = y[t]! - sigmoid(z);
      for (let j = 0; j <= k; j++) g[j]! += r * x[t]![j]!;
    }
    for (let j = 0; j <= k; j++) {
      const reg = j === 0 ? 0 : l2 * beta[j]!;
      beta[j]! += lr * (g[j]! / n - reg / n);
    }
  }
  const rawBeta = [beta[0]! - beta.slice(1).reduce((s, b, j) => s + (b * mu[j]!) / sd[j]!, 0)];
  for (let j = 0; j < k; j++) rawBeta.push(beta[j + 1]! / sd[j]!);
  return rawBeta;
}

export function logitPredict(p: Proto, beta: number[], medianAge: number): number {
  const r = oddsRaw(p, medianAge);
  return sigmoid(beta[0]! + r.reduce((s, v, j) => s + v * beta[j + 1]!, 0));
}

export function brierScore(y: number[], pr: number[]): number {
  return y.reduce((s, v, i) => s + (v - pr[i]!) ** 2, 0) / y.length;
}

/** Calibration quintiles: [mean predicted, mean actual] per fifth, by predicted odds. */
export function calibrationQuintiles(y: number[], pr: number[]): [number, number][] {
  const order = pr.map((_, i) => i).sort((a, b) => pr[a]! - pr[b]!);
  const out: [number, number][] = [];
  for (let q = 0; q < 5; q++) {
    const grp = order.slice(Math.floor((q * order.length) / 5), Math.floor(((q + 1) * order.length) / 5));
    out.push([mean(grp.map((i) => pr[i]!)), mean(grp.map((i) => y[i]!))]);
  }
  return out;
}

// ------------------------------------------------------------ determinism

/** mulberry32: a small seeded PRNG so bootstrap refits are byte-identical. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit hex of a UTF-8 string (the self-test checksum). */
export function fnv1aHex(text: string): string {
  let h = 0x811c9dc5;
  const bytes = Buffer.from(text, 'utf8');
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Compact dollars: 251.7M, 12.4K, 1.06B. */
export function fmtUsd(v: number): string {
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(v >= 10e9 ? 1 : 2) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(v >= 100e6 ? 0 : 1) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(v).toString();
}

/** Compact multiple: x2.63. */
export function fmtMult(v: number): string {
  return 'x' + v.toFixed(2);
}
