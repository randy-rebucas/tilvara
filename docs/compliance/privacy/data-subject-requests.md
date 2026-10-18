# Data subject requests (draft)

> **DRAFT, NOT LEGAL ADVICE.** Response times and identity checks are for the DPO to set. It describes
> what the system can do as built on 2026-10-18.

For: the DPO and Tilvara support. How to handle a request from a person to be informed, to access, correct,
object to, erase or block, or take a copy of their personal data (Data Privacy Act, Secs. 16–18).

## 1. First: who is the controller?

| Request about | Controller | Tilvara does |
|---|---|---|
| Their Tilvara account (email, name, sign-in, security events) | **Tilvara** | Answer it (section 3) |
| A business's records about them: an SC/PWD discount record, a takeaway name, a supplier record, their work as a cashier | **That business** | Forward it to the business's owner within 2 working days, tell the person it was forwarded, and help the business (section 4). Do not answer it ourselves |
| Both | Both | Split it |

Log every request (date, person, what was asked, controller, outcome, date closed) in the DPO's register.

**Identity**: confirm the person before giving or changing anything. For an account: a request from the
account's own email address plus a call-back or a signed-in confirmation. Never send data to an address
other than the one on the account.

**Time**: the DPO sets the response period; [proposed: 15 working days, extendable once with notice].

## 2. What the system can do today

| Need | Tool |
|---|---|
| Find a person in a business's records | Admin search and reports (sales, SC/PWD book, team, audit log), used by the business |
| A copy of the business's records | Subscription → Your records → Prepare a copy (all tables as CSV) |
| A copy of one person's account data | No self-service. Ops query (section 3) |
| Correct an account's name or email | **Self-service**: admin → the name in the band → Your account. A new email takes the password (and a code when two-step sign-in is on) and changes only when the link sent to the new address is opened; every session then ends and the old address is told |
| Correct a business record | Only by a new document where one exists (e.g. return and re-ring a sale). **No correction document for SC/PWD beneficiary details** (LEFTOVER) |
| Close (block) an account | **Self-service** on the same page, once the person belongs to no business. Ops: `pnpm --filter @1pos/database support account-disable --email … --reason "data subject request" --ticket …` (audited); `account-enable` undoes either |
| Erase | Not possible for fiscal records within the retention period. A closed account is blocked now; its anonymisation job is not built (it waits on the retention periods). Block and explain |

## 3. Requests about a Tilvara account

- **Access / copy**: as `onepos_migrator` with `SET ROLE onepos_platform`, collect the person's `users` row
  (without `password_hash`), their sessions (times, user agent), their NULL-tenant audit rows, and the list
  of businesses they belong to (names only). Send it as a file to the account's email. Records of what they
  did inside a business belong to that business's records: point them to the business.
- **Correction** of name or email: the person does it themself on Your account. If they cannot sign in
  (lost access to the old inbox and password), confirm identity, then update `users.display_name` or
  `users.email` as `onepos_platform` and record it in the ticket; an email must not collide with another
  account (emails are unique, ignoring case).
- **Objection / erasure**: the person closes the account on Your account once they belong to no business
  (it names the businesses otherwise; an owner closes their business first, tenant-offboarding.md). Or ops
  blocks it with `support account-disable`. Either way sign-in stops, sessions end, two-step sign-in data
  goes (self-closure) and the audit log records it. Anonymisation follows once no business's records
  within their retention period name the person (retention schedule; the job is not built).
- **Two-step sign-in data** is removed whenever it is reset or turned off.

## 4. Requests about a business's records (helping the controller)

Tell the business what the person asked, and how Tilvara can help:

- **Access**: the business finds the records in its admin (for an SC/PWD record: Reports → Sales → SC/PWD
  book for the date range, downloaded as CSV and searched for the name or ID number; the report has no
  search of its own) or in its export, and sends the person their own entries only.
- **Correction**: the business corrects through the documents the system has. A wrong SC/PWD name or ID
  number on a recorded sale cannot be changed in place; until a correction document exists, the business
  keeps a written note of the correction with its SC/PWD book and the DPO records the limitation.
- **Erasure / objection**: SC/PWD records are kept because tax rules require them; the business explains
  this to the person and the record is anonymised when the period ends. A takeaway name has no such
  reason: there is no way to clear it yet (LEFTOVER), so the business notes the request and Tilvara clears
  it when the tool exists.

## 5. Replies to adapt

**Forwarded to the business**

> Thank you for your request about your information at [business]. The records you are asking about are
> kept by [business], which decides how they are used; we provide their system. We have passed your
> request to them today, and they will reply to you. If you do not hear from them, contact us at [DPO
> email].

**Erasure not possible yet**

> We have stopped all use of your information except what the law requires us to keep. Records of sales
> where you received the senior citizen or PWD discount must be kept for [5] years under tax rules; after
> that they are made anonymous. Your account has been closed to sign-in.
