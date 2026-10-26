# ADR-0006: POS client — React/Vite first, Tauri + SQLite shell later

- Status: Accepted (2026-10-15). Amended: Rust was installed in session 8 and the Tauri 2 shell is built (`apps/pos-desktop/src-tauri`); the till's SQLite goes through one `rusqlite` connection, not the Tauri SQL plugin (ADR-0015).

## Context
Tauri needs a Rust toolchain (not installed on the dev machine) and real hardware to validate printer/drawer/scale adapters. The transaction engine and UX can be built and tested before that.

## Decision
- Phase 2: `apps/pos-desktop` is a React + Vite + TypeScript app running in a browser against the API (online-only, labelled "Browser mode — no offline, no hardware").
- Storage, printing and device access go through interfaces (`LocalStore`, `ReceiptPrinter`, `CashDrawer`, `Scanner`, `Scale`, `CustomerDisplay`, `PaymentTerminal`) from day one.
- Phase 5: add the Tauri shell, SQLite `LocalStore` (via a Tauri SQL plugin), ESC/POS printer adapter, durable local outbox.
- Browser mode is never advertised as having offline or hardware parity.

## Prerequisite
Install Rust (rustup) and the Tauri Windows prerequisites (WebView2, MSVC build tools) before Phase 5. *(Done, session 8.)*

## Amendment (session 16): customer display and scale labels
- **Customer display** (browser mode): the till opens a second window (`?display=customer`) and feeds it over a `BroadcastChannel` in the same browser: idle → the priced lines and total → "Thank you" with the change. No token, no network, no sign-in in that window; a newly opened display asks for the current state. The desktop till would need a second Tauri window (not built).
- **Scale labels**: an in-store EAN-13 `2` + 5-digit item code + 5-digit weight in grams + check digit; the item is the one whose barcode is the label's first six characters (its scale code) and must be sold by weight; the line takes the printed weight, never merged with another line. Read the same way online (`/v1/catalog/lookup`, which then answers `quantity`) and offline (the till's snapshot), by `parseScaleLabel` in `@1pos/sync-protocol`. Price-embedded labels are not read: dividing a printed price back into a quantity could not be reproduced exactly by the server's re-pricing.
