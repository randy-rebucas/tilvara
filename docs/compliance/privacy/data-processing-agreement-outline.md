# Data processing agreement: outline (draft)

> **DRAFT OUTLINE, NOT LEGAL ADVICE, NOT A CONTRACT.** Counsel drafts the agreement. This outline lists
> what the agreement between Tilvara (processor) and each business (controller) has to cover, under the
> Data Privacy Act's rules on outsourcing to a processor (IRR, as summarised in
> `../PH_COMPLIANCE_ASSUMPTIONS.md` §9), and what Tilvara can actually commit to as built on 2026-10-18.

SPEC "Privacy" asks for appropriate contracts between the SaaS operator and tenant businesses. The
agreement can be a schedule to the subscription terms, accepted at sign-up.

## Clauses and what Tilvara can commit to

| Clause | Content | What the system supports today |
|---|---|---|
| Subject, duration | The Tilvara service, for the subscription's term and the retention hold after it | Read-only after cancellation, data kept for the fiscal period (tenant-offboarding.md) |
| Nature and purpose | Recording sales, stock, purchasing, books and restaurant service for the business | — |
| Data and people | Processing register activities 2–9, 11, 13 | processing-register.md |
| Instructions | Tilvara processes the business's records only on its documented instructions: the service as configured by the business, and support access the business grants | No Tilvara access without a grant (support-access.md); grants are purpose-bound, ≤ 72 h, read-only |
| Confidentiality | Every Tilvara person who can reach business records is bound to confidentiality | Staff marked only by ops; production access runbook |
| Security | Measures in the register's "safeguards" list, kept up to date | Tested controls: THREAT_MODEL control → test map |
| Sub-processors | Listed below; the business is told before a new one is added and may object | List below |
| Transfers abroad | Where the data is hosted | [D1] |
| Data subject requests | Tilvara forwards requests it receives and helps the business answer them | Search and reports in the admin; data export; data-subject-requests.md |
| Breach notification | Tilvara tells the business without undue delay, **target 24 hours** after becoming aware, with the facts it needs for its own 72-hour notification | breach-procedure.md |
| Help with compliance | Help with impact assessments and NPC inquiries, at reasonable request | — |
| End of service | Return: the business exports its records at any time, including after cancellation. Deletion: after the fiscal retention period, personal data is anonymised; backups age out | Export ● (ZIP of CSVs); anonymisation ○ (not built: the agreement should state the hold and that anonymisation follows) |
| Audit | Tilvara makes available the information needed to show compliance (this pack, security summaries); on-site audits by agreement | The business's audit log shows every change and every support read |
| Liability, governing law | Counsel | — |

Do **not** commit to, until built:
- deletion on request before the retention period ends (tax law prevents it; offer blocking);
- automatic clearing of takeaway names or a configurable retention per business;
- a fixed recovery point better than the last daily backup (point-in-time recovery comes with D1);
- card refunds or card-data handling beyond "Tilvara never receives card numbers" (D6).

## Sub-processors

| Service | Provider | Data | Location | Status |
|---|---|---|---|---|
| Hosting: database, application, file storage, backups | [D1] | All business records and account data | [D1 region] | Not chosen |
| Email delivery | [D2] | Recipient email and name, one-time links | [D2] | Not chosen; no mail is delivered in production until then |
| Card and QR payments | PayMongo (chosen 2026-10-15) | Amount, method, reference; card data stays with PayMongo | [PayMongo's terms] | Not connected (D6) |

Monitoring, metrics and log storage follow the hosting choice and are added here with it.

## Businesses' own duties (to state, not to advise on)

The business, as controller, decides what it tells its customers (Part B of the notice is a template),
answers their requests, decides whether it must register with the NPC, and notifies the NPC and its
customers of breaches in its records. Tilvara helps with facts and tools but does not advise.
