import { z } from 'zod';

/** A commission rate as a fraction, "0" to "1" (e.g. "0.15" = 15 %). */
export const commissionRateSchema = z
  .string()
  .trim()
  .regex(/^(0(\.\d{1,6})?|1(\.0{1,6})?)$/, 'Use a fraction between 0 and 1, such as "0.15"');

const hhmm = z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time such as "09:30"');
const instant = z.iso.datetime({ offset: true });

// ------------------------------------------------------------------ service staff (ADR-0022 §2)

const staffFields = {
  displayName: z.string().trim().min(1).max(80),
  /** A member who signs in as this staff member (their calendar), or null. */
  membershipId: z.uuid().nullable(),
  commissionRate: commissionRateSchema,
  color: z.string().trim().toLowerCase().regex(/^#[0-9a-f]{6}$/, 'Use a colour such as "#7a4cc2"').nullable(),
};

export const createServiceStaffSchema = z.object({
  branchId: z.uuid(),
  displayName: staffFields.displayName,
  membershipId: staffFields.membershipId.optional(),
  commissionRate: staffFields.commissionRate.default('0'),
  color: staffFields.color.optional(),
});
export type CreateServiceStaffInput = z.infer<typeof createServiceStaffSchema>;

/**
 * `keepAppointments`: archive even though they have bookings to come (audit 2026-10-21); without it,
 * archiving someone with open future appointments is refused with 409 STAFF_HAS_APPOINTMENTS.
 */
export const updateServiceStaffSchema = z
  .object({ ...staffFields, archived: z.boolean(), keepAppointments: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).some((k) => k !== 'keepAppointments'), 'Nothing to update');
export type UpdateServiceStaffInput = z.infer<typeof updateServiceStaffSchema>;

export const serviceStaffListQuerySchema = z.object({
  branchId: z.uuid().optional(),
  includeArchived: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});
export type ServiceStaffListQuery = z.infer<typeof serviceStaffListQuerySchema>;

/** The services a staff member does (none = every service), each with an optional rate of its own. */
export const setStaffServicesSchema = z.object({
  services: z
    .array(z.object({ variantId: z.uuid(), commissionRate: commissionRateSchema.nullable().optional() }))
    .max(500)
    .refine((s) => new Set(s.map((x) => x.variantId)).size === s.length, 'Each service once'),
});
export type SetStaffServicesInput = z.infer<typeof setStaffServicesSchema>;

/** The weekly hours, replaced as a whole. Spans of one weekday never overlap. */
export const setStaffHoursSchema = z.object({
  hours: z
    .array(z.object({ weekday: z.number().int().min(0).max(6), startsAt: hhmm, endsAt: hhmm }))
    .max(50)
    .superRefine((hours, ctx) => {
      for (const [i, h] of hours.entries()) {
        if (h.endsAt <= h.startsAt) ctx.addIssue({ code: 'custom', path: [i, 'endsAt'], message: 'Ends after it starts' });
        for (const [j, o] of hours.entries()) {
          if (j > i && o.weekday === h.weekday && o.startsAt < h.endsAt && h.startsAt < o.endsAt) {
            ctx.addIssue({ code: 'custom', path: [j], message: 'Hours of one day do not overlap' });
          }
        }
      }
    }),
});
export type SetStaffHoursInput = z.infer<typeof setStaffHoursSchema>;

/** `keepAppointments`: as for archiving; without it, time off over open bookings is a 409 STAFF_HAS_APPOINTMENTS. */
export const createTimeOffSchema = z
  .object({ startsAt: instant, endsAt: instant, reason: z.string().trim().min(1).max(200).optional(), keepAppointments: z.boolean().optional() })
  .refine((v) => Date.parse(v.endsAt) > Date.parse(v.startsAt), { message: 'Ends after it starts', path: ['endsAt'] });
export type CreateTimeOffInput = z.infer<typeof createTimeOffSchema>;

// ------------------------------------------------------------------ appointments (ADR-0022 §4)

const appointmentService = z.object({
  variantId: z.uuid(),
  staffId: z.uuid(),
  startsAt: instant,
  /** Defaults to the service's duration. */
  minutes: z.number().int().min(5).max(720).optional(),
});

const appointmentFields = {
  customerId: z.uuid().nullable().optional(),
  guestName: z.string().trim().min(1).max(120).nullable().optional(),
  services: z.array(appointmentService).min(1).max(10),
  notes: z.string().trim().max(500).nullable().optional(),
  remind: z.boolean().optional(),
  /** Book outside the staff's hours or in their time off (front desk squeezing someone in). */
  outsideHours: z.boolean().default(false),
};

export const createAppointmentSchema = z
  .object({ branchId: z.uuid(), ...appointmentFields })
  .refine((v) => Boolean(v.customerId) || Boolean(v.guestName), { message: 'Name the customer or a guest', path: ['guestName'] });
export type CreateAppointmentInput = z.infer<typeof createAppointmentSchema>;

export const updateAppointmentSchema = z
  .object(appointmentFields)
  .partial()
  .extend({ outsideHours: z.boolean().default(false) })
  .refine((v) => Object.keys(v).some((k) => k !== 'outsideHours'), 'Nothing to update');
export type UpdateAppointmentInput = z.infer<typeof updateAppointmentSchema>;

/** BOOKED → ARRIVED, BOOKED/ARRIVED → NO_SHOW or CANCELLED (with a reason). COMPLETED only by ringing it up. */
export const appointmentStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ARRIVED') }),
  z.object({ status: z.literal('NO_SHOW') }),
  z.object({ status: z.literal('CANCELLED'), reason: z.string().trim().min(1).max(200) }),
]);
export type AppointmentStatusInput = z.infer<typeof appointmentStatusSchema>;

export const appointmentListQuerySchema = z
  .object({
    branchId: z.uuid(),
    from: instant,
    to: instant,
    staffId: z.uuid().optional(),
  })
  .refine((v) => Date.parse(v.to) > Date.parse(v.from) && Date.parse(v.to) - Date.parse(v.from) <= 42 * 86_400_000, {
    message: 'A window of up to 6 weeks',
    path: ['to'],
  });
export type AppointmentListQuery = z.infer<typeof appointmentListQuerySchema>;

/** Free times of the branch's staff for a service on a day (the booking form's suggestions). */
export const availabilityQuerySchema = z.object({
  branchId: z.uuid(),
  variantId: z.uuid(),
  /** The day in the branch's calendar. */
  date: z.iso.date(),
  staffId: z.uuid().optional(),
});
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

// ------------------------------------------------------------------ packages (ADR-0022 §6)

export const setPackageItemsSchema = z.object({
  items: z
    .array(z.object({ serviceVariantId: z.uuid(), sessions: z.number().int().min(1).max(1000) }))
    .min(1)
    .max(20)
    .refine((s) => new Set(s.map((x) => x.serviceVariantId)).size === s.length, 'Each service once'),
});
export type SetPackageItemsInput = z.infer<typeof setPackageItemsSchema>;

// ------------------------------------------------------------------ client notes (ADR-0022 §8)

export const customerNoteSchema = z.object({
  body: z.string().trim().min(1).max(2000),
  pinned: z.boolean().default(false),
});
export type CustomerNoteInput = z.infer<typeof customerNoteSchema>;

export const updateCustomerNoteSchema = z
  .object({ body: z.string().trim().min(1).max(2000), pinned: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateCustomerNoteInput = z.infer<typeof updateCustomerNoteSchema>;
