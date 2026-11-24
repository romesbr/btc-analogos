// Laboratório: tendência diária (BTC, ETH, SOL, S&P 500, Ibovespa) e hipóteses que só podem ser testadas ao vivo
// (open interest, funding, proporção de contas compradas/vendidas, gap de fim de semana). Roda a cada 15 min.
// As operações com stop/alvo (grupo C) são julgadas pela função "ciclo"; as posições de tendência (grupo A) são abertas
// e fechadas aqui, pelo próprio sinal diário.
import { createClient } from "jsr:@supabase/supabase-js@2";

const H1 = 3600e3, D1 = 86400e3, FEE = 0.0005;
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}").default;
const sb = createClient(Deno.env.get("SUPABASE_URL")!, key, { auth: { persistSession: false } });
let ATIVAS = new Set<string>();
const FAPI = "https://fapi.binance.com", SPOT = "https://data-api.binance.vision/api/v3";

async function getJSON(url: string, headers: Record<string, string> = {}) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url.slice(0, 80)}`);
      return await r.json();
    } catch (e) { if (i === 2) throw e; await new Promise((r) => setTimeout(r, 1500)); }
  }
}
async function must<T>(p: PromiseLike<{ data: T; error: unknown }>): Promise<T> {
  const { data, error } = await p; if (error) throw new Error(JSON.stringify(error)); return data;
}
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const nyParts = (ms: number) => {
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, weekday: "short", hour: "numeric", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms))) p[x.type] = x.value;
  return { wd: p.weekday, hour: (+p.hour) % 24, date: `${p.year}-${p.month}-${p.day}` };
};

// ---------------- A) tendência diária ----------------
type Dia = { t: number; c: number };
async function diariosCripto(sym: string): Promise<Dia[]> {
  const rows = await getJSON(`${SPOT}/klines?symbol=${sym}&interval=1d&limit=300`);
  const now = Date.now();
  return rows.filter((k: string[]) => +k[6] < now).map((k: string[]) => ({ t: +k[6] + 1, c: +k[4] })); // t = fechamento do dia
}
async function diariosYahoo(sym: string): Promise<Dia[]> {
  const p2 = Math.floor(Date.now() / 1000), p1 = p2 - 420 * 86400;
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${p1}&period2=${p2}&interval=1d`, { "User-Agent": "Mozilla/5.0" });
  const res = j.chart.result[0], ts: number[] = res.timestamp, cl: (number | null)[] = res.indicators.quote[0].close;
  const out: Dia[] = []; for (let i = 0; i < ts.length; i++) if (cl[i] != null) out.push({ t: ts[i] * 1000, c: cl[i] as number });
  // descarta o pregão de hoje se ainda não fechou (mercado aberto): só usa dias com pelo menos 8h desde a abertura registrada
  const meta = res.meta; const fechado = meta?.currentTradingPeriod?.regular?.end ? Date.now() / 1000 > meta.currentTradingPeriod.regular.end : true;
  if (!fechado && out.length) out.pop();
  return out;
}
function sinal(d: Dia[], regra: string): { on: boolean; ref: number } {
  const c = d.map((x) => x.c), n = c.length, last = c[n - 1];
  if (regra.startsWith("ma")) { const k = +regra.slice(2); const m = mean(c.slice(n - k)); return { on: last > m, ref: m }; }
  const L = +regra.slice(3); return { on: last > c[n - 1 - L], ref: c[n - 1 - L] };
}
async function tendencia(log: (m: string) => void) {
  const alvos = [
    { hip: "tend-ma50", regra: "ma50", ativos: ["BTCUSDT", "ETHUSDT", "SOLUSDT"] },
    { hip: "tend-mom28", regra: "mom28", ativos: ["BTCUSDT", "ETHUSDT", "SOLUSDT"] },
    { hip: "protecao-ma200", regra: "ma200", ativos: ["^GSPC"] },
    { hip: "protecao-ma100", regra: "ma100", ativos: ["^BVSP"] },
  ];
  const cache: Record<string, Dia[]> = {};
  const painel: unknown[] = [];
  const abertas = await must(sb.from("sugestoes").select("*").eq("status", "aberta").eq("tipo", "posicao"));
  for (const a of alvos) for (const ativo of a.ativos) {
    try {
      cache[ativo] ??= ativo.startsWith("^") ? await diariosYahoo(ativo) : await diariosCripto(ativo);
      const d = cache[ativo]; if (d.length < 210) continue;
      const dia = d[d.length - 1], s = sinal(d, a.regra);
      // deno-lint-ignore no-explicit-any
      const aberta = abertas.find((x: any) => x.hipotese === a.hip && x.ativo === ativo);
      // volatilidade anualizada dos últimos 20 dias (para dimensionar a posição na carteira)
      const cs = d.map((x) => x.c), rs = cs.slice(-21).map((x, i, a) => i ? Math.log(x / a[i - 1]) : 0).slice(1);
      const vol20 = sd(rs) * Math.sqrt(ativo.startsWith("^") ? 252 : 365) * 100;
      if (s.on && !aberta && ATIVAS.has(a.hip)) {
        await must(sb.from("sugestoes").upsert({ id: `${a.hip}_${ativo}_${dia.t}`, dec_ts: dia.t, criada: dia.t, horizonte: 0, lado: "COMPRA", entrada: dia.c,
          stop: null, alvo: null, expira: null, prev: vol20, concordancia: null, status: "aberta", hipotese: a.hip, ativo, tipo: "posicao" }));
        log(`[${a.hip}] ${ativo}: entrou comprado a ${dia.c}`);
      } else if (!s.on && aberta && dia.t > Number(aberta.criada)) {
        const bruto = (dia.c / aberta.entrada - 1) * 100;
        await must(sb.from("sugestoes").update({ status: "fechada", saida: dia.c, saida_t: dia.t, motivo: "sinal virou", bruto, taxas: 2 * FEE * 100, funding: 0,
          liquido: bruto - 2 * FEE * 100 }).eq("id", aberta.id));
        log(`[${a.hip}] ${ativo}: saiu a ${dia.c} (${(bruto - 0.1).toFixed(2)}%)`);
      }
      if (!ATIVAS.has(a.hip) && !aberta) continue;
      painel.push({ hipotese: a.hip, ativo, regra: a.regra, comprado: s.on, vol20, preco: dia.c, referencia: s.ref, dia: dia.t,
        aberta_desde: s.on ? (aberta ? Number(aberta.criada) : dia.t) : null, entrada: s.on ? (aberta ? aberta.entrada : dia.c) : null });
    } catch (e) { log(`Tendência ${ativo}: ${e}`); }
  }
  return painel;
}

// ---------------- C) hipóteses ao vivo (BTCUSDT perpétuo) ----------------
async function abrir(hip: string, id: string, lado: number, preco: number, stop: number, alvo: number, expira: number, prev: number | null, nota: string, log: (m: string) => void) {
  if (!ATIVAS.has(hip)) return "hipótese desligada (só leitura)";
  const ab = await must(sb.from("sugestoes").select("id").eq("status", "aberta").eq("hipotese", hip));
  if (ab.length) return "já existe operação aberta";
  const ja = await must(sb.from("sugestoes").select("id").eq("id", id));
  if (ja.length) return "já registrada";
  const now = Date.now();
  await must(sb.from("sugestoes").insert({ id, dec_ts: now, criada: now, horizonte: Math.round((expira - now) / H1), lado: lado === 1 ? "COMPRA" : "VENDA", entrada: preco,
    stop, alvo, expira, prev, concordancia: null, status: "aberta", hipotese: hip, ativo: "BTCUSDT", tipo: "operacao" }));
  log(`[${hip}] ${lado === 1 ? "COMPRA" : "VENDA"} a ${preco} — ${nota}`);
  return "sugestão criada";
}
async function hipotesesC(log: (m: string) => void) {
  const out: Record<string, unknown> = {};
  const now = Date.now();
  const k1h = await getJSON(`${FAPI}/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=500`);
  const fechadas = k1h.filter((k: string[]) => +k[6] < now);
  const closes: number[] = fechadas.map((k: string[]) => +k[4]);
  const lastT = +fechadas[fechadas.length - 1][6] + 1; // fechamento da última hora
  const price = +k1h[k1h.length - 1][4];
  const r1 = closes.slice(1).map((x, i) => Math.log(x / closes[i]));
  const sigH = sd(r1.slice(-480)), sig24 = sigH * Math.sqrt(24);
  const fresh = now - lastT <= 20 * 60e3;

  // C1: open interest + preço
  try {
    const oi = await getJSON(`${FAPI}/futures/data/openInterestHist?symbol=BTCUSDT&period=1h&limit=500`);
    const v: number[] = oi.map((x: { sumOpenInterest: string }) => +x.sumOpenInterest);
    const d4 = v.slice(4).map((x, i) => Math.log(x / v[i]));
    const zOI = (d4[d4.length - 1] - mean(d4.slice(-480, -1))) / sd(d4.slice(-480, -1));
    const p4 = Math.log(closes[closes.length - 1] / closes[closes.length - 5]);
    const zP = p4 / (sigH * 2);
    let motivo = `OI ${zOI.toFixed(1)}σ, preço ${zP.toFixed(1)}σ em 4h`;
    if (zOI > 2 && Math.abs(zP) > 1 && fresh) {
      const lado = zP > 0 ? -1 : 1;
      motivo = await abrir("oi-reversao", `oi_${lastT}`, lado, price, price * (1 - lado * 1.5 * sig24), price * (1 + lado * 1.5 * sig24), now + 24 * H1, zOI, motivo, log);
    } else motivo += " — sem sinal (precisa OI > 2σ e preço > 1σ)";
    out["oi-reversao"] = { zOI, zP, motivo, em: lastT };
  } catch (e) { out["oi-reversao"] = { erro: String(e) }; }

  // C2: funding extremo (avaliado na cobrança mais recente)
  try {
    const f = await getJSON(`${FAPI}/fapi/v1/fundingRate?symbol=BTCUSDT&limit=300`);
    const rates: number[] = f.map((x: { fundingRate: string }) => +x.fundingRate);
    const tF = +f[f.length - 1].fundingTime, atual = rates[rates.length - 1];
    const hist = rates.slice(-271, -1).slice().sort((a, b) => a - b);
    const p95 = hist[Math.floor(hist.length * 0.95)], p5 = hist[Math.floor(hist.length * 0.05)];
    let motivo = `funding ${(atual * 100).toFixed(4)}% (p5 ${(p5 * 100).toFixed(4)}%, p95 ${(p95 * 100).toFixed(4)}%)`;
    const recente = now - tF <= 30 * 60e3;
    if (recente && (atual > p95 || atual < p5)) {
      const lado = atual > p95 ? -1 : 1;
      motivo = await abrir("funding-extremo", `fund_${tF}`, lado, price, price * (1 - lado * 1.5 * sig24), price * (1 + lado * 1.5 * sig24), now + 24 * H1, atual, motivo, log);
    } else motivo += recente ? " — dentro da faixa normal" : " — aguardando próxima cobrança";
    out["funding-extremo"] = { atual, p5, p95, motivo, em: tF };
  } catch (e) { out["funding-extremo"] = { erro: String(e) }; }

  // C3: proporção de contas compradas/vendidas
  try {
    const ls = await getJSON(`${FAPI}/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=1h&limit=500`);
    const lr: number[] = ls.map((x: { longShortRatio: string }) => Math.log(+x.longShortRatio));
    const z = (lr[lr.length - 1] - mean(lr.slice(-480, -1))) / sd(lr.slice(-480, -1));
    const ratio = Math.exp(lr[lr.length - 1]);
    let motivo = `proporção ${ratio.toFixed(2)} (${z.toFixed(1)}σ)`;
    if (Math.abs(z) > 2 && fresh) {
      const lado = z > 0 ? -1 : 1;
      motivo = await abrir("longshort-extremo", `ls_${lastT}`, lado, price, price * (1 - lado * 1.5 * sig24), price * (1 + lado * 1.5 * sig24), now + 24 * H1, z, motivo, log);
    } else motivo += " — sem sinal (precisa > 2σ)";
    out["longshort-extremo"] = { ratio, z, motivo, em: lastT };
  } catch (e) { out["longshort-extremo"] = { erro: String(e) }; }

  // C4 (v2): estouro do gap de fim de semana. Se o BTC andou >= 2% entre sexta 17h e domingo 18h (NY) e, até a sexta
  // seguinte, o movimento chega ao dobro (preço de domingo + o mesmo movimento), entra A FAVOR por 24h, stop 1,5σ, sem alvo.
  try {
    const k15 = await getJSON(`${FAPI}/fapi/v1/klines?symbol=BTCUSDT&interval=15m&limit=1000`); // ~10 dias
    // última sexta 17h NY (fechamento) e o domingo 18h seguinte, a partir das velas de 1h
    let iSex = -1;
    for (let i = fechadas.length - 1; i >= 0; i--) { const p = nyParts(+fechadas[i][6] + 1); if (p.wd === "Fri" && p.hour === 17) { iSex = i; break; } }
    let motivo = "aguardando o fim de semana";
    if (iSex >= 0) {
      const tSex = +fechadas[iSex][6] + 1, pSex = +fechadas[iSex][4];
      const iDom = fechadas.findIndex((k: string[], i: number) => i > iSex && (() => { const p = nyParts(+k[6] + 1); return p.wd === "Sun" && p.hour === 18; })());
      if (iDom < 0) motivo = `sexta 17h: ${pSex.toFixed(0)} — aguardando domingo 18h (NY)`;
      else {
        const tDom = +fechadas[iDom][6] + 1, pDom = +fechadas[iDom][4], W = pDom / pSex - 1, sg = Math.sign(W);
        const fimSemana = tSex + 7 * D1, nivel = pDom * (1 + W);
        motivo = `fds ${(W * 100).toFixed(2)}% (sexta ${pSex.toFixed(0)} → domingo ${pDom.toFixed(0)})`;
        if (Math.abs(W) < 0.02) motivo += " — abaixo de 2%, sem operação nesta semana";
        else if (now > fimSemana) motivo += " — semana encerrada sem estouro";
        else {
          // primeira vela de 15 min, depois de domingo 18h, que tocou o nível de estouro
          const k = k15.find((x: string[]) => +x[0] >= tDom && (sg > 0 ? +x[2] >= nivel : +x[3] <= nivel));
          if (!k) motivo += ` — estouro em ${nivel.toFixed(0)} ainda não aconteceu`;
          else if (now - +k[0] > 45 * 60e3) motivo += ` — estourou ${nivel.toFixed(0)} às ${new Date(+k[0]).toISOString().slice(11, 16)} UTC (fora da janela de entrada)`;
          else {
            const lado = sg;
            motivo = await abrir("gap-v2", `gapv2_${tSex}`, lado, price, price * (1 - lado * 1.5 * sig24), null as unknown as number, now + 24 * H1, W * 100, motivo + ` — estourou ${nivel.toFixed(0)}`, log);
          }
        }
      }
    }
    out["gap-v2"] = { motivo, em: now };
  } catch (e) { out["gap-v2"] = { erro: String(e) }; }
  return out;
}

Deno.serve(async (req) => {
  const tk = await sb.from("interno").select("valor").eq("chave", "ciclo_token").maybeSingle();
  if (!tk.data?.valor || req.headers.get("x-ciclo-token") !== tk.data.valor) return new Response("não autorizado", { status: 401 });
  const logs: string[] = []; const log = (m: string) => { logs.push(`[${new Date().toISOString()}] ${m}`); console.log(m); };
  ATIVAS = new Set(((await sb.from("hipoteses").select("id").eq("ativa", true)).data ?? []).map((x: { id: string }) => x.id));
  const ant = (await sb.from("estado_lab").select("dados").eq("id", 1).maybeSingle()).data?.dados ?? {};
  // deno-lint-ignore no-explicit-any
  const estado: any = { ...ant, atualizado: Date.now() };
  try { estado.tendencia = await tendencia(log); } catch (e) { log("Tendência: " + e); }
  try { estado.hipoteses = await hipotesesC(log); } catch (e) { log("Hipóteses C: " + e); }
  estado.logs = [...logs.reverse(), ...(ant.logs ?? [])].slice(0, 60);
  await sb.from("estado_lab").upsert({ id: 1, dados: estado, atualizado: new Date().toISOString() });
  return new Response(JSON.stringify({ ok: true, logs }), { headers: { "content-type": "application/json" } });
});
