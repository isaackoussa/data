# 📈 Ma base de données boursières

Application pour **télécharger des données boursières** (actions, indices, ETF, cryptos, devises)
depuis Yahoo Finance et les **stocker dans ta propre base de données** (fichier SQLite `bourse.db`).

## 🌐 Version web hébergée sur Netlify

Le dossier contient une version web prête pour Netlify :

| Élément | Rôle |
|---------|------|
| `public/index.html` | l'interface (téléchargement, graphiques, export CSV/Excel, SQL dans le navigateur) |
| `netlify/functions/download.mts` | `POST /api/download` : récupère les cours sur Yahoo Finance et les enregistre |
| `netlify/functions/data.mts` | `GET/DELETE /api/data` : lit ou supprime les données de la base |
| `netlify/functions/worldbank.mts` | `/api/wb/*` : recherche d'indicateurs, pays, téléchargement et lecture des données de la Banque mondiale |
| Netlify Blobs (stores `bourse` et `worldbank`) | la base de données, permanente, gérée par Netlify (gratuit, rien à configurer) |

**Déployer :**
1. Sur [app.netlify.com](https://app.netlify.com) → *Add new project* → *Import an existing project* → GitHub → ce dépôt.
2. Branche : celle qui contient ce code. Netlify lit `netlify.toml`, il n'y a rien d'autre à remplir.
3. **Recommandé :** dans *Project configuration → Environment variables*, ajoute `APP_PASSWORD`
   (portée *Functions*) puis redéploie. Sans ça, n'importe qui ayant l'adresse peut utiliser et modifier ta base.
   Le site demandera ce mot de passe une fois, puis le mémorise dans le navigateur.

Ou en ligne de commande : `npm install && npx netlify deploy --prod`.

Les données de la base sont visibles dans Netlify sous *Data & Storage → Blobs*.

## 💻 Version locale (Python / Streamlit)

### Installation

```bash
python -m venv .venv
source .venv/bin/activate        # Windows : .venv\Scripts\activate
pip install -r requirements.txt
```

### Lancer l'application

```bash
streamlit run app.py
```

L'application s'ouvre dans ton navigateur (http://localhost:8501) avec 3 onglets :

1. **⬇️ Télécharger** : tape les tickers voulus (`AAPL, MC.PA, ^FCHI, BTC-USD…`), choisis
   l'intervalle (journalier, hebdo, mensuel, intraday) et la période. Les données sont
   ajoutées à la base, sans doublons : relancer le téléchargement met simplement à jour.
2. **🗄️ Ma base** : contenu de la base, graphique (chandeliers ou comparaison en base 100),
   statistiques (performance, plus haut, plus bas, volatilité), export **CSV / Excel**.
3. **🔎 Requête SQL** : interroge ta base librement, puis exporte le résultat.

### Ligne de commande (pour automatiser)

```bash
python cli.py download AAPL MSFT MC.PA --period 5y
python cli.py download BTC-USD --interval 1h --period 1mo
python cli.py download AIR.PA --start 2020-01-01 --end 2024-12-31
python cli.py list
python cli.py export AAPL MSFT -o export.xlsx
python cli.py sql "SELECT ticker, MAX(close) FROM prices GROUP BY ticker"
```

## Trouver un ticker

Cherche le nom sur [finance.yahoo.com](https://finance.yahoo.com). Quelques suffixes :
`.PA` Paris, `.DE` Francfort, `.L` Londres, `.MI` Milan, `.AS` Amsterdam, `.TO` Toronto.
Indices : `^FCHI` (CAC 40), `^GSPC` (S&P 500), `^IXIC` (Nasdaq). Devises : `EURUSD=X`.

## Structure de la base (version locale SQLite, et tables de l'onglet SQL en ligne)

| Table     | Colonnes |
|-----------|----------|
| `prices`  | ticker, interval, date, open, high, low, close, adj_close, volume |
| `tickers` | ticker, name, exchange, currency, sector, industry, updated_at |

Le fichier `bourse.db` peut aussi être ouvert avec [DB Browser for SQLite](https://sqlitebrowser.org),
Excel/Power BI (via ODBC) ou n'importe quel outil SQL.

> Les données viennent de Yahoo Finance via la librairie `yfinance` (non officielle) :
> elles sont gratuites mais destinées à un usage personnel. L'historique intraday est limité
> (ex. 7 jours pour `1m`, ~2 ans pour `1h`).
