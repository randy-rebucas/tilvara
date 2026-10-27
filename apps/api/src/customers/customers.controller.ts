import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import {
  anonymiseCustomerSchema,
  createCustomerSchema,
  customerConsentSchema,
  customerHistoryQuerySchema,
  customerListQuerySchema,
  idParamSchema,
  updateCustomerSchema,
  type AnonymiseCustomerInput,
  type CreateCustomerInput,
  type CustomerConsentInput,
  type CustomerHistoryQuery,
  type CustomerListQuery,
  type UpdateCustomerInput,
} from '@1pos/validation';
import { AllowReadOnlyBusiness, Auth, RequireTenant, type AuthContext } from '../auth/auth-context.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { CustomersService } from './customers.service.js';

const id = new ZodPipe(idParamSchema);

/** Customers (SPEC §6.9, ADR-0018). Permissions are checked in the service. */
@RequireTenant()
@Controller('customers')
export class CustomersController {
  constructor(@Inject(CustomersService) private readonly customers: CustomersService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query(new ZodPipe(customerListQuerySchema)) q: CustomerListQuery) {
    return this.customers.list(auth, q);
  }

  @Post()
  create(@Auth() auth: AuthContext, @Body(new ZodPipe(createCustomerSchema)) body: CreateCustomerInput) {
    return this.customers.create(auth, body);
  }

  @Get(':id')
  get(@Auth() auth: AuthContext, @Param('id', id) customerId: string) {
    return this.customers.get(auth, customerId);
  }

  @Patch(':id')
  update(@Auth() auth: AuthContext, @Param('id', id) customerId: string, @Body(new ZodPipe(updateCustomerSchema)) body: UpdateCustomerInput) {
    return this.customers.update(auth, customerId, body);
  }

  /** A withdrawal is honoured in a suspended or lapsed business too; the service refuses giving consent then. */
  @AllowReadOnlyBusiness()
  @HttpCode(200)
  @Post(':id/consent')
  consent(@Auth() auth: AuthContext, @Param('id', id) customerId: string, @Body(new ZodPipe(customerConsentSchema)) body: CustomerConsentInput) {
    return this.customers.consent(auth, customerId, body);
  }

  @HttpCode(200)
  @Post(':id/archive')
  archive(@Auth() auth: AuthContext, @Param('id', id) customerId: string) {
    return this.customers.archive(auth, customerId);
  }

  /** An erasure request is answered in a suspended or lapsed business too. */
  @AllowReadOnlyBusiness()
  @HttpCode(200)
  @Post(':id/anonymise')
  anonymise(@Auth() auth: AuthContext, @Param('id', id) customerId: string, @Body(new ZodPipe(anonymiseCustomerSchema)) body: AnonymiseCustomerInput) {
    return this.customers.anonymise(auth, customerId, body);
  }

  @Get(':id/sales')
  history(@Auth() auth: AuthContext, @Param('id', id) customerId: string, @Query(new ZodPipe(customerHistoryQuerySchema)) q: CustomerHistoryQuery) {
    return this.customers.history(auth, customerId, q);
  }

  @Get(':id/store-credit')
  credit(@Auth() auth: AuthContext, @Param('id', id) customerId: string, @Query(new ZodPipe(customerHistoryQuerySchema)) q: CustomerHistoryQuery) {
    return this.customers.credit(auth, customerId, q);
  }

  /** A data subject's access request: everything held about the customer, as JSON (audited). */
  @AllowReadOnlyBusiness()
  @HttpCode(200)
  @Post(':id/export')
  export(@Auth() auth: AuthContext, @Param('id', id) customerId: string) {
    return this.customers.export(auth, customerId);
  }
}
