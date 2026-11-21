// ===== Núcleo: retrato do momento, análogos, sugestão e juiz (sem dependência de navegador) =====
const Core = (() => {
  const PRECO = ["ret_1h","ret_2h","ret_4h","ret_8h","ret_12h","ret_24h","ret_72h","vol_4h_rel","vol_24h_rel",
                 "volume_24h_rel","pos_24h","dist_max7d","dist_min7d"];
  const CAL = ["mes_sin","mes_cos","dia_sin","dia_cos","hora_sin","hora_cos","fds"];
  const MAC = ["macro_prox4h","macro_ult4h"];
  const COLS = PRECO.concat(CAL, MAC);
  const H1 = 3600e3;

  function rollStd(a, w, minp) { // desvio padrão amostral (ddof=1), como pandas
    const n = a.length, out = new Float64Array(n).fill(NaN);
    let s = 0, s2 = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
      const x = a[i]; if (!isNaN(x)) { s += x; s2 += x * x; cnt++; }
      if (i >= w) { const y = a[i - w]; if (!isNaN(y)) { s -= y; s2 -= y * y; cnt--; } }
      if (cnt >= minp && cnt > 1) { const v = (s2 - s * s / cnt) / (cnt - 1); out[i] = Math.sqrt(Math.max(v, 0)); }
    }
    return out;
  }
  function rollSum(a, w, minp) {
    const n = a.length, out = new Float64Array(n).fill(NaN); let s = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
      s += a[i]; cnt++;
      if (i >= w) { s -= a[i - w]; cnt--; }
      if (cnt >= minp) out[i] = s;
    }
    return out;
  }
  function rollExt(a, w, isMax) { // janela completa obrigatória (como pandas sem min_periods)
    const n = a.length, out = new Float64Array(n).fill(NaN), dq = [];
    for (let i = 0; i < n; i++) {
      while (dq.length && (isMax ? a[dq[dq.length - 1]] <= a[i] : a[dq[dq.length - 1]] >= a[i])) dq.pop();
      dq.push(i);
      if (dq[0] <= i - w) dq.shift();
      if (i >= w - 1) out[i] = a[dq[0]];
    }
    return out;
  }
  // partes de data em um fuso específico (America/New_York) via Intl
  const fmtNY = new Intl.DateTimeFormat("en-US", {timeZone: "America/New_York", hour12: false,
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric", weekday: "short"});
  const WD = {Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6};
  const nyCache = new Map();
  function nyParts(ms) {
    const key = Math.floor(ms / H1);
    let r = nyCache.get(key);
    if (!r) {
      const p = {}; for (const x of fmtNY.formatToParts(new Date(key * H1))) p[x.type] = x.value;
      r = {month: +p.month, wd: WD[p.weekday], hour: (+p.hour) % 24};
      nyCache.set(key, r);
    }
    return r;
  }
  // eventos: lista de ms UTC ordenada
  function eventsToMs(rows) { // rows: [["CPI","2026-11-10 08:30"],...] em hora de NY
    const out = [];
    for (const [nome, s] of rows) {
      const [d, hm] = s.split(" "); const [Y, M, D] = d.split("-").map(Number); const [hh, mm] = hm.split(":").map(Number);
      // acha o offset de NY nessa data testando -4h e -5h
      for (const off of [4, 5]) {
        const ms = Date.UTC(Y, M - 1, D, hh + off, mm);
        const p = nyParts(ms);
        const hourNY = p.hour;
        if (hourNY === hh) { out.push({nome, ms}); break; }
      }
    }
    return out.sort((a, b) => a.ms - b.ms);
  }
  function lowerBound(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; }

  // bars: [{t,o,h,l,c,v}] velas de 1h ordenadas (t = abertura, ms UTC)
  function build(bars, evMs, horizons = [1, 4]) {
    const n = bars.length;
    const lc = new Float64Array(n), hi = new Float64Array(n), lo = new Float64Array(n), v = new Float64Array(n), c = new Float64Array(n);
    for (let i = 0; i < n; i++) { c[i] = bars[i].c; lc[i] = Math.log(bars[i].c); hi[i] = bars[i].h; lo[i] = bars[i].l; v[i] = bars[i].v; }
    const r1 = new Float64Array(n); r1[0] = NaN; for (let i = 1; i < n; i++) r1[i] = lc[i] - lc[i - 1];
    const vol30 = rollStd(r1, 720, 240), v4 = rollStd(r1, 4, 4), v24 = rollStd(r1, 24, 24);
    const sv24 = rollSum(v, 24, 24), sv720 = rollSum(v, 720, 240);
    const hi24 = rollExt(hi, 24, true), lo24 = rollExt(lo, 24, false);
    const hi168 = rollExt(hi, 168, true), lo168 = rollExt(lo, 168, false);
    const d = COLS.length, X = new Float64Array(n * d).fill(NaN);
    const valid = new Uint8Array(n), dec = new Float64Array(n);
    const fwd = {}; for (const k of horizons) fwd[k] = new Float64Array(n).fill(NaN);
    const evT = evMs.map(e => e.ms);
    const K = [1, 2, 4, 8, 12, 24, 72];
    for (let i = 0; i < n; i++) {
      const t = bars[i].t + H1; dec[i] = t;
      const row = new Array(d);
      for (let j = 0; j < K.length; j++) { const k = K[j]; row[j] = i >= k ? (lc[i] - lc[i - k]) / (vol30[i] * Math.sqrt(k)) : NaN; }
      row[7] = v4[i] / vol30[i]; row[8] = v24[i] / vol30[i];
      row[9] = Math.log((sv24[i] + 1) / (sv720[i] / 30 + 1));
      row[10] = (c[i] - lo24[i]) / (hi24[i] - lo24[i]);
      row[11] = (lc[i] - Math.log(hi168[i])) / (vol30[i] * Math.sqrt(168));
      row[12] = (lc[i] - Math.log(lo168[i])) / (vol30[i] * Math.sqrt(168));
      const p = nyParts(t);
      row[13] = Math.sin(2 * Math.PI * (p.month - 1) / 12); row[14] = Math.cos(2 * Math.PI * (p.month - 1) / 12);
      row[15] = Math.sin(2 * Math.PI * p.wd / 7); row[16] = Math.cos(2 * Math.PI * p.wd / 7);
      row[17] = Math.sin(2 * Math.PI * p.hour / 24); row[18] = Math.cos(2 * Math.PI * p.hour / 24);
      row[19] = p.wd >= 5 ? 1 : 0;
      const nx = lowerBound(evT, t), pv = nx - 1;
      row[20] = (nx < evT.length && (evT[nx] - t) / H1 <= 4) ? 1 : 0;
      row[21] = (pv >= 0 && (t - evT[pv]) / H1 <= 4) ? 1 : 0;
      let ok = 1;
      for (let j = 0; j < d; j++) { const x = row[j]; if (!isFinite(x)) { ok = 0; } X[i * d + j] = x; }
      valid[i] = ok;
      for (const k of horizons) if (i + k < n) fwd[k][i] = (lc[i + k] - lc[i]) * 100;
    }
    return {n, d, X, valid, dec, fwd, close: c};
  }

  function weights(w) {
    const out = new Float64Array(COLS.length);
    for (const [grp, key] of [[PRECO, "p"], [CAL, "c"], [MAC, "m"]])
      for (const col of grp) out[COLS.indexOf(col)] = w[key] > 0 ? Math.sqrt(w[key] / grp.length) : 0;
    return out;
  }

  // Busca de análogos para a linha qi, usando só linhas cujo desfecho em H horas já era conhecido em nowMs
  function analogs(F, qi, H, nowMs, wts, K) {
    const {d, X, valid, dec} = F, y = F.fwd[H], w = weights(wts);
    const base = [];
    for (let i = 0; i < F.n; i++) if (valid[i] && !isNaN(y[i]) && dec[i] + H * H1 <= nowMs && i !== qi) base.push(i);
    if (base.length < K * 4) return null;
    const mu = new Float64Array(d), sd = new Float64Array(d);
    for (const i of base) for (let j = 0; j < d; j++) mu[j] += X[i * d + j];
    for (let j = 0; j < d; j++) mu[j] /= base.length;
    for (const i of base) for (let j = 0; j < d; j++) { const z = X[i * d + j] - mu[j]; sd[j] += z * z; }
    for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j] / base.length) + 1e-9;
    const q = new Float64Array(d); for (let j = 0; j < d; j++) q[j] = (X[qi * d + j] - mu[j]) / sd[j] * w[j];
    const dist = new Float64Array(base.length);
    for (let b = 0; b < base.length; b++) {
      const i = base[b]; let s = 0;
      for (let j = 0; j < d; j++) { if (w[j] === 0) continue; const z = (X[i * d + j] - mu[j]) / sd[j] * w[j] - q[j]; s += z * z; }
      dist[b] = s;
    }
    // vizinhos mais próximos, exigindo 12 h de distância entre eles (evita contar o mesmo episódio várias vezes)
    const sortedIdx = Array.from(base.keys()).sort((a, b) => dist[a] - dist[b]);
    const order = [], taken = [];
    for (const b of sortedIdx) {
      const t = dec[base[b]];
      if (taken.some(x => Math.abs(x - t) < 12 * H1)) continue;
      order.push(b); taken.push(t);
      if (order.length === K) break;
    }
    const nb = order.map(b => ({i: base[b], dec: dec[base[b]], fwd: y[base[b]], dist: Math.sqrt(dist[b])}));
    const vals = nb.map(x => x.fwd);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const up = vals.filter(x => x > 0).length / vals.length;
    const sdv = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length - 1));
    const sorted = [...vals].sort((a, b) => a - b), med = sorted[Math.floor(sorted.length / 2)];
    return {H, mean, median: med, up, sd: sdv, neighbors: nb, baseSize: base.length};
  }

  // Decide se vira sugestão
  function decide(a, price, nowMs, evMs, cfg) {
    const side = a.mean > 0 ? "COMPRA" : "VENDA";
    const agree = a.mean > 0 ? a.up : 1 - a.up;
    const cost = 2 * cfg.feeTaker * 100;
    const motivos = [];
    if (agree < cfg.minAgreement) motivos.push(`concordância ${(agree * 100).toFixed(0)}% < ${(cfg.minAgreement * 100).toFixed(0)}%`);
    if (Math.abs(a.mean) < cost * cfg.costMargin) motivos.push(`movimento esperado ${Math.abs(a.mean).toFixed(2).replace('.', ',')}% < custo×margem ${(cost * cfg.costMargin).toFixed(2).replace('.', ',')}%`);
    const nextEv = evMs.find(e => e.ms >= nowMs);
    if (nextEv && (nextEv.ms - nowMs) / 60e3 <= cfg.macroBlockMin) motivos.push(`${nextEv.nome} em ${Math.round((nextEv.ms - nowMs) / 60e3)} min`);
    if (motivos.length) return {sugere: false, side, agree, motivos};
    const sigma = a.sd / 100;
    const dir = side === "COMPRA" ? 1 : -1;
    return {sugere: true, side, agree, motivos: [],
      entrada: price, stop: price * (1 - dir * cfg.stopMult * sigma), alvo: price * (1 + dir * cfg.targetMult * sigma),
      expira: nowMs + a.H * H1};
  }

  // Juiz: candles1m [{t,o,h,l,c}] ordenados; funding [{t,rate}]
  function judge(s, candles1m, funding, nowMs, cfg) {
    if (s.status !== "aberta") return s;
    const dir = s.lado === "COMPRA" ? 1 : -1;
    let saida = null, saidaT = null, motivo = null;
    for (const k of candles1m) {
      if (k.t < s.criada) continue;
      const kEnd = k.t + 60e3;
      if (kEnd > nowMs) break; // vela ainda aberta
      const hitStop = dir === 1 ? k.l <= s.stop : k.h >= s.stop;
      const hitAlvo = dir === 1 ? k.h >= s.alvo : k.l <= s.alvo;
      if (hitStop) { saida = s.stop; saidaT = kEnd; motivo = hitAlvo ? "stop (stop e alvo na mesma vela: conta o pior)" : "stop"; break; }
      if (hitAlvo) { saida = s.alvo; saidaT = kEnd; motivo = "alvo"; break; }
      if (kEnd >= s.expira) { saida = k.c; saidaT = kEnd; motivo = "prazo"; break; }
    }
    if (saida === null) return s;
    const bruto = dir * (saida / s.entrada - 1) * 100;
    const taxas = 2 * cfg.feeTaker * 100;
    let fund = 0;
    for (const f of funding) if (f.t > s.criada && f.t <= saidaT) fund += -dir * f.rate * 100;
    return {...s, status: "fechada", saida, saidaT, motivo, bruto, taxas, funding: fund, liquido: bruto - taxas + fund};
  }

  return {COLS, PRECO, CAL, MAC, build, analogs, decide, judge, eventsToMs, nyParts, weights};
})();
if (typeof module !== "undefined") module.exports = Core;
