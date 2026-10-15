# ADR-0006: POS client — React/Vite first, Tauri + SQLite shell later

- Status: Accepted (2026-10-15)

## Context
Tauri needs a Rust toolchain (not installed on the dev machine) and real hardware to validate printer/drawer/scale adapters. The transaction engine and UX can be built and tested before that.

## Decision
- Phase 2: `apps/pos-desktop` is a React + Vite + TypeScript app running in a browser against the API (online-only, labelled "Browser mode — no offline, no hardware").
- Storage, printing and device access go through interfaces (`LocalStore`, `ReceiptPrinter`, `CashDrawer`, `Scanner`, `Scale`, `CustomerDisplay`, `PaymentTerminal`) from day one.
- Phase 5: add the Tauri shell, SQLite `LocalStore` (via a Tauri SQL plugin), ESC/POS printer adapter, durable local outbox.
- Browser mode is never advertised as having offline or hardware parity.

## Prerequisite
Install Rust (rustup) and the Tauri Windows prerequisites (WebView2, MSVC build tools) before Phase 5.
