import type { Config } from "@netlify/functions";
import { checkAuth } from "../lib/store.mts";
import { searchSymbols } from "../lib/yahoo.mts";

// GET /api/search?q=omx stockholm -> [{ symbol, name, exchange, type }]
export default async (req: Request) => {
  const denied = checkAuth(req);
  if (denied) return denied;

  const q = (new URL(req.url).searchParams.get("q") || "").trim().slice(0, 100);
  if (q.length < 2) return Response.json({ results: [] });
  try {
    return Response.json({ results: await searchSymbols(q) });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 502 });
  }
};

export const config: Config = { path: "/api/search", method: "GET" };
