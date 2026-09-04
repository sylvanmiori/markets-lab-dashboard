# Markets Lab Dashboard

Static GitHub Pages UI. Box publisher overwrites `status.json` and `equity_history.json` only (sanitized, no secrets).

**Equity:** `equity_usd = 200 + realized_lab_pnl + unrealized_lab_mtm` on allowlisted series only. UI polls every 20s.