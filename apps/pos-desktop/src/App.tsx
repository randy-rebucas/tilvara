import { useEffect, useState } from 'react';
import type { ExchangeStart } from './components/CounterTools';
import { BusinessPicker, SignIn } from './components/Auth';
import { CloseShift } from './components/CloseShift';
import { History } from './components/History';
import { KitchenBoard, KitchenPicker, type KitchenPlace } from './components/Kitchen';
import { RegisterPicker, type Shift } from './components/Registers';
import { Sell } from './components/Sell';
import { Shell } from './components/Shell';
import { FloorPicker, Tables } from './components/Tables';
import { TillSetup } from './components/Till';
import { useT } from './i18n';
import type { GuideTopic } from './lib/guide';
import { useTill } from './lib/till';
import { api, session, signOut } from './lib/api';
import { servesTables, type Me } from './types';

type Stage =
  | { name: 'signin' }
  | { name: 'business'; me: Me }
  | { name: 'register'; me: Me }
  | { name: 'counter'; me: Me; shift: Shift }
  | { name: 'kitchen-pick'; me: Me }
  | { name: 'kitchen'; me: Me; place: KitchenPlace }
  | { name: 'floor-pick'; me: Me }
  | { name: 'floor'; me: Me; branch: Shift['branch'] };
type Tab = 'sell' | 'tables' | 'history' | 'close';
/** The part of the user guide each counter tab opens. */
const TAB_TOPIC: Record<Tab, GuideTopic> = { sell: 'sell', tables: 'tables', history: 'shift', close: 'close' };

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
    // A retail business has no restaurant service (business type), whatever the person may do.
    const kitchen = servesTables(stage.me) && stage.me.activeTenant?.permissions.includes('kitchen.operate');
    const floor = servesTables(stage.me) && stage.me.activeTenant?.permissions.includes('restaurant.orders');
    return (
      <Shell onSignOut={leave} help={{ topic: 'start', restaurant: servesTables(stage.me) }}>
        <RegisterPicker
          onReady={(shift) => {
            // A new or resumed shift always starts at the counter.
            setTab('sell');
            setStage({ name: 'counter', me: stage.me, shift });
          }}
          onKitchen={kitchen ? () => setStage({ name: 'kitchen-pick', me: stage.me }) : undefined}
          onFloor={floor ? () => setStage({ name: 'floor-pick', me: stage.me }) : undefined}
        />
      </Shell>
    );
  }
  if (stage.name === 'kitchen-pick') {
    return (
      <Shell onSignOut={leave} help={{ topic: 'kitchen' }}>
        <KitchenPicker onReady={(place) => setStage({ name: 'kitchen', me: stage.me, place })} onBack={() => setStage({ name: 'register', me: stage.me })} />
      </Shell>
    );
  }
  if (stage.name === 'kitchen') {
    const { place } = stage;
    return (
      <Shell
        onSignOut={leave}
        help={{ topic: 'kitchen' }}
        context={
          <span className="serial text-[0.8125rem]">
            {t('kds.entryTitle')} · {place.branch.name} · <span className="text-white">{place.station?.code ?? t('kds.allStations')}</span>
          </span>
        }
        nav={
          <button type="button" className="h-10 whitespace-nowrap rounded px-3 text-[0.9375rem] text-blue-ink hover:bg-white/10" onClick={() => setStage({ name: 'kitchen-pick', me: stage.me })}>
            {t('kds.changeStation')}
          </button>
        }
      >
        <KitchenBoard key={`${place.branch.id}:${place.station?.id ?? 'all'}`} place={place} />
      </Shell>
    );
  }

  if (stage.name === 'floor-pick') {
    return (
      <Shell onSignOut={leave} help={{ topic: 'tables' }}>
        <FloorPicker onReady={(branch) => setStage({ name: 'floor', me: stage.me, branch })} onBack={() => setStage({ name: 'register', me: stage.me })} />
      </Shell>
    );
  }
  if (stage.name === 'floor') {
    const { branch, me: who } = stage;
    return (
      <Shell
        onSignOut={leave}
        help={{ topic: 'tables' }}
        context={
          <span className="serial text-[0.8125rem]">
            {t('floor.entryTitle')} · {branch.name} · <span className="text-white">{who.user.displayName}</span>
          </span>
        }
        nav={
          <button type="button" className="h-10 whitespace-nowrap rounded px-3 text-[0.9375rem] text-blue-ink hover:bg-white/10" onClick={() => setStage({ name: 'register', me: who })}>
            {t('floor.toRegisters')}
          </button>
        }
      >
        <Tables place={{ branch, shift: null }} permissions={who.activeTenant?.permissions ?? []} active />
      </Shell>
    );
  }

  const { me, shift } = stage;
  const permissions = me.activeTenant?.permissions ?? [];
  const tableService = servesTables(me) && permissions.includes('restaurant.orders');
  const tabs: [Tab, string][] = [
    ['sell', t('nav.sell')],
    ...(tableService ? ([['tables', t('nav.tables')]] as [Tab, string][]) : []),
    ['history', t('nav.history')],
    ['close', t('nav.close')],
  ];
  return (
    <Shell
      onSignOut={leave}
      help={{ topic: TAB_TOPIC[tab], restaurant: servesTables(me) }}
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
        <Sell shift={shift} cashierUserId={me.userId} active={tab === 'sell'} permissions={permissions} exchange={exchange} onExchangeEnd={() => setExchange(null)} />
      </div>
      {/* Also kept mounted: a check whose card payment was taken must not lose it on a tab switch. */}
      {tableService && (
        <div hidden={tab !== 'tables'}>
          <Tables place={{ branch: shift.branch, shift }} permissions={permissions} active={tab === 'tables'} />
        </div>
      )}
      {tab === 'history' && <History shift={shift} permissions={permissions} onExchange={(x) => { setExchange(x); setTab('sell'); }} />}
      {tab === 'close' && <CloseShift shift={shift} canOverride={permissions.includes('cash.reconcile')} onClosed={() => setStage({ name: 'register', me })} />}
    </Shell>
  );
}
