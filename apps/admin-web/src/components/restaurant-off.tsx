import { Callout } from '@/components/note';
import { getT } from '@/i18n/server';

/**
 * In place of a restaurant screen when the business is set up as a shop (RETAIL or GROCERY) or a salon (SALON), or
 * its plan does not include restaurant service.
 */
export async function RestaurantOff({ reason = 'type' }: { reason?: 'type' | 'plan' }) {
  const { t } = await getT();
  return reason === 'plan' ? (
    <Callout>
      {t('biz.restaurantNotOnPlan')}{' '}
      <a href="/subscription" className="font-semibold underline">
        {t('biz.restaurantNotOnPlanLink')}
      </a>
    </Callout>
  ) : (
    <Callout>
      {t('biz.restaurantOff')}{' '}
      <a href="/subscription/business" className="font-semibold underline">
        {t('biz.restaurantOffLink')}
      </a>
    </Callout>
  );
}
