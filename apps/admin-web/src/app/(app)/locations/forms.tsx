'use client';

import { Copy } from 'lucide-react';
import { useState } from 'react';
import { Disclosure } from '@/components/disclosure-form';
import { FormError, SelectField, TextField } from '@/components/fields';
import { useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import type { Branch, LegalEntity, Register } from '@/lib/api';

function useForm() {
  const s = useSubmit();
  const general = s.error && s.error.code !== 'VALIDATION_FAILED' ? s.error.message : null;
  return { ...s, general };
}

function Actions({ pending, general, submitLabel, close }: { pending: boolean; general: string | null; submitLabel: string; close: () => void }) {
  const { t } = useT();
  return (
    <div className="col-span-full flex flex-wrap items-center gap-2">
      <button className="btn btn-primary" disabled={pending}>{submitLabel}</button>
      <button type="button" className="btn" onClick={close}>{t('common.cancel')}</button>
      <FormError message={general} />
    </div>
  );
}

// ---------------------------------------------------------------- legal entity
function EntityFields({ close }: { close: () => void }) {
  const { t } = useT();
  const { pending, submit, fieldError, general } = useForm();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const tin = String(f.get('tin') ?? '').trim();
    const r = await submit('POST', '/api/v1/legal-entities', { registeredName: f.get('registeredName'), tin: tin || null, vatStatus: f.get('vatStatus') }, { idempotent: true });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-3" noValidate>
      <TextField label={t('loc.registeredName')} name="registeredName" required autoFocus error={fieldError('registeredName')} />
      <TextField label={`${t('loc.tin')} (${t('common.optional')})`} name="tin" inputMode="numeric" placeholder="123-456-789" hint={t('loc.tinHint')} error={fieldError('tin')} />
      <SelectField label={t('loc.vat')} name="vatStatus" defaultValue="VAT">
        <option value="VAT">{t('loc.vatReg')}</option>
        <option value="NON_VAT">{t('loc.nonVat')}</option>
      </SelectField>
      <Actions pending={pending} general={general} submitLabel={t('common.create')} close={close} />
    </form>
  );
}

export function AddEntityForm() {
  const { t } = useT();
  return <Disclosure label={t('loc.addEntity')}>{(close) => <EntityFields close={close} />}</Disclosure>;
}

const blankToNull = (f: FormData, k: string) => String(f.get(k) ?? '').trim() || null;

/** The names, TIN, address and RDO that receipts print (VAT status is a tax profile, changed apart). */
function EditEntityFields({ close, entity }: { close: () => void; entity: LegalEntity }) {
  const { t } = useT();
  const { pending, submit, fieldError, general } = useForm();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await submit('PATCH', `/api/v1/legal-entities/${entity.id}`, {
      registeredName: String(f.get('registeredName') ?? '').trim(),
      tradeName: blankToNull(f, 'tradeName'),
      tin: blankToNull(f, 'tin'),
      registeredAddress: blankToNull(f, 'registeredAddress'),
      rdoCode: blankToNull(f, 'rdoCode'),
    });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2" noValidate>
      <TextField label={t('loc.registeredName')} name="registeredName" required autoFocus defaultValue={entity.registeredName} error={fieldError('registeredName')} />
      <TextField label={`${t('loc.tradeName')} (${t('common.optional')})`} name="tradeName" defaultValue={entity.tradeName ?? ''} error={fieldError('tradeName')} />
      <TextField label={`${t('loc.tin')} (${t('common.optional')})`} name="tin" inputMode="numeric" placeholder="123-456-789" hint={t('loc.tinHint')} defaultValue={entity.tin ?? ''} error={fieldError('tin')} />
      <TextField label={`${t('loc.rdo')} (${t('common.optional')})`} name="rdoCode" placeholder="049" defaultValue={entity.rdoCode ?? ''} error={fieldError('rdoCode')} />
      <div className="col-span-full">
        <TextField label={`${t('loc.address')} (${t('common.optional')})`} name="registeredAddress" hint={t('loc.addressHint')} defaultValue={entity.registeredAddress ?? ''} error={fieldError('registeredAddress')} />
      </div>
      <Actions pending={pending} general={general} submitLabel={t('common.save')} close={close} />
    </form>
  );
}

export function EditEntityForm({ entity }: { entity: LegalEntity }) {
  const { t } = useT();
  return <Disclosure kind="edit" label={t('loc.editDetails')}>{(close) => <EditEntityFields close={close} entity={entity} />}</Disclosure>;
}

// ---------------------------------------------------------------- branch
function BranchFields({ close, entities }: { close: () => void; entities: LegalEntity[] }) {
  const { t } = useT();
  const { pending, submit, fieldError, general } = useForm();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await submit('POST', '/api/v1/branches', {
      legalEntityId: f.get('legalEntityId'),
      code: f.get('code'),
      name: f.get('name'),
      birBranchCode: f.get('birBranchCode') || '00000',
    }, { idempotent: true });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-4" noValidate>
      <SelectField label={t('loc.entityOne')} name="legalEntityId">
        {entities.map((e) => <option key={e.id} value={e.id}>{e.registeredName}</option>)}
      </SelectField>
      <TextField label={t('loc.branchName')} name="name" required autoFocus error={fieldError('name')} />
      <TextField label={t('loc.branchCode')} name="code" required placeholder="MKT-01" error={fieldError('code')} />
      <TextField label={t('loc.birBranch')} name="birBranchCode" inputMode="numeric" placeholder="00000" error={fieldError('birBranchCode')} />
      <Actions pending={pending} general={general} submitLabel={t('common.create')} close={close} />
    </form>
  );
}

export function AddBranchForm({ entities }: { entities: LegalEntity[] }) {
  const { t } = useT();
  return <Disclosure label={t('loc.addBranch')}>{(close) => <BranchFields close={close} entities={entities} />}</Disclosure>;
}

/** Name, BIR branch code, address (printed on receipts) and time zone (local days for reports). */
function EditBranchFields({ close, branch }: { close: () => void; branch: Branch }) {
  const { t } = useT();
  const { pending, submit, fieldError, general } = useForm();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await submit('PATCH', `/api/v1/branches/${branch.id}`, {
      name: String(f.get('name') ?? '').trim(),
      birBranchCode: String(f.get('birBranchCode') ?? '').trim() || '00000',
      address: blankToNull(f, 'address'),
      timezone: String(f.get('timezone') ?? '').trim(),
    });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3" noValidate>
      <TextField label={t('loc.branchName')} name="name" required autoFocus defaultValue={branch.name} error={fieldError('name')} />
      <TextField label={t('loc.birBranch')} name="birBranchCode" inputMode="numeric" defaultValue={branch.birBranchCode} error={fieldError('birBranchCode')} />
      <TextField label={`${t('loc.address')} (${t('common.optional')})`} name="address" hint={t('loc.addressHint')} defaultValue={branch.address ?? ''} error={fieldError('address')} />
      <TextField label={t('loc.timezone')} name="timezone" defaultValue={branch.timezone} hint={t('loc.timezoneHint')} error={fieldError('timezone')} />
      <Actions pending={pending} general={general} submitLabel={t('common.save')} close={close} />
    </form>
  );
}

export function EditBranchForm({ branch }: { branch: Branch }) {
  const { t } = useT();
  return <Disclosure kind="edit" label={t('loc.edit')}>{(close) => <EditBranchFields close={close} branch={branch} />}</Disclosure>;
}

function EditRegisterFields({ close, register }: { close: () => void; register: Register }) {
  const { t } = useT();
  const { pending, submit, fieldError, general } = useForm();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const r = await submit('PATCH', `/api/v1/registers/${register.id}`, { name: String(new FormData(e.currentTarget).get('name') ?? '').trim() });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3" noValidate>
      <TextField label={t('loc.registerName')} name="name" required autoFocus defaultValue={register.name} error={fieldError('name')} />
      <Actions pending={pending} general={general} submitLabel={t('common.save')} close={close} />
    </form>
  );
}

export function EditRegisterForm({ register }: { register: Register }) {
  const { t } = useT();
  return <Disclosure kind="edit" label={t('loc.edit')}>{(close) => <EditRegisterFields close={close} register={register} />}</Disclosure>;
}

// ---------------------------------------------------------------- register
function RegisterFields({ close, branches }: { close: () => void; branches: Branch[] }) {
  const { t } = useT();
  const { pending, submit, fieldError, general } = useForm();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await submit('POST', '/api/v1/registers', { branchId: f.get('branchId'), code: f.get('code'), name: f.get('name') }, { idempotent: true });
    if (r.ok) close();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-3" noValidate>
      <SelectField label={t('loc.branchOne')} name="branchId">
        {branches.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
      </SelectField>
      <TextField label={t('loc.registerName')} name="name" required autoFocus placeholder="Counter 1" error={fieldError('name')} />
      <TextField label={t('loc.registerCode')} name="code" required placeholder="R1" error={fieldError('code')} />
      <Actions pending={pending} general={general} submitLabel={t('common.create')} close={close} />
    </form>
  );
}

export function AddRegisterForm({ branches }: { branches: Branch[] }) {
  const { t } = useT();
  return <Disclosure label={t('loc.addRegister')}>{(close) => <RegisterFields close={close} branches={branches} />}</Disclosure>;
}

// ---------------------------------------------------------------- terminal
function TerminalFields({ close, registers, onSecret }: { close: () => void; registers: Register[]; onSecret: (s: string) => void }) {
  const { t } = useT();
  const { pending, submit, fieldError, general } = useForm();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    // Not idempotent on purpose: the response carries a one-time secret that must never be stored for replay.
    const r = await submit<{ credential: string }>('POST', '/api/v1/terminals', { registerId: f.get('registerId'), name: f.get('name') });
    if (r.ok) {
      close();
      onSecret(r.data.credential);
    }
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2" noValidate>
      <SelectField label={t('loc.registerOne')} name="registerId">
        {registers.map((r) => <option key={r.id} value={r.id}>{r.code} · {r.name}</option>)}
      </SelectField>
      <TextField label={t('loc.terminalName')} name="name" required autoFocus placeholder="iPad Counter 1" error={fieldError('name')} />
      <Actions pending={pending} general={general} submitLabel={t('loc.pair')} close={close} />
    </form>
  );
}

/** Shows the one-time pairing key exactly once, with a copy action. */
export function PairTerminalForm({ registers }: { registers: Register[] }) {
  const { t } = useT();
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  if (secret) {
    return (
      <div className="w-full rounded-[5px] border border-[#ead3a6] bg-amber-bg p-4" role="status">
        <p className="font-semibold">{t('loc.credentialOnce')}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <code className="break-all rounded-[4px] border border-hair bg-white px-2 py-1 font-[family-name:var(--font-serial)] text-[0.875rem]">{secret}</code>
          <button type="button" className="btn" onClick={async () => { await navigator.clipboard.writeText(secret); setCopied(true); }}>
            <Copy aria-hidden className="size-4" /> {copied ? t('common.copied') : t('common.copy')}
          </button>
          <button type="button" className="btn" onClick={() => { setSecret(null); setCopied(false); }}>{t('common.done')}</button>
        </div>
      </div>
    );
  }
  return <Disclosure label={t('loc.pair')}>{(close) => <TerminalFields close={close} registers={registers} onSecret={setSecret} />}</Disclosure>;
}

/** Small row action (archive / revoke) with confirmation and inline error. */
export function RowAction({ url, label, body, danger = false, confirmText }: { url: string; label: string; body?: unknown; danger?: boolean; confirmText?: string }) {
  const { pending, submit, error } = useSubmit();
  return (
    <span className="inline-flex items-center gap-2">
      {error && <span role="alert" className="text-[0.8125rem] text-red">{error.message}</span>}
      <button
        type="button"
        className={`btn h-8 px-2.5 text-[0.8125rem] ${danger ? 'btn-danger' : ''}`}
        disabled={pending}
        onClick={() => {
          if (!confirmText || window.confirm(confirmText)) void submit('POST', url, body);
        }}
      >
        {label}
      </button>
    </span>
  );
}
