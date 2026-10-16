"""Téléchargement des données depuis Yahoo Finance (via yfinance)."""
import pandas as pd
import yfinance as yf

# Intervalles intraday : Yahoo limite l'historique (ex. 1m = 7 jours, 1h = 730 jours)
INTERVALS = ["1d", "1wk", "1mo", "1h", "30m", "15m", "5m", "1m"]
PERIODS = ["1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "ytd", "max"]


def parse_tickers(text: str) -> list[str]:
    """'AAPL, mc.pa  TSLA' -> ['AAPL', 'MC.PA', 'TSLA']"""
    seen = []
    for t in text.replace(",", " ").replace(";", " ").split():
        t = t.strip().upper()
        if t and t not in seen:
            seen.append(t)
    return seen


def download_prices(ticker: str, interval="1d", period=None, start=None, end=None) -> pd.DataFrame:
    """Renvoie un DataFrame aux colonnes : date, open, high, low, close, adj_close, volume."""
    kwargs = {"interval": interval, "auto_adjust": False, "actions": False}
    if start or end:
        kwargs.update(start=start, end=end)
    else:
        kwargs["period"] = period or "1y"
    raw = yf.Ticker(ticker).history(**kwargs)
    return normalize(raw, intraday=interval not in ("1d", "1wk", "1mo"))


def normalize(raw: pd.DataFrame, intraday: bool = False) -> pd.DataFrame:
    cols = ["date", "open", "high", "low", "close", "adj_close", "volume"]
    if raw is None or raw.empty:
        return pd.DataFrame(columns=cols)
    df = raw.reset_index()
    df.columns = [str(c).lower().replace(" ", "_") for c in df.columns]
    if "datetime" in df.columns:
        df = df.rename(columns={"datetime": "date"})
    if "adj_close" not in df.columns:
        df["adj_close"] = df["close"]
    fmt = "%Y-%m-%d %H:%M:%S" if intraday else "%Y-%m-%d"
    df["date"] = pd.to_datetime(df["date"]).dt.strftime(fmt)
    return df[cols].dropna(subset=["close"])


def download_info(ticker: str) -> dict:
    """Infos générales de l'entreprise (peut échouer selon le ticker : on renvoie {} alors)."""
    try:
        info = yf.Ticker(ticker).info or {}
    except Exception:
        return {}
    return {
        "name": info.get("longName") or info.get("shortName"),
        "exchange": info.get("exchange"),
        "currency": info.get("currency"),
        "sector": info.get("sector"),
        "industry": info.get("industry"),
    }
