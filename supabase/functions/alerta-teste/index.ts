// Teste fora da amostra do indicador de grande movimento nos dados da Binance (modelo treinado só até 2022 na Bitstamp).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { preparar, features, prob, COEF } from "./alerta.js";
import EVENTOS from "./eventos.js";
import Core from "./core.js";
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(Deno.env.get("SUPABASE_URL")!, key, { auth: { persistSession: false } });
Deno.serve(async (req) => {
  const tk = await sb.from("interno").select("valor").eq("chave", "ciclo_token").maybeSingle();
  if (req.headers.get("x-ciclo-token") !== tk.data?.valor) return new Response("não autorizado", { status: 401 });
  const { data } = await sb.rpc("velas_json");
  const bars = (data as any[]).map((r) => ({ t: +r[0], h: r[2], l: r[3], c: r[4], v: r[5] }));
  const evMs = (Core.eventsToMs(EVENTOS) as number[]).slice().sort((a, b) => a - b);
  const P = preparar(bars), n = bars.length;
  // alvo: maior excursão das próximas 24h ≥ 1,75 × mediana das excursões dos 30 dias anteriores
  const E = new Float64Array(n).fill(NaN);
  for (let i = 0; i + 24 < n; i++) { let hi = -Infinity, lo = Infinity; for (let k = i + 1; k <= i + 24; k++) { hi = Math.max(hi, bars[k].h); lo = Math.min(lo, bars[k].l); } E[i] = Math.max(Math.log(hi / bars[i].c), Math.log(bars[i].c / lo)); }
  const t0 = Date.UTC(2023, 0, 1), res: any = {};
  for (const modelo of ["ate2022", "producao"]) {
    const pts: [number, number][] = [];
    for (let i = 9600; i + 24 < n; i++) {
      if (bars[i].t < t0) continue;
      const win = Array.from(E.subarray(i - 24 - 719, i - 23)).sort((a, b) => a - b); const med = (win[359] + win[360]) / 2;
      const p = prob(features(P, i, evMs), (COEF as any)[modelo]); if (p == null) continue;
      pts.push([p, E[i] >= 1.75 * med ? 1 : 0]);
    }
    const base = pts.reduce((s, x) => s + x[1], 0) / pts.length;
    const ord = [...pts].sort((a, b) => a[0] - b[0]), dec: number[] = [];
    for (let d = 0; d < 10; d++) { const sl = ord.slice(Math.floor(d * ord.length / 10), Math.floor((d + 1) * ord.length / 10)); dec.push(+(sl.reduce((s, x) => s + x[1], 0) / sl.length).toFixed(3)); }
    let pos = 0, rs = 0; ord.forEach((x, j) => { if (x[1]) { pos++; rs += j + 1; } }); const auc = (rs - pos * (pos + 1) / 2) / (pos * (ord.length - pos));
    const niveis: any = {};
    for (const [nome, a, b] of [["BAIXO", 0, 0.15], ["NORMAL", 0.15, 0.3], ["ALTO", 0.3, 0.45], ["MUITO ALTO", 0.45, 1]] as [string, number, number][]) {
      const s = pts.filter((x) => x[0] >= a && x[0] < b); niveis[nome] = { tempo: +(s.length / pts.length * 100).toFixed(1), acerto: +(s.reduce((q, x) => q + x[1], 0) / Math.max(1, s.length) * 100).toFixed(1) };
    }
    res[modelo] = { n: pts.length, base: +(base * 100).toFixed(1), auc: +auc.toFixed(3), decis: dec, niveis };
  }
  return new Response(JSON.stringify(res), { headers: { "content-type": "application/json" } });
});
