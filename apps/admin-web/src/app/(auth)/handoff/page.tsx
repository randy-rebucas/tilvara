import { AuthFace, AuthStub } from '@/components/auth-note';
import { getT } from '@/i18n/server';
import { pageTitle } from '@/i18n/page-title';
import { HandoffSignIn } from './handoff-sign-in';

export const generateMetadata = pageTitle('handoff');

/**
 * A business's own address picking up a sign-in made on the main one (session 41). The one-time code
 * comes in the fragment, which no server sees; the page sends it to this address's own auth route.
 */
export default async function HandoffPage() {
  const { t } = await getT();
  return (
    <AuthStub denom="blue" face={<AuthFace denom="blue" title={t('handoff.title')} lede={t('handoff.lede')} />}>
      <HandoffSignIn />
    </AuthStub>
  );
}
