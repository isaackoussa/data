"""Couche base de données SQLite."""
import sqlite3
from pathlib import Path

import pandas as pd

DEFAULT_DB = Path(__file__).resolve().parent.parent / "bourse.db"

PRICE_COLUMNS = ["open", "high", "low", "close", "adj_close", "volume"]

SCHEMA = """
CREATE TABLE IF NOT EXISTS prices (
    ticker    TEXT NOT NULL,
    interval  TEXT NOT NULL DEFAULT '1d',
    date      TEXT NOT NULL,
    open      REAL,
    high      REAL,
    low       REAL,
    close     REAL,
    adj_close REAL,
    volume    INTEGER,
    PRIMARY KEY (ticker, interval, date)
);
CREATE TABLE IF NOT EXISTS tickers (
    ticker     TEXT PRIMARY KEY,
    name       TEXT,
    exchange   TEXT,
    currency   TEXT,
    sector     TEXT,
    industry   TEXT,
    updated_at TEXT
);
"""


def connect(path=DEFAULT_DB) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path))
    conn.executescript(SCHEMA)
    return conn


def save_prices(conn, df: pd.DataFrame, ticker: str, interval: str = "1d") -> int:
    """Insère ou met à jour les cours (pas de doublons). Retourne le nombre de lignes."""
    if df.empty:
        return 0
    rows = [
        (ticker, interval, r.date, r.open, r.high, r.low, r.close, r.adj_close,
         None if pd.isna(r.volume) else int(r.volume))
        for r in df.itertuples(index=False)
    ]
    conn.executemany(
        """INSERT INTO prices (ticker, interval, date, open, high, low, close, adj_close, volume)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(ticker, interval, date) DO UPDATE SET
             open=excluded.open, high=excluded.high, low=excluded.low,
             close=excluded.close, adj_close=excluded.adj_close, volume=excluded.volume""",
        rows,
    )
    conn.commit()
    return len(rows)


def save_info(conn, ticker: str, info: dict) -> None:
    conn.execute(
        """INSERT INTO tickers (ticker, name, exchange, currency, sector, industry, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(ticker) DO UPDATE SET
             name=excluded.name, exchange=excluded.exchange, currency=excluded.currency,
             sector=excluded.sector, industry=excluded.industry, updated_at=excluded.updated_at""",
        (ticker, info.get("name"), info.get("exchange"), info.get("currency"),
         info.get("sector"), info.get("industry")),
    )
    conn.commit()


def summary(conn) -> pd.DataFrame:
    """Une ligne par action : nombre de lignes, première et dernière date."""
    return pd.read_sql_query(
        """SELECT p.ticker, p.interval, t.name, t.currency, COUNT(*) AS lignes,
                  MIN(p.date) AS debut, MAX(p.date) AS fin
           FROM prices p LEFT JOIN tickers t USING (ticker)
           GROUP BY p.ticker, p.interval ORDER BY p.ticker""",
        conn,
    )


def load_prices(conn, tickers, interval="1d", start=None, end=None) -> pd.DataFrame:
    tickers = list(tickers)
    if not tickers:
        return pd.DataFrame()
    sql = f"SELECT * FROM prices WHERE interval = ? AND ticker IN ({','.join('?' * len(tickers))})"
    params = [interval, *tickers]
    if start:
        sql += " AND date >= ?"
        params.append(str(start))
    if end:
        sql += " AND date <= ?"
        params.append(str(end) + " 23:59:59")
    sql += " ORDER BY ticker, date"
    return pd.read_sql_query(sql, conn, params=params)


def delete_ticker(conn, ticker: str) -> None:
    conn.execute("DELETE FROM prices WHERE ticker = ?", (ticker,))
    conn.execute("DELETE FROM tickers WHERE ticker = ?", (ticker,))
    conn.commit()


def run_query(conn, sql: str) -> pd.DataFrame:
    """Exécute une requête SQL en lecture seule (SELECT / WITH uniquement)."""
    first = sql.strip().split(None, 1)[0].upper() if sql.strip() else ""
    if first not in ("SELECT", "WITH"):
        raise ValueError("Seules les requêtes SELECT / WITH sont autorisées ici.")
    return pd.read_sql_query(sql, conn)
