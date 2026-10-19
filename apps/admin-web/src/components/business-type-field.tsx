'use client';

import { useT } from '@/i18n/client';
import { BUSINESS_TYPES, type BusinessType } from '@/lib/business-type';

/** The three business types as radio choices, each with what it shows (sign-up and Business settings). */
export function BusinessTypeField({ defaultValue, error }: { defaultValue?: BusinessType; error?: string | undefined }) {
  const { t } = useT();
  return (
    <fieldset className="flex flex-col gap-2.5" aria-describedby={error ? 'businessType-error' : undefined}>
      <legend className="mb-1 text-[0.8125rem] font-semibold">{t('biz.type')}</legend>
      {BUSINESS_TYPES.map((type) => (
        <label key={type} className="flex items-start gap-2">
          <input type="radio" name="businessType" value={type} defaultChecked={defaultValue === type} required className="mt-1" />
          <span>
            {t(`biz.type.${type}`)}
            <span className="block text-[0.8125rem] text-muted">{t(`biz.type.${type}.hint`)}</span>
          </span>
        </label>
      ))}
      {error && (
        <p id="businessType-error" className="text-[0.8125rem] text-red">
          {error}
        </p>
      )}
    </fieldset>
  );
}
