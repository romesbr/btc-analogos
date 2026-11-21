// Ciclo do BTC · Análogos (Supabase Edge Function, executada pelo agendador a cada 15 min em São Paulo).
// 1) atualiza velas de 1h e funding da Binance; 2) a cada hora fechada, compara o momento com o histórico e
// gera sugestões; 3) julga as sugestões abertas com velas de 1 min (taxas + funding); 4) grava o estado do site.
import { createClient } from "jsr:@supabase/supabase-js@2";
import Core from "./core.js";
import EVENTOS from "./eventos.js";

const H1 = 3600e3, HORIZONS = [1, 4], START_MS = 1567900800000;
const SOURCES = [
  { id: "fut", nome: "Binance Futuros · BTCUSDT perpétuo", base: "https://fapi.binance.com/fapi/v1", funding: true, oi: true, max: 1500 },
  { id: "spot", nome: "Binance Spot · BTCUSDT (reserva, sem funding)", base: "https://data-api.binance.vision/api/v3", funding: false, oi: false, max: 1000 },
];
const evMs = Core.eventsToMs(EVENTOS);

function serviceKey(): string {
  const k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (k) return k;
  const all = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
  return all.default;
}
const sb = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), { auth: { persistSession: false } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url: string) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (r.status === 429 || r.status === 418) { await sleep(5000 * (i + 1)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
      return await r.json();
    } catch (e) { if (i === 3) throw e; await sleep(1000 * (i + 1)); }
  }
}
// deno-lint-ignore no-explicit-any
const toBar = (k: any[]) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], ct: +k[6] });

async function pickSource() {
  for (const s of SOURCES) {
    try { await getJSON(`${s.base}/klines?symbol=BTCUSDT&interval=1h&limit=2`); return s; } catch (_) { /* tenta a próxima */ }
  }
  throw new Error("Nenhuma fonte da Binance respondeu");
}
// deno-lint-ignore no-explicit-any
async function fetchKlines(src: any, interval: string, startMs: number, maxPages = 100) {
  // deno-lint-ignore no-explicit-any
  const out: any[] = []; let t = startMs;
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
async function must<T>(p: PromiseLike<{ data: T; error: unknown }>): Promise<T> {
  const { data, error } = await p; if (error) throw new Error(JSON.stringify(error)); return data;
}

Deno.serve(async (req) => {
  const tk = await sb.from("interno").select("valor").eq("chave", "ciclo_token").maybeSingle();
  const token = tk.data?.valor;
  if (!token || req.headers.get("x-ciclo-token") !== token) return new Response("não autorizado", { status: 401 });
  const logs: string[] = [];
  const log = (m: string) => { logs.push(`[${new Date().toISOString()}] ${m}`); console.log(m); };
  const now = Date.now();
  // deno-lint-ignore no-explicit-any
  const estadoAnt: any = (await must(sb.from("estado").select("dados").eq("id", 1).maybeSingle()))?.dados ?? {};
  // deno-lint-ignore no-explicit-any
  const estado: any = { ...estadoAnt, ultimoCiclo: now, status: "ok" };
  try {
    const cfg = (await must(sb.from("config").select("dados").eq("id", 1).single())).dados;
    const src = await pickSource();
    estado.fonte = src.nome; estado.fonteId = src.id;

    // ---- 1) velas de 1h
    const last = await must(sb.from("velas_1h").select("t").order("t", { ascending: false }).limit(1));
    const lastT = last.length ? Number(last[0].t) : null;
    if (lastT === null || now - (lastT + H1) >= H1) {
      const fresh = (await fetchKlines(src, "1h", lastT === null ? START_MS : lastT + H1, 60)).filter((b) => b.ct < now);
      for (let i = 0; i < fresh.length; i += 2000) {
        await must(sb.from("velas_1h").upsert(fresh.slice(i, i + 2000).map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v }))));
      }
      if (fresh.length) log(`${fresh.length} velas de 1h novas`);
      if (lastT === null) { estado.status = "histórico carregado; avaliações começam no próximo ciclo"; return fim(); }
    }

    // ---- 2) funding
    if (src.funding) {
      const lf = await must(sb.from("funding").select("t").order("t", { ascending: false }).limit(1));
      const since = lf.length ? Number(lf[0].t) + 1 : now - 30 * 86400e3;
      const rows = await getJSON(`${src.base}/fundingRate?symbol=BTCUSDT&limit=1000&startTime=${since}`);
      // deno-lint-ignore no-explicit-any
      if (rows.length) await must(sb.from("funding").upsert(rows.map((r: any) => ({ t: +r.fundingTime, rate: +r.fundingRate }))));
    }

    // preço atual (última vela de 1 min)
    const m1 = await getJSON(`${src.base}/klines?symbol=BTCUSDT&interval=1m&limit=2`);
    const price = +m1[m1.length - 1][4];
    estado.preco = price;

    // ---- 3) avaliação da hora fechada (uma vez por hora)
    const { data: velas, error: e1 } = await sb.rpc("velas_json");
    if (e1) throw new Error(JSON.stringify(e1));
    // deno-lint-ignore no-explicit-any
    const bars = (velas as any[]).map((r) => ({ t: +r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
    estado.horasHistorico = bars.length;
    const decTs = bars[bars.length - 1].t + H1;
    estado.proximaAvaliacao = decTs + H1;
    const ja = await must(sb.from("avaliacoes").select("h").eq("dec_ts", decTs));
    if (!ja.length || !estado.avaliacao || estado.avaliacao.decTs !== decTs) {
      const F = Core.build(bars, evMs, HORIZONS);
      const qi = F.n - 1;
      // tendência em tempo maior: média de 24h vs 72h (velas de 1h)
      const closes = bars.map((b) => b.c);
      const media = (n: number) => closes.slice(-n).reduce((s, x) => s + x, 0) / n;
      const s24 = media(24), s72 = media(72), cl = closes[closes.length - 1];
      const tendencia = cl > s24 && s24 > s72 ? "ALTA" : cl < s24 && s24 < s72 ? "BAIXA" : "NEUTRA";
      const ativos: number[] = cfg.horizontesAtivos ?? [4];
      const filtroTend = cfg.filtroTendencia ?? true;
      // deno-lint-ignore no-explicit-any
      const porH: any = {};
      const abertas = await must(sb.from("sugestoes").select("horizonte").eq("status", "aberta"));
      for (const H of HORIZONS) {
        const a = Core.analogs(F, qi, H, decTs, { p: cfg.wPreco, c: cfg.wCal, m: cfg.wMacro }, cfg.k);
        if (!a) continue;
        const d = Core.decide(a, price, now, evMs, cfg);
        if (d.sugere && !ativos.includes(H)) { d.sugere = false; d.motivos.push(`prazo de ${H} h desligado`); }
        if (d.sugere && filtroTend && !((d.side === "COMPRA" && tendencia === "ALTA") || (d.side === "VENDA" && tendencia === "BAIXA"))) {
          d.sugere = false; d.motivos.push(`${d.side.toLowerCase()} contra a tendência (${tendencia})`);
        }
        const fresh = now - decTs <= 20 * 60e3;
        // deno-lint-ignore no-explicit-any
        const jaAberta = abertas.some((s: any) => s.horizonte === H);
        let motivo = d.motivos.join("; "), sugeriu = false;
        if (!ja.length && d.sugere && fresh && !jaAberta) {
          await must(sb.from("sugestoes").upsert({ id: `${decTs}_${H}`, dec_ts: decTs, criada: now, horizonte: H, lado: d.side, entrada: d.entrada,
            stop: d.stop, alvo: d.alvo, expira: d.expira, prev: a.mean, concordancia: d.agree, status: "aberta" }));
          sugeriu = true; motivo = "sugestão criada"; log(`Nova sugestão ${d.side} (${H} h) a ${d.entrada}`);
        } else if (d.sugere && !fresh) motivo = "avaliação fora da janela de decisão";
        else if (d.sugere && jaAberta) motivo = "já existe sugestão aberta neste prazo";
        if (!ja.length) await must(sb.from("avaliacoes").upsert({ dec_ts: decTs, h: H, prev: a.mean, up: a.up, sd: a.sd, sugeriu, motivo }));
        porH[H] = { mean: a.mean, median: a.median, up: a.up, sd: a.sd, decisao: d, motivo,
          vizinhos: a.neighbors.slice(0, 12).map((x: { i: number; dec: number; dist: number }) => ({ dec: x.dec, dist: x.dist, f1: F.fwd[1][x.i], f4: F.fwd[4][x.i] })) };
      }
      estado.avaliacao = { decTs, avaliadoEm: now, porH, tendencia, media24: s24, media72: s72 };
      if (src.oi) {
        try { const r = await getJSON(`${src.base}/openInterest?symbol=BTCUSDT`); await must(sb.from("open_interest").upsert({ t: +r.time, oi: +r.openInterest, preco: price })); }
        catch (e) { log("Open interest indisponível: " + e); }
      }
    }

    // ---- 4) juiz
    const abertas = await must(sb.from("sugestoes").select("*").eq("status", "aberta"));
    if (abertas.length) {
      // deno-lint-ignore no-explicit-any
      const since = Math.min(...abertas.map((s: any) => Number(s.criada))) - 60e3;
      const c1m = (await fetchKlines(src, "1m", since, 10)).map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v }));
      const fund = (await must(sb.from("funding").select("t,rate").gte("t", since))).map((f: { t: number; rate: number }) => ({ t: Number(f.t), rate: f.rate }));
      for (const s of abertas) {
        const sj = { ...s, criada: Number(s.criada), expira: Number(s.expira) };
        const r = Core.judge(sj, c1m, fund, Date.now(), cfg);
        if (r.status !== "aberta") {
          await must(sb.from("sugestoes").update({ status: r.status, saida: r.saida, saida_t: r.saidaT, motivo: r.motivo, bruto: r.bruto,
            taxas: r.taxas, funding: r.funding, liquido: r.liquido }).eq("id", s.id));
          log(`Sugestão ${s.lado} (${s.horizonte} h) fechada: ${r.motivo}, ${r.liquido.toFixed(2)}%`);
        }
      }
    }
  } catch (e) {
    estado.status = "erro: " + (e instanceof Error ? e.message : String(e)); log(estado.status);
  }
  return fim();

  async function fim() {
    estado.logs = [...logs.reverse(), ...(estadoAnt.logs ?? [])].slice(0, 60);
    await sb.from("estado").upsert({ id: 1, dados: estado, atualizado: new Date().toISOString() });
    return new Response(JSON.stringify({ status: estado.status, logs }), { headers: { "content-type": "application/json" } });
  }
});
