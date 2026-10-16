import type { Config } from "@netlify/functions";
import { checkAuth, getDoc, merge, saveDoc } from "../lib/store.mts";
import { fetchPrices, INTERVALS, PERIODS } from "../lib/yahoo.mts";

const MAX_TICKERS = 20;

export default async (req: Request) => {
  const denied = checkAuth(req);
  if (denied) return denied;

  const body = await req.json().catch(() => ({}));
  const tickers: string[] = [
    ...new Set<string>(
      String(body.tickers || "")
        .toUpperCase()
        .split(/[\s,;]+/)
        .filter(Boolean),
    ),
  ];
  const interval = INTERVALS.includes(body.interval) ? body.interval : "1d";
  const period = PERIODS.includes(body.period) ? body.period : "1y";
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const start = dateRe.test(body.start || "") ? body.start : undefined;
  const end = dateRe.test(body.end || "") ? body.end : undefined;

  if (!tickers.length) return Response.json({ error: "aucun ticker" }, { status: 400 });
  if (tickers.length > MAX_TICKERS)
    return Response.json({ error: `maximum ${MAX_TICKERS} tickers par téléchargement` }, { status: 400 });

  const results = await Promise.all(
    tickers.map(async (ticker) => {
      try {
        const { info, rows } = await fetchPrices(ticker, { interval, period, start, end });
        if (!rows.length) return { ticker, lignes: 0, statut: "aucune donnée" };
        const old = await getDoc(interval, ticker);
        const all = merge(old?.rows || [], rows);
        await saveDoc({ ticker, interval, info, rows: all, updated: new Date().toISOString() });
        return { ticker, lignes: rows.length, total: all.length, nom: info.name, statut: "ok" };
      } catch (e: any) {
        return { ticker, lignes: 0, statut: `erreur : ${e.message}` };
      }
    }),
  );
  return Response.json({ results });
};

export const config: Config = { path: "/api/download", method: "POST" };
