import { createClient } from "jsr:@supabase/supabase-js@2";
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
Deno.serve(async (req) => {
  const tk = await sb.from("interno").select("valor").eq("chave", "ciclo_token").maybeSingle();
  if (req.headers.get("x-ciclo-token") !== tk.data?.valor) return new Response("nao autorizado", { status: 401 });
  const { modo } = await req.json();
  try {
    const r = modo === "funding" ? await funding() : await correl();
    return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ erro: String(e) }), { status: 500 });
  }
});
