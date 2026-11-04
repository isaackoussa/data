import type { Config, Context } from "@netlify/functions";
import { checkAuth } from "../lib/store.mts";
import {
  deleteQuotes, deleteRef, fetchAndStoreBrvm, getBonds, getFetchLog, getQuotes, getRefs, mergeQuotes, mergeRefs,
  quotesSummary, saveBonds, type Quote,
} from "../lib/brvm.mts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const num = (v: any) => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

// GET    /api/brvm/bonds                 -> caractéristiques des obligations
// PUT    /api/brvm/bonds                 -> remplace la liste { bonds: [...] }
// GET    /api/brvm/quotes                -> résumé des cotations enregistrées
// GET    /api/brvm/quotes?symbol=X       -> cotations d'une obligation
// POST   /api/brvm/quotes                -> import { rows: [{ symbol, date, price, volume, value }] }
// DELETE /api/brvm/quotes?symbol=X
// GET    /api/brvm/refs                  -> séries de référence
// POST   /api/brvm/refs                  -> import { series, points: [{ date, rate }] }
// DELETE /api/brvm/refs?series=X
// POST   /api/brvm/fetch                 -> lit la cote du jour sur brvm.org { save: true|false, date? }
// GET    /api/brvm/log                   -> journal des récupérations automatiques
export default async (req: Request, context: Context) => {
  const denied = checkAuth(req);
  if (denied) return denied;
  const url = new URL(req.url);
  const a = context.params.action;
  try {
    if (a === "bonds") {
      if (req.method === "PUT") {
        const body = await req.json();
        const bonds = (Array.isArray(body.bonds) ? body.bonds : [])
          .filter((b: any) => b && String(b.symbol || "").trim())
          .map((b: any) => ({ ...b, symbol: String(b.symbol).trim().toUpperCase() }));
        if (bonds.length > 2000) return Response.json({ error: "trop d'obligations" }, { status: 400 });
        await saveBonds(bonds);
        return Response.json({ ok: true, count: bonds.length });
      }
      return Response.json({ bonds: await getBonds() });
    }

    if (a === "quotes") {
      const symbol = url.searchParams.get("symbol");
      if (req.method === "DELETE") {
        if (!symbol) return Response.json({ error: "symbole manquant" }, { status: 400 });
        await deleteQuotes(symbol);
        return Response.json({ ok: true });
      }
      if (req.method === "POST") {
        const body = await req.json();
        const rows = Array.isArray(body.rows) ? body.rows : [];
        if (rows.length > 200000) return Response.json({ error: "trop de lignes (200 000 max par import)" }, { status: 400 });
        const by = new Map<string, Quote[]>();
        let rejected = 0;
        for (const r of rows) {
          const sym = String(r.symbol || "").trim().toUpperCase();
          if (!sym || !DATE.test(String(r.date || "")) || num(r.price) == null) { rejected++; continue; }
          if (!by.has(sym)) by.set(sym, []);
          by.get(sym)!.push([r.date, num(r.price), num(r.volume) ?? 0, num(r.value)]);
        }
        for (const [sym, q] of by) await mergeQuotes(sym, q);
        // obligations inconnues ajoutées à la table des caractéristiques
        const bonds = await getBonds();
        const known = new Set(bonds.map((b) => b.symbol));
        const fresh = [...by.keys()].filter((s) => !known.has(s)).map((symbol) => ({ symbol }));
        if (fresh.length) await saveBonds([...bonds, ...fresh]);
        return Response.json({ imported: rows.length - rejected, rejected, bonds: by.size, newBonds: fresh.length });
      }
      if (symbol) {
        const q = await getQuotes(symbol);
        return q ? Response.json(q) : Response.json({ error: "introuvable" }, { status: 404 });
      }
      return Response.json({ summary: await quotesSummary() });
    }

    if (a === "refs") {
      if (req.method === "DELETE") {
        const series = url.searchParams.get("series");
        if (!series) return Response.json({ error: "série manquante" }, { status: 400 });
        await deleteRef(series);
        return Response.json({ ok: true });
      }
      if (req.method === "POST") {
        const body = await req.json();
        const series = String(body.series || "").trim().slice(0, 80);
        if (!series) return Response.json({ error: "nom de série manquant" }, { status: 400 });
        const pts = (Array.isArray(body.points) ? body.points : [])
          .filter((p: any) => DATE.test(String(p.date || "")) && num(p.rate) != null)
          .map((p: any) => [p.date, num(p.rate)] as [string, number]);
        return Response.json({ series, count: await mergeRefs(series, pts), imported: pts.length });
      }
      return Response.json({ refs: await getRefs() });
    }

    if (a === "fetch" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const date = DATE.test(String(body.date || "")) ? body.date : new Date().toISOString().slice(0, 10);
      return Response.json(await fetchAndStoreBrvm(date, body.save !== false));
    }

    if (a === "log") return Response.json({ log: await getFetchLog() });

    return Response.json({ error: "action inconnue" }, { status: 404 });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 502 });
  }
};

export const config: Config = { path: "/api/brvm/:action", method: ["GET", "POST", "PUT", "DELETE"] };
