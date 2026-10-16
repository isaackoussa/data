// Données de la Banque mondiale (API ouverte, en français) : https://api.worldbank.org/v2/fr/...
import { getStore } from "@netlify/blobs";

const API = "https://api.worldbank.org/v2/fr";
const CACHE_DAYS = 7;

export type WbIndicator = { id: string; name: string; unit: string | null; source: string | null; note: string | null };
export type WbCountry = { id: string; name: string; region: string | null; aggregate: boolean };
// [code pays ISO3, nom du pays, année, valeur]
export type WbRow = [string, string, number, number];
export type WbDoc = { indicator: WbIndicator; rows: WbRow[]; updated: string };

const store = () => getStore({ name: "worldbank", consistency: "strong" });

async function wbFetch(path: string): Promise<any[]> {
  const sep = path.includes("?") ? "&" : "?";
  const resp = await fetch(`${API}${path}${sep}format=json`, { headers: { Accept: "application/json" } });
  const json: any = await resp.json().catch(() => null);
  if (!json) throw new Error(`Banque mondiale : réponse ${resp.status}`);
  // en cas d'erreur l'API renvoie [{ message: [{ value: "..." }] }]
  if (!Array.isArray(json) || json[0]?.message) {
    throw new Error(json?.[0]?.message?.[0]?.value || "réponse inattendue de la Banque mondiale");
  }
  return json;
}

/** Liste gardée en cache dans Blobs (les listes d'indicateurs et de pays changent rarement). */
async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const s = getStore({ name: "cache", consistency: "strong" });
  const hit = (await s.get(key, { type: "json" })) as { at: number; data: T } | null;
  if (hit && Date.now() - hit.at < CACHE_DAYS * 864e5) return hit.data;
  const data = await load();
  await s.setJSON(key, { at: Date.now(), data });
  return data;
}

/** Les ~1 500 indicateurs du World Development Indicators (source 2), en français. */
export const listIndicators = () =>
  cached("wb-indicators-fr", async () => {
    const [, items] = await wbFetch("/sources/2/indicators?per_page=5000");
    return (items || []).map((x: any): WbIndicator => ({
      id: x.id,
      name: (x.name || x.id).trim(),
      unit: x.unit || null,
      source: x.source?.value || null,
      note: x.sourceNote ? String(x.sourceNote).slice(0, 600) : null,
    }));
  });

export const listCountries = () =>
  cached("wb-countries-fr", async () => {
    const [, items] = await wbFetch("/country?per_page=400");
    return (items || [])
      .map((x: any): WbCountry => ({
        id: x.id,
        name: x.name,
        region: x.region?.id && x.region.id !== "NA" ? x.region.value?.trim() : null,
        aggregate: x.region?.id === "NA",
      }))
      .sort((a: WbCountry, b: WbCountry) => a.name.localeCompare(b.name, "fr"));
  });

const norm = (t: string) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Recherche d'indicateurs : tous les mots doivent apparaître dans le nom ou le code. */
export async function searchIndicators(q: string): Promise<WbIndicator[]> {
  const words = norm(q).split(/\s+/).filter(Boolean);
  const all = await listIndicators();
  return all
    .filter((i) => { const h = norm(`${i.id} ${i.name}`); return words.every((w) => h.includes(w)); })
    // les noms les plus courts (indicateurs les plus généraux) d'abord
    .sort((a, b) => a.name.length - b.name.length)
    .slice(0, 30);
}

export async function fetchIndicator(id: string, countries: string[], start: number, end: number) {
  // codes déjà validés (2-3 lettres/chiffres) : le ";" doit rester tel quel dans l'URL
  const where = countries.length ? countries.join(";") : "all";
  const [meta, items] = await wbFetch(
    `/country/${where}/indicator/${encodeURIComponent(id)}?per_page=20000&date=${start}:${end}`,
  );
  if (meta?.pages > 1) throw new Error("trop de données d'un coup : réduis la période ou le nombre de pays");
  const rows: WbRow[] = (items || [])
    .filter((x: any) => x.value != null && x.countryiso3code)
    .map((x: any) => [x.countryiso3code, x.country?.value || x.countryiso3code, Number(x.date), Number(x.value)]);
  const indicator = items?.[0]?.indicator;
  return { rows, name: indicator?.value as string | undefined };
}

export function mergeRows(oldRows: WbRow[], newRows: WbRow[]): WbRow[] {
  const m = new Map<string, WbRow>();
  for (const r of [...oldRows, ...newRows]) m.set(`${r[0]}|${r[2]}`, r);
  return [...m.values()].sort((a, b) => (a[1] === b[1] ? a[2] - b[2] : a[1].localeCompare(b[1], "fr")));
}

export const getDoc = async (id: string) => (await store().get(encodeURIComponent(id), { type: "json" })) as WbDoc | null;

export async function saveDoc(doc: WbDoc) {
  const countries = new Set(doc.rows.map((r) => r[0]));
  const years = doc.rows.map((r) => r[2]);
  await store().setJSON(encodeURIComponent(doc.indicator.id), doc, {
    metadata: {
      id: doc.indicator.id,
      name: doc.indicator.name,
      count: doc.rows.length,
      countries: countries.size,
      start: years.length ? Math.min(...years) : null,
      end: years.length ? Math.max(...years) : null,
      updated: doc.updated,
    },
  });
}

export async function summary() {
  const s = store();
  const { blobs } = await s.list();
  const metas = await Promise.all(blobs.map((b) => s.getMetadata(b.key)));
  return metas.map((m) => m?.metadata).filter(Boolean).sort((a: any, b: any) => a.name.localeCompare(b.name, "fr"));
}

export const deleteDoc = (id: string) => store().delete(encodeURIComponent(id));
