// Récupération des cours via l'API "chart" de Yahoo Finance.

export const INTERVALS = ["1d", "1wk", "1mo", "1h", "30m", "15m", "5m", "1m"];
export const PERIODS = ["1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "ytd", "max"];

// [date, open, high, low, close, adj_close, volume]
export type Row = [string, number | null, number | null, number | null, number, number | null, number | null];

export type Info = {
  name: string | null;
  exchange: string | null;
  currency: string | null;
  type: string | null;
};

export type Options = { interval: string; period?: string; start?: string; end?: string };

const round = (v: number | null | undefined) =>
  v == null || Number.isNaN(v) ? null : Math.round(v * 1e6) / 1e6;

export function buildUrl(ticker: string, o: Options): string {
  const params = new URLSearchParams({ interval: o.interval, includeAdjustedClose: "true", events: "div,splits" });
  if (o.start || o.end) {
    const start = o.start ? Date.parse(o.start) / 1000 : 0;
    // la date de fin est incluse : on va jusqu'au lendemain 00:00
    const end = o.end ? Date.parse(o.end) / 1000 + 86400 : Math.floor(Date.now() / 1000);
    params.set("period1", String(Math.floor(start)));
    params.set("period2", String(Math.floor(end)));
  } else {
    params.set("range", o.period || "1y");
  }
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?${params}`;
}

export function parseChart(json: any, interval: string): { info: Info; rows: Row[] } {
  const err = json?.chart?.error;
  if (err) throw new Error(err.description || err.code || "erreur Yahoo");
  const res = json?.chart?.result?.[0];
  if (!res) throw new Error("aucune donnée");
  const meta = res.meta || {};
  const info: Info = {
    name: meta.longName || meta.shortName || null,
    exchange: meta.fullExchangeName || meta.exchangeName || null,
    currency: meta.currency || null,
    type: meta.instrumentType || null,
  };
  const ts: number[] = res.timestamp || [];
  const q = res.indicators?.quote?.[0] || {};
  const adj: (number | null)[] = res.indicators?.adjclose?.[0]?.adjclose || [];
  const intraday = !["1d", "1wk", "1mo"].includes(interval);
  const offset = meta.gmtoffset || 0; // dates à l'heure locale de la bourse
  const byDate = new Map<string, Row>();
  ts.forEach((t, i) => {
    const close = q.close?.[i];
    if (close == null) return;
    const iso = new Date((t + offset) * 1000).toISOString();
    const date = intraday ? iso.slice(0, 19).replace("T", " ") : iso.slice(0, 10);
    byDate.set(date, [
      date,
      round(q.open?.[i]),
      round(q.high?.[i]),
      round(q.low?.[i]),
      round(close) as number,
      round(adj[i] ?? close),
      q.volume?.[i] ?? null,
    ]);
  });
  return { info, rows: [...byDate.values()] };
}

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36",
  Accept: "application/json",
};

export type SearchResult = { symbol: string; name: string | null; exchange: string | null; type: string | null };

/** Recherche de tickers par nom ("OMX Stockholm 30", "LVMH", "Taiwan"...). */
export async function searchSymbols(q: string): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q, quotesCount: "10", newsCount: "0", listsCount: "0", enableFuzzyQuery: "true" });
  const resp = await fetch(`https://query2.finance.yahoo.com/v1/finance/search?${params}`, { headers: HEADERS });
  const json: any = await resp.json().catch(() => null);
  if (!json) throw new Error(`Yahoo a répondu ${resp.status}`);
  return (json.quotes || [])
    .filter((x: any) => x.symbol)
    .map((x: any) => ({
      symbol: x.symbol,
      name: x.longname || x.shortname || null,
      exchange: x.exchDisp || x.exchange || null,
      type: x.typeDisp || x.quoteType || null,
    }));
}

export async function fetchPrices(ticker: string, o: Options) {
  const resp = await fetch(buildUrl(ticker, o), { headers: HEADERS });
  if (resp.status === 404) throw new Error("ticker introuvable");
  const json = await resp.json().catch(() => null);
  if (!json) throw new Error(`Yahoo a répondu ${resp.status}`);
  return parseChart(json, o.interval);
}
