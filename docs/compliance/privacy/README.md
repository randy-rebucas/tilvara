# Privacy pack (drafts for the Data Protection Officer)

> **DRAFTS, NOT LEGAL ADVICE.** Written by engineering on 2026-10-18 from the system as built and from
> the research in `../PH_COMPLIANCE_ASSUMPTIONS.md` §9, which is itself only partially verified. Every
> legal reading below must be confirmed by the DPO and, where the DPO decides, by Philippine counsel
> before the pilot. Text in [square brackets] is for the operator to fill in.

For: Tilvara's Data Protection Officer (DPO) and counsel. It describes what personal data Tilvara holds, why, for
how long, and what happens when something goes wrong, so the DPO can judge it and turn it into the
company's documents. It answers SPEC "Privacy" and ADR-0016 slice 8, and covers release gate G6
(`PH_COMPLIANCE_ASSUMPTIONS.md`).

| Document | What it is |
|---|---|
| [processing-register.md](processing-register.md) | Record of processing activities: each activity, its purpose, data, people, basis, recipients, storage, retention, safeguards |
| [privacy-notice-draft.md](privacy-notice-draft.md) | A notice for people who use Tilvara, and a short template businesses can show their customers |
| [retention-schedule.md](retention-schedule.md) | How long each kind of data is kept, the reason, and whether the system enforces it today |
| [breach-procedure.md](breach-procedure.md) | Personal data breach: assessment, the 72-hour notifications, templates, the register |
| [data-processing-agreement-outline.md](data-processing-agreement-outline.md) | The clauses the Tilvara–business agreement needs, and the sub-processor list |
| [data-subject-requests.md](data-subject-requests.md) | Handling access, correction, erasure and objection requests with the tools that exist |

## 1. Who is controller and who is processor

Under the Data Privacy Act of 2012 (RA 10173), its IRR and NPC circulars:

- **For a business's own records** (its sales, SC/PWD beneficiaries, takeaway names, suppliers, its staff
  records), **the business is the personal information controller (PIC)** and **Tilvara is its personal
  information processor (PIP)**. Tilvara processes these only to run the service the business signed up for.
- **For Tilvara accounts** (everyone who signs in: owners, staff, Tilvara support), **Tilvara is the PIC**: it
  decides how sign-in, security, audit and support work.
- Tilvara staff who look at a business through support access act for Tilvara as processor, inside the
  business's grant.

This split drives the notice (two parts), the breach duties (Tilvara tells the business, which tells the NPC
and its customers, for business records; Tilvara tells the NPC and its users directly for account data) and
the processing agreement.

## 2. DPO and NPC registration: engineering's evaluation

SPEC asks for an evaluation of the DPO and registration obligations. The facts the DPO needs:

- **Scale.** Tilvara is multi-tenant: every business's records sit in one system. At pilot scale the number
  of people whose data it holds is small; at commercial scale it is the sum over all businesses.
- **Sensitive personal information (engineering reading, DPO to confirm).** SC/PWD records hold the
  beneficiary's name, government ID number (OSCA, PWD ID) and TIN when given. Sec. 3(l) of the Act counts
  age, health and government-issued identifiers peculiar to a person as sensitive. A senior citizen
  record reveals age; a PWD record reveals a disability (though never its type: Tilvara stores name and ID
  number only); the ID numbers and TIN are government-issued identifiers. **Engineering assumes these
  records are sensitive personal information.**
- **Continuous, not occasional.** Every SC/PWD sale adds a record; processing is the core of the service.
- **NPC Circular 2022-04** (as summarised in the compliance assumptions §9) makes registration of the DPO
  and the data processing systems mandatory when, among other criteria, an organisation processes
  sensitive personal information of at least 1,000 individuals, or processing is likely to pose a risk to
  data subjects, or is not occasional. Registration is renewed yearly; new systems within 20 days of
  starting.

**Recommendation (for the DPO to decide):** appoint a DPO before the pilot and register Tilvara as PIC (its
accounts) and PIP (business records) under Circular 2022-04, checking first whether the circular has been
amended. Businesses that record SC/PWD sales may have their own registration duty; the onboarding
material should say so without advising them.

Decision record: **[DPO name], [date], [registered / not registered, reason]**.

## 3. What engineering found while writing this pack

These are gaps in the system, recorded in `docs/LEFTOVER.md` as well:

1. **No purge of expired sign-in data.** `user_sessions` (including the browser's user agent) and
   `password_reset_tokens` are kept for ever. The retention schedule proposes limits.
2. **No anonymisation.** Since the follow-up session a person can close their own account (blocked at
   once) and correct their name and email; the anonymisation job for closed accounts and offboarded
   businesses is not built (it waits on the retention periods). See data-subject-requests.md.
3. **Append-only records cannot be corrected in place.** A misspelled SC/PWD name stays as recorded;
   there is no correction document for beneficiary details yet.
4. **The outbox keeps delivered events for ever.** Payloads carry ids only today, so little personal data,
   but there is no purge.
5. **Desktop tills keep every offline sale locally after it has synced**, with no purge. These are cash
   sales without SC/PWD details (the discount cannot be given offline), so the personal data on a till is
   limited to the cashier's identity and the business's own details; still, a stolen till PC holds its
   sales history (security-incident.md 2.3). If SC/PWD offline selling is ever added, this becomes a
   sensitive-data question.
6. **Log redaction** (done in the follow-up session): the logger redacts personal fields (email, names,
   ID numbers, TIN, phone, address, user agent, IP) as well as secrets, at any depth up to three objects,
   and dev mail logs mask the recipient. `logger.test.ts` checks every key at every depth, and
   `logging.test.ts` runs sign-up, invitation, reset and email change and finds none of their emails or
   names in the API logs. Free text in a message string is still not caught: log ids, never names.
7. **No customer profiles or marketing consent exist**, so SPEC 6.9's consent separation is not yet
   relevant. When customer profiles come, they need their own entries in the register and the notice.
8. **Hosting region is open (D1).** If Tilvara is hosted outside the Philippines, business records cross the
   border; the notice and the agreement must say where.

## 4. Questions for the DPO

1. Confirm the PIC/PIP split above, and whether Tilvara support staff need individual confidentiality
   undertakings.
2. Are SC/PWD beneficiary records sensitive personal information? Lawful basis: engineering assumes
   "processing provided for by existing laws" (Sec. 13(b)), since RR 5-2017 and the SC/PWD laws require
   the name and ID on each discounted sale.
3. Registration under Circular 2022-04: required now, at pilot, or at a threshold?
4. Retention: confirm 5 years from the filing deadline (EOPT, amended Sec. 235) for fiscal records, or
   longer; and the proposed limits for account data (retention-schedule.md).
5. Breach notification to businesses: is a contractual target of 24 hours right?
6. Hosting outside the Philippines (D1): acceptable, and what the agreement must say.
7. The audit log keeps sign-in events and who did what for as long as the fiscal records. Proportionate?
8. *Moot since 2026-10-25: salons were removed and migration 0112 deleted the service notes (processing register §15a); kept for the record.* **Salon service notes** (processing register §15a) can hold allergies and other health information.
   Since 2026-10-21 they are shown only to the business's own staff who hold `customers.read`. They are
   refused to the business's API keys (third-party integrations) and to Tilvara support sessions, and
   appointment notes are blanked for both. Is that the right line? Should staff need a separate
   permission to read them, beyond `customers.read` (which cashiers hold)?
