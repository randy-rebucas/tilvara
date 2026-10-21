import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  appointmentListQuerySchema,
  appointmentStatusSchema,
  availabilityQuerySchema,
  createAppointmentSchema,
  createServiceStaffSchema,
  createTimeOffSchema,
  customerNoteSchema,
  idParamSchema,
  serviceStaffListQuerySchema,
  setPackageItemsSchema,
  setStaffHoursSchema,
  setStaffServicesSchema,
  updateAppointmentSchema,
  updateCustomerNoteSchema,
  updateServiceStaffSchema,
  type AppointmentListQuery,
  type AppointmentStatusInput,
  type AvailabilityQuery,
  type CreateAppointmentInput,
  type CreateServiceStaffInput,
  type CreateTimeOffInput,
  type CustomerNoteInput,
  type ServiceStaffListQuery,
  type SetPackageItemsInput,
  type SetStaffHoursInput,
  type SetStaffServicesInput,
  type UpdateAppointmentInput,
  type UpdateCustomerNoteInput,
  type UpdateServiceStaffInput,
} from '@1pos/validation';
import { z } from 'zod';
import { Auth, RequireTenant, type AuthContext } from '../auth/auth-context.js';
import { Idempotent } from '../infrastructure/idempotency.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { AppointmentsService } from './appointments.service.js';
import { SalonService } from './salon.service.js';
import { StaffService } from './staff.service.js';

const id = new ZodPipe(idParamSchema);
const openQuery = new ZodPipe(z.object({ open: z.enum(['true', 'false']).default('false').transform((v) => v === 'true') }));

/**
 * Salons, spas and barber shops (ADR-0022): service staff, appointments, package contents and a
 * client's packages, visits and notes. Permissions and the business type are checked in the services.
 */
@RequireTenant()
@Controller()
export class SalonController {
  constructor(
    @Inject(StaffService) private readonly staff: StaffService,
    @Inject(AppointmentsService) private readonly appointments: AppointmentsService,
    @Inject(SalonService) private readonly salon: SalonService,
  ) {}

  // ---------------------------------------------------------------- service staff

  @Get('service-staff')
  listStaff(@Auth() auth: AuthContext, @Query(new ZodPipe(serviceStaffListQuerySchema)) q: ServiceStaffListQuery) {
    return this.staff.list(auth, q);
  }

  @Idempotent()
  @Post('service-staff')
  createStaff(@Auth() auth: AuthContext, @Body(new ZodPipe(createServiceStaffSchema)) body: CreateServiceStaffInput) {
    return this.staff.create(auth, body);
  }

  @Get('service-staff/:id')
  getStaff(@Auth() auth: AuthContext, @Param('id', id) staffId: string) {
    return this.staff.get(auth, staffId);
  }

  @Patch('service-staff/:id')
  updateStaff(@Auth() auth: AuthContext, @Param('id', id) staffId: string, @Body(new ZodPipe(updateServiceStaffSchema)) body: UpdateServiceStaffInput) {
    return this.staff.update(auth, staffId, body);
  }

  @Put('service-staff/:id/services')
  setStaffServices(@Auth() auth: AuthContext, @Param('id', id) staffId: string, @Body(new ZodPipe(setStaffServicesSchema)) body: SetStaffServicesInput) {
    return this.staff.setServices(auth, staffId, body);
  }

  @Put('service-staff/:id/hours')
  setStaffHours(@Auth() auth: AuthContext, @Param('id', id) staffId: string, @Body(new ZodPipe(setStaffHoursSchema)) body: SetStaffHoursInput) {
    return this.staff.setHours(auth, staffId, body);
  }

  @Idempotent()
  @Post('service-staff/:id/time-off')
  addTimeOff(@Auth() auth: AuthContext, @Param('id', id) staffId: string, @Body(new ZodPipe(createTimeOffSchema)) body: CreateTimeOffInput) {
    return this.staff.addTimeOff(auth, staffId, body);
  }

  @Delete('service-staff/:id/time-off/:timeOffId')
  removeTimeOff(@Auth() auth: AuthContext, @Param('id', id) staffId: string, @Param('timeOffId', id) timeOffId: string) {
    return this.staff.removeTimeOff(auth, staffId, timeOffId);
  }

  // ---------------------------------------------------------------- appointments

  @Get('appointments')
  listAppointments(@Auth() auth: AuthContext, @Query(new ZodPipe(appointmentListQuerySchema)) q: AppointmentListQuery) {
    return this.appointments.list(auth, q);
  }

  /** Free times for a service on a branch day, per staff member who does it. */
  @Get('appointments/availability')
  availability(@Auth() auth: AuthContext, @Query(new ZodPipe(availabilityQuerySchema)) q: AvailabilityQuery) {
    return this.appointments.availability(auth, q);
  }

  @Idempotent()
  @Post('appointments')
  book(@Auth() auth: AuthContext, @Body(new ZodPipe(createAppointmentSchema)) body: CreateAppointmentInput) {
    return this.appointments.create(auth, body);
  }

  @Get('appointments/:id')
  getAppointment(@Auth() auth: AuthContext, @Param('id', id) appointmentId: string) {
    return this.appointments.get(auth, appointmentId);
  }

  @Patch('appointments/:id')
  changeAppointment(@Auth() auth: AuthContext, @Param('id', id) appointmentId: string, @Body(new ZodPipe(updateAppointmentSchema)) body: UpdateAppointmentInput) {
    return this.appointments.update(auth, appointmentId, body);
  }

  /** Arrived, no-show or cancelled; completed only by ringing it up. */
  @HttpCode(200)
  @Post('appointments/:id/status')
  setStatus(@Auth() auth: AuthContext, @Param('id', id) appointmentId: string, @Body(new ZodPipe(appointmentStatusSchema)) body: AppointmentStatusInput) {
    return this.appointments.setStatus(auth, appointmentId, body);
  }

  // ---------------------------------------------------------------- packages

  @Get('variants/:id/package-items')
  packageItems(@Auth() auth: AuthContext, @Param('id', id) variantId: string) {
    return this.salon.packageItems(auth, variantId);
  }

  @Put('variants/:id/package-items')
  setPackageItems(@Auth() auth: AuthContext, @Param('id', id) variantId: string, @Body(new ZodPipe(setPackageItemsSchema)) body: SetPackageItemsInput) {
    return this.salon.setPackageItems(auth, variantId, body);
  }

  // ---------------------------------------------------------------- client history

  @Get('customers/:id/packages')
  customerPackages(@Auth() auth: AuthContext, @Param('id', id) customerId: string, @Query(openQuery) q: { open: boolean }) {
    return this.salon.packages(auth, customerId, q.open);
  }

  @Get('customers/:id/visits')
  visits(@Auth() auth: AuthContext, @Param('id', id) customerId: string) {
    return this.salon.visits(auth, customerId);
  }

  @Get('customers/:id/notes')
  notes(@Auth() auth: AuthContext, @Param('id', id) customerId: string) {
    return this.salon.notes(auth, customerId);
  }

  @Idempotent()
  @Post('customers/:id/notes')
  addNote(@Auth() auth: AuthContext, @Param('id', id) customerId: string, @Body(new ZodPipe(customerNoteSchema)) body: CustomerNoteInput) {
    return this.salon.addNote(auth, customerId, body);
  }

  @Patch('customers/:id/notes/:noteId')
  updateNote(@Auth() auth: AuthContext, @Param('id', id) customerId: string, @Param('noteId', id) noteId: string, @Body(new ZodPipe(updateCustomerNoteSchema)) body: UpdateCustomerNoteInput) {
    return this.salon.updateNote(auth, customerId, noteId, body);
  }

  @Delete('customers/:id/notes/:noteId')
  removeNote(@Auth() auth: AuthContext, @Param('id', id) customerId: string, @Param('noteId', id) noteId: string) {
    return this.salon.removeNote(auth, customerId, noteId);
  }
}
