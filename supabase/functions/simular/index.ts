// Simulação pontual: o que o sistema teria sugerido em horas passadas (usando só dados disponíveis em cada hora).
import { createClient } from "jsr:@supabase/supabase-js@2";
import Core from "https://cdn.jsdelivr.net/gh/romesbr/btc-analogos@b9cd85ee13e84260a287203f72b380733a1e4625/supabase/functions/ciclo/core.js";
import EVENTOS from "https://cdn.jsdelivr.net/gh/romesbr/btc-analogos@b9cd85ee13e84260a287203f72b380733a1e4625/supabase/functions/ciclo/eventos.js";
const H1 = 3600e3;
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}").default;
const sb = createClient(Deno.env.get("SUPABASE_URL")!, key, { auth: { persistSession: false } });
const evMs = Core.eventsToMs(EVENTOS);
Deno.serve(async (req) => {
  const { inicio, fim } = await req.json();
  const cfg = (await sb.from("config").select("dados").eq("id", 1).single()).data!.dados;
  const { data: velas } = await sb.rpc("velas_json");
  // deno-lint-ignore no-explicit-any
  const bars = (velas as any[]).map((r) => ({ t: +r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
  const F = Core.build(bars, evMs, [1, 4]);
  const idx = new Map(bars.map((b, i) => [b.t + H1, i]));
  // deno-lint-ignore no-explicit-any
  const out: any[] = [];
  for (let dec = inicio; dec <= fim; dec += H1) {
    const qi = idx.get(dec); if (qi === undefined) continue;
    const price = bars[qi].c;
    // deno-lint-ignore no-explicit-any
    const row: any = { dec, preco: price, minima_vela: bars[qi].l, porH: {} };
    for (const H of [1, 4]) {
      const a = Core.analogs(F, qi, H, dec, { p: cfg.wPreco, c: cfg.wCal, m: cfg.wMacro }, cfg.k);
      if (!a) continue;
      const d = Core.decide(a, price, dec, evMs, cfg);
      // deno-lint-ignore no-explicit-any
      const r: any = { media: a.mean, sobe: a.up, sd: a.sd, sugere: d.sugere, lado: d.side, motivos: d.motivos, real: F.fwd[H][qi] };
      if (d.sugere && dec + H * H1 <= Date.now()) {
        const k = await (await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=${H * 60 + 2}&startTime=${dec}`)).json();
        const c1m = k.map((x: string[]) => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4] }));
        const s = { status: "aberta", lado: d.side, entrada: d.entrada, stop: d.stop, alvo: d.alvo, criada: dec, expira: d.expira };
        const j = Core.judge(s, c1m, [], Date.now(), cfg);
        Object.assign(r, { entrada: d.entrada, stop: d.stop, alvo: d.alvo, resultado: j.motivo, liquido: j.liquido });
      }
      row.porH[H] = r;
    }
    out.push(row);
  }
  return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
});
