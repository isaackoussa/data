// Obligations BRVM : caractéristiques, cotations quotidiennes, taux de référence (Netlify Blobs, store "brvm").
import { getStore } from "@netlify/blobs";

const store = () => getStore({ name: "brvm", consistency: "strong" });

// Cotation : [date AAAA-MM-JJ, cours, volume (nombre de titres), valeur échangée (FCFA)]
export type Quote = [string, number | null, number | null, number | null];
// Référence : [date AAAA-MM-JJ, taux en %]
export type RefPoint = [string, number];

// ---------- caractéristiques (une seule liste, petite) ----------
export const getBonds = async () => ((await store().get("bonds", { type: "json" })) as any[] | null) || [];
export const saveBonds = (bonds: any[]) => store().setJSON("bonds", bonds);

// ---------- cotations : un objet par obligation ----------
const qKey = (symbol: string) => `quotes/${encodeURIComponent(symbol)}`;
export const getQuotes = async (symbol: string) =>
  ((await store().get(qKey(symbol), { type: "json" })) as { symbol: string; rows: Quote[] } | null);

/** Ajoute ou remplace des cotations (une par date). */
export async function mergeQuotes(symbol: string, rows: Quote[]) {
  const old = (await getQuotes(symbol))?.rows || [];
  const m = new Map<string, Quote>();
  for (const r of [...old, ...rows]) m.set(r[0], r);
  const all = [...m.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  await store().setJSON(qKey(symbol), { symbol, rows: all }, {
    metadata: { symbol, count: all.length, start: all[0]?.[0] ?? null, end: all.at(-1)?.[0] ?? null,
                traded: all.filter((r) => (r[2] || 0) > 0).length },
  });
  return all.length;
}

export async function quotesSummary() {
  const s = store();
  const { blobs } = await s.list({ prefix: "quotes/" });
  const metas = await Promise.all(blobs.map((b) => s.getMetadata(b.key)));
  return metas.map((m) => m?.metadata).filter(Boolean).sort((a: any, b: any) => (a.symbol < b.symbol ? -1 : 1));
}
export const deleteQuotes = (symbol: string) => store().delete(qKey(symbol));

// ---------- séries de référence (taux directeur BCEAO, UMOA-Titres...) ----------
export const getRefs = async () =>
  ((await store().get("refs", { type: "json" })) as Record<string, RefPoint[]> | null) || {};
export async function mergeRefs(series: string, points: RefPoint[]) {
  const refs = await getRefs();
  const m = new Map<string, RefPoint>((refs[series] || []).map((p) => [p[0], p]));
  for (const p of points) m.set(p[0], p);
  refs[series] = [...m.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  await store().setJSON("refs", refs);
  return refs[series].length;
}
export async function deleteRef(series: string) {
  const refs = await getRefs();
  delete refs[series];
  await store().setJSON("refs", refs);
}

// ---------- journal des récupérations automatiques ----------
export const getFetchLog = async () => ((await store().get("fetchlog", { type: "json" })) as any[] | null) || [];
export async function logFetch(entry: any) {
  const log = await getFetchLog();
  log.unshift({ at: new Date().toISOString(), ...entry });
  await store().setJSON("fetchlog", log.slice(0, 60));
}

// ---------- lecture de la cote des obligations sur brvm.org ----------
// ⚠️ Le format exact de la page n'a pas pu être vérifié : l'analyse est volontairement générique
// (on cherche un tableau dont les en-têtes ressemblent à « Symbole », « Cours », « Volume »…).
export const BRVM_BONDS_URL = "https://www.brvm.org/fr/cours-obligations/0";

const strip = (h: string) =>
  h.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&#039;|&apos;/g, "'")
   .replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

/** "10 000", "99,50", "1.234.567" -> nombre (null si vide ou "-"). */
export function parseNum(t: string | null | undefined): number | null {
  if (t == null) return null;
  let s = String(t).replace(/[\s  ]/g, "").replace(/%$/, "");
  if (!s || s === "-" || s === "--") return null;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, "");
  s = s.replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseTables(html: string) {
  const tables: { headers: string[]; rows: string[][] }[] = [];
  for (const t of html.match(/<table[\s\S]*?<\/table>/gi) || []) {
    const trs = t.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    let headers: string[] = [];
    const rows: string[][] = [];
    for (const tr of trs) {
      const ths = tr.match(/<th[\s\S]*?<\/th>/gi);
      if (ths && !headers.length) { headers = ths.map(strip); continue; }
      const tds = tr.match(/<td[\s\S]*?<\/td>/gi);
      if (tds) rows.push(tds.map(strip));
    }
    if (!headers.length && rows.length) headers = rows.shift()!;
    tables.push({ headers, rows });
  }
  return tables;
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
function findCol(headers: string[], patterns: RegExp[]) {
  const h = headers.map(norm);
  for (const p of patterns) { const i = h.findIndex((x) => p.test(x)); if (i >= 0) return i; }
  return -1;
}

/** Repère le tableau des obligations et le convertit en cotations. */
export function extractBondQuotes(html: string) {
  const tables = parseTables(html);
  for (const t of tables) {
    const iSym = findCol(t.headers, [/symbole/, /^code/, /ticker/]);
    const iPrice = findCol(t.headers, [/cours.*(jour|clot|actuel)/, /cours du jour/, /^cours$/, /dernier/, /cours/]);
    if (iSym < 0 || iPrice < 0 || !t.rows.length) continue;
    const iName = findCol(t.headers, [/^nom/, /libelle/, /titre/, /designation/]);
    const iVol = findCol(t.headers, [/volume/, /quantite/, /nombre/]);
    const iVal = findCol(t.headers, [/valeur/, /montant/, /capitalisation echang/]);
    const rows = t.rows
      .filter((r) => r[iSym])
      .map((r) => ({
        symbol: r[iSym].toUpperCase().replace(/\s+/g, ""),
        name: iName >= 0 ? r[iName] : null,
        price: parseNum(r[iPrice]),
        volume: iVol >= 0 ? parseNum(r[iVol]) : null,
        value: iVal >= 0 ? parseNum(r[iVal]) : null,
      }));
    return { headers: t.headers, columns: { iSym, iName, iPrice, iVol, iVal }, rows, tables: tables.length };
  }
  return { headers: tables[0]?.headers || [], columns: null, rows: [], tables: tables.length };
}

/** Récupère la cote du jour et l'enregistre. `date` = date de la séance (AAAA-MM-JJ). */
export async function fetchAndStoreBrvm(date: string, save = true) {
  const resp = await fetch(BRVM_BONDS_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36",
      Accept: "text/html", "Accept-Language": "fr-FR,fr;q=0.9",
    },
  });
  const html = await resp.text();
  const found = extractBondQuotes(html);
  // Un jour férié, la page affiche sans doute encore la séance précédente : l'enregistrer créerait de faux
  // « jours sans transaction ». On n'enregistre que si la date de séance figure sur la page, ou s'il y a des échanges.
  const [y, m, d] = date.split("-");
  const MOIS = ["janvier", "fevrier", "mars", "avril", "mai", "juin", "juillet", "aout", "septembre", "octobre", "novembre", "decembre"];
  const text = norm(strip(html));
  const dateOnPage = [`${d}/${m}/${y}`, `${d}-${m}-${y}`, `${+d} ${MOIS[+m - 1]} ${y}`, `${d} ${MOIS[+m - 1]} ${y}`].some((f) => text.includes(f));
  const anyTrade = found.rows.some((r) => (r.volume || 0) > 0);
  const sessionOk = dateOnPage || anyTrade;
  let saved = 0;
  if (save && found.rows.length && sessionOk) {
    for (const r of found.rows) {
      if (r.price == null) continue;
      await mergeQuotes(r.symbol, [[date, r.price, r.volume ?? 0, r.value ?? null]]);
      saved++;
    }
    // ajoute les obligations inconnues à la table des caractéristiques (à compléter à la main)
    const bonds = await getBonds();
    const known = new Set(bonds.map((b) => b.symbol));
    const added = found.rows.filter((r) => !known.has(r.symbol)).map((r) => ({ symbol: r.symbol, name: r.name || "" }));
    if (added.length) await saveBonds([...bonds, ...added]);
  }
  const note = !found.rows.length ? "aucun tableau d'obligations reconnu"
    : !sessionOk ? "date de séance absente de la page et aucun échange : pas de séance ? rien enregistré" : "";
  if (save) await logFetch({ date, status: resp.status, tables: found.tables, headers: found.headers, found: found.rows.length, saved, note });
  return { status: resp.status, ...found, saved, dateOnPage, anyTrade, note,
           sample: found.rows.length ? null : strip(html).slice(0, 1500) };
}
