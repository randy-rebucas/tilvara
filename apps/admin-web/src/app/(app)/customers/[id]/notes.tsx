'use client';

import { Pencil, Pin, PinOff, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { FormError } from '@/components/fields';
import { useFormKey, useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { CustomerNote } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

/**
 * Service notes on a client (ADR-0022 §8): colour formulas, preferences, allergies. Pinned first.
 * They can hold health information, so the form says to keep only what the service needs.
 */
export function ServiceNotes({ customerId, notes, canManage }: { customerId: string; notes: CustomerNote[]; canManage: boolean }) {
  const { t } = useT();
  return (
    <div className="grid gap-3">
      {canManage && <NoteForm customerId={customerId} />}
      {notes.length === 0 ? (
        <p className="text-[0.9375rem] text-muted">{t('cnote.empty')}</p>
      ) : (
        <ul className="grid gap-2">
          {notes.map((n) => <NoteRow key={n.id} customerId={customerId} note={n} canManage={canManage} />)}
        </ul>
      )}
    </div>
  );
}

function NoteForm({ customerId, note, close }: { customerId: string; note?: CustomerNote; close?: () => void }) {
  const { t } = useT();
  const key = useFormKey();
  const { pending, submit, error, fieldError } = useSubmit();
  const [body, setBody] = useState(note?.body ?? '');
  const [pinned, setPinned] = useState(note?.pinned ?? false);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const r = note
      ? await submit('PATCH', `/api/v1/customers/${customerId}/notes/${note.id}`, { body: body.trim(), pinned })
      : await submit('POST', `/api/v1/customers/${customerId}/notes`, { body: body.trim(), pinned }, { idempotencyKey: key });
    if (r.ok) {
      if (close) close();
      else {
        setBody('');
        setPinned(false);
      }
    }
  }
  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-2 rounded-[5px] border border-hair bg-white p-3">
      <label htmlFor={note ? `note-${note.id}` : 'note-new'} className="text-[0.8125rem] font-semibold">{note ? t('cnote.edit') : t('cnote.add')}</label>
      <textarea
        id={note ? `note-${note.id}` : 'note-new'}
        name="noteBody"
        className="input min-h-20 py-2"
        maxLength={2000}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={t('cnote.placeholder')}
        aria-invalid={fieldError('body') ? true : undefined}
        aria-describedby="note-privacy"
      />
      <p id="note-privacy" className="text-[0.8125rem] text-muted">{t('cnote.privacy')}</p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[0.9375rem]">
          <input type="checkbox" name="pinned" checked={pinned} onChange={(e) => setPinned(e.target.checked)} className="size-4 accent-[var(--color-blue)]" /> {t('cnote.pin')}
        </label>
        <button className="btn btn-primary" disabled={pending || !body.trim()}>{note ? t('common.save') : t('cnote.save')}</button>
        {close && <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>}
        <FormError message={fieldError('body') ?? (error && error.code !== 'VALIDATION_FAILED' ? error.message : null)} />
      </div>
    </form>
  );
}

function NoteRow({ customerId, note, canManage }: { customerId: string; note: CustomerNote; canManage: boolean }) {
  const { t, lang } = useT();
  const [editing, setEditing] = useState(false);
  const { pending, submit, error } = useSubmit();
  if (editing) return <li><NoteForm customerId={customerId} note={note} close={() => setEditing(false)} /></li>;
  return (
    <li className="rounded-[5px] border border-hair-soft bg-white px-3 py-2" data-note={note.id}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 whitespace-pre-wrap break-words">
          {note.pinned && <span className="tag mr-2 border-blue/40! text-blue!">{t('cnote.pinned')}</span>}
          {note.body}
        </p>
        {canManage && (
          <div className="flex shrink-0 gap-1">
            <button type="button" className="grid size-8 place-items-center rounded-[4px] text-muted hover:bg-paper-deep hover:text-ink" title={t('cnote.edit')} onClick={() => setEditing(true)}>
              <Pencil aria-hidden className="size-4" /><span className="sr-only">{t('cnote.edit')}</span>
            </button>
            <button
              type="button"
              className="grid size-8 place-items-center rounded-[4px] text-muted hover:bg-paper-deep hover:text-ink"
              title={note.pinned ? t('cnote.unpin') : t('cnote.pin')}
              disabled={pending}
              onClick={() => void submit('PATCH', `/api/v1/customers/${customerId}/notes/${note.id}`, { pinned: !note.pinned })}
            >
              {note.pinned ? <PinOff aria-hidden className="size-4" /> : <Pin aria-hidden className="size-4" />}
              <span className="sr-only">{note.pinned ? t('cnote.unpin') : t('cnote.pin')}</span>
            </button>
            <button
              type="button"
              className="grid size-8 place-items-center rounded-[4px] text-muted hover:bg-[#fbeceb] hover:text-red"
              title={t('cnote.delete')}
              disabled={pending}
              onClick={() => {
                if (window.confirm(t('cnote.deleteConfirm'))) void submit('DELETE', `/api/v1/customers/${customerId}/notes/${note.id}`);
              }}
            >
              <Trash2 aria-hidden className="size-4" /><span className="sr-only">{t('cnote.delete')}</span>
            </button>
          </div>
        )}
      </div>
      <p className="mt-1 text-[0.8125rem] text-muted">{t('cnote.by', { name: note.updatedByName ?? '—', at: formatDateTime(note.updatedAt, lang) })}</p>
      <FormError message={error?.message} />
    </li>
  );
}
