import type { Config, Context } from "@netlify/functions";
import { checkAuth } from "../lib/store.mts";
import {
  deleteDoc, fetchIndicator, getDoc, listCountries, listIndicators, mergeRows, saveDoc, searchIndicators, summary,
} from "../lib/worldbank.mts";

// GET    /api/wb/search?q=pib            -> indicateurs correspondants
// GET    /api/wb/countries               -> pays et groupes de pays
// POST   /api/wb/download                -> { indicator, countries: ["FRA", ...] (vide = tous), start, end }
// GET    /api/wb/data                    -> indicateurs enregistrés
// GET    /api/wb/data?indicator=CODE     -> toutes les valeurs d'un indicateur
// DELETE /api/wb/data?indicator=CODE     -> supprime l'indicateur de la base
export default async (req: Request, context: Context) => {
  const denied = checkAuth(req);
  if (denied) return denied;
  const url = new URL(req.url);
  const action = context.params.action;

  try {
    if (action === "search") {
      const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
      return Response.json({ results: q.length < 2 ? [] : await searchIndicators(q) });
    }

    if (action === "countries") return Response.json({ countries: await listCountries() });

    if (action === "download" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const id = String(body.indicator || "").trim();
      if (!/^[A-Za-z0-9._]+$/.test(id)) return Response.json({ error: "indicateur invalide" }, { status: 400 });
      const countries: string[] = (Array.isArray(body.countries) ? body.countries : [])
        .map((c: any) => String(c).toUpperCase())
        .filter((c: string) => /^[A-Z0-9]{2,3}$/.test(c));
      if (countries.length > 60) return Response.json({ error: "60 pays maximum (ou « tous les pays »)" }, { status: 400 });
      const year = new Date().getFullYear();
      const start = Math.max(1960, Math.min(year, Number(body.start) || 2000));
      const end = Math.max(start, Math.min(year, Number(body.end) || year));

      const { rows, name } = await fetchIndicator(id, countries, start, end);
      const info = (await listIndicators()).find((i) => i.id === id);
      const indicator = info || { id, name: name || id, unit: null, source: null, note: null };
      const old = await getDoc(id);
      const all = mergeRows(old?.rows || [], rows);
      if (all.length) await saveDoc({ indicator, rows: all, updated: new Date().toISOString() });
      return Response.json({ indicator, received: rows.length, total: all.length });
    }

    if (action === "data") {
      const id = url.searchParams.get("indicator");
      if (req.method === "DELETE") {
        if (!id) return Response.json({ error: "indicateur manquant" }, { status: 400 });
        await deleteDoc(id);
        return Response.json({ ok: true });
      }
      if (!id) return Response.json({ summary: await summary() });
      const doc = await getDoc(id);
      return doc ? Response.json(doc) : Response.json({ error: "introuvable" }, { status: 404 });
    }

    return Response.json({ error: "action inconnue" }, { status: 404 });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 502 });
  }
};

export const config: Config = { path: "/api/wb/:action", method: ["GET", "POST", "DELETE"] };
