import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { api, ApiFailure } from '../lib/api';
import { useTill } from '../lib/till';
import type { BranchMenu, MenuItem } from '../types';
import type { Shift } from './Registers';
import { Field, Money, Note } from './ui';

/** A modifier group as the screens show it: from what the branch serves, or the till's snapshot. */
export interface ChoiceGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  options: { id: string; name: string; variantId: string | null; price?: string | null; available?: boolean }[];
}

/** A menu item the counter sells with choices (counter service, session 25). */
export interface CounterItem {
  variantId: string;
  name: string;
  available: boolean;
  soldOut: boolean;
  modifierGroups: ChoiceGroup[];
}

/** The takeaway menu the counter sells from, when the branch has counter service on. */
export interface CounterMenu {
  menuVersionId: string;
  items: Map<string, CounterItem>;
}

/** A pick-one group swaps the choice; otherwise a choice toggles, up to the group's maximum. */
export function toggleChoice(groups: ChoiceGroup[], chosen: string[], groupId: string, optionId: string): string[] {
  const group = groups.find((g) => g.id === groupId)!;
  const inGroup = chosen.filter((id) => group.options.some((o) => o.id === id));
  if (chosen.includes(optionId)) return chosen.filter((id) => id !== optionId);
  if (group.maxSelect === 1) return [...chosen.filter((id) => !inGroup.includes(id)), optionId];
  if (inGroup.length >= group.maxSelect) return chosen;
  return [...chosen, optionId];
}

/** Groups still short of their minimum (e.g. doneness not chosen yet). */
export const missingGroups = (groups: ChoiceGroup[], chosen: string[]) =>
  groups.filter((g) => chosen.filter((id) => g.options.some((o) => o.id === id)).length < g.minSelect);

/** The choices of an item's groups as buttons, with each group's rule beside its name. */
export function ChoiceGroups({ groups, chosen, onChange }: { groups: ChoiceGroup[]; chosen: string[]; onChange: (ids: string[]) => void }) {
  const { t } = useT();
  return (
    <>
      {groups.map((g) => (
        <fieldset key={g.id} className="grid gap-2">
          <legend className="mb-1 text-[0.875rem] font-semibold">
            {g.name}{' '}
            <span className="font-normal text-muted">
              {g.minSelect > 0 ? t(g.maxSelect === 1 ? 'order.pickOne' : 'order.pickAtLeast', { n: String(g.minSelect) }) : t('order.upTo', { n: String(g.maxSelect) })}
            </span>
          </legend>
          <div className="flex flex-wrap gap-2">
            {g.options.map((o) => (
              <button key={o.id} type="button" className="btn btn-sm" disabled={o.available === false} aria-pressed={chosen.includes(o.id)} onClick={() => onChange(toggleChoice(groups, chosen, g.id, o.id))}>
                {o.name}
                {o.price && o.price !== '0' && <span className="money text-muted">+<Money value={o.price} /></span>}
              </button>
            ))}
          </div>
        </fieldset>
      ))}
    </>
  );
}

/**
 * Choices for a counter item (counter service): its groups, a note for the kitchen, and Add (or Save
 * when changing a line already in the cart). Add stays off until every required group has its choice.
 */
export function CounterChoicesPanel({ item, initial, initialNote, editing, onApply, onCancel }: {
  item: CounterItem;
  initial?: string[];
  initialNote?: string;
  editing?: boolean;
  onApply: (choices: string[], note: string) => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const [chosen, setChosen] = useState<string[]>(initial ?? []);
  const [note, setNote] = useState(initialNote ?? '');
  const missing = missingGroups(item.modifierGroups, chosen);
  return (
    <Note denom="blue" className="no-print grid gap-4 p-5" aria-label={t('counter.choicesFor', { name: item.name })}>
      <h2 className="text-[1.125rem] font-semibold">{item.name}</h2>
      <ChoiceGroups groups={item.modifierGroups} chosen={chosen} onChange={setChosen} />
      <Field id="kitchenNote" label={t('counter.kitchenNote')} hint={t('counter.kitchenNoteHint')} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
      {missing.length > 0 && <p className="text-[0.875rem] text-muted">{t('order.chooseFirst', { groups: missing.map((g) => g.name).join(', ') })}</p>}
      <div className="flex gap-2">
        <button type="button" className="btn btn-primary flex-1" disabled={missing.length > 0} onClick={() => onApply(chosen, note.trim())}>
          {editing ? t('order.saveChanges') : t('counter.addToCart')}
        </button>
        <button type="button" className="btn" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </Note>
  );
}

const fromServed = (items: MenuItem[]): Map<string, CounterItem> =>
  new Map(items.map((i) => [i.variantId, { variantId: i.variantId, name: i.name, available: i.available, soldOut: i.soldOut, modifierGroups: i.modifierGroups }]));

/**
 * The counter-service menu for this shift's branch: online, what the branch serves for takeaway (if
 * counter service is on); offline on the desktop till, the menu in its snapshot. Null when the branch
 * sells over the counter as a shop. Re-read every two minutes and when the till goes on or offline.
 */
export function useCounterMenu(shift: Shift, offline: boolean): CounterMenu | null {
  const till = useTill();
  const [menu, setMenu] = useState<CounterMenu | null>(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        if (offline) {
          const c = await till.engine?.counterMenu();
          if (!live) return;
          setMenu(c ? {
            menuVersionId: c.menuVersionId,
            items: new Map(c.items.map((i) => [i.variantId, { variantId: i.variantId, name: i.name, available: true, soldOut: false, modifierGroups: i.modifierGroups }])),
          } : null);
          return;
        }
        const served = await api<BranchMenu & { counterService?: boolean; menu: (BranchMenu['menu'] & { menuVersionId: string }) | null }>('GET', `/v1/branches/${shift.branch.id}/menu?orderType=TAKEAWAY`);
        if (!live) return;
        setMenu(served.counterService && served.menu ? { menuVersionId: served.menu.menuVersionId, items: fromServed(served.menu.sections.flatMap((s) => s.items)) } : null);
      } catch (err) {
        // Not on the plan, not a restaurant, or no access: the counter sells as a shop. A lost answer keeps what it had.
        if (live && err instanceof ApiFailure && err.error.status >= 400 && err.error.status < 500) setMenu(null);
      }
    };
    void load();
    const p = setInterval(() => void load(), 120_000);
    return () => {
      live = false;
      clearInterval(p);
    };
  }, [shift.branch.id, offline, till.engine]);
  return menu;
}
