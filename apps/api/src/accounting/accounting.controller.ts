import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import {
  accountListQuerySchema,
  createAccountSchema,
  createJournalEntrySchema,
  idParamSchema,
  journalListQuerySchema,
  periodActionSchema,
  periodListQuerySchema,
  reverseJournalEntrySchema,
  trialBalanceQuerySchema,
  type AccountListQuery,
  type CreateAccountInput,
  type CreateJournalEntryInput,
  type JournalListQuery,
  type PeriodActionInput,
  type PeriodListQuery,
  type ReverseJournalEntryInput,
  type TrialBalanceQuery,
} from '@1pos/validation';
import { Auth, RequireTenant, type AuthContext } from '../auth/auth-context.js';
import { Idempotent } from '../infrastructure/idempotency.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { AccountingService } from './accounting.service.js';

const id = new ZodPipe(idParamSchema);

/** Chart of accounts, journal, periods and the trial balance. Entity-scoped permissions are checked in the service. */
@RequireTenant()
@Controller()
export class AccountingController {
  constructor(@Inject(AccountingService) private readonly accounting: AccountingService) {}

  @Get('accounts')
  listAccounts(@Auth() auth: AuthContext, @Query(new ZodPipe(accountListQuerySchema)) q: AccountListQuery) {
    return this.accounting.listAccounts(auth, q);
  }

  @Idempotent()
  @Post('accounts')
  createAccount(@Auth() auth: AuthContext, @Body(new ZodPipe(createAccountSchema)) body: CreateAccountInput) {
    return this.accounting.createAccount(auth, body);
  }

  @Get('journal-entries')
  listEntries(@Auth() auth: AuthContext, @Query(new ZodPipe(journalListQuerySchema)) q: JournalListQuery) {
    return this.accounting.listEntries(auth, q);
  }

  @Get('journal-entries/:id')
  getEntry(@Auth() auth: AuthContext, @Param('id', id) entryId: string) {
    return this.accounting.getEntry(auth, entryId);
  }

  /** Manual entry (accounting.post). Financial write: Idempotency-Key is mandatory. */
  @Idempotent({ required: true })
  @Post('journal-entries')
  createManual(@Auth() auth: AuthContext, @Body(new ZodPipe(createJournalEntrySchema)) body: CreateJournalEntryInput) {
    return this.accounting.createManual(auth, body);
  }

  @Idempotent({ required: true })
  @Post('journal-entries/:id/reverse')
  reverse(@Auth() auth: AuthContext, @Param('id', id) entryId: string, @Body(new ZodPipe(reverseJournalEntrySchema)) body: ReverseJournalEntryInput) {
    return this.accounting.reverse(auth, entryId, body);
  }

  @Get('accounting/periods')
  listPeriods(@Auth() auth: AuthContext, @Query(new ZodPipe(periodListQuerySchema)) q: PeriodListQuery) {
    return this.accounting.listPeriods(auth, q);
  }

  @HttpCode(200)
  @Post('accounting/periods/close')
  closePeriod(@Auth() auth: AuthContext, @Body(new ZodPipe(periodActionSchema)) body: PeriodActionInput) {
    return this.accounting.closePeriod(auth, body);
  }

  @HttpCode(200)
  @Post('accounting/periods/reopen')
  reopenPeriod(@Auth() auth: AuthContext, @Body(new ZodPipe(periodActionSchema)) body: PeriodActionInput) {
    return this.accounting.reopenPeriod(auth, body);
  }

  @Get('reports/trial-balance')
  trialBalance(@Auth() auth: AuthContext, @Query(new ZodPipe(trialBalanceQuerySchema)) q: TrialBalanceQuery) {
    return this.accounting.trialBalance(auth, q);
  }
}
