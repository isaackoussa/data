import type { Config } from "@netlify/functions";
import { checkAuth, deleteDoc, getDoc, summary } from "../lib/store.mts";

// GET    /api/data                        -> contenu de la base (une ligne par action)
// GET    /api/data?ticker=AAPL&interval=1d -> toutes les lignes d'une action
// DELETE /api/data?ticker=AAPL&interval=1d -> supprime l'action
export default async (req: Request) => {
  const denied = checkAuth(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const ticker = url.searchParams.get("ticker");
  const interval = url.searchParams.get("interval") || "1d";

  if (req.method === "DELETE") {
    if (!ticker) return Response.json({ error: "ticker manquant" }, { status: 400 });
    await deleteDoc(interval, ticker);
    return Response.json({ ok: true });
  }

  if (!ticker) return Response.json({ summary: await summary() });

  const doc = await getDoc(interval, ticker);
  if (!doc) return Response.json({ error: "introuvable" }, { status: 404 });
  return Response.json(doc);
};

export const config: Config = { path: "/api/data", method: ["GET", "DELETE"] };
