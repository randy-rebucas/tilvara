# Support access (Tilvara staff looking at a business)

Tilvara staff have **no standing access** to any business (SPEC §13, THREAT_MODEL T14). A business lets
support look, read-only, for a reason it gives and for at most 72 hours. It sees every page support opened
and can end the access at any moment. Design: ADR-0016 "As built — slice 6".

## 1. Who can be support staff

A staff account is a normal Tilvara account (its own email and password) that ops has marked as staff. It
must use two-step sign-in, and every support session needs a sign-in that passed the code step.

Add or remove staff with ops credentials (`DATABASE_MIGRATOR_URL`, never the API's runtime credentials):

```
pnpm --filter @1pos/database support staff-add --email sam@1pos.example --reason "Joined support, ticket HR-12"
pnpm --filter @1pos/database support staff-disable --email sam@1pos.example --reason "Left the team"
pnpm --filter @1pos/database support staff-list
```

- `staff-add` refuses an account without two-step sign-in. `--actor` defaults to your OS user name.
- `staff-disable` takes effect at the staff member's **next request**, including a support view already
  open.
- Both write platform audit rows (`platform.staff.added`, `platform.staff.disabled`) that no business sees.

Being staff gives nothing by itself: the support page lists only businesses that have given access.

## 2. The business gives access

The owner or admin (`tenant.manage`) goes to **Subscription → Support access → Give support access**:

- what support should look at (required, kept with the grant);
- for how long: 2 to 72 hours (the API and the database both hold the 72-hour cap);
- optionally the ticket number support gave them.

A suspended business, or one whose subscription lapsed, can still give and end access (often it needs
help leaving; see the offboarding runbook).

## 3. Using it (staff)

1. Sign in with your password and authenticator code.
2. Go to `/support` (also linked from the business picker). It lists open grants: business, purpose,
   ticket, end time.
3. **Open read-only**. The back office opens the business with an orange banner: *Support view of … —
   read-only, ends …*. **Leave support view** returns you to `/support`.

What the support view can do:

- **Read** what the business's read permissions cover: products, prices, stock, sales, reports, books,
  members and roles, locations, and the audit log.
- **Not read** management pages: subscription, support access, data exports.
- **Not write anything.** Every non-GET request is refused with `403 SUPPORT_READ_ONLY` (only signing out
  is allowed). There is no payment, no change, no export.

What support reads and every refused change go to the business's own audit log as `support.request` or
`support.write_refused`, with the route template only (never ids or query strings) and the staff member's
name. A read is written once per route in each 15-minute window (one back-office page is about ten
requests, and pages get reopened), so the log shows what was looked at and when without filling up;
every refused change is its own row. Opening a grant writes `support.session_opened` in the business and `platform.support.opened` at
platform level.

The view ends by itself when the grant expires, is ended by the business, or the staff account is
disabled. The next page then answers `SUPPORT_ACCESS_ENDED` and the back office returns you to
`/support`. Access tokens of a support view never outlive the grant.

## 4. The business sees and ends it

**Subscription → Support access** shows each grant with its status (Open / Ended / Expired), who gave it,
how many times it was opened, pages read, changes refused, and the staff names. **Every step in the audit
log** opens the log filtered to that grant. **End access now** ends it at once (`support.revoked`).

## 5. If something looks wrong

- A business reports support activity it did not expect: check the grant's audit trail. A grant cannot be
  changed after it is given (database trigger), only ended.
- A staff account may be compromised: `staff-disable` it first (it stops every open support view), then
  rotate its password and two-step sign-in.
- The platform-level rows (`platform.support.opened`, `platform.staff.*`) are read as `onepos_platform`
  (NULL-tenant audit rows).

## Not built yet

- Write access for support (only `READ_ONLY` exists; the database refuses anything else).
- Naming a specific staff member on a grant: any active staff member may use an open grant, and the
  business sees who did.
- An admin screen for platform staff (the CLI is the tool).
