import { useEffect, useState } from 'react';
import type { ExchangeStart } from './components/CounterTools';
import { BusinessPicker, SignIn } from './components/Auth';
import { CloseShift } from './components/CloseShift';
import { History } from './components/History';
import { RegisterPicker, type Shift } from './components/Registers';
import { Sell } from './components/Sell';
import { Shell } from './components/Shell';
import { TillSetup } from './components/Till';
import { useT } from './i18n';
import { tabsFor, type Tab } from './lib/tabs';
import { useBrand } from './lib/brand';
import { useTill } from './lib/till';
import { api, session, signOut } from './lib/api';
import type { Me } from './types';

type Stage =
  | { name: 'signin' }
  | { name: 'business'; me: Me }
  | { name: 'register'; me: Me }
  | { name: 'counter'; me: Me; shift: Shift };

export function App() {
  const till = useTill();
  const [skippedSetup, setSkippedSetup] = useState(false);
  if (till.mode === 'loading') return <Shell>{null}</Shell>;
  if (till.mode === 'unconfigured' && !skippedSetup) {
    return (
      <Shell help={{ topic: 'till' }}>
        <TillSetup onSkip={() => setSkippedSetup(true)} />
      </Shell>
    );
  }
  return <Counter />;
}

function Counter() {
  const { t } = useT();
  const [stage, setStage] = useState<Stage>({ name: 'signin' });
  const [tab, setTab] = useState<Tab>('sell');
  /** An exchange started from This shift, finished on Sell (session 20). */
  const [exchange, setExchange] = useState<ExchangeStart | null>(null);
  const brand = useBrand();

  useEffect(() => session.onSignedOut(() => {
    setStage({ name: 'signin' });
    brand.clear();
  }), [brand]);

  async function afterSignIn() {
    const me = await api<Me>('GET', '/v1/me');
    setStage(me.activeTenant ? { name: 'register', me } : { name: 'business', me });
    // A till in a browser learns the business's look once it knows the business (a desktop till has it from its snapshot).
    if (me.activeTenant) void brand.loadFromServer();
  }

  async function leave() {
    await signOut();
    brand.clear();
    setStage({ name: 'signin' });
    setTab('sell');
  }

  if (stage.name === 'signin') {
    return (
      <Shell backdrop>
        <SignIn onDone={() => void afterSignIn()} />
      </Shell>
    );
  }
  if (stage.name === 'business') {
    return (
      <Shell onSignOut={leave} backdrop>
        <BusinessPicker me={stage.me} onDone={() => void afterSignIn()} />
      </Shell>
    );
  }
  if (stage.name === 'register') {
    return (
      <Shell onSignOut={leave} help={{ topic: 'start' }} backdrop>
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
  const permissions = me.activeTenant?.permissions ?? [];
  const extensions = me.activeTenant?.extensions ?? [];
  const tabs = tabsFor(extensions);
  return (
    <Shell
      onSignOut={leave}
      help={{ topic: tabs.find((x) => x.key === tab)?.topic ?? 'sell', extensions }}
      context={
        <span className="serial text-[0.8125rem]">
          {shift.branch.name} · <span className="text-white">{shift.register.code}</span> · {me.user.displayName}
        </span>
      }
      nav={
        <nav className="flex gap-1" aria-label={t('a11y.counterNav')} data-testid="counter-nav">
          {tabs.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              aria-current={tab === key ? 'page' : undefined}
              onClick={() => setTab(key)}
              className={`h-10 whitespace-nowrap rounded px-3 text-[0.9375rem] ${tab === key ? 'bg-white/20 font-semibold text-white' : 'text-blue-ink hover:bg-white/10'}`}
            >
              {t(label)}
            </button>
          ))}
        </nav>
      }
    >
      {/* Kept mounted: a cart and its authorized card/QR payments survive a look at the shift history. */}
      <div hidden={tab !== 'sell'}>
        <Sell shift={shift} cashierUserId={me.userId} active={tab === 'sell'} permissions={permissions} exchange={exchange} onExchangeEnd={() => setExchange(null)} />
      </div>
      {tab === 'history' && <History shift={shift} permissions={permissions} onExchange={(x) => { setExchange(x); setTab('sell'); }} />}
      {tab === 'close' && <CloseShift shift={shift} onClosed={() => setStage({ name: 'register', me })} />}
    </Shell>
  );
}
