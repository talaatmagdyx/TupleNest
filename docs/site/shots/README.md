# Screenshots

Every image here was captured from the real app (a macOS release build, window
1427 × 840 points), not mocked up. Stills are 1400 px wide JPEGs; the GIFs are
1100 px wide, palette-optimised, and made from captured frames.

The demo data is synthetic and contains no real people or companies:

- **PostgreSQL `shop` and `shop_staging`:** about 250,000 orders, 400
  customers, products and line items, with order volume growing over time. A
  view, `monthly_revenue`, rolls them up by month. The profiles connect as an
  `analyst` role.
- **SQLite `analytics.sqlite`:** 50,000 events, opened from
  `/Users/Shared/TupleNestDemo/`.

The profiles are "Shop · production" (tagged `prod`), "Shop · staging"
(`staging`) and "Analytics" (`dev`). The app was started with an empty data
folder, so nothing from a real setup appears.
