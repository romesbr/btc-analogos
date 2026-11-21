// BTC · Análogos — servidor 24h (Node 20+, sem dependências externas)
// Coleta dados públicos da Binance, avalia o momento a cada hora fechada comparando com o histórico,
// gera sugestões, julga lucro/prejuízo (taxas + funding) e serve um site privado com senha.
"use strict";
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const Core = require("./core.js");

// ---------------- Configuração (.env) ----------------
function loadEnv(file) {
  try { for (const line of fs.readFileSync(file, "utf8").split("\n")) { const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch (e) {}
}
loadEnv(path.join(__dirname, ".env"));
const env = (k, d) => process.env[k] ?? d;
const PORT = +env("PORT", 8080), HOST = env("HOST", "127.0.0.1");
const PASSWORD = env("PANEL_PASSWORD", "");
const DATA = env("DATA_DIR", path.join(__dirname, "dados"));
const API_OVERRIDE = env("API_OVERRIDE", ""); // apenas para testes
fs.mkdirSync(DATA, { recursive: true });
const DEFAULT_CFG = { k: 50, wPreco: 1, wCal: 3, wMacro: 1, minAgreement: 0.60, costMargin: 1.5, stopMult: 1.5, targetMult: 1.5, feeTaker: 0.0005, macroBlockMin: 30 };
const HORIZONS = [1, 4], H1 = 3600e3;
const SOURCES = [
  { id: "fut", nome: "Binance Futuros · BTCUSDT perpétuo", base: "https://fapi.binance.com/fapi/v1", funding: true, oi: true, max: 1500 },
  { id: "spot", nome: "Binance Spot · BTCUSDT (reserva, sem funding)", base: "https://data-api.binance.vision/api/v3", funding: false, oi: false, max: 1000 },
];
if (API_OVERRIDE) for (const s of SOURCES) s.base = API_OVERRIDE;
const START_MS = 1567900800000; // 08/09/2019, início do perpétuo BTCUSDT

// ---------------- Persistência simples (JSON) ----------------
const file = n => path.join(DATA, n);
const readJSON = (n, d) => { try { return JSON.parse(fs.readFileSync(file(n), "utf8")); } catch (e) { return d; } };
const writeJSON = (n, v) => { const tmp = file(n + ".tmp"); fs.writeFileSync(tmp, JSON.stringify(v)); fs.renameSync(tmp, file(n)); };
let cfg = Object.assign({}, DEFAULT_CFG, readJSON("config.json", {}));
let sugestoes = readJSON("sugestoes.json", []);
let avaliacoes = readJSON("avaliacoes.json", []);
let oiHist = readJSON("open_interest.json", []);
let funding = readJSON("funding.json", []);
let bars1h = [], candles1m = [], SRC = null, lastEval = null, F = null, lastPrice = null, lastTick = 0, status = "iniciando";
const logs = [];
const evMs = Core.eventsToMs(JSON.parse(fs.readFileSync(path.join(__dirname, "eventos.json"), "utf8")));
function log(msg) { const line = `[${new Date().toISOString()}] ${msg}`; console.log(line); logs.unshift(line); logs.length = Math.min(logs.length, 300); }

// ---------------- Binance ----------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJSON(url) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (r.status === 429 || r.status === 418) { await sleep(30000 * (i + 1)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
      return await r.json();
    } catch (e) { if (i === 4) throw e; await sleep(2000 * (i + 1)); }
  }
}
const toBar = k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], ct: +k[6] });
const strip = ({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v });
async function fetchKlines(interval, startMs, limit) {
  const out = []; let t = startMs;
  while (true) {
    const rows = await getJSON(`${SRC.base}/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit || SRC.max}${t != null ? `&startTime=${t}` : ""}`);
    if (!rows.length) break;
    out.push(...rows.map(toBar));
    if (t == null || rows.length < (limit || SRC.max)) break;
    const nt = +rows[rows.length - 1][0] + 1; if (nt <= t) break; t = nt;
    await sleep(250);
  }
  return out;
}
async function pickSource() {
  for (const s of SOURCES) {
    try { SRC = s; await getJSON(`${s.base}/klines?symbol=BTCUSDT&interval=1h&limit=2`); log(`Fonte: ${s.nome}`); return; }
    catch (e) { log(`Fonte indisponível (${s.nome}): ${e.message}`); }
  }
  SRC = null; throw new Error("Nenhuma fonte da Binance respondeu a partir deste servidor.");
}
async function syncHistory() {
  const key = `velas_1h_${SRC.id}.json`;
  if (!bars1h.length) bars1h = readJSON(key, []);
  const start = bars1h.length ? bars1h[bars1h.length - 1].t + H1 : START_MS;
  const now = Date.now();
  const fresh = (await fetchKlines("1h", start)).filter(b => b.ct < now).map(strip);
  if (fresh.length) {
    const map = new Map(bars1h.map(b => [b.t, b])); for (const b of fresh) map.set(b.t, b);
    bars1h = [...map.values()].sort((a, b) => a.t - b.t);
    writeJSON(key, bars1h);
  }
  return fresh.length;
}
async function syncFunding() {
  if (!SRC.funding) return;
  const since = funding.length ? funding[funding.length - 1].t + 1 : Date.now() - 30 * 86400e3;
  const rows = await getJSON(`${SRC.base}/fundingRate?symbol=BTCUSDT&limit=1000&startTime=${since}`);
  if (rows.length) { funding.push(...rows.map(r => ({ t: +r.fundingTime, rate: +r.fundingRate }))); funding = funding.slice(-5000); writeJSON("funding.json", funding); }
}
async function snapshotOI() {
  if (!SRC.oi) return;
  try { const r = await getJSON(`${SRC.base}/openInterest?symbol=BTCUSDT`); oiHist.push({ t: +r.time, oi: +r.openInterest, preco: lastPrice }); writeJSON("open_interest.json", oiHist); } catch (e) { log("Open interest indisponível: " + e.message); }
}
async function sync1m() {
  const open = sugestoes.filter(s => s.status === "aberta");
  const since = Math.min(Date.now() - 3 * H1, ...open.map(s => s.criada - 60e3));
  const have = candles1m.length ? candles1m[candles1m.length - 1].t : 0;
  const first = candles1m.length ? candles1m[0].t : Infinity;
  const start = (first > since) ? since : have; // recarrega do início se faltar trecho necessário
  const rows = (await fetchKlines("1m", start)).map(strip);
  const map = new Map((first > since ? [] : candles1m).map(b => [b.t, b])); for (const b of rows) map.set(b.t, b);
  candles1m = [...map.values()].sort((a, b) => a.t - b.t);
  const keepFrom = Math.min(Date.now() - 6 * H1, ...open.map(s => s.criada - 60e3));
  candles1m = candles1m.filter(b => b.t >= keepFrom);
  if (candles1m.length) lastPrice = candles1m[candles1m.length - 1].c;
}

// ---------------- Motor e juiz ----------------
function evaluate(createSuggestions) {
  F = Core.build(bars1h, evMs, HORIZONS);
  const qi = F.n - 1, now = Date.now(), decTs = F.dec[qi];
  const res = { decTs, porH: {}, avaliadoEm: now };
  if (!F.valid[qi]) { lastEval = res; return; }
  for (const H of HORIZONS) {
    const a = Core.analogs(F, qi, H, decTs, { p: cfg.wPreco, c: cfg.wCal, m: cfg.wMacro }, cfg.k);
    if (!a) continue;
    const price = lastPrice ?? F.close[qi];
    const d = Core.decide(a, price, now, evMs, cfg);
    const fresh = now - decTs <= 10 * 60e3;
    const jaAberta = sugestoes.some(s => s.status === "aberta" && s.horizonte === H);
    let motivo = d.motivos.join("; "), sugeriu = false;
    if (createSuggestions && d.sugere && fresh && !jaAberta && !sugestoes.some(s => s.decTs === decTs && s.horizonte === H)) {
      sugestoes.push({ id: `${decTs}_${H}`, decTs, criada: now, horizonte: H, lado: d.side, entrada: d.entrada, stop: d.stop, alvo: d.alvo,
        expira: d.expira, prev: a.mean, concordancia: d.agree, status: "aberta" });
      writeJSON("sugestoes.json", sugestoes); sugeriu = true; motivo = "sugestão criada";
      log(`Nova sugestão ${d.side} (${H} h) a ${d.entrada}`);
    } else if (d.sugere && !fresh) motivo = "avaliação fora da janela de decisão";
    else if (d.sugere && jaAberta) motivo = "já existe sugestão aberta neste prazo";
    if (createSuggestions && !avaliacoes.some(x => x.decTs === decTs && x.H === H)) {
      avaliacoes.push({ decTs, H, prev: a.mean, up: a.up, sd: a.sd, sugeriu, motivo }); writeJSON("avaliacoes.json", avaliacoes);
    }
    const nb = a.neighbors.slice(0, 12).map(x => ({ dec: x.dec, dist: x.dist, f1: F.fwd[1][x.i], f4: F.fwd[4][x.i] }));
    res.porH[H] = { mean: a.mean, median: a.median, up: a.up, sd: a.sd, baseSize: a.baseSize, decisao: d, motivo, vizinhos: nb };
  }
  lastEval = res;
}
function runJudge() {
  if (!candles1m.length) return;
  let changed = false; const now = Date.now();
  sugestoes = sugestoes.map(s => {
    if (s.status !== "aberta") return s;
    const r = Core.judge(s, candles1m, funding, now, cfg);
    if (r.status !== s.status) { changed = true; log(`Sugestão ${s.lado} (${s.horizonte} h) fechada: ${r.motivo}, ${r.liquido.toFixed(2)}%`); }
    return r;
  });
  if (changed) writeJSON("sugestoes.json", sugestoes);
}

// ---------------- Ciclo ----------------
let busy = false;
async function tick() {
  if (busy) return; busy = true;
  try {
    if (!SRC) { await pickSource(); await syncHistory(); await syncFunding().catch(e => log("Funding: " + e.message)); await sync1m(); evaluate(true); status = "ok"; }
    await sync1m();
    const lastT = bars1h.length ? bars1h[bars1h.length - 1].t : 0;
    if (Date.now() - (lastT + H1) >= H1 + 2000) { // fechou uma hora nova
      const n = await syncHistory();
      if (n) { await syncFunding().catch(e => log("Funding: " + e.message)); await snapshotOI(); evaluate(true); }
    }
    runJudge();
    lastTick = Date.now(); status = "ok";
  } catch (e) { status = "erro: " + e.message; log("Erro no ciclo: " + e.message); if (/Nenhuma fonte/.test(e.message)) SRC = null; }
  finally { busy = false; }
}

// ---------------- Site ----------------
function authOK(req) {
  if (!PASSWORD) return true;
  const h = req.headers.authorization || ""; if (!h.startsWith("Basic ")) return false;
  const pass = Buffer.from(h.slice(6), "base64").toString().split(":").slice(1).join(":");
  const a = Buffer.from(pass), b = Buffer.from(PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const candleCache = new Map();
async function candles(interval) {
  const c = candleCache.get(interval); if (c && Date.now() - c.at < 15000) return c.data;
  const data = (await fetchKlines(interval, null, 500)).map(strip); candleCache.set(interval, { at: Date.now(), data }); return data;
}
function stateJSON() {
  return { status, fonte: SRC ? SRC.nome : null, fonteId: SRC ? SRC.id : null, agora: Date.now(), ultimoCiclo: lastTick, preco: lastPrice,
    horasHistorico: bars1h.length, proximaAvaliacao: bars1h.length ? bars1h[bars1h.length - 1].t + 2 * H1 : null,
    cfg, estado: lastEval, sugestoes, horasAvaliadas: new Set(avaliacoes.map(a => a.decTs)).size, logs: logs.slice(0, 60),
    oiAmostras: oiHist.length };
}
function csv() {
  const cols = ["criada", "horizonte", "lado", "entrada", "stop", "alvo", "prev", "concordancia", "status", "motivo", "saida", "saidaT", "bruto", "taxas", "funding", "liquido"];
  const f = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });
  return [cols.join(";")].concat(sugestoes.map(s => cols.map(c => { const v = s[c]; if (c === "criada" || c === "saidaT") return v ? f.format(new Date(v)) : ""; return v == null ? "" : String(v).replace(".", ","); }).join(";"))).join("\n");
}
const server = http.createServer(async (req, res) => {
  if (!authOK(req)) { res.writeHead(401, { "WWW-Authenticate": 'Basic realm="BTC Analogos", charset="UTF-8"' }); return res.end("Senha necessária"); }
  const u = new URL(req.url, "http://x");
  try {
    if (u.pathname === "/" || u.pathname === "/index.html") { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return res.end(fs.readFileSync(path.join(__dirname, "public", "index.html"))); }
    if (u.pathname === "/api/state") { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); return res.end(JSON.stringify(stateJSON())); }
    if (u.pathname === "/api/candles") { const iv = u.searchParams.get("interval") === "15m" ? "15m" : "1h"; res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(await candles(iv))); }
    if (u.pathname === "/api/sugestoes.csv") { res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=sugestoes_btc.csv" }); return res.end("﻿" + csv()); }
    if (u.pathname === "/api/open_interest.json") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(oiHist)); }
    if (u.pathname === "/api/config" && req.method === "POST") {
      let body = ""; for await (const ch of req) body += ch;
      const inc = JSON.parse(body || "{}");
      for (const k of Object.keys(DEFAULT_CFG)) if (k in inc && isFinite(+inc[k])) cfg[k] = +inc[k];
      writeJSON("config.json", cfg); log("Configurações alteradas: " + JSON.stringify(cfg));
      if (bars1h.length) evaluate(false);
      res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(cfg));
    }
    if (u.pathname === "/api/reset" && req.method === "POST") {
      sugestoes = []; avaliacoes = []; writeJSON("sugestoes.json", sugestoes); writeJSON("avaliacoes.json", avaliacoes); log("Placar zerado.");
      res.writeHead(200); return res.end("ok");
    }
    res.writeHead(404); res.end("não encontrado");
  } catch (e) { res.writeHead(500); res.end("erro: " + e.message); }
});
server.listen(PORT, HOST, () => log(`Site em http://${HOST}:${PORT} ${PASSWORD ? "(com senha)" : "(SEM SENHA — defina PANEL_PASSWORD)"}`));
tick(); setInterval(tick, 20000);
