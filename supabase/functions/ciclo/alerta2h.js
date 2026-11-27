// Indicador de "tranco" nas próximas 2 horas (sem direção): chance de a maior excursão das próximas 2 velas de 1h
// passar do dobro da excursão típica de 2h dos últimos 30 dias. Modelo logístico treinado em 2021–2026 (Binance),
// com a abertura de Nova York como variável. Teste fora da amostra (2023–26): BAIXO 7%, NORMAL 17%, ALTO 34%, MUITO ALTO 62%.
const H1 = 3600e3;
export const MODELO = {"w": [-1.953520129884887, -0.02117885480273916, 0.30359676881932873, 0.10568257361007313, 0.12376478182481543, 0.5215391090475908, 0.18121031304214405, 0.07452088299541926, 0, 0.3261190156139598, 0.22973739198574036], "mu": [-0.19525247333319407, -0.05566597819408608, -0.002725732546724002, -0.0022552638670363784, -0.0036416060693721234, -0.003189960969604299, 0.28561492987131953, 0, 0.05954174877322912, 0.05954174877322912], "sd": [0.46887177433557575, 0.24536733913444872, 0.5907347232416139, 0.536829809118364, 0.6657855445464128, 0.4754049405675863, 0.45170680945278047, 0, 0.23663585722845681, 0.23663585722845681], "cols": ["rv24_720", "rv168_720", "comp8", "comp24", "vol4", "vol24", "fds", "macro2", "abertura", "pos_abertura"]};
const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "numeric" });
const DIAS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function ny(ms) { const dia = Math.floor(ms / 864e5); const off = (+fmt.format(new Date(dia * 864e5 + 12 * H1)) % 24) - 12; const loc = new Date(ms + off * H1); return { wd: DIAS[loc.getUTCDay()], h: loc.getUTCHours(), m: loc.getUTCMinutes() }; }
// P = Alerta.preparar(bars); i = índice da última vela fechada; evMs = anúncios macro ordenados
export function features(P, i, evMs) {
  const sdk = (k) => { const a = i + 1 - k, s = P.S1[i + 1] - P.S1[a], q = P.S2[i + 1] - P.S2[a]; return Math.sqrt((q - s * s / k) / (k - 1)); };
  const dm = (nome) => { const { s, cs } = P.G[nome]; return s[i] - (cs[i + 1] - cs[i - 719]) / 720; };
  const cl = (x) => Math.max(-5, Math.min(5, x));
  const dec = P.bars[i].t + H1, a = ny(dec), util = a.wd !== "Sat" && a.wd !== "Sun";
  const b = ny(dec + H1); let prox = Infinity; for (const e of evMs) if (e > dec) { prox = e; break; }
  const s720 = sdk(720);
  return { rv24_720: cl(Math.log(sdk(24) / s720)), rv168_720: cl(Math.log(sdk(168) / s720)), comp8: cl(dm("rng8")), comp24: cl(dm("rng24")), vol4: cl(dm("lv4")), vol24: cl(dm("lv24")),
    fds: util ? 0 : 1, macro2: prox - dec <= 2 * H1 ? 1 : 0, abertura: util && (a.h === 9 || b.h === 9) ? 1 : 0, pos_abertura: util && (a.h === 10 || a.h === 11) ? 1 : 0 };
}
export function prob(f, M = MODELO) { let z = M.w[0]; M.cols.forEach((k, j) => { z += M.w[j + 1] * (f[k] - M.mu[j]) / (M.sd[j] || 1); }); return 1 / (1 + Math.exp(-z)); }
export function nivel(p) { return p >= 0.45 ? "MUITO ALTO" : p >= 0.25 ? "ALTO" : p >= 0.10 ? "NORMAL" : "BAIXO"; }
// excursão típica de 2h nos últimos 30 dias (amostrada a cada 10h), em log
export function tipica2h(bars, i) {
  const xs = []; for (let k = i - 2 - 719; k <= i - 2; k += 10) { const hi = Math.max(bars[k + 1].h, bars[k + 2].h), lo = Math.min(bars[k + 1].l, bars[k + 2].l); xs.push(Math.max(Math.log(hi / bars[k].c), Math.log(bars[k].c / lo))); }
  xs.sort((a, b) => a - b); return xs[Math.floor(xs.length / 2)];
}
