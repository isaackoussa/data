"""Application Streamlit : télécharger des données boursières et gérer sa base.

Lancer avec :  streamlit run app.py
"""
import io
from datetime import date, timedelta

import pandas as pd
import plotly.graph_objects as go
import streamlit as st

from stockdb import db, fetch

st.set_page_config(page_title="Ma base boursière", page_icon="📈", layout="wide")
st.title("📈 Ma base de données boursières")

conn = db.connect()


def to_excel(df: pd.DataFrame) -> bytes:
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        if "ticker" in df.columns and df["ticker"].nunique() > 1:
            for t, part in df.groupby("ticker"):
                part.to_excel(writer, sheet_name=str(t)[:31], index=False)
        else:
            df.to_excel(writer, sheet_name="donnees", index=False)
    return buf.getvalue()


def export_buttons(df: pd.DataFrame, name: str):
    c1, c2 = st.columns(2)
    c1.download_button("⬇️ Télécharger en CSV", df.to_csv(index=False).encode("utf-8"),
                       f"{name}.csv", "text/csv", width="stretch")
    c2.download_button("⬇️ Télécharger en Excel", to_excel(df), f"{name}.xlsx",
                       "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                       width="stretch")


tab_dl, tab_db, tab_sql = st.tabs(["⬇️ Télécharger", "🗄️ Ma base", "🔎 Requête SQL"])

# ---------------------------------------------------------------- Télécharger
with tab_dl:
    st.markdown(
        "Entre un ou plusieurs symboles (tickers) Yahoo Finance, séparés par des virgules ou espaces. "
        "Exemples : `AAPL` (Apple), `MC.PA` (LVMH, Paris), `^FCHI` (CAC 40), `BTC-USD`, `EURUSD=X`."
    )
    tickers_text = st.text_input("Tickers", "AAPL, MSFT, MC.PA")
    c1, c2 = st.columns(2)
    interval = c1.selectbox("Intervalle", fetch.INTERVALS,
                            help="1d = journalier, 1wk = hebdo, 1mo = mensuel, le reste = intraday "
                                 "(historique limité par Yahoo).")
    mode = c2.radio("Période", ["Période prédéfinie", "Dates précises"], horizontal=True)
    period = start = end = None
    if mode == "Période prédéfinie":
        period = st.select_slider("Durée", fetch.PERIODS, value="1y")
    else:
        d1, d2 = st.columns(2)
        start = d1.date_input("Du", date.today() - timedelta(days=365))
        end = d2.date_input("Au", date.today())
    with_info = st.checkbox("Récupérer aussi le nom / secteur de l'entreprise", value=True)

    if st.button("🚀 Télécharger et enregistrer dans la base", type="primary"):
        tickers = fetch.parse_tickers(tickers_text)
        if not tickers:
            st.warning("Entre au moins un ticker.")
        progress = st.progress(0.0)
        results = []
        for i, t in enumerate(tickers):
            try:
                # yfinance : la date de fin est exclue, on ajoute un jour
                df = fetch.download_prices(t, interval, period, start,
                                           end + timedelta(days=1) if end else None)
                n = db.save_prices(conn, df, t, interval)
                if with_info and n:
                    db.save_info(conn, t, fetch.download_info(t))
                results.append({"ticker": t, "lignes": n,
                                "statut": "✅ OK" if n else "⚠️ aucune donnée (ticker invalide ?)"})
            except Exception as e:
                results.append({"ticker": t, "lignes": 0, "statut": f"❌ {e}"})
            progress.progress((i + 1) / len(tickers))
        if results:
            st.dataframe(pd.DataFrame(results), hide_index=True, width="stretch")

# ---------------------------------------------------------------- Ma base
with tab_db:
    summary = db.summary(conn)
    if summary.empty:
        st.info("La base est vide. Va dans l'onglet « Télécharger » pour commencer.")
    else:
        st.subheader("Contenu de la base")
        st.dataframe(summary, hide_index=True, width="stretch")

        st.subheader("Consulter / exporter")
        c1, c2, c3, c4 = st.columns([3, 1, 1, 1])
        intervals = sorted(summary["interval"].unique())
        sel_interval = c2.selectbox("Intervalle", intervals, key="db_interval")
        available = summary.loc[summary["interval"] == sel_interval, "ticker"].tolist()
        selected = c1.multiselect("Actions", available, default=available[:3])
        d_start = c3.date_input("Du", pd.to_datetime(summary["debut"].min()).date(), key="db_start")
        d_end = c4.date_input("Au", date.today(), key="db_end")

        data = db.load_prices(conn, selected, sel_interval, d_start, d_end)
        if not data.empty:
            normalise = st.toggle("Comparer en base 100 (performance relative)", value=len(selected) > 1)
            fig = go.Figure()
            if len(selected) == 1 and not normalise:
                fig.add_trace(go.Candlestick(x=data["date"], open=data["open"], high=data["high"],
                                             low=data["low"], close=data["close"], name=selected[0]))
                fig.update_layout(xaxis_rangeslider_visible=False)
            else:
                for t, part in data.groupby("ticker"):
                    y = part["adj_close"]
                    if normalise:
                        y = y / y.iloc[0] * 100
                    fig.add_trace(go.Scatter(x=part["date"], y=y, mode="lines", name=t))
            fig.update_layout(height=450, margin=dict(l=10, r=10, t=30, b=10))
            st.plotly_chart(fig, width="stretch")

            # Petites statistiques par action
            stats = []
            for t, part in data.groupby("ticker"):
                ret = part["adj_close"].pct_change().dropna()
                stats.append({
                    "ticker": t,
                    "dernier cours": round(part["close"].iloc[-1], 2),
                    "performance %": round((part["adj_close"].iloc[-1] / part["adj_close"].iloc[0] - 1) * 100, 2),
                    "plus haut": round(part["high"].max(), 2),
                    "plus bas": round(part["low"].min(), 2),
                    "volatilité %/période": round(ret.std() * 100, 2) if len(ret) > 1 else None,
                })
            st.dataframe(pd.DataFrame(stats), hide_index=True, width="stretch")

            with st.expander(f"Voir les données brutes ({len(data)} lignes)"):
                st.dataframe(data, hide_index=True, width="stretch")
            export_buttons(data, "donnees_boursieres")

        with st.expander("🗑️ Supprimer une action de la base"):
            to_del = st.selectbox("Action", summary["ticker"].unique(), key="del")
            if st.button(f"Supprimer {to_del}"):
                db.delete_ticker(conn, to_del)
                st.success(f"{to_del} supprimé.")
                st.rerun()

# ---------------------------------------------------------------- SQL
with tab_sql:
    st.markdown(
        "Interroge directement ta base en SQL (lecture seule). Tables : "
        "`prices(ticker, interval, date, open, high, low, close, adj_close, volume)` et "
        "`tickers(ticker, name, exchange, currency, sector, industry, updated_at)`."
    )
    example = ("SELECT ticker, substr(date, 1, 7) AS mois, AVG(close) AS cours_moyen, SUM(volume) AS volume\n"
               "FROM prices WHERE interval = '1d'\nGROUP BY ticker, mois ORDER BY ticker, mois")
    sql = st.text_area("Requête", example, height=150)
    if st.button("▶️ Exécuter"):
        try:
            res = db.run_query(conn, sql)
            st.dataframe(res, hide_index=True, width="stretch")
            export_buttons(res, "resultat_requete")
        except Exception as e:
            st.error(str(e))
