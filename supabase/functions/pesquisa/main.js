import { createClient } from "jsr:@supabase/supabase-js@2";
import * as Alerta from "https://cdn.jsdelivr.net/gh/romesbr/btc-analogos@c352af0beae9de474a70a6b1e053fca9e8d5bba2/supabase/functions/ciclo/alerta.js";
import Core from "https://cdn.jsdelivr.net/gh/romesbr/btc-analogos@c352af0beae9de474a70a6b1e053fca9e8d5bba2/supabase/functions/ciclo/core.js";
import EVENTOS from "https://cdn.jsdelivr.net/gh/romesbr/btc-analogos@c352af0beae9de474a70a6b1e053fca9e8d5bba2/supabase/functions/ciclo/eventos.js";
const sb = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const H1 = 36e5, D1 = 864e5;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const tstat = (a) => a.length > 2 ? mean(a) / sd(a) * Math.sqrt(a.length) : NaN;
const corr = (a, b) => {
  const ma = mean(a), mb = mean(b);
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < a.length; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return sab / Math.sqrt(saa * sbb);
};
const r3 = (x) => Math.round(x * 1e3) / 1e3;
async function funding() {
  const { data: velas } = await sb.rpc("velas_json");
  const bars = velas.map((r) => ({ t: +r[0], h: r[2], l: r[3], c: r[4] }));
  const idx = new Map(bars.map((b, i) => [b.t, i]));
  const fr = [];
  for (let from = 0; ; from += 1e3) {
    const { data } = await sb.from("funding").select("t,rate").order("t").range(from, from + 999);
    if (!data?.length) break;
    fr.push(...data.map((x) => ({ t: +x.t, rate: +x.rate })));
    if (data.length < 1e3) break;
  }
  const lr = bars.map((b, i) => i ? Math.log(b.c / bars[i - 1].c) : 0);
  const res = [];
  let livreAte = 0;
  for (let k = 271; k < fr.length; k++) {
    const f = fr[k];
    if (f.t < livreAte) continue;
    const hist = fr.slice(k - 270, k).map((x) => x.rate).sort((a, b) => a - b);
    const p95 = hist[Math.floor(hist.length * 0.95)], p5 = hist[Math.floor(hist.length * 0.05)];
    if (!(f.rate > p95 || f.rate < p5)) continue;
    const i0 = idx.get(Math.floor(f.t / H1) * H1 - H1);
    if (i0 == null || i0 < 500 || i0 + 25 >= bars.length) continue;
    const lado = f.rate > p95 ? -1 : 1, p = bars[i0].c;
    const sig = sd(lr.slice(i0 - 479, i0 + 1)) * Math.sqrt(24);
    const stop = p * (1 - lado * 1.5 * sig), alvo = p * (1 + lado * 1.5 * sig);
    let saida = bars[i0 + 24].c, j = i0 + 24, mot = "prazo";
    for (let q = i0 + 1; q <= i0 + 24; q++) {
      const b = bars[q];
      if (lado === 1 ? b.l <= stop : b.h >= stop) {
        saida = stop;
        j = q;
        mot = "stop";
        break;
      }
      if (lado === 1 ? b.h >= alvo : b.l <= alvo) {
        saida = alvo;
        j = q;
        mot = "alvo";
        break;
      }
    }
    const tFim = bars[j].t + H1;
    const fund = fr.filter((x) => x.t > f.t && x.t <= tFim).reduce((s, x) => s + x.rate, 0) * 100 * lado;
    const liq = lado * (saida / p - 1) * 100 - 0.1 - fund;
    res.push({ t: f.t, lado, liq, mot, ano: new Date(f.t).getUTCFullYear() });
    livreAte = tFim;
  }
  const all = res.map((r) => r.liq), por = {};
  for (const r of res) (por[r.ano] ||= []).push(r.liq);
  const anos = Object.fromEntries(Object.entries(por).map(([a, v]) => [a, { n: v.length, media: r3(mean(v)), acerto: r3(v.filter((x) => x > 0).length / v.length) }]));
  const lados = [1, -1].map((l) => {
    const v = res.filter((r) => r.lado === l).map((r) => r.liq);
    return { lado: l === 1 ? "compra (funding baixo)" : "venda (funding alto)", n: v.length, media: r3(mean(v)), t: r3(tstat(v)) };
  });
  return { n: all.length, media: r3(mean(all)), t: r3(tstat(all)), acerto: r3(all.filter((x) => x > 0).length / all.length), lados, anos };
}
async function yahoo(sym) {
  const p2 = Math.floor(Date.now() / 1e3), p1 = Math.floor(Date.UTC(2017, 0, 1) / 1e3);
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${p1}&period2=${p2}&interval=1d`, { headers: { "User-Agent": "Mozilla/5.0" } });
  const j = await r.json();
  const x = j.chart.result[0];
  const ts = x.timestamp, cl = x.indicators.quote[0].close;
  const m = /* @__PURE__ */ new Map();
  ts.forEach((t, i) => {
    if (cl[i] != null) m.set(new Date((t + x.meta.gmtoffset) * 1e3).toISOString().slice(0, 10), cl[i]);
  });
  return m;
}
async function correl() {
  const nomes = { "BTC-USD": "BTC", "^GSPC": "S&P 500", "^IXIC": "Nasdaq", "DX-Y.NYB": "D\xF3lar (DXY)", "GC=F": "Ouro", "^TNX": "Juros EUA 10 anos", "^VIX": "VIX (medo)", "CL=F": "Petr\xF3leo", "ETH-USD": "ETH", "BRL=X": "D\xF3lar/Real", "^BVSP": "Ibovespa" };
  const S = {};
  for (const k of Object.keys(nomes)) {
    try {
      S[k] = await yahoo(k);
    } catch (_e) {
    }
  }
  const btc = S["BTC-USD"];
  const out = {};
  const dias = [...S["^GSPC"].keys()].filter((d) => btc.has(d)).sort();
  for (const k of Object.keys(nomes)) {
    if (k === "BTC-USD" || !S[k]) continue;
    const X = S[k];
    const ds = dias.filter((d) => X.has(d));
    const pares = [];
    for (let i = 1; i < ds.length; i++) {
      const d0 = ds[i - 1], d1 = ds[i];
      const b = Math.log(btc.get(d1) / btc.get(d0)), x = k === "^TNX" ? X.get(d1) - X.get(d0) : Math.log(X.get(d1) / X.get(d0));
      const d2 = ds[i + 1];
      const bNext = d2 ? Math.log(btc.get(d2) / btc.get(d1)) : null;
      pares.push({ d: d1, b, x, bNext });
    }
    const per = {};
    for (const [nome, a, z] of [["2017\u201319", "2017", "2019-12-31"], ["2020\u201321", "2020", "2021-12-31"], ["2022\u201323", "2022", "2023-12-31"], ["2024\u201326", "2024", "2099"], ["\xFAltimos 90 dias", new Date(Date.now() - 90 * D1).toISOString().slice(0, 10), "2099"]]) {
      const p = pares.filter((q) => q.d >= a && q.d <= z);
      if (p.length > 20) per[nome] = r3(corr(p.map((q) => q.b), p.map((q) => q.x)));
    }
    const pl = pares.filter((q) => q.bNext != null && q.d >= "2022");
    const lead = r3(corr(pl.map((q) => q.x), pl.map((q) => q.bNext)));
    out[nomes[k]] = { diaria: per, antecipa_dia_seguinte_desde_2022: lead, n_lead: pl.length };
  }
  return out;
}
async function fred(id) {
  const r = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, { headers: { "User-Agent": "Mozilla/5.0" } });
  const txt = await r.text();
  const m = /* @__PURE__ */ new Map();
  for (const l of txt.split("\n").slice(1)) {
    const [d, v] = l.split(",");
    if (v && v !== "." && !isNaN(+v)) m.set(d, +v);
  }
  return m;
}
async function yahooDesde(sym, ano) {
  const p2 = Math.floor(Date.now() / 1e3), p1 = Math.floor(Date.UTC(ano, 0, 1) / 1e3);
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${p1}&period2=${p2}&interval=1d`, { headers: { "User-Agent": "Mozilla/5.0" } });
  const j = await r.json();
  const x = j.chart.result[0];
  const ts = x.timestamp, q = x.indicators.quote[0];
  const out = [];
  ts.forEach((t, i) => {
    if (q.close[i] != null) out.push({ d: new Date((t + x.meta.gmtoffset) * 1e3).toISOString().slice(0, 10), c: q.close[i], h: q.high[i] ?? q.close[i], l: q.low[i] ?? q.close[i] });
  });
  return out;
}
async function ouro() {
  const g = await yahooDesde("GC=F", 2e3);
  const n = g.length;
  const c = g.map((x) => x.c), r = c.map((x, i) => i ? x / c[i - 1] - 1 : 0);
  const FEE = 5e-4, ANO = 252;
  const ma = (k, i) => i < k - 1 ? NaN : c.slice(i - k + 1, i + 1).reduce((s, x) => s + x, 0) / k;
  const vol20 = (i) => i < 21 ? NaN : sd(r.slice(i - 19, i + 1)) * Math.sqrt(ANO);
  function stats(sinal, nome) {
    const ret = [];
    let pos = 0;
    const dias = [];
    for (let i = 250; i < n; i++) {
      const novo = sinal(i - 1);
      ret.push(novo * r[i] - Math.abs(novo - pos) * FEE);
      pos = novo;
      dias.push(g[i].d);
    }
    const per = (a, z) => {
      const x = ret.filter((_, k) => dias[k] >= a && dias[k] <= z);
      let eq = 1, pico = 1, dd = 0;
      for (const v of x) {
        eq *= 1 + v;
        pico = Math.max(pico, eq);
        dd = Math.min(dd, eq / pico - 1);
      }
      return { cagr: r3((Math.pow(eq, ANO / x.length) - 1) * 100), sharpe: r3(mean(x) / sd(x) * Math.sqrt(ANO)), queda: r3(dd * 100) };
    };
    return { nome, tudo: per("2001", "2099"), "2001\u20132012": per("2001", "2012-12-31"), "2013\u20132026": per("2013", "2099") };
  }
  const vs = (i) => Math.min(1, 0.15 / vol20(i)) || 0;
  const don = (() => {
    const p = new Array(n).fill(0);
    let cur = 0;
    for (let i = 55; i < n; i++) {
      const hi = Math.max(...g.slice(i - 55, i).map((x) => x.h)), lo = Math.min(...g.slice(i - 27, i).map((x) => x.l));
      if (c[i] > hi) cur = 1;
      else if (c[i] < lo) cur = 0;
      p[i] = cur;
    }
    return p;
  })();
  const regras = [
    stats(() => 1, "Segurar ouro"),
    stats((i) => c[i] > ma(50, i) ? 1 : 0, "M\xE9dia 50d"),
    stats((i) => c[i] > ma(100, i) ? 1 : 0, "M\xE9dia 100d"),
    stats((i) => c[i] > ma(200, i) ? 1 : 0, "M\xE9dia 200d"),
    stats((i) => don[i], "Rompimento 55d (Tartarugas)"),
    stats((i) => c[i] > c[i - 126] ? 1 : 0, "Momentum 6 meses"),
    stats((i) => c[i] > c[i - 252] ? 1 : 0, "Momentum 12 meses"),
    stats((i) => vs(i), "Segurar com tamanho por volatilidade (alvo 15%)"),
    stats((i) => (c[i] > ma(200, i) ? 1 : 0) * vs(i), "M\xE9dia 200d + volatilidade"),
    stats((i) => (c[i] > c[i - 252] ? 1 : 0) * vs(i), "Momentum 12m + volatilidade")
  ];
  const juros = await fred("DFII10");
  const dxy = new Map((await yahooDesde("DX-Y.NYB", 2003)).map((x) => [x.d, x.c]));
  const idx = new Map(g.map((x, i) => [x.d, i]));
  function lead(serie, dif, nome) {
    const ds = [...serie.keys()].filter((d) => idx.has(d)).sort();
    const A = [], B = [], S1 = [], S2 = [];
    const per = {};
    for (let k = 1; k < ds.length - 1; k++) {
      const i0 = idx.get(ds[k - 1]), i1 = idx.get(ds[k]), i2 = idx.get(ds[k + 1]);
      const x = dif ? serie.get(ds[k]) - serie.get(ds[k - 1]) : Math.log(serie.get(ds[k]) / serie.get(ds[k - 1]));
      const gHoje = Math.log(c[i1] / c[i0]), gAmanha = Math.log(c[i2] / c[i1]);
      S1.push(x);
      S2.push(gHoje);
      A.push(x);
      B.push(gAmanha);
      const dec = ds[k].slice(0, 3) + "0s";
      per[dec] ||= { a: [], b: [] };
      per[dec].a.push(x);
      per[dec].b.push(gAmanha);
    }
    return { nome, mesmo_dia: r3(corr(S1, S2)), antecipa_dia_seguinte: r3(corr(A, B)), n: A.length, por_decada: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, r3(corr(v.a, v.b))])) };
  }
  const antecip = [lead(juros, true, "Juros reais EUA 10 anos (varia\xE7\xE3o)"), lead(dxy, false, "D\xF3lar (DXY)")];
  const mes = {};
  let ini = 0;
  for (let i = 1; i < n; i++) if (g[i].d.slice(0, 7) !== g[i - 1].d.slice(0, 7)) {
    if (ini) {
      const m = +g[i - 1].d.slice(5, 7);
      (mes[m] ||= []).push((c[i - 1] / c[ini - 1] - 1) * 100);
    }
    ini = i;
  }
  const sazon = Object.fromEntries(Object.entries(mes).map(([m, v]) => [m, { media: r3(mean(v)), t: r3(tstat(v)), n: v.length }]));
  const dow = {};
  for (let i = 1; i < n; i++) {
    const w = (/* @__PURE__ */ new Date(g[i].d + "T12:00:00Z")).getUTCDay();
    (dow[w] ||= []).push(r[i] * 100);
  }
  const semana = Object.fromEntries(Object.entries(dow).map(([w, v]) => [w, { media: r3(mean(v)), t: r3(tstat(v)) }]));
  return { periodo: [g[0].d, g[n - 1].d], regras, antecip, sazon, semana };
}
function logit(X, y, lam = 1) {
  const p = X[0].length;
  let w = new Array(p).fill(0);
  for (let it = 0; it < 8; it++) {
    const H = Array.from({ length: p }, () => new Array(p).fill(0)), g = new Array(p).fill(0);
    for (let i = 0; i < X.length; i++) {
      const xi = X[i];
      let z = 0;
      for (let j = 0; j < p; j++) z += w[j] * xi[j];
      const mu = 1 / (1 + Math.exp(-z)), s = mu * (1 - mu), e = y[i] - mu;
      for (let j = 0; j < p; j++) {
        g[j] += e * xi[j];
        const a = s * xi[j];
        for (let k = j; k < p; k++) H[j][k] += a * xi[k];
      }
    }
    for (let j = 0; j < p; j++) {
      for (let k = 0; k < j; k++) H[j][k] = H[k][j];
      if (j) {
        H[j][j] += lam;
        g[j] -= lam * w[j];
      }
    }
    const A = H.map((r, j) => [...r, g[j]]);
    for (let c = 0; c < p; c++) {
      let m = c;
      for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[m][c])) m = r;
      [A[c], A[m]] = [A[m], A[c]];
      for (let r = 0; r < p; r++) if (r !== c) {
        const f = A[r][c] / A[c][c];
        for (let k = c; k <= p; k++) A[r][k] -= f * A[c][k];
      }
    }
    const d = A.map((r, j) => r[p] / r[j]);
    w = w.map((x, j) => x + d[j]);
    if (Math.max(...d.map(Math.abs)) < 1e-6) break;
  }
  return w;
}
function auc(ps) {
  const o = [...ps].sort((a, b) => a[0] - b[0]);
  let pos = 0, rs = 0;
  o.forEach((x, j) => {
    if (x[1]) {
      pos++;
      rs += j + 1;
    }
  });
  return (rs - pos * (pos + 1) / 2) / (pos * (o.length - pos));
}
async function dvol(usaIV) {
  const iv = /* @__PURE__ */ new Map();
  const ini = Date.UTC(2021, 2, 24), agora = Date.now();
  for (let s = ini; s < agora; s += 1e3 * H1) {
    const r = await fetch(`https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=${s}&end_timestamp=${s + 1e3 * H1}&resolution=3600`);
    const j = await r.json();
    for (const d of j.result?.data ?? []) iv.set(+d[0], +d[4]);
  }
  const { data } = await sb.rpc("velas_json");
  const bars = data.map((r) => ({ t: +r[0], h: r[2], l: r[3], c: r[4], v: r[5] }));
  const evMs = Core.eventsToMs(EVENTOS).slice().sort((a, b) => a - b);
  const P = Alerta.preparar(bars), n = bars.length;
  const E = new Float64Array(n).fill(NaN);
  for (let i = 0; i + 24 < n; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let k = i + 1; k <= i + 24; k++) {
      hi = Math.max(hi, bars[k].h);
      lo = Math.min(lo, bars[k].l);
    }
    E[i] = Math.max(Math.log(hi / bars[i].c), Math.log(bars[i].c / lo));
  }
  const lr = bars.map((b, i) => i ? Math.log(b.c / bars[i - 1].c) : 0);
  const cols = Alerta.COEF.producao.cols;
  const rows = [];
  for (let i = 9600; i + 24 < n; i += 6) {
    const tDec = bars[i].t + H1;
    const ivNow = iv.get(bars[i].t), iv24 = iv.get(bars[i].t - 24 * H1);
    if (ivNow == null || iv24 == null) continue;
    const hist = [];
    for (let k = 1; k <= 720; k += 6) {
      const x = iv.get(bars[i].t - k * H1);
      if (x != null) hist.push(x);
    }
    if (hist.length < 60) continue;
    const f = Alerta.features(P, i, evMs);
    if (!f) continue;
    const win = [];
    for (let k = i - 24 - 719; k <= i - 24; k += 6) win.push(E[k]);
    win.sort((a, b) => a - b);
    const med = win[Math.floor(win.length / 2)];
    const rv720 = sd(lr.slice(i - 719, i + 1)) * Math.sqrt(8760) * 100, rv24 = sd(lr.slice(i - 23, i + 1)) * Math.sqrt(8760) * 100;
    const extra = [Math.log(ivNow / rv720), Math.log(ivNow / rv24), Math.log(ivNow / iv24), (ivNow - mean(hist)) / sd(hist)].map((x) => Math.max(-5, Math.min(5, x)));
    rows.push({ t: tDec, base: cols.map((k) => f[k]), extra, y: E[i] >= 1.75 * med ? 1 : 0 });
  }
  const res = { n: rows.length, desde: new Date(rows[0].t).toISOString().slice(0, 10) };
  for (const [nome, usa] of [[usaIV ? "com volatilidade impl\xEDcita" : "sem volatilidade impl\xEDcita", usaIV]]) {
    const pts = [];
    for (const ano of [2023, 2024, 2025, 2026]) {
      const t0 = Date.UTC(ano, 0, 1), t1 = Date.UTC(ano + 1, 0, 1);
      const tr = rows.filter((r) => r.t < t0 - 24 * H1), te = rows.filter((r) => r.t >= t0 && r.t < t1);
      if (!te.length) continue;
      const feat = (r) => usa ? [...r.base, ...r.extra] : r.base;
      const Xtr = tr.map(feat), p = Xtr[0].length, mu = new Array(p).fill(0), sg = new Array(p).fill(0);
      for (const x of Xtr) x.forEach((v, j) => mu[j] += v / Xtr.length);
      for (const x of Xtr) x.forEach((v, j) => sg[j] += (v - mu[j]) ** 2 / Xtr.length);
      const z = (x) => [1, ...x.map((v, j) => (v - mu[j]) / (Math.sqrt(sg[j]) || 1))];
      const w = logit(Xtr.map(z), tr.map((r) => r.y));
      for (const r of te) {
        const xx = z(feat(r));
        let s = 0;
        xx.forEach((v, j) => s += v * w[j]);
        pts.push([1 / (1 + Math.exp(-s)), r.y]);
      }
    }
    const o = [...pts].sort((a, b) => a[0] - b[0]), dec = [];
    for (let d = 0; d < 10; d++) {
      const sl = o.slice(Math.floor(d * o.length / 10), Math.floor((d + 1) * o.length / 10));
      dec.push(r3(sl.reduce((s, x) => s + x[1], 0) / sl.length));
    }
    const top5 = o.slice(Math.floor(o.length * 0.95));
    res[nome] = { auc: r3(auc(pts)), base: r3(mean(pts.map((x) => x[1]))), decis: dec, top5pct: r3(mean(top5.map((x) => x[1]))) };
  }
  const q = [...rows].sort((a, b) => a.extra[0] - b.extra[0]);
  res.quintis_iv_sobre_realizado = [0, 1, 2, 3, 4].map((k) => r3(mean(q.slice(Math.floor(k * q.length / 5), Math.floor((k + 1) * q.length / 5)).map((r) => r.y))));
  return res;
}
const limpa = (s) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
async function pagina(u) {
  const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" } });
  return r.ok ? await r.text() : "";
}
function linhas(html) {
  const out = [];
  for (const tr of html.split(/<tr[\s>]/i).slice(1)) {
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => limpa(m[1]));
    if (tds.length >= 4) out.push(tds);
  }
  return out;
}
async function fda() {
  const idx = await pagina("https://www.fda.gov/drugs/development-approval-process-drugs/novel-drug-approvals-fda");
  const links = /* @__PURE__ */ new Map();
  for (const m of idx.matchAll(/href="([^"]*novel-drug-approvals-(20\d\d)[^"]*)"/gi)) {
    const ano = +m[2];
    if (ano >= 2015 && !links.has(ano)) links.set(ano, m[1].startsWith("http") ? m[1] : "https://www.fda.gov" + m[1]);
  }
  const rows = [];
  const anos = {};
  for (const [ano, u] of [...links.entries()].sort()) {
    const ls = linhas(await pagina(u));
    anos[ano] = ls.length;
    for (const td of ls) {
      const off = /^\d+\.?$/.test(td[0]) ? 1 : 0;
      const marca = td[off], princ = td[off + 1], dt = td[off + 2], uso = td.slice(off + 3).join(" ");
      const d = new Date(dt);
      if (isNaN(+d)) continue;
      rows.push({ id: `${ano}|${marca}`.toUpperCase(), fonte: "CDER", ano, data: d.toISOString().slice(0, 10), marca, principio: princ, uso: uso.slice(0, 600) });
    }
  }
  const cber = linhas(await pagina("https://www.fda.gov/vaccines-blood-biologics/cellular-gene-therapy-products/approved-cellular-and-gene-therapy-products"));
  const emp = /* @__PURE__ */ new Map();
  for (const q of ['submissions.submission_class_code:"TYPE 1"', "application_number:BLA*"]) {
    for (let skip = 0; skip < 3e3; skip += 1e3) {
      const r = await fetch(`https://api.fda.gov/drug/drugsfda.json?search=${encodeURIComponent(q)}&limit=1000&skip=${skip}`);
      if (!r.ok) break;
      const j = await r.json();
      for (const a of j.results ?? []) for (const p of a.products ?? []) emp.set(String(p.brand_name).toUpperCase(), a.sponsor_name);
      if ((j.results ?? []).length < 1e3) break;
    }
  }
  for (const r of rows) r.empresa = emp.get(String(r.marca).toUpperCase()) ?? null;
  for (let i = 0; i < rows.length; i += 200) await sb.from("pesquisa_fda").upsert(rows.slice(i, i + 200));
  return { anos, total: rows.length, com_empresa: rows.filter((r) => r.empresa).length, cber_linhas: cber.length, cber_exemplo: cber.slice(0, 3) };
}
Deno.serve(async (req) => {
  const tk = await sb.from("interno").select("valor").eq("chave", "ciclo_token").maybeSingle();
  if (req.headers.get("x-ciclo-token") !== tk.data?.valor) return new Response("nao autorizado", { status: 401 });
  const { modo } = await req.json();
  try {
    const r = modo === "funding" ? await funding() : modo === "ouro" ? await ouro() : modo === "fda" ? await fda() : modo === "dvol" ? await dvol(false) : modo === "dvol-iv" ? await dvol(true) : await correl();
    return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ erro: String(e) }), { status: 500 });
  }
});
