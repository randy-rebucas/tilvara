-- Hand-written (session 24, ADR-0020 §3): the app updates products column by column; "Keeps expiry
-- dates" (products.tracks_expiry, added in 0088) is edited on the product form like track_inventory.
GRANT UPDATE (tracks_expiry) ON products TO onepos_app;
