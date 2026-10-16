"""Version ligne de commande (pratique pour automatiser, ex. tâche planifiée).

Exemples :
  python cli.py download AAPL MSFT MC.PA --period 5y
  python cli.py download BTC-USD --interval 1h --period 1mo
  python cli.py download AIR.PA --start 2020-01-01 --end 2024-12-31
  python cli.py list
  python cli.py export AAPL MSFT -o export.csv
  python cli.py sql "SELECT ticker, MAX(close) FROM prices GROUP BY ticker"
"""
import argparse

from stockdb import db, fetch


def main():
    p = argparse.ArgumentParser(description="Base de données boursières")
    p.add_argument("--db", default=db.DEFAULT_DB, help="Chemin du fichier SQLite")
    sub = p.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("download", help="Télécharger et enregistrer des cours")
    d.add_argument("tickers", nargs="+")
    d.add_argument("--interval", default="1d", choices=fetch.INTERVALS)
    d.add_argument("--period", default="1y", choices=fetch.PERIODS)
    d.add_argument("--start")
    d.add_argument("--end")

    sub.add_parser("list", help="Afficher le contenu de la base")

    e = sub.add_parser("export", help="Exporter en CSV ou Excel (.xlsx)")
    e.add_argument("tickers", nargs="+")
    e.add_argument("--interval", default="1d")
    e.add_argument("-o", "--output", default="export.csv")

    q = sub.add_parser("sql", help="Exécuter une requête SELECT")
    q.add_argument("query")

    args = p.parse_args()
    conn = db.connect(args.db)

    if args.cmd == "download":
        for t in fetch.parse_tickers(" ".join(args.tickers)):
            df = fetch.download_prices(t, args.interval, args.period, args.start, args.end)
            n = db.save_prices(conn, df, t, args.interval)
            if n:
                db.save_info(conn, t, fetch.download_info(t))
            print(f"{t:12s} {n:6d} lignes" + ("" if n else "  (aucune donnée)"))
    elif args.cmd == "list":
        print(db.summary(conn).to_string(index=False))
    elif args.cmd == "export":
        tickers = fetch.parse_tickers(" ".join(args.tickers))
        df = db.load_prices(conn, tickers, args.interval)
        if args.output.endswith(".xlsx"):
            df.to_excel(args.output, index=False)
        else:
            df.to_csv(args.output, index=False)
        print(f"{len(df)} lignes exportées dans {args.output}")
    elif args.cmd == "sql":
        print(db.run_query(conn, args.query).to_string(index=False))


if __name__ == "__main__":
    main()
