import { Module } from '@nestjs/common';
import { AppointmentsService } from './appointments.service.js';
import { SalonController } from './salon.controller.js';
import { SalonService } from './salon.service.js';
import { StaffService } from './staff.service.js';

/** Salons, spas and barber shops (ADR-0022). Ringing up, packages and tips at the sale live in SalesService. */
@Module({
  controllers: [SalonController],
  providers: [StaffService, AppointmentsService, SalonService],
})
export class SalonModule {}
