// Calculs obligataires : échéancier, coupon couru, rendement actuariel, mesures de liquidité, panel.
// Fonctions pures (sans accès à la page) : utilisables dans le navigateur et testables avec Node.
(function (root) {
  const DAY = 864e5;
  const toTime = (d) => Date.parse(d + "T00:00:00Z");
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const addMonths = (d, n) => {
    const [y, m, day] = d.split("-").map(Number);
    const target = new Date(Date.UTC(y, m - 1 + n, 1));
    const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(day, last));
    return iso(target.getTime());
  };
  const yearsBetween = (a, b) => (toTime(b) - toTime(a)) / (365 * DAY);

  /** Champs manquants pour pouvoir calculer un rendement. */
  function missingFields(b) {
    const miss = [];
    if (!(Number(b.coupon) >= 0) || b.coupon === "" || b.coupon == null) miss.push("coupon");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.issue || "")) miss.push("date d'émission");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.maturity || "")) miss.push("échéance");
    if (b.amort === "custom" && !parseCustom(b.customSchedule).length) miss.push("échéancier");
    return miss;
  }

  /** "2027-06-30:20; 2028-06-30:20" -> [["2027-06-30", 0.2], ...] (part du nominal initial remboursée). */
  function parseCustom(txt) {
    return String(txt || "").split(/[;\n]+/).map((s) => s.trim()).filter(Boolean).map((s) => {
      const [d, p] = s.split(/[:=]/).map((x) => x.trim());
      return [d, Number(String(p).replace(",", ".")) / 100];
    }).filter(([d, p]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && p > 0).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }

  /**
   * Échéancier pour 1 de nominal initial : [{ date, coupon, principal, outstandingBefore }].
   * - in fine : tout le capital à l'échéance
   * - constant : remboursement par parts égales à chaque échéance après `deferral` années de différé
   * - custom : dates et pourcentages saisis (les dates hors calendrier des coupons sont ajoutées)
   * Le coupon d'une période = taux annuel × capital restant × durée de la période
   * (1/fréquence sur le calendrier régulier, jours exacts / 365 sinon).
   */
  function schedule(b) {
    if (missingFields(b).length) return null;
    const freq = [1, 2, 4, 12].includes(Number(b.freq)) ? Number(b.freq) : 1;
    const step = 12 / freq;
    const grid = [];
    for (let k = 0, d = b.maturity; d > b.issue && k < 2000; k++, d = addMonths(b.maturity, -step * (k))) grid.push(d);
    grid.reverse();
    const onGrid = new Set(grid);
    let principal = new Map();
    if (b.amort === "custom") {
      parseCustom(b.customSchedule).forEach(([d, p]) => principal.set(d, (principal.get(d) || 0) + p));
    } else if (b.amort === "constant") {
      const deferral = Number(b.deferral) || 0;
      const amortDates = grid.filter((d) => yearsBetween(b.issue, d) > deferral + 1e-9);
      const dates = amortDates.length ? amortDates : [b.maturity];
      dates.forEach((d) => principal.set(d, 1 / dates.length));
    } else {
      principal.set(b.maturity, 1);
    }
    const dates = [...new Set([...grid, ...principal.keys()])].filter((d) => d > b.issue && d <= b.maturity).sort();
    const c = Number(b.coupon) / 100;
    let out = 1, prev = b.issue;
    const flows = [];
    for (const d of dates) {
      // durée de la période : 1/fréquence entre deux dates du calendrier, prorata exact sinon
      const frac = onGrid.has(d) && onGrid.has(prev) ? 1 / freq
        : onGrid.has(d) && prev === b.issue ? yearsOrStep(b.issue, d, freq)
        : yearsBetween(prev, d);
      const coupon = c * out * frac;
      const p = Math.min(out, principal.get(d) || 0);
      flows.push({ date: d, coupon, principal: p, outstandingBefore: out });
      out = Math.max(0, out - p);
      prev = d;
    }
    // reste éventuel (pourcentages saisis < 100 %) : remboursé à l'échéance
    if (out > 1e-9 && flows.length) { flows[flows.length - 1].principal += out; }
    return flows;
  }
  // Première période : régulière si l'émission tombe sur le calendrier, sinon prorata exact.
  function yearsOrStep(issue, d, freq) {
    const regular = addMonths(d, -12 / freq) === issue;
    return regular ? 1 / freq : yearsBetween(issue, d);
  }

  /** Capital restant (pour 1 de nominal initial) après les remboursements datés <= t. */
  function outstanding(flows, t) {
    let out = 1;
    for (const f of flows) if (f.date <= t) out -= f.principal;
    return Math.max(0, out);
  }

  /** Coupon couru à la date t (pour 1 de nominal initial). */
  function accrued(b, flows, t) {
    const next = flows.find((f) => f.date > t);
    if (!next) return 0;
    const prevIdx = flows.indexOf(next) - 1;
    const prev = prevIdx >= 0 ? flows[prevIdx].date : b.issue;
    const len = yearsBetween(prev, next.date);
    return len > 0 ? next.coupon * Math.min(1, yearsBetween(prev, t) / len) : 0;
  }

  /**
   * Rendement actuariel annuel (en %) à la date t.
   * price : cours tel que coté ; s'il est > 200 on le considère en FCFA par titre, sinon en % .
   * opts.basis : "outstanding" (cours en % du capital restant, par défaut) ou "initial" (en % du nominal initial)
   * opts.clean : true si le cours est « pied de coupon » (hors coupon couru, par défaut)
   * opts.tax : taux d'impôt sur les coupons (0..1) pour un rendement net
   */
  function ytm(b, flows, t, price, opts = {}) {
    if (!flows || price == null || !(price > 0)) return null;
    const nominal = Number(b.nominal) || 10000;
    const out = outstanding(flows, t);
    if (out <= 1e-9) return null;
    const base = opts.basis === "initial" ? 1 : out;
    const pct = price > 200 ? price / (nominal * base) : price / 100;
    const dirty = pct * base + (opts.clean === false ? 0 : accrued(b, flows, t));
    const tax = opts.tax || 0;
    const future = flows.filter((f) => f.date > t).map((f) => ({ tau: timeTo(b, flows, t, f.date), cf: f.coupon * (1 - tax) + f.principal }));
    if (!future.length) return null;
    const pv = (y) => future.reduce((s, f) => s + f.cf / Math.pow(1 + y, f.tau), 0);
    let lo = -0.9, hi = 3;
    if ((pv(lo) - dirty) * (pv(hi) - dirty) > 0) return null;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (pv(mid) > dirty) lo = mid; else hi = mid;
    }
    return ((lo + hi) / 2) * 100;
  }

  /**
   * Temps d'actualisation (années) de t jusqu'au flux du `target` : en nombre de périodes de coupon
   * (convention actuarielle : chaque période vaut exactement 1/fréquence, prorata en jours dans la période en cours).
   * Pour une date hors calendrier régulier (échéancier personnalisé), jours exacts / 365.
   */
  function timeTo(b, flows, t, target) {
    const freq = [1, 2, 4, 12].includes(Number(b.freq)) ? Number(b.freq) : 1;
    const i = flows.findIndex((f) => f.date > t);
    const prev = i > 0 ? flows[i - 1].date : b.issue;
    const next = flows[i].date;
    const regular = (d1, d2) => addMonths(d2, -12 / freq) === d1;
    if (!regular(prev, next)) return yearsBetween(t, target);
    let tau = (toTime(next) - toTime(t)) / (toTime(next) - toTime(prev)) / freq;
    for (let k = i; flows[k].date < target; k++) {
      tau += regular(flows[k].date, flows[k + 1].date) ? 1 / freq : yearsBetween(flows[k].date, flows[k + 1].date);
    }
    return tau;
  }

  /** Durée de vie moyenne restante (années), pondérée par le capital restant à rembourser. */
  function avgLife(flows, t) {
    const fut = flows.filter((f) => f.date > t && f.principal > 0);
    const tot = fut.reduce((s, f) => s + f.principal, 0);
    return tot > 0 ? fut.reduce((s, f) => s + f.principal * yearsBetween(t, f.date), 0) / tot : null;
  }

  /** Dernière valeur d'une série de référence à la date t ou avant. */
  function refAt(points, t) {
    if (!points || !points.length) return null;
    let lo = 0, hi = points.length - 1, ans = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (points[mid][0] <= t) { ans = points[mid][1]; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }

  /**
   * Panel quotidien : une ligne par obligation et par jour de bourse.
   * Jours de bourse = toutes les dates présentes dans les cotations (toutes obligations confondues).
   * Un jour sans ligne ou avec un volume nul = « sans transaction » ; le cours est alors le dernier connu (cours figé).
   */
  function dailyPanel(bonds, quotes, refs, opts = {}) {
    const days = [...new Set(Object.values(quotes).flatMap((q) => q.map((r) => r[0])))].sort();
    const rows = [];
    for (const b of bonds) {
      const q = quotes[b.symbol];
      if (!q || !q.length) continue;
      const flows = schedule(b);
      const bySym = new Map(q.map((r) => [r[0], r]));
      const first = q[0][0], lastQuote = q.at(-1)[0];
      const end = b.maturity && b.maturity < lastQuote ? b.maturity : lastQuote;
      const refPts = refs[b.ref || opts.ref] || null;
      const tax = opts.net ? (Number(b.tax) || 0) / 100 : 0;
      let lastPrice = null, lastTradedPrice = null;
      for (const d of days) {
        if (d < first || d > end) continue;
        const r = bySym.get(d);
        const vol = r ? Number(r[2]) || 0 : 0;
        const traded = vol > 0 ? 1 : 0;
        if (r && r[1] != null) lastPrice = r[1];
        const price = lastPrice;
        const nominal = Number(b.nominal) || 10000;
        const out = flows ? outstanding(flows, d) : null;
        const pctPrice = price == null ? null : price > 200 ? price / nominal / (opts.basis === "initial" || out == null ? 1 : out) * 100 : price;
        let value = r && r[3] != null ? Number(r[3]) : null;
        if (value == null && traded && pctPrice != null) value = vol * nominal * (pctPrice / 100) * (opts.basis === "initial" || out == null ? 1 : out);
        let ret = null, amihud = null;
        if (traded && lastTradedPrice != null && price > 0) {
          ret = Math.log(price / lastTradedPrice);
          if (value > 0) amihud = Math.abs(ret) / (value / 1e6);
        }
        if (traded) lastTradedPrice = price;
        const y = flows ? ytm(b, flows, d, price, { basis: opts.basis, clean: opts.clean, tax }) : null;
        const ref = refAt(refPts, d);
        const outstandingFcfa = b.amount && out != null ? Number(b.amount) * out : null;
        rows.push({
          symbole: b.symbol, date: d, cours: price, cours_pct: pctPrice, volume: vol, valeur_fcfa: value,
          transaction: traded, cours_fige: r && traded ? 0 : 1,
          rendement: y, reference: ref, spread_pb: y != null && ref != null ? (y - ref) * 100 : null,
          duree_vie_moy: flows ? avgLife(flows, d) : null, capital_restant_pct: out != null ? out * 100 : null,
          encours_fcfa: outstandingFcfa, rotation: outstandingFcfa && value ? value / outstandingFcfa : traded ? null : 0,
          amihud, rendement_log: ret,
        });
      }
    }
    return rows;
  }

  /** Panel mensuel : agrégation par obligation et par mois. */
  function monthlyPanel(daily) {
    const groups = new Map();
    for (const r of daily) {
      const k = r.symbole + "|" + r.date.slice(0, 7);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const mean = (xs) => { const v = xs.filter((x) => x != null && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    return [...groups.values()].map((g) => {
      const traded = g.filter((r) => r.transaction);
      const last = g.at(-1);
      return {
        symbole: g[0].symbole, mois: g[0].date.slice(0, 7), jours_bourse: g.length, jours_transaction: traded.length,
        part_sans_transaction: 1 - traded.length / g.length,
        volume: g.reduce((s, r) => s + (r.volume || 0), 0), valeur_fcfa: g.reduce((s, r) => s + (r.valeur_fcfa || 0), 0),
        rotation: last.encours_fcfa ? g.reduce((s, r) => s + (r.valeur_fcfa || 0), 0) / last.encours_fcfa : null,
        amihud_moyen: mean(traded.map((r) => r.amihud)),
        cours_fin: last.cours, rendement_moyen: mean(g.map((r) => r.rendement)), rendement_fin: last.rendement,
        reference_fin: last.reference, spread_moyen_pb: mean(g.map((r) => r.spread_pb)),
        duree_vie_moy: last.duree_vie_moy,
      };
    });
  }

  root.Bonds = { schedule, outstanding, accrued, ytm, avgLife, refAt, dailyPanel, monthlyPanel, missingFields, parseCustom, addMonths };
  if (typeof module !== "undefined") module.exports = root.Bonds;
})(typeof window !== "undefined" ? window : globalThis);
