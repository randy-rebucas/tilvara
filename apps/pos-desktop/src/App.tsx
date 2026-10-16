import { useEffect, useState } from 'react';
import { BusinessPicker, SignIn } from './components/Auth';
import { CloseShift } from './components/CloseShift';
import { History } from './components/History';
import { RegisterPicker, type Shift } from './components/Registers';
import { Sell } from './components/Sell';
import { Shell } from './components/Shell';
import { useT } from './i18n';
import { api, session, signOut } from './lib/api';
import type { Me } from './types';

type Stage = { name: 'signin' } | { name: 'business'; me: Me } | { name: 'register'; me: Me } | { name: 'counter'; me: Me; shift: Shift };
type Tab = 'sell' | 'history' | 'close';

export function App() {
  const { t } = useT();
  const [stage, setStage] = useState<Stage>({ name: 'signin' });
  const [tab, setTab] = useState<Tab>('sell');

  useEffect(() => session.onSignedOut(() => setStage({ name: 'signin' })), []);

  async function afterSignIn() {
    const me = await api<Me>('GET', '/v1/me');
    setStage(me.activeTenant ? { name: 'register', me } : { name: 'business', me });
  }

  async function leave() {
    await signOut();
    setStage({ name: 'signin' });
    setTab('sell');
  }

  if (stage.name === 'signin') {
    return (
      <Shell>
        <SignIn onDone={() => void afterSignIn()} />
      </Shell>
    );
  }
  if (stage.name === 'business') {
    return (
      <Shell onSignOut={leave}>
        <BusinessPicker me={stage.me} onDone={() => void afterSignIn()} />
      </Shell>
    );
  }
  if (stage.name === 'register') {
    return (
      <Shell onSignOut={leave}>
        <RegisterPicker
          onReady={(shift) => {
            // A new or resumed shift always starts at the counter.
            setTab('sell');
            setStage({ name: 'counter', me: stage.me, shift });
          }}
        />
      </Shell>
    );
  }

  const { me, shift } = stage;
  const tabs: [Tab, string][] = [
    ['sell', t('nav.sell')],
    ['history', t('nav.history')],
    ['close', t('nav.close')],
  ];
  return (
    <Shell
      onSignOut={leave}
      context={
        <span className="serial text-[0.8125rem]">
          {shift.branch.name} · <span className="text-white">{shift.register.code}</span> · {me.user.displayName}
        </span>
      }
      nav={
        <nav className="flex gap-1" aria-label="Counter">
          {tabs.map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-current={tab === key ? 'page' : undefined}
              onClick={() => setTab(key)}
              className={`h-10 whitespace-nowrap rounded px-3 text-[0.9375rem] ${tab === key ? 'bg-white/20 font-semibold text-white' : 'text-blue-ink hover:bg-white/10'}`}
            >
              {label}
            </button>
          ))}
        </nav>
      }
    >
      {/* Kept mounted: a cart and its authorized card/QR payments survive a look at the shift history. */}
      <div hidden={tab !== 'sell'}>
        <Sell shift={shift} active={tab === 'sell'} />
      </div>
      {tab === 'history' && <History shift={shift} permissions={me.activeTenant?.permissions ?? []} />}
      {tab === 'close' && <CloseShift shift={shift} onClosed={() => setStage({ name: 'register', me })} />}
    </Shell>
  );
}
