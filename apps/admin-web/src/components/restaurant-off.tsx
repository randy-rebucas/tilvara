import { Callout } from '@/components/note';
import { getT } from '@/i18n/server';

/** In place of a restaurant screen when the business is set up as a retail shop (business type). */
export async function RestaurantOff() {
  const { t } = await getT();
  return (
    <Callout>
      {t('biz.restaurantOff')}{' '}
      <a href="/subscription/business" className="font-semibold underline">
        {t('biz.restaurantOffLink')}
      </a>
    </Callout>
  );
}
