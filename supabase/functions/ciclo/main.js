import { createClient } from "jsr:@supabase/supabase-js@2";
import Core from "./core.js";
import EVENTOS from "./eventos.js";
import * as Alerta from "./alerta.js";
import * as A2 from "./alerta2h.js";
const H1 = 36e5, HORIZONS = [1, 4], BUILD_H = [1, 4, 48], START_MS = 15679008e5;
const SOURCES = [
  { id: "fut", nome: "Binance Futuros \xB7 BTCUSDT perp\xE9tuo", base: "https://fapi.binance.com/fapi/v1", funding: true, oi: true, max: 1500 },
  { id: "spot", nome: "Binance Spot \xB7 BTCUSDT (reserva, sem funding)", base: "https://data-api.binance.vision/api/v3", funding: false, oi: false, max: 1e3 }
];
const evMs = Core.eventsToMs(EVENTOS);
function serviceKey() {
  const k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (k) return k;
  const all = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
  return all.default;
}
const sb = createClient(Deno.env.get("SUPABASE_URL"), serviceKey(), { auth: { persistSession: false } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJSON(url) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15e3) });
      if (r.status === 429 || r.status === 418) {
        await sleep(5e3 * (i + 1));
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
      return await r.json();
    } catch (e) {
      if (i === 3) throw e;
      await sleep(1e3 * (i + 1));
    }
  }
}
const toBar = (k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], ct: +k[6] });
async function pickSource() {
  for (const s of SOURCES) {
    try {
      await getJSON(`${s.base}/klines?symbol=BTCUSDT&interval=1h&limit=2`);
      return s;
    } catch (_) {
    }
  }
  throw new Error("Nenhuma fonte da Binance respondeu");
}
async function fetchKlines(src, interval, startMs, maxPages = 100) {
  const out = [];
  let t = startMs;
  for (let p = 0; p < maxPages; p++) {
    const rows = await getJSON(`${src.base}/klines?symbol=BTCUSDT&interval=${interval}&limit=${src.max}&startTime=${t}`);
    if (!rows.length) break;
    out.push(...rows.map(toBar));
    if (rows.length < src.max) break;
    t = +rows[rows.length - 1][0] + 1;
    await sleep(150);
  }
  return out;
}
async function must(p) {
  const { data, error } = await p;
  if (error) throw new Error(JSON.stringify(error));
  return data;
}
Deno.serve(async (req) => {
  const tk = await sb.from("interno").select("valor").eq("chave", "ciclo_token").maybeSingle();
  const token = tk.data?.valor;
  if (!token || req.headers.get("x-ciclo-token") !== token) return new Response("n\xE3o autorizado", { status: 401 });
  const logs = [];
  const log = (m) => {
    logs.push(`[${(/* @__PURE__ */ new Date()).toISOString()}] ${m}`);
    console.log(m);
  };
  const now = Date.now();
  const estadoAnt = (await must(sb.from("estado").select("dados").eq("id", 1).maybeSingle()))?.dados ?? {};
  const estado = { ...estadoAnt, ultimoCiclo: now, status: "ok" };
  try {
    const cfg = (await must(sb.from("config").select("dados").eq("id", 1).single())).dados;
    const src = await pickSource();
    estado.fonte = src.nome;
    estado.fonteId = src.id;
    const last = await must(sb.from("velas_1h").select("t").order("t", { ascending: false }).limit(1));
    const lastT = last.length ? Number(last[0].t) : null;
    if (lastT === null || now - (lastT + H1) >= H1) {
      const fresh = (await fetchKlines(src, "1h", lastT === null ? START_MS : lastT + H1, 60)).filter((b) => b.ct < now);
      for (let i = 0; i < fresh.length; i += 2e3) {
        await must(sb.from("velas_1h").upsert(fresh.slice(i, i + 2e3).map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v }))));
      }
      if (fresh.length) log(`${fresh.length} velas de 1h novas`);
      if (lastT === null) {
        estado.status = "hist\xF3rico carregado; avalia\xE7\xF5es come\xE7am no pr\xF3ximo ciclo";
        return fim();
      }
    }
    if (src.funding) {
      const lf = await must(sb.from("funding").select("t").order("t", { ascending: false }).limit(1));
      const since = lf.length ? Number(lf[0].t) + 1 : now - 30 * 864e5;
      const rows = await getJSON(`${src.base}/fundingRate?symbol=BTCUSDT&limit=1000&startTime=${since}`);
      if (rows.length) await must(sb.from("funding").upsert(rows.map((r) => ({ t: +r.fundingTime, rate: +r.fundingRate }))));
    }
    const m1 = await getJSON(`${src.base}/klines?symbol=BTCUSDT&interval=1m&limit=2`);
    const price = +m1[m1.length - 1][4];
    estado.preco = price;
    const { data: velas, error: e1 } = await sb.rpc("velas_json");
    if (e1) throw new Error(JSON.stringify(e1));
    const bars = velas.map((r) => ({ t: +r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
    estado.horasHistorico = bars.length;
    const decTs = bars[bars.length - 1].t + H1;
    estado.proximaAvaliacao = decTs + H1;
    const ja = await must(sb.from("avaliacoes").select("h").eq("dec_ts", decTs));
    if (!ja.length || !estado.avaliacao || estado.avaliacao.decTs !== decTs) {
      const F = Core.build(bars, evMs, BUILD_H);
      const qi = F.n - 1;
      const closes = bars.map((b) => b.c);
      const media = (n) => closes.slice(-n).reduce((s, x) => s + x, 0) / n;
      const s24 = media(24), s72 = media(72), cl = closes[closes.length - 1];
      const tendencia = cl > s24 && s24 > s72 ? "ALTA" : cl < s24 && s24 < s72 ? "BAIXA" : "NEUTRA";
      const ativos = cfg.horizontesAtivos ?? [4];
      const filtroTend = cfg.filtroTendencia ?? true;
      const porH = {};
      const abertas2 = await must(sb.from("sugestoes").select("horizonte,hipotese").eq("status", "aberta"));
      for (const H of HORIZONS) {
        const a = Core.analogs(F, qi, H, decTs, { p: cfg.wPreco, c: cfg.wCal, m: cfg.wMacro }, cfg.k);
        if (!a) continue;
        const d = Core.decide(a, price, now, evMs, cfg);
        if (d.sugere && !ativos.includes(H)) {
          d.sugere = false;
          d.motivos.push(`prazo de ${H} h desligado`);
        }
        if (d.sugere && filtroTend && !(d.side === "COMPRA" && tendencia === "ALTA" || d.side === "VENDA" && tendencia === "BAIXA")) {
          d.sugere = false;
          d.motivos.push(`${d.side.toLowerCase()} contra a tend\xEAncia (${tendencia})`);
        }
        const fresh = now - decTs <= 20 * 6e4;
        const jaAberta = abertas2.some((s) => s.horizonte === H && s.hipotese === "analogos-1h4h");
        let motivo = d.motivos.join("; "), sugeriu = false;
        if (!ja.length && d.sugere && fresh && !jaAberta) {
          await must(sb.from("sugestoes").upsert({
            id: `${decTs}_${H}`,
            dec_ts: decTs,
            criada: now,
            horizonte: H,
            lado: d.side,
            entrada: d.entrada,
            stop: d.stop,
            alvo: d.alvo,
            expira: d.expira,
            prev: a.mean,
            concordancia: d.agree,
            status: "aberta",
            hipotese: "analogos-1h4h",
            ativo: "BTCUSDT",
            tipo: "operacao"
          }));
          sugeriu = true;
          motivo = "sugest\xE3o criada";
          log(`Nova sugest\xE3o ${d.side} (${H} h) a ${d.entrada}`);
        } else if (d.sugere && !fresh) motivo = "avalia\xE7\xE3o fora da janela de decis\xE3o";
        else if (d.sugere && jaAberta) motivo = "j\xE1 existe sugest\xE3o aberta neste prazo";
        if (!ja.length) await must(sb.from("avaliacoes").upsert({ dec_ts: decTs, h: H, prev: a.mean, up: a.up, sd: a.sd, sugeriu, motivo }));
        porH[H] = {
          mean: a.mean,
          median: a.median,
          up: a.up,
          sd: a.sd,
          decisao: d,
          motivo,
          vizinhos: a.neighbors.slice(0, 12).map((x) => ({ dec: x.dec, dist: x.dist, f1: F.fwd[1][x.i], f4: F.fwd[4][x.i] }))
        };
      }
      const s80 = media(80), s200 = media(200);
      const tend4h = cl > s80 && s80 > s200 ? 1 : cl < s80 && s80 < s200 ? -1 : 0;
      let swing = { tend4h: tend4h === 1 ? "ALTA" : tend4h === -1 ? "BAIXA" : "NEUTRA" };
      const swAtiva = !!(await sb.from("hipoteses").select("ativa").eq("id", "swing-analogos-t4h").maybeSingle()).data?.ativa;
      if (swAtiva && Math.round(decTs / H1) % 4 === 0) {
        const a48 = Core.analogs(F, qi, 48, decTs, { p: cfg.wPreco, c: cfg.wCal, m: cfg.wMacro }, cfg.k);
        if (a48) {
          const lado = a48.mean > 0 ? 1 : -1, agree = a48.mean > 0 ? a48.up : 1 - a48.up;
          const rets = closes.slice(-721).map((x, i, arr) => i ? Math.log(x / arr[i - 1]) : 0).slice(1);
          const mu = rets.reduce((s, x) => s + x, 0) / rets.length;
          const sigH = Math.sqrt(rets.reduce((s, x) => s + (x - mu) ** 2, 0) / (rets.length - 1)) * Math.sqrt(48);
          const motivos = [];
          if (agree < 0.6) motivos.push(`concord\xE2ncia ${(agree * 100).toFixed(0)}% < 60%`);
          if (Math.abs(a48.mean) < 0.15) motivos.push(`movimento esperado ${Math.abs(a48.mean).toFixed(2).replace(".", ",")}% < 0,15%`);
          if (lado !== tend4h) motivos.push(`contra ou sem tend\xEAncia de 4h (${swing.tend4h})`);
          const swAberta = abertas2.some((s) => s.hipotese === "swing-analogos-t4h");
          if (!motivos.length && swAberta) motivos.push("j\xE1 existe swing aberto");
          if (!motivos.length && now - decTs > 20 * 6e4) motivos.push("fora da janela de decis\xE3o");
          if (!motivos.length) {
            await must(sb.from("sugestoes").upsert({
              id: `swing_${decTs}`,
              dec_ts: decTs,
              criada: now,
              horizonte: 48,
              lado: lado === 1 ? "COMPRA" : "VENDA",
              entrada: price,
              stop: price * (1 - lado * 1.5 * sigH),
              alvo: price * (1 + lado * 1.5 * sigH),
              expira: now + 48 * H1,
              prev: a48.mean,
              concordancia: agree,
              status: "aberta",
              hipotese: "swing-analogos-t4h",
              ativo: "BTCUSDT",
              tipo: "operacao"
            }));
            log(`Swing: ${lado === 1 ? "COMPRA" : "VENDA"} 48h a ${price}`);
          }
          swing = { ...swing, avaliadoEm: decTs, media: a48.mean, up: a48.up, sugeriu: !motivos.length, motivo: motivos.join("; ") || "sugest\xE3o criada" };
        }
      } else if (estadoAnt.swing) swing = { ...estadoAnt.swing, tend4h: swing.tend4h };
      estado.swing = swing;
      try {
        const evOrd = [...evMs].sort((a, b) => a - b);
        const AP = Alerta.preparar(bars), ia = bars.length - 1;
        const fa = Alerta.features(AP, ia, evOrd), pa = Alerta.prob(fa);
        if (pa != null) {
          const tip = Alerta.excursaoTipica(AP, ia) * 100, nv = Alerta.nivel(pa);
          await must(sb.from("alertas").upsert({ dec_ts: decTs, prob: pa, nivel: nv, preco: cl, tipica: tip, limiar: 1.75 * tip, features: fa }));
          const pend = await must(sb.from("alertas").select("dec_ts,preco,limiar").is("excursao", null).lte("dec_ts", decTs - 24 * H1).limit(200));
          const pos = new Map(bars.map((b, k) => [b.t + H1, k]));
          for (const a of pend) {
            const k = pos.get(Number(a.dec_ts));
            if (k == null || k + 24 >= bars.length) continue;
            let hi = -Infinity, lo = Infinity;
            for (let j = k + 1; j <= k + 24; j++) {
              hi = Math.max(hi, bars[j].h);
              lo = Math.min(lo, bars[j].l);
            }
            const up = Math.log(hi / bars[k].c) * 100, dn = Math.log(bars[k].c / lo) * 100, ex = Math.max(up, dn);
            await must(sb.from("alertas").update({ excursao: ex, sentido: up >= dn ? "ALTA" : "BAIXA", grande: ex >= a.limiar }).eq("dec_ts", a.dec_ts));
          }
          estado.alerta = { decTs, prob: pa, nivel: nv, tipica: tip, limiar: 1.75 * tip };
          const f2 = A2.features(AP, ia, evOrd), p2 = A2.prob(f2), tip2 = A2.tipica2h(bars, ia) * 100, nv2 = A2.nivel(p2);
          await must(sb.from("alertas2h").upsert({ dec_ts: decTs, prob: p2, nivel: nv2, preco: cl, limiar: 2 * tip2, features: f2 }));
          const pend2 = await must(sb.from("alertas2h").select("dec_ts,limiar").is("excursao", null).lte("dec_ts", decTs - 2 * H1).limit(200));
          for (const a of pend2) {
            const k = pos.get(Number(a.dec_ts));
            if (k == null || k + 2 >= bars.length) continue;
            const hi = Math.max(bars[k + 1].h, bars[k + 2].h), lo = Math.min(bars[k + 1].l, bars[k + 2].l);
            const up = Math.log(hi / bars[k].c) * 100, dn = Math.log(bars[k].c / lo) * 100, ex = Math.max(up, dn);
            await must(sb.from("alertas2h").update({ excursao: ex, sentido: up >= dn ? "ALTA" : "BAIXA", grande: ex >= a.limiar }).eq("dec_ts", a.dec_ts));
          }
          estado.alerta2h = { decTs, prob: p2, nivel: nv2, limiar: 2 * tip2, abertura: !!f2.abertura || !!f2.pos_abertura };
          if (nv === "MUITO ALTO" || nv === "ALTO") log(`Alerta de movimento: ${nv} (${(pa * 100).toFixed(0)}%)`);
        }
      } catch (e) {
        log("Alerta: " + e);
      }
      estado.avaliacao = { decTs, avaliadoEm: now, porH, tendencia, media24: s24, media72: s72 };
      if (src.oi) {
        try {
          const r = await getJSON(`${src.base}/openInterest?symbol=BTCUSDT`);
          await must(sb.from("open_interest").upsert({ t: +r.time, oi: +r.openInterest, preco: price }));
        } catch (e) {
          log("Open interest indispon\xEDvel: " + e);
        }
      }
    }
    const abertas = await must(sb.from("sugestoes").select("*").eq("status", "aberta").eq("tipo", "operacao").eq("ativo", "BTCUSDT"));
    if (abertas.length) {
      const since = Math.min(...abertas.map((s) => Number(s.criada))) - 6e4;
      const c1m = (await fetchKlines(src, "1m", since, 10)).map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v }));
      const fund = (await must(sb.from("funding").select("t,rate").gte("t", since))).map((f) => ({ t: Number(f.t), rate: f.rate }));
      for (const s of abertas) {
        const sj = { ...s, criada: Number(s.criada), expira: Number(s.expira) };
        const r = Core.judge(sj, c1m, fund, Date.now(), cfg);
        if (r.status !== "aberta") {
          await must(sb.from("sugestoes").update({
            status: r.status,
            saida: r.saida,
            saida_t: r.saidaT,
            motivo: r.motivo,
            bruto: r.bruto,
            taxas: r.taxas,
            funding: r.funding,
            liquido: r.liquido
          }).eq("id", s.id));
          log(`[${s.hipotese}] ${s.lado} (${s.horizonte} h) fechada: ${r.motivo}, ${r.liquido.toFixed(2)}%`);
        }
      }
    }
  } catch (e) {
    estado.status = "erro: " + (e instanceof Error ? e.message : String(e));
    log(estado.status);
  }
  return fim();
  async function fim() {
    estado.logs = [...logs.reverse(), ...estadoAnt.logs ?? []].slice(0, 60);
    await sb.from("estado").upsert({ id: 1, dados: estado, atualizado: (/* @__PURE__ */ new Date()).toISOString() });
    return new Response(JSON.stringify({ status: estado.status, logs }), { headers: { "content-type": "application/json" } });
  }
});
