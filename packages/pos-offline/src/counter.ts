/** A cart line at the till: a catalog item. */
export interface CounterCartLine {
  variantId: string;
  quantity: string;
  /** Who performed or sold it (ADR-0022 §5): a staff member of the snapshot. */
  staffId?: string | undefined;
  /** A prescription medicine (ADR-0025 §6): the item of a prescription recorded with this sale. */
  prescription?: { prescriptionRef: string; itemRef: string } | undefined;
}
