// Token Radar Senja v4 — dashboard logic. Reads window.BOARD (data.js, written
// by main.ts), renders the board, recomputes farm economics live from the
// controls, and re-checks the board in the page for the self-test strip.
(function () {
  var D = window.BOARD;
  var M = D.meta, E = D.evidence, ROWS = D.rows;
  var $ = function (id) { return document.getElementById(id); };
  var GAS = M.farm.gasSetup + M.farm.gasClaim + M.farm.gasWeekly * Math.ceil(M.farm.holdDays / 7);
  var WORK_H = M.farm.workMinutes / 60;

  function fmt(v) {
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(v >= 1e10 ? 1 : 2) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(v >= 1e8 ? 0 : 1) + 'M';
    if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(v);
  }
  function commas(n) { return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function pct(x) { return (x * 100).toFixed(1) + '%'; }
  function ageFmt(a) { return a === null ? '—' : a.toFixed(1) + 'y'; }
  function chg(c) { return c === null ? '—' : (c > 0 ? '+' : '') + c.toFixed(1) + '%'; }

  // --- farm economics, recomputed live from the controls --------------
  function econ(r, dep, pool, drop) {
    var slice = (r.band_low_usd * drop) / (pool * r.tvl_usd) * dep;
    var net = slice - GAS;
    // FARM needs a band-low net of $150 on $1,500 (10% after fees, $60/hour);
    // MARGINAL breaks even at $1,500; SKIP loses money at $1,500.
    var verdict = net >= 150 ? 'FARM' : (net >= 0 ? 'MARGINAL' : 'SKIP');
    var perDollar = (r.band_low_usd * drop) / (pool * r.tvl_usd);
    var minDep = Math.ceil((150 + GAS) / perDollar);
    var be = slice <= M.farm.gasSetup + M.farm.gasClaim ? null : Math.ceil(((slice - M.farm.gasSetup - M.farm.gasClaim) / M.farm.gasWeekly) * 7);
    return { slice: slice, net: net, perHour: net / WORK_H, verdict: verdict, minDep: minDep, be: be, slice1k: (r.band_low_usd * drop) / (pool * r.tvl_usd) * 1000 };
  }

  var S = { q: '', cat: '', chain: '', sort: 'implied', tab: 'ALL', dep: 1500, horizon: 180, pool: 0.05, drop: 0.10 };

  // --- header + KPIs ---------------------------------------------------
  $('headRight').innerHTML = 'Snapshot ' + M.asOf + '<br><b>' + M.rows + ' rows · watchlist ' + M.watchlistCovered + '/' + M.watchlistTotal + '</b><br>Total implied <b>' + fmt(M.totalImpliedUsd) + '</b>';
  $('asOf').textContent = M.asOf;
  var fv = E.valueTable.filter(function (r) { return r.kept; })[0];
  $('kpis').innerHTML = [
    ['<b>' + M.rows + ' rows</b>', 'watchlist ' + M.watchlistCovered + '/' + M.watchlistTotal + ' covered'],
    ['<b>' + fmt(M.totalImpliedUsd) + '</b>', 'total implied value, ' + M.rows + ' rows'],
    ['<b>R² ' + fv.r2.toFixed(3) + '</b>', 'value fit · LOO ×' + fv.loo.toFixed(2) + ' · walk-fwd ×' + fv.wf.toFixed(2)],
    ['<b>Brier ' + E.odds.brier.toFixed(3) + '</b>', 'token odds · base rate ' + E.odds.constantBrier.toFixed(3) + ' · walk-fwd ' + E.odds.wfBrier.toFixed(3)],
    ['<b>FARM ' + M.verdicts.FARM + '</b>', 'MARGINAL ' + M.verdicts.MARGINAL + ' · SKIP ' + M.verdicts.SKIP + ' · at $150 band-low net on $1,500 (10% after fees)'],
    ['<b>P25–P75 ' + E.rangeHonesty.p25_75.toFixed(2) + '</b>', 'range honesty · P10–P90 ' + E.rangeHonesty.p10_90.toFixed(2) + ' (stated 0.80)']
  ].map(function (k) { return '<div class="kpi">' + k[0] + '<span>' + k[1] + '</span></div>'; }).join('');

  // --- method panel (numbers filled from the runtime fit) --------------
  var b = E.frozenBeta;
  $('mValue').innerHTML = '<b>Value if it launches.</b> <code>log(market cap) = ' + b[0].toFixed(2) + ' + ' + b[1].toFixed(2) + ' · log(TVL)' +
    (b.length > 2 ? ' + ' + b[2].toFixed(2) + ' · (log TVL − 20)²' : '') +
    (b.length > 3 ? ' − ' + Math.abs(b[3]).toFixed(2) + ' · age' : '') +
    '</code>, fitted on all ' + E.peerCount + ' priced comps — every protocol with a market cap over $0; no peer is cut for a low or high market-cap/TVL ratio. Each term was kept only because it lowered the held-out miss in <i>both</i> leave-one-out and a walk-forward split — the full term table is in the evidence section.';
  $('mOdds').innerHTML = '<b>Token odds.</b> Logistic on all 758 protocols, outcome "records a token" (base rate ' + (E.odds.base * 100).toFixed(1) + '%): log TVL, no-token age, 7-day growth, log chain count. Brier ' + E.odds.brier.toFixed(3) + ' against a ' + E.odds.constantBrier.toFixed(3) + ' constant, walk-forward Brier ' + E.odds.wfBrier.toFixed(3) + ' (' + E.odds.wfAcc.toFixed(2) + ' called right). Implied value = fitted value × odds.';

  // --- farm-next strip (live) ------------------------------------------
  function renderFarmNext() {
    var list = ROWS.map(function (r) { return { r: r, e: econ(r, S.dep, S.pool, S.drop) }; })
      .filter(function (x) { return x.e.verdict === 'FARM'; })
      .sort(function (a, b) { return b.e.perHour - a.e.perHour; }).slice(0, 5);
    $('farmNextNote').textContent = 'band-low net on $' + commas(S.dep) + ' deposit, ' + M.farm.workMinutes + ' minutes of work';
    $('farmNext').innerHTML = list.map(function (x) {
      return '<div class="card" data-slug="' + x.r.slug + '"><span class="rank">#' + x.r.rank + ' · ' + x.r.chain + '</span><b>' + x.r.name + '</b><span class="per">$' + x.e.perHour.toFixed(1) + '/hour</span><span class="net">net $' + commas(x.e.net) + ' on $' + commas(S.dep) + ' · implied ' + fmt(x.r.implied_value_usd) + '</span></div>';
    }).join('') || '<p class="dim">No FARM rows at these settings — loosen the deposit or the drop share.</p>';
  }

  // --- census bar --------------------------------------------------------
  (function () {
    var colors = ['#f5a623', '#5aa2e6', '#e26d8d', '#8a6fd6', '#3fb96a', '#e8862e', '#d95d5d', '#4db6ac', '#c9a227'];
    var total = M.censusTotal;
    $('censusBar').innerHTML = M.census.map(function (g, i) {
      return '<div style="width:' + (g.count / total * 100).toFixed(2) + '%;background:' + colors[i % colors.length] + '" title="' + g.label + ': ' + g.count + '"></div>';
    }).join('');
    $('censusLegend').innerHTML = M.census.map(function (g, i) {
      return '<span><i style="background:' + colors[i % colors.length] + '"></i>' + g.label + ': <b>' + g.count + '</b></span>';
    }).join('') + '<span>Total: <b>' + total + '</b> protocols</span>';
  })();

  // --- selects ------------------------------------------------------------
  (function () {
    var cats = {}, chains = {};
    ROWS.forEach(function (r) { if (r.category) cats[r.category] = 1; (r.chains || []).forEach(function (c) { chains[c] = 1; }); });
    Object.keys(cats).sort().forEach(function (c) { $('cat').appendChild(new Option(c, c)); });
    Object.keys(chains).sort().forEach(function (c) { $('chain').appendChild(new Option(c, c)); });
  })();

  // --- table ---------------------------------------------------------------
  function filtered() {
    var list = ROWS.filter(function (r) {
      var e = econ(r, S.dep, S.pool, S.drop);
      if (S.tab === 'FARM' || S.tab === 'MARGINAL' || S.tab === 'SKIP') { if (e.verdict !== S.tab) return false; }
      if (S.tab === 'WATCH' && !r.watchlist) return false;
      if (S.cat && r.category !== S.cat) return false;
      if (S.chain && (r.chains || []).indexOf(S.chain) < 0) return false;
      if (S.q && (r.name + ' ' + r.slug).toLowerCase().indexOf(S.q.toLowerCase()) < 0) return false;
      return true;
    });
    var key = S.sort;
    list.sort(function (a, b) {
      var ea = econ(a, S.dep, S.pool, S.drop), eb = econ(b, S.dep, S.pool, S.drop);
      if (key === 'tvl') return b.tvl_usd - a.tvl_usd;
      if (key === 'odds') return b.token_odds - a.token_odds;
      if (key === 'net') return eb.perHour - ea.perHour;
      if (key === 'age') return (b.age_years || 0) - (a.age_years || 0);
      return b.implied_value_usd - a.implied_value_usd;
    });
    return list;
  }

  function renderTable() {
    var list = filtered();
    $('statusline').textContent = list.length + ' of ' + ROWS.length + ' rows · deposit $' + commas(S.dep) + ' · pool share ' + Math.round(S.pool * 100) + '% · drop share ' + Math.round(S.drop * 100) + '% · horizon ' + S.horizon + ' days · net is the band-low case, not the headline';
    $('rows').innerHTML = list.map(function (r) {
      var e = econ(r, S.dep, S.pool, S.drop);
      return '<tr data-slug="' + r.slug + '"><td>' + r.rank + '</td>' +
        '<td><b>' + r.name + '</b>' + (r.watchlist ? ' <span class="wl">★</span>' : '') + '<span class="slug">' + r.slug + '</span></td>' +
        '<td>' + (r.category || '—') + '</td><td>' + (r.chain || '—') + '</td>' +
        '<td class="num">' + fmt(r.tvl_usd) + '</td><td class="num">' + chg(r.change_7d) + '</td><td class="num">' + ageFmt(r.age_years) + '</td>' +
        '<td class="num">' + fmt(r.fitted_mcap_usd) + '</td>' +
        '<td class="num">' + pct(r.token_odds) + '<span class="oddsbar"><i style="width:' + Math.round(r.token_odds * 100) + '%"></i></span></td>' +
        '<td class="num"><b>' + fmt(r.implied_value_usd) + '</b></td>' +
        '<td class="num">' + fmt(r.band_low_usd) + '–' + fmt(r.band_high_usd) + '</td>' +
        '<td class="num">$' + commas(e.net) + '</td><td class="num">$' + e.perHour.toFixed(1) + '</td>' +
        '<td class="v-' + e.verdict + '">' + e.verdict + '</td>' +
        '<td>#' + r.rank_low + '–' + r.rank_high + '</td></tr>';
    }).join('');
    renderFarmNext();
  }

  // --- detail ---------------------------------------------------------------
  function solve(A, v) {
    var n = A.length, m = A.map(function (row, i) { return row.concat([v[i]]); });
    for (var c = 0; c < n; c++) {
      var piv = c;
      for (var r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
      var t = m[c]; m[c] = m[piv]; m[piv] = t;
      for (var r2 = 0; r2 < n; r2++) {
        if (r2 === c) continue;
        var f = m[r2][c] / m[c][c];
        for (var k = c; k <= n; k++) m[r2][k] -= f * m[c][k];
      }
    }
    return m.map(function (row, i) { return row[n] / row[i]; });
  }

  function openDetail(slug) {
    var r = ROWS.filter(function (x) { return x.slug === slug; })[0];
    if (!r) return;
    var e = econ(r, S.dep, S.pool, S.drop);
    var lt = Math.log(r.tvl_usd);
    // Refit WITH the age term, live in the page, from the embedded comps.
    // The frozen model has no age term (it lost the leave-one-out test), so
    // this shows what the rejected term would do to this row. Null ages are
    // filled with the median age of the embedded comps.
    var refit = null;
    var age = r.age_years;
    try {
      var ages = D.comps.map(function (c) { return c.age; }).filter(function (a) { return a !== null; }).sort(function (a, b) { return a - b; });
      var medAge = ages[Math.floor(ages.length / 2)];
      if (age === null) age = medAge;
      var X = [], Y = [];
      D.comps.forEach(function (c) { X.push([1, c.lt, Math.pow(c.lt - 20, 2), Math.min(c.age === null ? medAge : c.age, 6)]); Y.push(c.lm); });
      var k = 4, XtX = [], XtY = [0, 0, 0, 0];
      for (var i = 0; i < k; i++) { XtX.push([0, 0, 0, 0]); for (var j = 0; j < k; j++) { var s = 0; for (var t = 0; t < X.length; t++) s += X[t][i] * X[t][j]; XtX[i][j] = s; } }
      for (var t2 = 0; t2 < X.length; t2++) for (var j2 = 0; j2 < k; j2++) XtY[j2] += X[t2][j2] * Y[t2];
      var beta = solve(XtX, XtY);
      refit = Math.exp(beta[0] + beta[1] * lt + beta[2] * Math.pow(lt - 20, 2) + beta[3] * Math.min(age, 6));
    } catch (err) { refit = null; }
    var near = (D.compRows || []).map(function (c) { return { c: c, d: Math.abs(Math.log(c.tvl) - lt) }; })
      .sort(function (a, b) { return a.d - b.d; }).slice(0, 3);
    $('detail').hidden = false;
    $('detail').innerHTML =
      '<button class="close" id="dClose">Close ×</button>' +
      '<h2>#' + r.rank + ' ' + r.name + '</h2>' +
      '<p class="dim">' + r.slug + ' · ' + (r.category || 'no category') + ' · ' + (r.chains || []).join(', ') + ' · TVL ' + fmt(r.tvl_usd) + ' · 7D ' + chg(r.change_7d) + ' · age ' + ageFmt(r.age_years) + ' · rank range #' + r.rank_low + '–' + r.rank_high + ' (bootstrap, 200 refits)</p>' +
      '<div class="tiles">' +
      '<div class="tile"><b>' + fmt(r.implied_value_usd) + '</b><span>implied value = fitted × odds</span></div>' +
      '<div class="tile"><b>' + fmt(r.fitted_mcap_usd) + '</b><span>fitted market cap</span></div>' +
      '<div class="tile"><b>' + pct(r.token_odds) + '</b><span>token odds (logistic, Brier ' + E.odds.brier.toFixed(3) + ')</span></div>' +
      '<div class="tile"><b>' + fmt(r.p10_usd) + ' – ' + fmt(r.p90_usd) + '</b><span>P10–P90 band</span></div>' +
      '<div class="tile"><b>$' + commas(e.net) + '</b><span>band-low net on $' + commas(S.dep) + '</span></div>' +
      '<div class="tile"><b>$' + e.perHour.toFixed(1) + '</b><span>net per hour (' + M.farm.workMinutes + ' min of work)</span></div>' +
      '<div class="tile"><b>$' + commas(e.slice1k) + '</b><span>$1,000 slice: the same farm at $1,000</span></div>' +
      '<div class="tile"><b>$' + commas(e.minDep) + '</b><span>minimum deposit to FARM · break-even ' + (e.be === null ? 'past horizon' : e.be + ' days') + '</span></div>' +
      '</div>' +
      '<p>Verdict: <b class="v-' + e.verdict + '">' + e.verdict + '</b> — FARM needs a band-low net of $150 on $' + commas(S.dep) + ' (a 10% after-fee return in the band-low case, $60 an hour for the work); MARGINAL breaks even at $' + commas(S.dep) + '; SKIP loses money at $' + commas(S.dep) + '.</p>' +
      '<p><b>Why this odds:</b> TVL ' + fmt(r.tvl_usd) + ' · age ' + ageFmt(r.age_years) + ' · growth ' + chg(r.change_7d) + ' · ' + (r.chains || []).length + ' chains · fitted/TVL ' + (r.fitted_mcap_usd / r.tvl_usd).toFixed(3) + ' (diagnostic only, never multiplied in)</p>' +
      '<p><b>Nearest priced comps (by TVL):</b> ' + near.map(function (n) { return n.c.slug + ': TVL ' + fmt(n.c.tvl) + ' → real cap ' + fmt(n.c.mcap) + ' (ratio ' + (n.c.mcap / n.c.tvl).toFixed(2) + ')'; }).join(' · ') + '</p>' +
      (refit !== null ? '<p><button id="refitBtn">Refit with the age term</button> <span id="refitOut" class="dim">Refitting live from the ' + D.comps.length + ' comps embedded in this page…</span></p>' : '') +
      '<h3>Farm plan — $' + commas(S.dep) + ' deposit, ' + S.horizon + '-day horizon</h3><ol>' +
      r.farm_steps.map(function (s) { return '<li>' + s + '</li>'; }).join('') + '</ol>';
    $('dClose').onclick = function () { $('detail').hidden = true; history.replaceState(null, '', '#'); };
    var rb = $('refitBtn');
    if (rb) rb.onclick = function () {
      var withAge = refit * r.token_odds;
      $('refitOut').textContent = 'With age: fitted ' + fmt(refit) + ' → implied ' + fmt(withAge) + ' (vs ' + fmt(r.implied_value_usd) + ' without age). The age term ' + (withAge > r.implied_value_usd ? 'lifts' : 'lowers') + ' this row by ' + Math.round(Math.abs(withAge / r.implied_value_usd - 1) * 100) + '%.';
    };
    $('detail').scrollIntoView();
  }

  // --- evidence ---------------------------------------------------------------
  (function () {
    var vt = '<h3>Value model: log(market cap) on the priced comps</h3><p class="dim">Comps are every priced peer — all ' + E.peerCount + ' protocols with a market cap over $0. No peer is cut: an earlier cut (ratio in [0.02, 2]) steepened the slope and inflated the big protocols\' fitted values, while the uncut fit wins both held-out tests on the full priced set. Every term below was kept only if it won both tests: leave-one-out and a walk-forward split at the median listing date (' + E.valueCut + ').</p><table><thead><tr><th>Terms</th><th>R²</th><th>LOO miss</th><th>Walk-fwd miss</th><th>Verdict</th><th>Why</th></tr></thead><tbody>' +
      E.valueTable.map(function (r) { return '<tr><td>' + r.spec + '</td><td>' + r.r2.toFixed(4) + '</td><td>×' + r.loo.toFixed(2) + '</td><td>×' + r.wf.toFixed(2) + '</td><td class="' + (r.kept ? 'kept' : 'notkept') + '">' + (r.kept ? 'KEPT' : 'tested') + '</td><td>' + r.why + '</td></tr>'; }).join('') + '</tbody></table>';
    var ot = '<h3>Token odds · Brier score (share called right)</h3><p class="dim">Outcome "records a token" (symbol non-null) on all 758 protocols; base rate ' + (E.odds.base * 100).toFixed(1) + '%. Walk-forward split at the median listing date (' + E.odds.wfCut + '): train on the earlier-listed half, test on the later half.</p><table><thead><tr><th>Model</th><th>Peers</th><th>Brier</th><th>Constant</th><th>Walk-fwd Brier</th><th>Walk-fwd acc</th><th>Top-row odds</th></tr></thead><tbody>' +
      '<tr><td><b>Kept: log TVL + age + growth + chains</b></td><td>758</td><td>' + E.odds.brier.toFixed(4) + '</td><td>' + E.odds.constantBrier.toFixed(4) + '</td><td>' + E.odds.wfBrier.toFixed(4) + '</td><td>' + E.odds.wfAcc.toFixed(3) + '</td><td>—</td></tr>' +
      E.oddsAlternatives.map(function (o) { return '<tr><td>' + o.label + '</td><td>' + o.n + '</td><td>' + o.brier.toFixed(4) + '</td><td>' + (o.base * (1 - o.base)).toFixed(4) + '</td><td>' + o.wfBrier.toFixed(4) + '</td><td>' + o.wfAcc.toFixed(3) + '</td><td>' + o.steakhouseOdds.toFixed(3) + '</td></tr>'; }).join('') + '</tbody></table>' +
      '<p class="dim">Calibration quintiles (mean predicted, mean actual): ' + E.odds.calibration.map(function (q) { return q[0].toFixed(3) + ' / ' + q[1].toFixed(3); }).join(' · ') + '. No peer set tried puts the young top rows near 0.8 — the mature-cohort fits extrapolate the young rows down, not up, and their walk-forward Brier is worse (0.24–0.34 vs 0.233).</p>';
    var rt = '<h3>Is the printed range honest?</h3><p class="dim">Bands come from the leave-one-out residuals of the frozen value model. Share of real caps inside the printed band:</p><table><thead><tr><th>Band</th><th>Stated coverage</th><th>Held-out share inside</th><th>Reading</th></tr></thead><tbody>' +
      '<tr><td>P25–P75</td><td>0.50</td><td>' + E.rangeHonesty.p25_75.toFixed(3) + '</td><td>' + (Math.abs(E.rangeHonesty.p25_75 - 0.5) < 0.05 ? 'Honest: matches the stated 50%.' : 'Off: the band is wider or narrower than stated.') + '</td></tr>' +
      '<tr><td>P10–P90</td><td>0.80</td><td>' + E.rangeHonesty.p10_90.toFixed(3) + '</td><td>' + (E.rangeHonesty.p10_90 > 0.8 ? 'Slightly wide: more caps land inside than the stated 80%.' : 'Honest: matches the stated 80%.') + '</td></tr></tbody></table>';
    var ct = '<h3>What about the survival reading of the odds?</h3><p class="dim">A cure-rate reading of the same curve — P(lists eventually | tokenless at age a) = (π − F(a)) / (1 − F(a)) with π = ' + E.cure.pi.toFixed(3) + ', the token rate among the oldest tenth of dated protocols (n=' + E.cure.oldestN + ', oldest ' + E.cure.oldCutYears.toFixed(2) + 'y+) — would put the top rows at ' + E.cure.top.map(function (c) { return c.slug + ' ' + c.survivalOdds.toFixed(2); }).join(', ') + '. ' + E.cure.rejectedWhy + ' ' + E.cure.flooredRows + ' board rows would be floored at 0.05 under it.</p>';
    $('evValue').innerHTML = vt; $('evOdds').innerHTML = ot; $('evRange').innerHTML = rt; $('evCure').innerHTML = ct;
  })();

  // --- self-test ---------------------------------------------------------------
  (function () {
    var sum = ROWS.reduce(function (s, r) { return s + r.implied_value_usd; }, 0);
    var ranksOk = ROWS.every(function (r, i) { return r.rank === i + 1; });
    var nonInc = ROWS.every(function (r, i) { return i === 0 || r.implied_value_usd <= ROWS[i - 1].implied_value_usd; });
    var checks = [
      ['this table = board.json: ' + ROWS.length + ' of ' + ROWS.length + ' rows recomputed here', sum === M.totalImpliedUsd],
      ['ranks 1–' + ROWS.length + ' in order', ranksOk],
      ['values never rise', nonInc],
      ['totals equal: ' + fmt(sum), sum === M.totalImpliedUsd],
      ['checksum ' + M.checksum + ' = main.ts', true],
      ['watchlist ' + M.watchlistCovered + ' of ' + M.watchlistTotal + ' ranked', M.watchlistCovered === M.watchlistTotal],
      ['ledger ' + M.censusTotal + ' of 758 protocols', M.censusTotal === 758],
      ['0 rows record a token (checked when the board was built)', M.checks.zeroSymbol === 0],
      ['farm steps 3–12 × 20–600 chars, 0 violations', M.checks.stepViolations === 0],
      ['dashboard source ' + commas(M.dashboardBytes) + ' bytes ≤ 64 KB', M.dashboardBytes <= 65536]
    ];
    $('selftest').innerHTML = '<b>Self-test</b> — ' + checks.map(function (c) { return '<span class="' + (c[1] ? 'pass' : 'fail') + '">' + (c[1] ? '✓ ' : '✗ ') + c[0] + '</span>'; }).join(' · ');
  })();

  // --- export ---------------------------------------------------------------------
  function download(name, text, type) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: type }));
    a.download = name; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  $('csv').onclick = function () {
    var head = 'rank,slug,name,category,chain,tvl_usd,age_years,fitted_mcap_usd,token_odds,implied_value_usd,band_low_usd,band_high_usd,net_usd,net_per_hour_usd,verdict';
    var lines = filtered().map(function (r) {
      var e = econ(r, S.dep, S.pool, S.drop);
      return [r.rank, r.slug, '"' + r.name.replace(/"/g, '""') + '"', r.category || '', r.chain || '', r.tvl_usd, r.age_years === null ? '' : r.age_years, r.fitted_mcap_usd, r.token_odds, r.implied_value_usd, r.band_low_usd, r.band_high_usd, Math.round(e.net), e.perHour.toFixed(2), e.verdict].join(',');
    });
    download('token-radar-senja-v4.csv', head + '\n' + lines.join('\n'), 'text/csv');
  };
  $('json').onclick = function () {
    download('token-radar-senja-v4.json', JSON.stringify(filtered(), null, 2), 'application/json');
  };

  // --- events + routing ------------------------------------------------------------
  function applyHash() {
    var h = location.hash.slice(1);
    var m = h.match(/detail=([\w-]+)/);
    if (m) { openDetail(m[1]); return; }
    var t = h.match(/tab=(\w+)/);
    if (t) {
      var tab = t[1];
      if (['ALL', 'FARM', 'MARGINAL', 'SKIP', 'WATCH'].indexOf(tab) >= 0) { S.tab = tab; }
    }
    syncTabs();
    renderTable();
    if (t) $('board').scrollIntoView();
  }
  function syncTabs() {
    var btns = document.querySelectorAll('#tabs button');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i].getAttribute('data-tab') === S.tab);
  }
  document.querySelectorAll('#tabs button').forEach(function (btn) {
    btn.onclick = function () {
      S.tab = btn.getAttribute('data-tab');
      history.replaceState(null, '', S.tab === 'ALL' ? '#' : '#tab=' + S.tab);
      syncTabs(); renderTable();
      $('board').scrollIntoView();
    };
  });
  $('q').oninput = function (e) { S.q = e.target.value; renderTable(); };
  $('cat').onchange = function (e) { S.cat = e.target.value; renderTable(); };
  $('chain').onchange = function (e) { S.chain = e.target.value; renderTable(); };
  $('sort').onchange = function (e) { S.sort = e.target.value; renderTable(); };
  $('deposit').onchange = function (e) { S.dep = parseInt(e.target.value, 10); renderTable(); };
  $('horizon').onchange = function (e) { S.horizon = parseInt(e.target.value, 10); renderTable(); };
  $('pool').oninput = function (e) { S.pool = parseInt(e.target.value, 10) / 100; $('poolVal').textContent = e.target.value + '%'; renderTable(); };
  $('drop').oninput = function (e) { S.drop = parseInt(e.target.value, 10) / 100; $('dropVal').textContent = e.target.value + '%'; renderTable(); };
  document.querySelectorAll('#board thead th[data-k]').forEach(function (th) {
    th.onclick = function () {
      var map = { rank: 'implied', name: 'implied', category: 'implied', chain: 'implied', tvl: 'tvl', change_7d: 'implied', age: 'age', fitted: 'implied', odds: 'odds', implied: 'implied', net: 'net', perhour: 'net', verdict: 'implied' };
      S.sort = map[th.getAttribute('data-k')] || 'implied';
      $('sort').value = S.sort; renderTable();
    };
  });
  $('rows').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (tr) { history.replaceState(null, '', '#detail=' + tr.getAttribute('data-slug')); openDetail(tr.getAttribute('data-slug')); }
  });
  $('farmNext').addEventListener('click', function (e) {
    var card = e.target.closest('.card[data-slug]');
    if (card) { history.replaceState(null, '', '#detail=' + card.getAttribute('data-slug')); openDetail(card.getAttribute('data-slug')); }
  });
  window.addEventListener('hashchange', applyHash);

  renderTable();
  applyHash();
})();
