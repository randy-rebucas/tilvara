# Personal data breach procedure (draft)

> **DRAFT, NOT LEGAL ADVICE.** Based on NPC Circular 16-03 as summarised in
> `../PH_COMPLIANCE_ASSUMPTIONS.md` §9 (partially verified). The DPO confirms the rules, the thresholds and
> the forms against the current NPC issuances before adopting this.

For: the DPO, the incident lead and 1POS management. It runs **alongside**
[incident-response.md](../../operations/incident-response.md) and
[security-incident.md](../../operations/security-incident.md): those contain and fix; this one decides
who must be told, and records it.

## 1. What counts

A **personal data breach** is a security incident that leads to personal data being destroyed, lost,
altered, disclosed or accessed without authority, whether by accident or on purpose. It covers
confidentiality (seen or taken), integrity (changed) and availability (lost).

Examples in 1POS:
- one business's records shown to another business (cross-tenant exposure);
- an account, a staff account or an ops credential used by someone else;
- a backup, export file or database copy reaching someone not allowed (with the key, or unencrypted);
- a stolen till PC (its local sales);
- SC/PWD records changed or lost by a defect, with no correct copy;
- records lost in a disaster beyond the last backup.

A security incident with **no** personal data at risk (a blocked attack, an outage with nothing lost) is
not a breach, but goes in the incident register (section 7) all the same.

## 2. The clock

**72 hours** from the moment 1POS **knows, or reasonably believes**, that a breach needing notification
happened. Not from when the investigation ends. The incident log's first entry about personal data
starts it; write the time.

For business records, 1POS is the processor: **the business is the controller and carries the duty to
notify the NPC and its customers**. 1POS tells each affected business **without undue delay, target
24 hours**, so it can meet its own 72 hours, and helps it with the facts.

For 1POS account data (sign-in data of owners, staff, support), 1POS is the controller and notifies the
NPC and the people itself.

## 3. Steps

| Step | Who | Within |
|---|---|---|
| 1. Contain (security-incident.md) | Incident lead | At once |
| 2. Tell the DPO; open the breach entry (section 7) | Incident lead | 1 hour after personal data is suspected |
| 3. Assess (section 4) | DPO with the operator | As facts come in; first assessment within 24 hours |
| 4. Tell affected businesses (template A) | DPO / management | Target 24 hours |
| 5. Decide on NPC and data subject notification (section 5) | DPO | Before 72 hours |
| 6. Notify the NPC (template B) and the people (template C) where required | DPO | Within 72 hours |
| 7. Follow-up reports to the NPC and businesses as facts change | DPO | As the NPC requires |
| 8. Close: review, register, lessons (incident-response.md §5) | DPO, incident lead | After resolution |

If not all facts are known at 72 hours, notify with what is known and say what is still being
established. Delaying the notification needs a reason the circular allows (as summarised: to determine
the scope, prevent further harm, or restore the system's integrity); the DPO records it.

## 4. Assessing

Answer, with evidence, in the breach entry:

1. **Whose data?** Which businesses; which groups (members, SC/PWD beneficiaries, takeaway customers,
   supplier contacts, 1POS staff); how many people. The processing register names the data in each group;
   security-incident.md §3 has the queries.
2. **What data?** Name it per category. In 1POS the most serious are:
   - SC/PWD records: name with OSCA/PWD ID number and TIN (engineering treats them as **sensitive**: they
     reveal age or disability and carry government-issued identifiers);
   - account credentials: password hashes, sessions, encrypted MFA secrets (+ whether
     `MFA_ENCRYPTION_KEY` was exposed too);
   - emails and names of members.
3. **Confidentiality, integrity or availability?** Seen, taken, changed, lost?
4. **Was it protected?** An encrypted backup or export whose key did not leak is much lower risk.
5. **Contained?** What proves it?
6. **Harm**: could it enable identity fraud, discrimination, financial loss, embarrassment?

## 5. When the NPC and the people must be told

As summarised from Circular 16-03, notification is required when **all three** hold:

1. the breach involves **sensitive personal information**, or information that could enable **identity
   fraud**;
2. the data is reasonably believed to have been **acquired by an unauthorised person**;
3. the unauthorised acquisition is **likely to give rise to a real risk of serious harm** to the people
   affected.

Guide for 1POS (the DPO decides each case):

| Situation | Likely outcome |
|---|---|
| SC/PWD records exposed across businesses or to an outsider | Notify (sensitive + acquired + risk) |
| Encrypted backup stolen, key safe | Usually not notifiable; record it |
| Encrypted backup stolen **and** key exposed | Notify |
| A member's account used by someone else who read the business's reports | Business decides; usually notify the affected people if SC/PWD records were read |
| Support staff read a business outside a grant | Cannot happen by design; if it did, it is a cross-tenant class event: notify the business at once |
| Records lost in a restore beyond the last backup | Availability breach: tell the business; NPC notification depends on harm |
| Stolen till PC | Offline sales hold no SC/PWD details; usually record only |

## 6. Templates

Fill in the brackets; keep the language plain. The business may need a Filipino version for its
customers.

**A. To an affected business (1POS as processor)**

> Subject: Security incident affecting your 1POS records — [date]
>
> On [date and time], we found [what happened, in one or two sentences]. It affected [which of your
> records: e.g. senior citizen and PWD discount records from [date] to [date], about [number] people].
> [What we know about who could see or change them.]
>
> What we have done: [containment, e.g. closed the access, rotated keys]. Your records [were / were not]
> changed. [Your tills and sales are / are not affected.]
>
> What you may need to do: as the controller of these records, you may have to notify the National
> Privacy Commission and the people affected within 72 hours of learning of it. We will give you every
> fact you need for that. Our DPO, [name, email, phone], is available to you directly.
>
> We will update you by [time] and as we learn more.

**B. To the NPC (contents to include, per the circular as summarised; use the NPC's current form or
portal)**

- the PIC's name and contact person (the DPO);
- nature of the breach: what happened, when, how it was discovered, how many people, which systems;
- the personal data involved, by category, noting sensitive information;
- measures taken and planned: containment, recovery, steps to reduce harm, help offered to the people;
- whether and how the people affected were or will be told, or why not.

**C. To the people affected**

> We are writing to tell you about a security incident involving your information held by [business
> name / 1POS]. On [date], [what happened]. The information involved was [e.g. your name and senior
> citizen ID number, recorded when you received the senior citizen discount].
>
> What we have done: [measures]. What you can do: [e.g. watch for anyone using your ID number; nothing
> else is needed]. If you have questions, contact [DPO name, email, phone]. You may also contact the
> National Privacy Commission at privacy.gov.ph.

## 7. Registers

- **Breach and incident register** (kept by the DPO, outside the code repository): every security
  incident, breach or not, with date found, date contained, data and people involved, assessment,
  notification decision and reason, notifications sent (to whom, when), and follow-up.
- **Annual report**: the circular (as summarised) expects an annual summary of security incidents and
  breaches to the NPC. The register is its source.
- Evidence (logs, audit exports, the incident log) is kept until the matter is closed and any claim
  period has passed; the DPO sets the period.

## 8. Readiness

- [ ] DPO named and reachable out of hours; deputy named
- [ ] Contact list of every pilot business's owner (phone, email) kept outside 1POS, so it is reachable
      when 1POS is down
- [ ] Template A agreed with counsel; Filipino version of template C prepared
- [ ] NPC breach notification channel and current form checked by the DPO
- [ ] One tabletop exercise before the pilot (e.g. "a backup file and its key are found on a public
      share") using this procedure, the incident log and the registers
