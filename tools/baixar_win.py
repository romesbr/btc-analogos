# Baixa o histórico do mini índice (série contínua) do MetaTrader 5 e salva CSVs compactados em data/win/.
import os, sys, time, json, datetime as dt
import MetaTrader5 as mt5
import pandas as pd

OUT = "data/win"; os.makedirs(OUT, exist_ok=True)
rel = {"inicio": dt.datetime.utcnow().isoformat(), "etapas": []}
def nota(m):
    print(m, flush=True); rel["etapas"].append(m)
def salvar_rel():
    json.dump(rel, open(f"{OUT}/relatorio.json", "w"), indent=1, ensure_ascii=False, default=str)

senha = os.environ.get("MT5_PASSWORD", "")
if not senha:
    nota("ERRO: segredo MT5_PASSWORD não configurado no GitHub"); salvar_rel(); sys.exit(1)
path = r"C:\Program Files\MetaTrader 5\terminal64.exe"
ok = False
for tent in range(3):
    ok = mt5.initialize(path=path, login=int(os.environ["MT5_LOGIN"]), password=senha, server=os.environ["MT5_SERVER"], timeout=180000)
    nota(f"initialize tentativa {tent+1}: {ok} {mt5.last_error()}")
    if ok: break
    time.sleep(15)
if not ok:
    salvar_rel(); sys.exit(1)
ai = mt5.account_info(); nota(f"conta: {ai.login if ai else None} servidor: {ai.server if ai else None}")
ti = mt5.terminal_info(); nota(f"terminal: maxbars={getattr(ti, 'maxbars', None)} conectado={getattr(ti, 'connected', None)}")
cands = [s.name for s in (mt5.symbols_get("WIN*") or [])]
nota(f"símbolos WIN encontrados: {cands[:40]}")
alvos = [s for s in ["WIN$N", "WIN$", "WIN$D", "WIN@N", "WIN@"] if s in cands] or [c for c in cands if "$" in c or "@" in c][:2]
nota(f"usando: {alvos}")
TFS = {"M1": mt5.TIMEFRAME_M1, "M5": mt5.TIMEFRAME_M5, "M15": mt5.TIMEFRAME_M15, "H1": mt5.TIMEFRAME_H1, "D1": mt5.TIMEFRAME_D1}
for sym in alvos:
    mt5.symbol_select(sym, True); time.sleep(3)
    for nome, tf in TFS.items():
        frames = []
        fim = dt.datetime.now() + dt.timedelta(days=1)
        # pede em blocos para trás até não vir mais nada
        for _ in range(400):
            r = None
            for _t in range(4):
                r = mt5.copy_rates_from(sym, tf, fim, 50000)
                if r is not None and len(r): break
                time.sleep(3)
            if r is None or not len(r): break
            df = pd.DataFrame(r); frames.append(df)
            primeiro = pd.to_datetime(df.time.min(), unit="s")
            novo_fim = primeiro.to_pydatetime() - dt.timedelta(seconds=1)
            if novo_fim >= fim: break
            fim = novo_fim
            if len(r) < 50000: break
        if not frames:
            nota(f"{sym} {nome}: sem dados {mt5.last_error()}"); continue
        df = pd.concat(frames).drop_duplicates("time").sort_values("time")
        df["time"] = pd.to_datetime(df.time, unit="s")
        arq = f"{OUT}/{sym.replace('$','S').replace('@','A')}_{nome}.csv.gz"
        df.to_csv(arq, index=False, compression="gzip")
        nota(f"{sym} {nome}: {len(df)} velas de {df.time.min()} a {df.time.max()} -> {arq}")
mt5.shutdown(); rel["fim"] = dt.datetime.utcnow().isoformat(); salvar_rel()
