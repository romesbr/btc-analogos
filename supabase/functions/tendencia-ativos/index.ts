// Teste de regras de tendência diária em vários ativos (dados diários do Yahoo Finance).
// Regras definidas antes: médias de 20/50/100/200 dias e momentum de 7/28/90 dias; comprado/fora e comprado/vendido.
// Sinal no fechamento, posição a partir do pregão seguinte, custo 0,05% por lado. Períodos: 1ª metade, 2ª metade, últimos 12 meses.
const ATIVOS: Record<string, string> = { "BTC-USD": "Bitcoin", "ETH-USD": "Ethereum", "GC=F": "Ouro", "^GSPC": "S&P 500", "^BVSP": "Ibovespa", "BRL=X": "Dólar/Real", "SOL-USD": "Solana" };
const FEE = 0.0005;
async function serie(sym: string) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=946684800&period2=${Math.floor(Date.now() / 1000)}&interval=1d&events=history`;
  const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`${sym}: HTTP ${r.status}`);
  const j = await r.json(); const res = j.chart.result[0];
  const ts: number[] = res.timestamp; const cl: (number | null)[] = (res.indicators.adjclose?.[0]?.adjclose) ?? res.indicators.quote[0].close;
  const out: { t: number; c: number }[] = [];
  for (let i = 0; i < ts.length; i++) if (cl[i] != null && isFinite(cl[i] as number) && (cl[i] as number) > 0) out.push({ t: ts[i] * 1000, c: cl[i] as number });
  return out;
}
function avalia(c: number[], pos: number[], i0: number, i1: number, porAno: number) {
  let eq = 1, pico = 1, dd = 0, trocas = 0, somaR = 0, somaR2 = 0, n = 0, prev = 0;
  for (let i = i0 + 1; i <= i1; i++) {
    const p = pos[i - 1]; // sinal de ontem
    const r = c[i] / c[i - 1] - 1;
    const custo = Math.abs(p - prev) * FEE; if (p !== prev) trocas++; prev = p;
    const net = p * r - custo;
    eq *= 1 + net; pico = Math.max(pico, eq); dd = Math.min(dd, eq / pico - 1);
    somaR += net; somaR2 += net * net; n++;
  }
  const anos = n / porAno, media = somaR / n, sd = Math.sqrt(somaR2 / n - media * media);
  return { cagr: +(((eq ** (1 / anos)) - 1) * 100).toFixed(1), sharpe: +((media / sd) * Math.sqrt(porAno)).toFixed(2), maxdd: +(dd * 100).toFixed(1), trocasAno: +(trocas / anos).toFixed(1) };
}
Deno.serve(async () => {
  const saida: unknown[] = [];
  for (const [sym, nome] of Object.entries(ATIVOS)) {
    let s; try { s = await serie(sym); } catch (e) { saida.push({ ativo: nome, erro: String(e) }); continue; }
    if (s.length < 400) { saida.push({ ativo: nome, erro: `poucos dados (${s.length})` }); continue; }
    const c = s.map((x) => x.c), n = c.length;
    saida.push({ ativo: nome, info: true, pontos: n, primeiro: new Date(s[0].t).toISOString().slice(0, 10), ultimo: new Date(s[n - 1].t).toISOString().slice(0, 10) });
    const anosTot = (s[n - 1].t - s[0].t) / (365.25 * 86400e3); const porAno = n / anosTot;
    const pre = [0]; for (const x of c) pre.push(pre[pre.length - 1] + x);
    const sma = (i: number, k: number) => i < k - 1 ? NaN : (pre[i + 1] - pre[i + 1 - k]) / k;
    const regras: Record<string, number[]> = { "Comprar e segurar": c.map(() => 1) };
    for (const k of [20, 50, 100, 200]) {
      const up = c.map((x, i) => (isFinite(sma(i, k)) && x > sma(i, k)) ? 1 : 0);
      regras[`Média ${k}d · comprado/fora`] = up; regras[`Média ${k}d · comprado/vendido`] = up.map((u, i) => isFinite(sma(i, k)) ? (u ? 1 : -1) : 0);
    }
    for (const L of [7, 28, 90]) {
      const m = c.map((x, i) => i >= L ? Math.sign(Math.log(x / c[i - L])) : 0);
      regras[`Momentum ${L}d · comprado/fora`] = m.map((v) => v > 0 ? 1 : 0); regras[`Momentum ${L}d · comprado/vendido`] = m;
    }
    const start = 200, meio = Math.floor((start + n - 1) / 2);
    const ult12 = s.findIndex((x) => x.t >= s[n - 1].t - 365 * 86400e3);
    const per = { "1a metade": [start, meio], "2a metade": [meio, n - 1], "12 meses": [ult12, n - 1] } as Record<string, number[]>;
    const datas = { inicio: new Date(s[start].t).toISOString().slice(0, 10), meio: new Date(s[meio].t).toISOString().slice(0, 10), fim: new Date(s[n - 1].t).toISOString().slice(0, 10) };
    for (const [regra, pos] of Object.entries(regras)) {
      const lin: Record<string, unknown> = { ativo: nome, regra, ...datas };
      for (const [pn, [a, b]] of Object.entries(per)) lin[pn] = avalia(c, pos, a, b, porAno);
      saida.push(lin);
    }
  }
  return new Response(JSON.stringify(saida), { headers: { "content-type": "application/json" } });
});
