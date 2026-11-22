// Indicador de grande movimento (sem direção). Probabilidade de a maior excursão das próximas 24h
// passar de 1,75× a excursão típica dos últimos 30 dias. Modelo logístico treinado no histórico (2017–2026).
// bars: velas de 1h [{t (abertura, ms), h, l, c, v}] contínuas; evMs: horários de anúncios macro (ms, ordenados).
const H1 = 3600e3;
export const COEF = {"ate2022": {"cols": ["rv24_720", "rv168_720", "rv720_1y", "comp8", "comp24", "comp72", "vol4", "vol24", "vol_tr", "ret24", "dist_hi", "dist_lo", "hs", "hc", "fds", "macro24"], "coef": [-0.5274555895730857, -0.07578164859249922, -0.33213600363345147, 0.3325954117957467, 0.4428632610087682, 0.293763539157524, 0.24350392854992642, 1.1145654567558259, -1.3037265623049417, 0.10384278103790907, -0.15085188276027506, -0.15287916165347443, -0.0016771488893006373, 0.1056673559194954, -0.21215642140229843, 0.24298774418573788], "b": -0.8711527073771604}, "producao": {"cols": ["rv24_720", "rv168_720", "rv720_1y", "comp8", "comp24", "comp72", "vol4", "vol24", "vol_tr", "ret24", "dist_hi", "dist_lo", "hs", "hc", "fds", "macro24"], "coef": [-0.2306122237124437, -0.031656188191180656, -0.4641036575608609, 0.348886373938486, 0.40029631295776413, 0.2307711792380868, 0.1609207467022752, 0.9075575873689556, -1.2546297463443483, 0.12767262299432172, -0.12369438094892755, -0.1420047300064355, 0.00740507172787404, 0.12024403412845512, -0.32310325753324615, 0.2551851202684021], "b": -0.9134125454691304}};
const nyFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, weekday: "short", hour: "numeric" });
function ny(ms) { const p = {}; for (const x of nyFmt.formatToParts(new Date(ms))) p[x.type] = x.value; return { wd: p.weekday, hour: (+p.hour) % 24 }; }
export function preparar(bars) {
  const n = bars.length, r = new Float64Array(n), S1 = new Float64Array(n + 1), S2 = new Float64Array(n + 1), V = new Float64Array(n + 1);
  for (let i = 1; i < n; i++) r[i] = Math.log(bars[i].c / bars[i - 1].c);
  for (let i = 0; i < n; i++) { S1[i + 1] = S1[i] + r[i]; S2[i + 1] = S2[i] + r[i] * r[i]; V[i + 1] = V[i] + bars[i].v; }
  const P = { n, r, S1, S2, V, bars, G: {} };
  // séries auxiliares e somas acumuladas (para desvio em relação à média de 720 períodos)
  for (const k of [8, 24, 72]) {
    const s = new Float64Array(n), cs = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) { s[i] = i >= k - 1 ? Math.log(Math.log(rmax(P, i, k, "h") / rmin(P, i, k, "l"))) : NaN; cs[i + 1] = cs[i] + (isFinite(s[i]) ? s[i] : 0); }
    P.G["rng" + k] = { s, cs };
  }
  for (const k of [4, 24]) {
    const s = new Float64Array(n), cs = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) { s[i] = i >= k - 1 ? Math.log(V[i + 1] - V[i + 1 - k] + 1e-6) : NaN; cs[i + 1] = cs[i] + (isFinite(s[i]) ? s[i] : 0); }
    P.G["lv" + k] = { s, cs };
  }
  return P;
}
// desvio-padrão (ddof=1) dos retornos das últimas k velas terminando em i
function sd(P, i, k) { const a = i + 1 - k; if (a < 1) return NaN; const s = P.S1[i + 1] - P.S1[a], q = P.S2[i + 1] - P.S2[a]; return Math.sqrt((q - s * s / k) / (k - 1)); }
function rmax(P, i, k, f) { let m = -Infinity; for (let j = i - k + 1; j <= i; j++) m = Math.max(m, P.bars[j][f]); return m; }
function rmin(P, i, k, f) { let m = Infinity; for (let j = i - k + 1; j <= i; j++) m = Math.min(m, P.bars[j][f]); return m; }
function desvMedia(P, nome, i) { const { s, cs } = P.G[nome]; return s[i] - (cs[i + 1] - cs[i - 719]) / 720; }
const clip = (x) => Math.max(-5, Math.min(5, x));
export function features(P, i, evMs) {
  if (i < 8760 + 800) return null;
  const b = P.bars, c = b[i].c, s720 = sd(P, i, 720), s24 = s720 * Math.sqrt(24);
  const f = {
    rv24_720: Math.log(sd(P, i, 24) / s720), rv168_720: Math.log(sd(P, i, 168) / s720), rv720_1y: Math.log(s720 / sd(P, i, 8760)),
    comp8: desvMedia(P, "rng8", i), comp24: desvMedia(P, "rng24", i), comp72: desvMedia(P, "rng72", i),
    vol4: desvMedia(P, "lv4", i), vol24: desvMedia(P, "lv24", i),
    vol_tr: Math.log((P.V[i + 1] - P.V[i - 23] + 1e-6) / ((P.V[i + 1] - P.V[i - 167]) / 7 + 1e-6)),
    ret24: Math.abs(P.S1[i + 1] - P.S1[i - 23]) / s24,
    dist_hi: Math.log(rmax(P, i, 720, "h") / c) / s24, dist_lo: Math.log(c / rmin(P, i, 720, "l")) / s24,
  };
  const t = ny(b[i].t); f.hs = Math.sin(2 * Math.PI * t.hour / 24); f.hc = Math.cos(2 * Math.PI * t.hour / 24);
  f.fds = (t.wd === "Sat" || t.wd === "Sun" || (t.wd === "Fri" && t.hour >= 17)) ? 1 : 0;
  const dec = b[i].t + H1; let prox = Infinity; for (const e of evMs) if (e > dec) { prox = e; break; }
  f.macro24 = prox - dec <= 24 * H1 ? 1 : 0;
  for (const k in f) f[k] = clip(f[k]);
  return f;
}
export function prob(f, M = COEF.producao) { if (!f) return null; let z = M.b; M.cols.forEach((k, j) => z += M.coef[j] * f[k]); return 1 / (1 + Math.exp(-z)); }
export function nivel(p) { return p == null ? "—" : p >= 0.45 ? "MUITO ALTO" : p >= 0.3 ? "ALTO" : p >= 0.15 ? "NORMAL" : "BAIXO"; }
// excursão típica dos últimos 30 dias (mediana da maior excursão em 24h), para dizer quanto é "grande" agora
export function excursaoTipica(P, i) {
  const b = P.bars, xs = [];
  for (let j = i - 24 - 719; j <= i - 24; j++) { let hi = -Infinity, lo = Infinity; for (let k = j + 1; k <= j + 24; k++) { hi = Math.max(hi, b[k].h); lo = Math.min(lo, b[k].l); } xs.push(Math.max(Math.log(hi / b[j].c), Math.log(b[j].c / lo))); }
  xs.sort((a, b) => a - b); return xs[Math.floor(xs.length / 2)];
}
