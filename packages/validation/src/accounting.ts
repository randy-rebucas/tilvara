import { z } from 'zod';
import { amountSchema } from './catalog.js';

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
const memo = z.string().trim().min(1).max(500);

export const accountListQuerySchema = z.object({ legalEntityId: z.uuid() });
export type AccountListQuery = z.infer<typeof accountListQuerySchema>;

export const createAccountSchema = z.object({
  legalEntityId: z.uuid(),
  code: z.string().trim().regex(/^[0-9A-Z][0-9A-Z.-]{0,19}$/, 'Use up to 20 digits, capitals, . or -'),
  name: z.string().trim().min(1).max(200),
  type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']),
});
export type CreateAccountInput = z.infer<typeof createAccountSchema>;

export const journalListQuerySchema = z
  .object({
    legalEntityId: z.uuid(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    sourceType: z.string().trim().toUpperCase().regex(/^[A-Z_]{3,30}$/).optional(),
    sourceId: z.uuid().optional(),
    accountId: z.uuid().optional(),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: '"from" must not be after "to"', path: ['from'] });
export type JournalListQuery = z.infer<typeof journalListQuerySchema>;

/** A manual journal entry (accounting.post): at least two lines, each a debit or a credit, balanced. */
export const createJournalEntrySchema = z
  .object({
    legalEntityId: z.uuid(),
    entryDate: z.iso.date(),
    memo,
    lines: z
      .array(
        z.object({
          accountId: z.uuid(),
          debit: amountSchema.optional(),
          credit: amountSchema.optional(),
          branchId: z.uuid().nullable().optional(),
          memo: z.string().trim().max(200).nullable().optional(),
        }),
      )
      .min(2)
      .max(200),
  })
  .superRefine((v, ctx) => {
    v.lines.forEach((l, i) => {
      const d = Number(l.debit ?? 0);
      const c = Number(l.credit ?? 0);
      if ((d > 0) === (c > 0)) ctx.addIssue({ code: 'custom', path: ['lines', i], message: 'Each line is either a debit or a credit' });
    });
  });
export type CreateJournalEntryInput = z.infer<typeof createJournalEntrySchema>;

export const reverseJournalEntrySchema = z.object({ memo, entryDate: z.iso.date().optional() });
export type ReverseJournalEntryInput = z.infer<typeof reverseJournalEntrySchema>;

export const periodListQuerySchema = z.object({ legalEntityId: z.uuid() });
export type PeriodListQuery = z.infer<typeof periodListQuerySchema>;

export const periodActionSchema = z.object({ legalEntityId: z.uuid(), month, reason: z.string().trim().max(500).optional() });
export type PeriodActionInput = z.infer<typeof periodActionSchema>;

export const trialBalanceQuerySchema = z
  .object({ legalEntityId: z.uuid(), from: z.iso.date(), to: z.iso.date() })
  .refine((v) => v.from <= v.to, { message: '"from" must not be after "to"', path: ['from'] });
export type TrialBalanceQuery = z.infer<typeof trialBalanceQuerySchema>;
