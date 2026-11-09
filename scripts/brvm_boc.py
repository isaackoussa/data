#!/usr/bin/env python3
"""Lecture des Bulletins Officiels de la Cote (BOC) de la BRVM : cotations quotidiennes des obligations.

Le BOC du jour est publié en PDF à l'adresse https://www.brvm.org/sites/default/files/boc_AAAAMMJJ_2.pdf
(sans suffixe ou avec "_1" pour certaines années). On le convertit en texte avec `pdftotext -layout`
(paquet poppler-utils) puis on lit chaque ligne d'obligation :

    Symbole  Titre  Valeur nominale  Cours précédent  Cours du jour  Cours de référence  Volume  Valeur
             Coupon couru  Période  Montant net  Échéance  Type d'amortissement

Les données sont enregistrées dans public/data/obligations/ (un fichier JSON par année + index.json),
servies telles quelles par le site.

Usage :
    python3 scripts/brvm_boc.py update                    # ajoute les séances manquantes jusqu'à aujourd'hui
    python3 scripts/brvm_boc.py update --from 2018-01-01  # récupère l'historique depuis une date
    python3 scripts/brvm_boc.py parse fichier.pdf         # affiche les lignes lues dans un bulletin
"""
import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

BASE = "https://www.brvm.org/sites/default/files/boc_{}{}.pdf"
SUFFIXES = ["_2", "", "_1", "_3"]
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "data", "obligations")

# Colonnes d'une ligne de données (fichiers annuels)
COLUMNS = ["date", "symbole", "nominal", "cours_precedent", "cours", "cours_reference", "volume", "valeur",
           "coupon_couru", "periodicite", "coupon_net", "prochaine_echeance", "amortissement", "statut", "detachement"]
STATUT = COLUMNS.index("statut")

MOIS = {"janv": 1, "fevr": 2, "févr": 2, "mars": 3, "avr": 4, "mai": 5, "juin": 6, "juil": 7, "aout": 8, "août": 8,
        "sept": 9, "oct": 10, "nov": 11, "dec": 12, "déc": 12}

SYMBOL = re.compile(r"^\s{0,3}([A-Z0-9]{2,12}\.[A-Z0-9]{1,5})\s+(.*)$")
DATE_FR = re.compile(r"^(\d{1,2})-([a-zéèûô]+)\.?-(\d{2})$", re.I)
AMORT = re.compile(r"^[A-Z]{1,4}$")
PERIODE = re.compile(r"^[ASTMB]$")
STATUS = {"NC", "SP", "ND", "NT"}  # NC = non coté (pas d'échange), SP = suspendu


def num(tok):
    """'10 000' -> 10000 ; '563,95' -> 563.95 ; '2 900.37' -> 2900.37 ; 'NC' -> None"""
    t = tok.replace(" ", " ").replace(" ", "")
    if not t or t.upper() in STATUS or t == "-":
        return None
    if "," in t and "." in t:
        t = t.replace(",", "")
    else:
        t = t.replace(",", ".")
    try:
        v = float(t)
    except ValueError:
        return None
    return int(v) if v.is_integer() else v


def is_num(tok):
    return num(tok) is not None


def date_fr(tok):
    """'9-déc.-26' -> '2026-12-09'"""
    m = DATE_FR.match(tok.strip())
    if not m:
        return None
    mois = MOIS.get(m.group(2).lower().rstrip("."))
    if not mois:
        return None
    return f"20{m.group(3)}-{mois:02d}-{int(m.group(1)):02d}"


def parse_line(line):
    """Lit une ligne d'obligation ; None si la ligne n'en est pas une."""
    m = SYMBOL.match(line)
    if not m:
        return None
    sym, rest = m.group(1), m.group(2)
    parts = [p for p in re.split(r"\s{2,}", rest.strip()) if p]
    # « (*) » entre le titre et les chiffres : détachement de coupon ce jour (la date d'échéance est celle de la séance)
    detachement = 1 if any(p.strip() == "(*)" for p in parts) or re.search(r"\s\(\*\)$", parts[0] if parts else "") else 0
    parts = [re.sub(r"\s*\(\*\)$", "", p) for p in parts if p.strip() != "(*)"]
    if len(parts) < 4:
        return None
    # fin de ligne : ... couru  période  montant  échéance  amortissement
    i = len(parts)
    amort = None
    if AMORT.match(parts[i - 1]) and parts[i - 1].upper() not in STATUS:
        amort = parts[i - 1]; i -= 1
    echeance = date_fr(parts[i - 1]) if i > 0 else None
    if not echeance:
        return None  # signature propre aux tableaux d'obligations : sans date d'échéance, ce n'est pas une ligne d'obligation
    i -= 1
    coupon_net = None
    if i > 0 and is_num(parts[i - 1]):
        coupon_net = num(parts[i - 1]); i -= 1
    periode = None
    if i > 0 and PERIODE.match(parts[i - 1]):
        periode = parts[i - 1]; i -= 1
    elif i > 0 and re.match(r"^(.+?)\s+([ASTMB])$", parts[i - 1]):  # "563,95 A" collés par un seul espace
        a, b = re.match(r"^(.+?)\s+([ASTMB])$", parts[i - 1]).groups()
        parts[i - 1] = a; periode = b
    couru = None
    middle = parts[1:i]
    title = parts[0]
    # le coupon couru est le dernier nombre avant la période
    if middle and is_num(middle[-1]):
        couru = num(middle[-1]); middle = middle[:-1]
    # le titre peut être collé à la valeur nominale par un seul espace : on le sépare
    if middle == [] or not (is_num(middle[0]) or middle[0].upper() in STATUS):
        return None
    toks = middle
    statut = next((t.upper() for t in toks if t.upper() in STATUS), None)
    vals = toks
    nominal = num(vals[0])
    prev = cours = ref = vol = val = None
    if statut:
        j = [t.upper() for t in vals].index(statut)
        if j >= 2:
            prev = num(vals[1])
        after = vals[j + 1:]
        if after:
            ref = num(after[0])
    else:
        # échange ce jour : nominal, [précédent], cours, référence, volume, valeur
        n = len(vals)
        if n >= 6:
            prev, cours, ref, vol, val = (num(x) for x in vals[1:6])
        elif n == 5:
            cours, ref, vol, val = (num(x) for x in vals[1:5])
        elif n == 4:
            prev, cours, ref = (num(x) for x in vals[1:4])
        elif n == 3:
            prev, ref = num(vals[1]), num(vals[2])
        elif n == 2:
            ref = num(vals[1])
        statut = "T" if vol else "NC"
        if not vol:
            cours = None
    return {"symbole": sym, "titre": title, "nominal": nominal, "cours_precedent": prev, "cours": cours,
            "cours_reference": ref, "volume": vol or 0, "valeur": val or 0, "coupon_couru": couru,
            "periodicite": periode, "coupon_net": coupon_net, "prochaine_echeance": echeance,
            "amortissement": amort, "statut": statut, "detachement": detachement}


def parse_text(text):
    """Toutes les lignes d'obligations d'un bulletin (texte pdftotext -layout)."""
    rows, last, category = [], None, None
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        up = stripped.upper()
        # titres de rubriques : "OBLIGATIONS SOUVERAINES", "OBLIGATIONS GSS D'ENTREPRISES", "FCTC D'ENTREPRISES"…
        if (up.startswith("OBLIGATIONS") or up.startswith("FCTC") or re.match(r"^\d\.\s+", stripped)) \
                and not re.search(r"\d{2,}", stripped.split(" ", 1)[-1] if re.match(r"^\d\.", stripped) else stripped) \
                and len(stripped) < 90:
            category = re.sub(r"^\d\.\s+", "", stripped).strip()
            last = None
            continue
        r = parse_line(line)
        if r:
            r["categorie"] = category
            rows.append(r); last = r
            continue
        # suite du titre sur la ligne suivante (titre long coupé)
        if last and line.startswith(" ") and not up.startswith("TOTAL") and len(stripped) < 45 \
                and not re.search(r"\d[\d ]{3,}\d", stripped.replace("-", "")):
            sep = "" if last["titre"].endswith("-") else " "  # « 2024-» + « 2029 » -> « 2024-2029 »
            last["titre"] = (last["titre"] + sep + stripped).strip()
        else:
            last = None
    # une obligation peut apparaître dans deux rubriques (ex. GSS et FCTC) : on garde la première
    seen, out = set(), []
    for r in rows:
        if r["symbole"] not in seen:
            seen.add(r["symbole"]); out.append(r)
    return out


def pdf_to_text(path):
    return subprocess.run(["pdftotext", "-layout", path, "-"], check=True, capture_output=True).stdout.decode("utf-8", "replace")


def download(day, tries=3):
    """Télécharge le BOC d'une date (AAAA-MM-JJ). Renvoie le chemin d'un fichier temporaire ou None s'il n'existe pas."""
    return next(candidates(day, tries), None)


def candidates(day, tries=3):
    """Toutes les variantes publiées du BOC d'une date (_2, sans suffixe, _1…), chacune dans un fichier temporaire."""
    stamp = day.replace("-", "")
    for suf in SUFFIXES:
        url = BASE.format(stamp, suf)
        for attempt in range(tries):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=60) as resp:
                    data = resp.read()
                if not data.startswith(b"%PDF"):
                    break
                fd, path = tempfile.mkstemp(suffix=".pdf")
                with os.fdopen(fd, "wb") as f:
                    f.write(data)
                yield path
                break
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    break
                time.sleep(2 ** attempt)
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                time.sleep(2 ** attempt)


def read_bulletin(day):
    """Lignes d'obligations du BOC d'une date. None s'il n'y a pas de bulletin, "illisible" si aucun PDF n'est exploitable."""
    found = False
    for path in candidates(day):
        found = True
        try:
            rows = parse_text(pdf_to_text(path))
            if rows:
                return rows
        except subprocess.CalledProcessError:
            pass  # PDF abîmé : on essaie la variante suivante
        finally:
            os.remove(path)
    return "illisible" if found else None


# ---------- stockage ----------
def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def save_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def update(start, end, data_dir, sleep=0.3, verbose=True):
    os.makedirs(data_dir, exist_ok=True)
    index_path = os.path.join(data_dir, "index.json")
    index = load_json(index_path, {"columns": COLUMNS, "years": [], "seances": [], "sans_bulletin": [], "obligations": {}})
    index.setdefault("bulletins_illisibles", [])
    done = set(index["seances"]) | set(index["sans_bulletin"]) | set(index["bulletins_illisibles"])
    years = {}
    today = dt.date.today()
    d = start
    added = 0
    while d <= end:
        day = d.isoformat()
        if d.weekday() < 5 and day not in done:
            rows = read_bulletin(day)
            if rows == "illisible":
                index["bulletins_illisibles"].append(day)
                if verbose:
                    print(day, "bulletin publié mais illisible (PDF abîmé)")
            elif rows is None:
                # jour férié ou bulletin pas encore publié : on ne mémorise l'absence qu'après quelques jours
                if (today - d).days > 4:
                    index["sans_bulletin"].append(day)
                if verbose:
                    print(day, "pas de bulletin")
            else:
                y = d.year
                if y not in years:
                    years[y] = load_json(os.path.join(data_dir, f"{y}.json"), {"year": y, "rows": []})
                    years[y]["rows"] = [r for r in years[y]["rows"] if r[0] != day]
                for r in rows:
                    years[y]["rows"].append([day] + [r[c] for c in COLUMNS[1:]])
                    info = index["obligations"].setdefault(r["symbole"], {"titre": r["titre"], "categorie": r["categorie"],
                                                                           "premiere": day, "derniere": day, "echanges": 0})
                    info["titre"], info["categorie"] = r["titre"], r["categorie"] or info.get("categorie")
                    info["premiere"] = min(info["premiere"], day)
                    info["derniere"] = max(info["derniere"], day)
                index["seances"].append(day)
                added += 1
                traded = sum(1 for r in rows if r["statut"] == "T")
                if verbose:
                    print(day, f"{len(rows)} obligations, {traded} échangées", flush=True)
                if added % 20 == 0:
                    _flush(index, years, data_dir)
                time.sleep(sleep)
        d += dt.timedelta(days=1)
    _flush(index, years, data_dir)
    return added


def _flush(index, years, data_dir):
    for y, obj in years.items():
        obj["rows"].sort(key=lambda r: (r[0], r[1]))
        save_json(os.path.join(data_dir, f"{y}.json"), obj)
    # nombre de séances avec échange par obligation (recalculé sur les années chargées)
    index["years"] = sorted({int(f[:4]) for f in os.listdir(data_dir) if re.match(r"^\d{4}\.json$", f)})
    index["seances"] = sorted(set(index["seances"]))
    index["sans_bulletin"] = sorted(set(index["sans_bulletin"]))
    index["bulletins_illisibles"] = sorted(set(index.get("bulletins_illisibles", [])))
    for y in index["years"]:
        obj = years.get(y) or load_json(os.path.join(data_dir, f"{y}.json"), {"rows": []})
        years[y] = obj
    counts = {}
    for obj in years.values():
        for r in obj["rows"]:
            if r[STATUT] == "T":
                counts[r[1]] = counts.get(r[1], 0) + 1
    for s, info in index["obligations"].items():
        info["echanges"] = counts.get(s, 0)
    index["mise_a_jour"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    save_json(os.path.join(data_dir, "index.json"), index)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    u = sub.add_parser("update", help="ajoute les séances manquantes")
    u.add_argument("--from", dest="start", help="date de début (AAAA-MM-JJ), par défaut 10 jours avant la dernière séance")
    u.add_argument("--to", dest="end", help="date de fin (AAAA-MM-JJ), par défaut aujourd'hui")
    u.add_argument("--data", default=DATA_DIR)
    p = sub.add_parser("parse", help="affiche les obligations lues dans un bulletin PDF")
    p.add_argument("pdf")
    args = ap.parse_args()

    if args.cmd == "parse":
        rows = parse_text(pdf_to_text(args.pdf))
        for r in rows:
            print(json.dumps(r, ensure_ascii=False))
        print(f"{len(rows)} obligations, {sum(r['statut'] == 'T' for r in rows)} échangées", file=sys.stderr)
        return
    index = load_json(os.path.join(args.data, "index.json"), {"seances": []})
    if args.start:
        start = dt.date.fromisoformat(args.start)
    elif index.get("seances"):
        start = dt.date.fromisoformat(index["seances"][-1]) - dt.timedelta(days=10)
    else:
        start = dt.date.today() - dt.timedelta(days=30)
    end = dt.date.fromisoformat(args.end) if args.end else dt.date.today()
    n = update(start, end, args.data)
    print(f"{n} séance(s) ajoutée(s)")


if __name__ == "__main__":
    main()
