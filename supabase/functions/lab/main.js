import { createClient } from "jsr:@supabase/supabase-js@2";
const H1 = 36e5, D1 = 864e5, FEE = 5e-4;
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}").default;
const sb = createClient(Deno.env.get("SUPABASE_URL"), key, { auth: { persistSession: false } });
const FAPI = "https://fapi.binance.com", SPOT = "https://data-api.binance.vision/api/v3";
async function getJSON(url, headers = {}) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(15e3) });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url.slice(0, 80)}`);
      return await r.json();
    } catch (e) {
      if (i === 2) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}
async function must(p) {
  const { data, error } = await p;
  if (error) throw new Error(JSON.stringify(error));
  return data;
}
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const nyParts = (ms) => {
  const p = {};
  for (const x of new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, weekday: "short", hour: "numeric", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms))) p[x.type] = x.value;
  return { wd: p.weekday, hour: +p.hour % 24, date: `${p.year}-${p.month}-${p.day}` };
};
async function diariosCripto(sym) {
  const rows = await getJSON(`${SPOT}/klines?symbol=${sym}&interval=1d&limit=300`);
  const now = Date.now();
  return rows.filter((k) => +k[6] < now).map((k) => ({ t: +k[6] + 1, c: +k[4] }));
}
async function diariosYahoo(sym) {
  const p2 = Math.floor(Date.now() / 1e3), p1 = p2 - 420 * 86400;
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${p1}&period2=${p2}&interval=1d`, { "User-Agent": "Mozilla/5.0" });
  const res = j.chart.result[0], ts = res.timestamp, cl = res.indicators.quote[0].close;
  const out = [];
  for (let i = 0; i < ts.length; i++) if (cl[i] != null) out.push({ t: ts[i] * 1e3, c: cl[i] });
  const meta = res.meta;
  const fechado = meta?.currentTradingPeriod?.regular?.end ? Date.now() / 1e3 > meta.currentTradingPeriod.regular.end : true;
  if (!fechado && out.length) out.pop();
  return out;
}
function sinal(d, regra) {
  const c = d.map((x) => x.c), n = c.length, last = c[n - 1];
  if (regra.startsWith("ma")) {
    const k = +regra.slice(2);
    const m = mean(c.slice(n - k));
    return { on: last > m, ref: m };
  }
  const L = +regra.slice(3);
  return { on: last > c[n - 1 - L], ref: c[n - 1 - L] };
}
async function tendencia(log) {
  const alvos = [
    { hip: "tend-ma50", regra: "ma50", ativos: ["BTCUSDT", "ETHUSDT", "SOLUSDT"] },
    { hip: "tend-mom28", regra: "mom28", ativos: ["BTCUSDT", "ETHUSDT", "SOLUSDT"] },
    { hip: "protecao-ma200", regra: "ma200", ativos: ["^GSPC"] },
    { hip: "protecao-ma100", regra: "ma100", ativos: ["^BVSP"] }
  ];
  const cache = {};
  const painel = [];
  const abertas = await must(sb.from("sugestoes").select("*").eq("status", "aberta").eq("tipo", "posicao"));
  for (const a of alvos) for (const ativo of a.ativos) {
    try {
      cache[ativo] ??= ativo.startsWith("^") ? await diariosYahoo(ativo) : await diariosCripto(ativo);
      const d = cache[ativo];
      if (d.length < 210) continue;
      const dia = d[d.length - 1], s = sinal(d, a.regra);
      const aberta = abertas.find((x) => x.hipotese === a.hip && x.ativo === ativo);
      if (s.on && !aberta) {
        await must(sb.from("sugestoes").upsert({
          id: `${a.hip}_${ativo}_${dia.t}`,
          dec_ts: dia.t,
          criada: dia.t,
          horizonte: 0,
          lado: "COMPRA",
          entrada: dia.c,
          stop: null,
          alvo: null,
          expira: null,
          prev: null,
          concordancia: null,
          status: "aberta",
          hipotese: a.hip,
          ativo,
          tipo: "posicao"
        }));
        log(`[${a.hip}] ${ativo}: entrou comprado a ${dia.c}`);
      } else if (!s.on && aberta && dia.t > Number(aberta.criada)) {
        const bruto = (dia.c / aberta.entrada - 1) * 100;
        await must(sb.from("sugestoes").update({
          status: "fechada",
          saida: dia.c,
          saida_t: dia.t,
          motivo: "sinal virou",
          bruto,
          taxas: 2 * FEE * 100,
          funding: 0,
          liquido: bruto - 2 * FEE * 100
        }).eq("id", aberta.id));
        log(`[${a.hip}] ${ativo}: saiu a ${dia.c} (${(bruto - 0.1).toFixed(2)}%)`);
      }
      painel.push({
        hipotese: a.hip,
        ativo,
        regra: a.regra,
        comprado: s.on,
        preco: dia.c,
        referencia: s.ref,
        dia: dia.t,
        aberta_desde: s.on ? aberta ? Number(aberta.criada) : dia.t : null,
        entrada: s.on ? aberta ? aberta.entrada : dia.c : null
      });
    } catch (e) {
      log(`Tend\xEAncia ${ativo}: ${e}`);
    }
  }
  return painel;
}
async function abrir(hip, id, lado, preco, stop, alvo, expira, prev, nota, log) {
  const ab = await must(sb.from("sugestoes").select("id").eq("status", "aberta").eq("hipotese", hip));
  if (ab.length) return "j\xE1 existe opera\xE7\xE3o aberta";
  const ja = await must(sb.from("sugestoes").select("id").eq("id", id));
  if (ja.length) return "j\xE1 registrada";
  const now = Date.now();
  await must(sb.from("sugestoes").insert({
    id,
    dec_ts: now,
    criada: now,
    horizonte: Math.round((expira - now) / H1),
    lado: lado === 1 ? "COMPRA" : "VENDA",
    entrada: preco,
    stop,
    alvo,
    expira,
    prev,
    concordancia: null,
    status: "aberta",
    hipotese: hip,
    ativo: "BTCUSDT",
    tipo: "operacao"
  }));
  log(`[${hip}] ${lado === 1 ? "COMPRA" : "VENDA"} a ${preco} \u2014 ${nota}`);
  return "sugest\xE3o criada";
}
async function hipotesesC(log) {
  const out = {};
  const now = Date.now();
  const k1h = await getJSON(`${FAPI}/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=500`);
  const fechadas = k1h.filter((k) => +k[6] < now);
  const closes = fechadas.map((k) => +k[4]);
  const lastT = +fechadas[fechadas.length - 1][6] + 1;
  const price = +k1h[k1h.length - 1][4];
  const r1 = closes.slice(1).map((x, i) => Math.log(x / closes[i]));
  const sigH = sd(r1.slice(-480)), sig24 = sigH * Math.sqrt(24);
  const fresh = now - lastT <= 20 * 6e4;
  try {
    const oi = await getJSON(`${FAPI}/futures/data/openInterestHist?symbol=BTCUSDT&period=1h&limit=500`);
    const v = oi.map((x) => +x.sumOpenInterest);
    const d4 = v.slice(4).map((x, i) => Math.log(x / v[i]));
    const zOI = (d4[d4.length - 1] - mean(d4.slice(-480, -1))) / sd(d4.slice(-480, -1));
    const p4 = Math.log(closes[closes.length - 1] / closes[closes.length - 5]);
    const zP = p4 / (sigH * 2);
    let motivo = `OI ${zOI.toFixed(1)}\u03C3, pre\xE7o ${zP.toFixed(1)}\u03C3 em 4h`;
    if (zOI > 2 && Math.abs(zP) > 1 && fresh) {
      const lado = zP > 0 ? -1 : 1;
      motivo = await abrir("oi-reversao", `oi_${lastT}`, lado, price, price * (1 - lado * 1.5 * sig24), price * (1 + lado * 1.5 * sig24), now + 24 * H1, zOI, motivo, log);
    } else motivo += " \u2014 sem sinal (precisa OI > 2\u03C3 e pre\xE7o > 1\u03C3)";
    out["oi-reversao"] = { zOI, zP, motivo, em: lastT };
  } catch (e) {
    out["oi-reversao"] = { erro: String(e) };
  }
  try {
    const f = await getJSON(`${FAPI}/fapi/v1/fundingRate?symbol=BTCUSDT&limit=300`);
    const rates = f.map((x) => +x.fundingRate);
    const tF = +f[f.length - 1].fundingTime, atual = rates[rates.length - 1];
    const hist = rates.slice(-271, -1).slice().sort((a, b) => a - b);
    const p95 = hist[Math.floor(hist.length * 0.95)], p5 = hist[Math.floor(hist.length * 0.05)];
    let motivo = `funding ${(atual * 100).toFixed(4)}% (p5 ${(p5 * 100).toFixed(4)}%, p95 ${(p95 * 100).toFixed(4)}%)`;
    const recente = now - tF <= 30 * 6e4;
    if (recente && (atual > p95 || atual < p5)) {
      const lado = atual > p95 ? -1 : 1;
      motivo = await abrir("funding-extremo", `fund_${tF}`, lado, price, price * (1 - lado * 1.5 * sig24), price * (1 + lado * 1.5 * sig24), now + 24 * H1, atual, motivo, log);
    } else motivo += recente ? " \u2014 dentro da faixa normal" : " \u2014 aguardando pr\xF3xima cobran\xE7a";
    out["funding-extremo"] = { atual, p5, p95, motivo, em: tF };
  } catch (e) {
    out["funding-extremo"] = { erro: String(e) };
  }
  try {
    const ls = await getJSON(`${FAPI}/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=1h&limit=500`);
    const lr = ls.map((x) => Math.log(+x.longShortRatio));
    const z = (lr[lr.length - 1] - mean(lr.slice(-480, -1))) / sd(lr.slice(-480, -1));
    const ratio = Math.exp(lr[lr.length - 1]);
    let motivo = `propor\xE7\xE3o ${ratio.toFixed(2)} (${z.toFixed(1)}\u03C3)`;
    if (Math.abs(z) > 2 && fresh) {
      const lado = z > 0 ? -1 : 1;
      motivo = await abrir("longshort-extremo", `ls_${lastT}`, lado, price, price * (1 - lado * 1.5 * sig24), price * (1 + lado * 1.5 * sig24), now + 24 * H1, z, motivo, log);
    } else motivo += " \u2014 sem sinal (precisa > 2\u03C3)";
    out["longshort-extremo"] = { ratio, z, motivo, em: lastT };
  } catch (e) {
    out["longshort-extremo"] = { erro: String(e) };
  }
  try {
    const ny = nyParts(now);
    let motivo = "aguardando domingo 18h (NY)";
    if (ny.wd === "Sun" && ny.hour >= 18) {
      let pSexta = null, tSexta = 0;
      for (const k of fechadas) {
        const tc = +k[6] + 1;
        const p = nyParts(tc);
        if (p.wd === "Fri" && p.hour === 17) {
          pSexta = +k[4];
          tSexta = tc;
        }
      }
      if (pSexta) {
        const mov = (price / pSexta - 1) * 100;
        motivo = `movimento desde sexta 17h: ${mov.toFixed(2)}%`;
        if (Math.abs(mov) >= 2) {
          const lado = mov > 0 ? -1 : 1;
          const expira = tSexta + 7 * D1;
          motivo = await abrir("gap-fds", `gap_${tSexta}`, lado, price, price * (1 + Math.sign(mov) * Math.abs(mov) / 100), pSexta, expira, mov, motivo, log);
        } else motivo += " \u2014 abaixo de 2%";
      }
    }
    out["gap-fds"] = { motivo, em: now };
  } catch (e) {
    out["gap-fds"] = { erro: String(e) };
  }
  return out;
}
Deno.serve(async (req) => {
  const tk = await sb.from("interno").select("valor").eq("chave", "ciclo_token").maybeSingle();
  if (!tk.data?.valor || req.headers.get("x-ciclo-token") !== tk.data.valor) return new Response("n\xE3o autorizado", { status: 401 });
  const logs = [];
  const log = (m) => {
    logs.push(`[${(/* @__PURE__ */ new Date()).toISOString()}] ${m}`);
    console.log(m);
  };
  const ant = (await sb.from("estado_lab").select("dados").eq("id", 1).maybeSingle()).data?.dados ?? {};
  const estado = { ...ant, atualizado: Date.now() };
  try {
    estado.tendencia = await tendencia(log);
  } catch (e) {
    log("Tend\xEAncia: " + e);
  }
  try {
    estado.hipoteses = await hipotesesC(log);
  } catch (e) {
    log("Hip\xF3teses C: " + e);
  }
  estado.logs = [...logs.reverse(), ...ant.logs ?? []].slice(0, 60);
  await sb.from("estado_lab").upsert({ id: 1, dados: estado, atualizado: (/* @__PURE__ */ new Date()).toISOString() });
  return new Response(JSON.stringify({ ok: true, logs }), { headers: { "content-type": "application/json" } });
});
