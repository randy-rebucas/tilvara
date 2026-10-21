import type { SnapshotCounter } from '@1pos/sync-protocol';

/** A counter cart line: a catalog item, with choices and a kitchen note for a menu item (session 25). */
export interface CounterCartLine {
  variantId: string;
  quantity: string;
  choices?: string[] | undefined;
  kitchenNote?: string | undefined;
  /** Who performed or sold it (ADR-0022 §5): a staff member of the snapshot. */
  staffId?: string | undefined;
}

/** A kitchen ticket the till prints itself (offline counter service): one per station. */
export interface LocalKitchenTicket {
  station: { id: string; code: string; name: string };
  items: { name: string; quantity: string; note: string | null; choices: string[] }[];
}

/** Why a counter cart cannot be sold as it is (the cashier fixes the choices). */
export class CounterCartError extends Error {
  constructor(readonly code: 'COUNTER_SERVICE_OFF' | 'NOT_ON_MENU' | 'MODIFIER_NOT_ALLOWED' | 'MODIFIER_COUNT' | 'DUPLICATE_MODIFIER', message: string) {
    super(message);
    this.name = 'CounterCartError';
  }
}

/**
 * The server's counter rule (`expandCounterLines` in the API), on the till: each menu item's priced
 * choices follow it as their own lines (the option's item, at the item's quantity), free choices go to
 * the kitchen only. Priced the same way on both sides, so the till's total is the server's.
 * `parentIndex[i]`: the line a priced choice belongs to. `kitchen`: the tickets, by station (an item
 * goes to the station with its code, else the default one; with neither it is not printed).
 */
export function expandCounterCart(counter: SnapshotCounter | null | undefined, lines: CounterCartLine[]) {
  const out: { variantId: string; quantity: string }[] = [];
  const parentIndex: (number | null)[] = [];
  const tickets = new Map<string, LocalKitchenTicket>();
  for (const [i, line] of lines.entries()) {
    const item = counter?.items.find((m) => m.variantId === line.variantId);
    const asked = Boolean(line.choices?.length || line.kitchenNote);
    if (!counter && asked) throw new CounterCartError('COUNTER_SERVICE_OFF', 'Choices need counter service at this branch');
    if (!item && asked) throw new CounterCartError('NOT_ON_MENU', `Line ${i + 1} is not on the menu`);
    const parentAt = out.length;
    out.push({ variantId: line.variantId, quantity: line.quantity });
    parentIndex.push(null);
    if (!item) continue;
    const ids = line.choices ?? [];
    if (new Set(ids).size !== ids.length) throw new CounterCartError('DUPLICATE_MODIFIER', 'Each choice once per item');
    const chosen = ids.map((id) => {
      for (const g of item.modifierGroups) {
        const o = g.options.find((x) => x.id === id);
        if (o) return { group: g, option: o };
      }
      throw new CounterCartError('MODIFIER_NOT_ALLOWED', `A choice does not belong to ${item.name}`);
    });
    for (const g of item.modifierGroups) {
      const n = chosen.filter((c) => c.group.id === g.id).length;
      if (n < g.minSelect || n > g.maxSelect) throw new CounterCartError('MODIFIER_COUNT', g.minSelect === g.maxSelect ? `Choose ${g.minSelect} for ${g.name}` : `Choose ${g.minSelect} to ${g.maxSelect} for ${g.name}`);
    }
    for (const c of chosen) {
      if (!c.option.variantId) continue;
      out.push({ variantId: c.option.variantId, quantity: line.quantity });
      parentIndex.push(parentAt);
    }
    const station = counter!.stations.find((s) => s.code === item.stationCode) ?? counter!.stations.find((s) => s.isDefault);
    if (!station) continue;
    const ticket = tickets.get(station.id) ?? { station: { id: station.id, code: station.code, name: station.name }, items: [] };
    ticket.items.push({ name: item.name, quantity: line.quantity, note: line.kitchenNote ?? null, choices: chosen.map((c) => c.option.name) });
    tickets.set(station.id, ticket);
  }
  return { lines: out, parentIndex, kitchen: [...tickets.values()] };
}
