// Stockage de la base dans Netlify Blobs : un objet JSON par (intervalle, ticker).
import { getStore } from "@netlify/blobs";
import type { Info, Row } from "./yahoo.mts";

export type Doc = { ticker: string; interval: string; info: Info; rows: Row[]; updated: string };

const store = () => getStore({ name: "bourse", consistency: "strong" });
const keyOf = (interval: string, ticker: string) => `${interval}/${encodeURIComponent(ticker)}`;

export async function getDoc(interval: string, ticker: string): Promise<Doc | null> {
  return (await store().get(keyOf(interval, ticker), { type: "json" })) as Doc | null;
}

/** Fusionne les nouvelles lignes avec l'existant (les nouvelles remplacent les anciennes à date égale). */
export function merge(oldRows: Row[], newRows: Row[]): Row[] {
  const m = new Map<string, Row>();
  for (const r of oldRows) m.set(r[0], r);
  for (const r of newRows) m.set(r[0], r);
  return [...m.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

export async function saveDoc(doc: Doc) {
  const rows = doc.rows;
  await store().setJSON(keyOf(doc.interval, doc.ticker), doc, {
    metadata: {
      ticker: doc.ticker,
      interval: doc.interval,
      name: doc.info.name,
      currency: doc.info.currency,
      count: rows.length,
      start: rows[0]?.[0] ?? null,
      end: rows.at(-1)?.[0] ?? null,
      updated: doc.updated,
    },
  });
}

export async function summary() {
  const s = store();
  const { blobs } = await s.list();
  const metas = await Promise.all(blobs.map((b) => s.getMetadata(b.key)));
  return metas
    .map((m) => m?.metadata)
    .filter(Boolean)
    .sort((a: any, b: any) => (a.ticker + a.interval < b.ticker + b.interval ? -1 : 1));
}

export async function deleteDoc(interval: string, ticker: string) {
  await store().delete(keyOf(interval, ticker));
}

/** Si la variable APP_PASSWORD est définie, toutes les requêtes doivent fournir ce mot de passe. */
export function checkAuth(req: Request): Response | null {
  const expected = Netlify.env.get("APP_PASSWORD");
  if (!expected || req.headers.get("x-app-password") === expected) return null;
  return Response.json({ error: "mot de passe requis" }, { status: 401 });
}
