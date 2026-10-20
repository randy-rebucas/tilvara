import type { ReactNode } from 'react';
import { Note, type Denom } from './ui';

/**
 * The counter's sign-in and set-up screens are printed like the admin's (DESIGN.md, Auth Face):
 * a face with an engraved guilloche rosette, the headline and microprint, a tear line, and the
 * form on the stub.
 */

const STRIPE: Record<Denom, string> = {
  blue: 'var(--color-blue)',
  orange: 'var(--color-orange-soft)',
  violet: 'var(--color-violet)',
  green: 'var(--color-green)',
};

/** One guilloche band: a circle of radius R modulated by `petals` waves of amplitude A. */
function band(R: number, A: number, petals: number, steps: number) {
  let d = '';
  for (let i = 0; i < steps; i++) {
    const th = (i / steps) * Math.PI * 2;
    const r = R + A * Math.sin(petals * th);
    d += `${i ? 'L' : 'M'}${(r * Math.cos(th)).toFixed(1)} ${(r * Math.sin(th)).toFixed(1)}`;
  }
  return `${d}Z`;
}

// Each band is drawn once and repeated, rotated a fraction of one wave, so the copies weave a lattice.
const BANDS = [
  { id: 'gl-a', R: 178, A: 11, petals: 30, copies: 5, opacity: 0.2 },
  { id: 'gl-b', R: 138, A: 18, petals: 18, copies: 6, opacity: 0.26 },
  { id: 'gl-c', R: 88, A: 24, petals: 12, copies: 6, opacity: 0.2 },
  { id: 'gl-d', R: 40, A: 16, petals: 8, copies: 4, opacity: 0.28 },
].map((b) => ({ ...b, d: band(b.R, b.A, b.petals, b.petals * 20), step: 360 / b.petals / b.copies }));

function Rosette({ color }: { color: string }) {
  return (
    <svg
      viewBox="-200 -200 400 400"
      aria-hidden
      focusable="false"
      className="rosette pointer-events-none absolute -bottom-[125px] -right-[95px] size-[250px] sm:-bottom-[150px] sm:-right-[110px] sm:size-[310px]"
      style={{ color }}
      fill="none"
      stroke="currentColor"
      strokeWidth={0.7}
    >
      <defs>
        {BANDS.map((b) => <path key={b.id} id={b.id} d={b.d} pathLength={1} />)}
      </defs>
      {BANDS.map((b, i) => (
        <g key={b.id} strokeOpacity={b.opacity} style={{ animationDelay: `${i * 90}ms` }}>
          {Array.from({ length: b.copies }, (_, k) => (
            <use key={k} href={`#${b.id}`} transform={`rotate(${(k * b.step).toFixed(2)})`} />
          ))}
        </g>
      ))}
    </svg>
  );
}

export function AuthFace({ denom, title, lede, foot }: { denom: Denom; title: string; lede?: ReactNode; foot?: ReactNode }) {
  return (
    <div className="relative flex min-w-0 flex-col overflow-hidden px-6 pb-5 pt-7 sm:px-9 sm:pb-6 sm:pt-10">
      <Rosette color={STRIPE[denom]} />
      <h1 className="max-w-[15ch] text-[2.25rem] font-bold leading-[1.1] tracking-[-0.015em]">{title}</h1>
      {lede && <p className="mt-3 max-w-[44ch] text-muted">{lede}</p>}
      <div className="mt-auto pt-10">
        {foot && <div className="mb-6">{foot}</div>}
        <p aria-hidden className="microprint">{'Tilvara · '.repeat(48)}</p>
      </div>
    </div>
  );
}

/** A single task: the face, a tear line, and the form on the stub. */
export function AuthStub({ denom, title, lede, foot, children }: { denom: Denom; title: string; lede?: ReactNode; foot?: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-[1040px] px-4 py-8 sm:px-6 sm:py-12">
      <Note denom={denom} className="reveal mx-auto grid max-w-[600px] grid-cols-1 overflow-hidden lg:min-h-[460px] lg:max-w-none lg:grid-cols-[minmax(0,1fr)_auto_420px]">
        <AuthFace denom={denom} title={title} lede={lede} foot={foot} />
        <div aria-hidden className="perf" />
        <div className="min-w-0 px-6 pb-7 pt-6 sm:px-8 sm:pb-9 lg:py-10 lg:pl-8 lg:pr-11">{children}</div>
      </Note>
    </div>
  );
}
