# Runbook: offline tills and their recovery

For: store managers and Tilvara support. Background: ADR-0015 (offline cash sales and sync).

The desktop till keeps selling **cash** when it cannot reach the server. Each sale is saved on the till
first and sent later. The server records each sale once, or puts it in front of a manager. This runbook
says what to do in each situation. The browser POS does not work offline.

## Where things are on the till PC
| What | Where |
|---|---|
| Sales waiting to be sent, the price list, settings | `%APPDATA%\ph.onepos.till\till.sqlite` (plus `-wal` / `-shm` files next to it) |
| The terminal key | Windows Credential Manager, generic credential **"Tilvara till"** |
| Server address and terminal id | inside `till.sqlite` (shown in Till settings) |

## 1. The connection drops while selling
**What the cashier sees:** an amber "Offline" banner, and the band chip shows "Offline · N to send".

**What still works:**
- cash sales on the shift that was open when the till last reached the server;
- items and prices from the till's own price list;
- the offline receipt, which has a local reference such as `R1-TAbCd-000003` and is not an invoice.

**What does not work** (it needs the server): card and QR, SC/PWD and other discounts, returns and voids,
opening or closing a shift, and table service.

**Do:** keep selling cash. The till sends the sales by itself when the connection is back, oldest first.
Nobody needs to press anything.

**If a checkout was in progress when the connection dropped:** the cashier may see "Could not confirm the
sale". Pressing **Record cash sale offline** is safe: the till reuses the same transaction id. If the
first attempt did reach the server, the copy goes to review as "Already recorded online" (see 3), and the
sale is never counted twice.

## 2. A till shows as "Silent" in the admin
Admin → **Offline** → **Tills** marks a till **Silent** when its register has an open shift and the till
has not reached the server for over 30 minutes. A till that is online checks in every 10 minutes.

**Do:**
1. Check the till's network or internet connection. The till sends its sales as soon as it reconnects.
2. **Do not close the shift** while a till is silent: its offline sales are not in the drawer count yet.
   A sale that arrives after the shift closed waits for review as "the shift was already closed" (see 3).
3. If the till PC is off or broken, see 5.

## 3. Sales waiting for review
Admin → **Offline** → **To review**. Each one says why it was not recorded. The shift cannot close while
one of its sales waits here.

| Problem shown | Usual cause | Action |
|---|---|---|
| Already recorded online as sale #N | the connection dropped mid-checkout and the cashier recorded it offline | **Dismiss** ("duplicate of #N"); the cash is counted once |
| Different total than its price list gives | till data was tampered with or damaged | count the drawer, then **Dismiss** with the reason; the difference shows as a drawer variance |
| Shift was already closed | the shift was closed while the till was still offline | **Dismiss**; the cash shows as a variance on that shift, to be explained |
| Cashier not allowed / suspended | the member was suspended or lost permissions | fix the membership, then **Record again** |
| The accounting month is closed | a sale from a month the accountant has closed | reopen the month (with a reason) or **Dismiss** |

**Record again** retries the sale exactly as the till sent it. A refused retry is counted and shown.

## 4. The till restarts during an outage
Sales already saved on the till are kept, and the chip still shows "N to send". Nobody can **sign in**
until the server is reachable, because signing in needs the server. So selling waits for the connection.
When the connection is back, sign in, and the till sends what it holds.

## 5. The till PC breaks, or its disk is lost
- **Sales already sent are safe** on the server.
- **Sales not yet sent are only on that PC.** If the disk can be read, copy `till.sqlite` (with its `-wal`
  file) to the replacement PC's folder above, start the till, and it sends them. Restoring an **older
  backup** is also safe:
  - sales the server already has are answered "already recorded" and not counted again;
  - new sales continue normally; their numbers continue after the last one the server has from this
    terminal (since session 16 the snapshot tells the till), so local references do not repeat.
- **If nothing can be recovered**, the unsent sales are lost to the system. The drawer count at closing
  shows their cash as an overage. Use the paper copies of the offline receipts (local references) to
  explain it.
- **New PC:** in the admin, add a new terminal on the same register (Locations → register → Terminals).
  On the PC, install the till, enter the server address, terminal id and one-time key, and revoke the old
  terminal.

## 6. A till is stolen or must be retired
Admin → Locations → the register → Terminals → **Revoke**. The till stops syncing and selling at once and
cannot be restored. Anything it had not sent stays on that device.

**Recovering what a revoked till had not sent** (since session 16): if you have the device, add a new
terminal **on the same register**, and on that PC open Till settings → **Disconnect**, then set it up again
with the new terminal id and key. The sales waiting on it are delivered by the new terminal and recorded
(each one audited as `offline_sale.recovered`, naming the revoked terminal). A sale the old till had
already delivered answers with its original record, never twice. Only a terminal on the same register can
do this, and only for a terminal that is revoked.

## 7. The price list on the till is old
Till settings shows "Price list from …". A till that has been offline for more than 24 hours still sells
at its saved prices. Those sales are recorded, flagged for the manager ("price list older than 24 hours"),
and stand at the price the customer paid. Prices that changed meanwhile are flagged the same way.

## 8. Before closing a shift on a desktop till
1. Make sure the chip does not say "N to send", or press **Send now** in Till settings.
2. Resolve anything in **To review** for that shift.
3. Then count and close as usual.
