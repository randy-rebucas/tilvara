# Support: resetting two-step sign-in (lost phone)

Two-step sign-in (TOTP) is required for privileged members (owner, admin, accountant, and any role with a
privileged permission; ADR-0016 slice 1). A member who loses the phone with the authenticator app **and**
their recovery codes cannot sign in. This page says who resets it and how.

## 1. A member who is not the only owner

An owner or admin of the same business does it; support is not involved.

1. Confirm it is really the member: call them on a number you already know, or see them in person.
2. Admin → **Team** → the member → **Lost phone** → **Reset two-step sign-in**.
3. Write how you confirmed it (for example "called on her usual number, she confirmed the shift she closed
   yesterday"). The reason is kept in the audit log.

What happens: the member's authenticator and recovery codes are removed, every session of theirs ends,
their password stays. A privileged member must set up two-step sign-in again at the next sign-in; business
pages stay closed for them until they do. Audit: `member.mfa_reset` in the business, `auth.mfa.reset` at
platform level (actor, business, reason).

Refused: resetting yourself (use a recovery code instead), resetting someone whose roles you could not have
granted, anyone without `members.manage` for the whole business, and (since session 40) a member who is also
on another business's team (`MFA_RESET_OTHER_BUSINESS`): the reset is account-wide, so it would act on the
other business too. Support resets them as in section 2.

## 2. The owner, or a member who is also in another business (no one in the business can reset them)

Support does it, with a ticket.

1. Open a ticket. Verify identity **before** anything else, with at least two of: the email and phone number
   on the account, the business TIN and registered name, the last sale number or shift closed, a call-back
   to the number on file. Record what was checked in the ticket.
2. Run, with ops credentials (`DATABASE_MIGRATOR_URL`; never the API's runtime credentials):

   ```
   pnpm --filter @1pos/database support mfa-reset --email owner@example.ph \
     --reason "ID and TIN checked on a call-back to the number on file" --ticket TCK-1042
   ```

   `--actor` defaults to your OS user name; pass your support name if it differs.
3. Tell the owner to sign in with their password and set up two-step sign-in again right away, and to keep
   the new recovery codes somewhere safe (printed, not on the same phone).

The function `auth_mfa_support_reset()` writes a platform-level audit row `auth.mfa.support_reset` with the
actor, reason and ticket. It refuses a call without all three, and only the migrator role can run it.

## Watch for

- Several resets for one business in a short time, or a reset followed by changes to members, prices or
  the books: review the audit log with the owner.
- A reset requested by email only, or under time pressure: slow down and call back on the number on file.
