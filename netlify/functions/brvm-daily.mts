import type { Config } from "@netlify/functions";
import { fetchAndStoreBrvm } from "../lib/brvm.mts";

// Chaque jour de semaine à 18 h 30 UTC (= 18 h 30 à Abidjan, GMT toute l'année, après la clôture de la BRVM) :
// lecture de la cote des obligations sur brvm.org et enregistrement dans la base.
export default async () => {
  const date = new Date().toISOString().slice(0, 10);
  try {
    const r = await fetchAndStoreBrvm(date);
    console.log(`BRVM ${date} : statut ${r.status}, ${r.rows.length} obligations lues, ${r.saved} enregistrées`);
  } catch (e: any) {
    console.error(`BRVM ${date} : échec`, e.message);
  }
};

export const config: Config = { schedule: "30 18 * * 1-5" };
