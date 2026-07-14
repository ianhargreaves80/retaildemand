# Retail Demand, Europe

A monthly data sheet for European retail and FMCG: a calibrated range for retail
demand per market, not a forecast, plus consumer confidence, financial headroom
and category price pressure across 35 markets. Live at https://retaildemand.org.

Why a range: under honest out-of-sample testing, nothing beat assuming no change
from the last observed print. The Method section on the page states the findings
in plain terms, along with the coverage the bands actually achieved.

## The registry

`performance/` is the prediction registry. Every published range is logged per
edition, market and horizon before outcomes exist (`predictions.csv`), and scored
against actuals as target months mature. Actuals are recorded the first time they
are seen, so later data revisions never rewrite the track record. The registry is
append-only; this repository's commit history is the audit trail.

Data: Eurostat (retail volume sts_trtu_m, HICP prc_hicp, consumer confidence,
unemployment, household saving rate).

© Ian Hargreaves · Lausanne · [ianhargreaves.dev](https://ianhargreaves.dev)
