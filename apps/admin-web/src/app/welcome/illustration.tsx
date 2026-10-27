import type { CSSProperties } from 'react';

/** Landing page drawings: authored SVG in the Salapi colours (no photos or screenshots exist yet). */

const C = {
  ink: '#1d1f24',
  body: '#2b2e35',
  body2: '#3a3d45',
  muted: '#555962',
  hair: '#cfc9b8',
  hairSoft: '#e7e1d1',
  paper: '#f4f1e8',
  paperDeep: '#ebe6d6',
  blue: '#2a5da8',
  blueInk: '#dce6f5',
  violet: '#6b4c9a',
  orange: '#e07b1f',
  green: '#1e5b3a',
  gold: '#d4a227',
};

const i = (n: number) => ({ '--i': n }) as CSSProperties;

/** A guilloche watermark: modulated rings, each repeated a fraction of a wave so the copies weave. */
export function Guilloche({ className = '', color = C.blue, opacity = 0.14 }: { className?: string; color?: string; opacity?: number }) {
  const rings = [
    { R: 182, A: 10, petals: 32, copies: 4 },
    { R: 146, A: 16, petals: 22, copies: 5 },
    { R: 104, A: 20, petals: 14, copies: 5 },
    { R: 60, A: 14, petals: 9, copies: 4 },
  ];
  return (
    <svg viewBox="-200 -200 400 400" aria-hidden focusable="false" className={`pointer-events-none ${className}`} fill="none" stroke={color} strokeWidth={0.6} strokeOpacity={opacity}>
      {rings.flatMap(({ R, A, petals, copies }) => {
        const steps = petals * 16;
        let d = '';
        for (let s = 0; s < steps; s++) {
          const th = (s / steps) * Math.PI * 2;
          const r = R + A * Math.sin(petals * th);
          d += `${s ? 'L' : 'M'}${(r * Math.cos(th)).toFixed(1)} ${(r * Math.sin(th)).toFixed(1)}`;
        }
        return Array.from({ length: copies }, (_, k) => <path key={`${R}-${k}`} d={`${d}Z`} transform={`rotate(${((k * 360) / petals / copies).toFixed(2)})`} />);
      })}
    </svg>
  );
}

/** The counter: a till on a cash drawer, a scanner and a receipt printer, beside a laptop with the back office. */
export function CounterScene({ label }: { label: string }) {
  const bars = [34, 46, 40, 58, 50, 66, 54, 72];
  return (
    <svg viewBox="0 0 600 420" role="img" aria-label={label} className="h-auto w-full">
      <defs>
        <pattern id="land-lines" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(25)">
          <line x1="0" y1="0" x2="0" y2="8" stroke={C.ink} strokeOpacity="0.035" strokeWidth="1.5" />
        </pattern>
        <clipPath id="land-slot">
          <rect x="190" y="180" width="120" height="122" />
        </clipPath>
        <linearGradient id="land-screen" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.16" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Backdrop */}
      <rect x="14" y="28" width="572" height="352" rx="22" fill={C.paperDeep} />
      <rect x="14" y="28" width="572" height="352" rx="22" fill="url(#land-lines)" />
      <circle cx="470" cy="70" r="70" fill={C.blue} fillOpacity="0.06" />
      <circle cx="96" cy="320" r="40" fill={C.gold} fillOpacity="0.08" />

      {/* Sync arc: the till's sales travel to the back office. */}
      <path d="M232 74 C 280 18, 380 18, 432 112" fill="none" stroke={C.blue} strokeOpacity="0.35" strokeWidth="2" strokeDasharray="3 6" strokeLinecap="round" />
      <path className="land-trace" d="M432 112 C 380 18, 280 18, 232 74" pathLength={100} fill="none" stroke={C.blue} strokeWidth="3" strokeLinecap="round" strokeDasharray="10 90" />
      <g transform="translate(330 38)">
        <circle r="17" fill="#fff" stroke={C.hair} />
        <path d="M-7 0.5 L-2 5.5 L8 -5" fill="none" stroke={C.blue} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </g>

      {/* Laptop: the back office */}
      <g transform="translate(0 -30)">
      <rect x="36" y="104" width="262" height="168" rx="10" fill={C.body} />
      <rect x="46" y="114" width="242" height="148" rx="3" fill={C.paper} />
      <rect x="46" y="114" width="242" height="17" fill={C.blue} />
      <rect x="54" y="120" width="28" height="5" rx="1.5" fill="#fff" fillOpacity="0.95" />
      {[96, 116, 136, 156].map((x) => (
        <rect key={x} x={x} y="121" width="14" height="3.5" rx="1.5" fill={C.blueInk} fillOpacity="0.75" />
      ))}
      {[C.violet, C.orange, C.blue, C.green].map((stripe, n) => (
        <g key={stripe} transform={`translate(${54 + n * 57} 138)`}>
          <rect width="52" height="32" rx="2.5" fill="#fff" stroke={C.hair} strokeWidth="0.8" />
          <rect x="48" y="0" width="4" height="32" rx="1" fill={stripe} />
          <rect x="6" y="7" width="20" height="3" rx="1.5" fill={C.hair} />
          <rect x="6" y="15" width="30" height="8" rx="1.5" fill={C.ink} fillOpacity="0.8" />
        </g>
      ))}
      <rect x="54" y="176" width="166" height="78" rx="2.5" fill="#fff" stroke={C.hair} strokeWidth="0.8" />
      <rect x="62" y="183" width="40" height="3.5" rx="1.5" fill={C.hair} />
      {bars.map((h, n) => (
        <rect key={n} className="land-bar" style={i(n)} x={66 + n * 18} y={248 - h * 0.78} width="11" height={h * 0.78} rx="1.5" fill={C.blue} fillOpacity={n === bars.length - 1 ? 1 : 0.55} />
      ))}
      <rect x="226" y="176" width="54" height="78" rx="2.5" fill="#fff" stroke={C.hair} strokeWidth="0.8" />
      {[0, 1, 2, 3, 4].map((n) => (
        <g key={n}>
          <rect x="232" y={186 + n * 13} width="24" height="3" rx="1.5" fill={C.hair} />
          <rect x="262" y={186 + n * 13} width="12" height="3" rx="1.5" fill={C.muted} fillOpacity="0.7" />
        </g>
      ))}
      <rect x="36" y="104" width="262" height="168" rx="10" fill="url(#land-screen)" />
      <path d="M18 272 H316 L304 288 H30 Z" fill={C.body2} />
      <rect x="148" y="272" width="38" height="4" rx="2" fill={C.muted} />

      </g>

      {/* Receipt printer, the receipt rising out of its slot */}
      <g clipPath="url(#land-slot)">
        <g className="land-paper">
          <path d="M222 262 l5 -5 l5 5 l5 -5 l5 5 l5 -5 l5 5 l5 -5 l5 5 l5 -5 l5 5 l5 -5 V304 H222 Z" fill="#fff" stroke={C.hair} strokeWidth="0.8" />
          <rect x="230" y="268" width="26" height="3" rx="1.5" fill={C.ink} fillOpacity="0.75" />
          {[275, 281, 287].map((y) => (
            <g key={y}>
              <rect x="230" y={y} width="22" height="2.5" rx="1.2" fill={C.hair} />
              <rect x="262" y={y} width="12" height="2.5" rx="1.2" fill={C.hair} />
            </g>
          ))}
          <rect x="230" y="293" width="16" height="3.5" rx="1.5" fill={C.ink} />
          <rect x="258" y="293" width="16" height="3.5" rx="1.5" fill={C.blue} />
        </g>
      </g>
      <rect x="204" y="300" width="94" height="54" rx="9" fill={C.body2} />
      <rect x="216" y="300" width="70" height="5" rx="2" fill={C.ink} />
      <circle cx="282" cy="340" r="3" fill={C.blue} />
      <circle cx="270" cy="340" r="3" fill={C.muted} />

      {/* Cash drawer with the till on top */}
      <rect x="320" y="324" width="196" height="30" rx="5" fill={C.body} />
      <rect x="394" y="336" width="48" height="5" rx="2.5" fill={C.muted} />
      <rect x="430" y="268" width="18" height="50" fill={C.body2} />
      <rect x="400" y="316" width="78" height="9" rx="4" fill={C.body2} />
      <rect x="326" y="112" width="226" height="162" rx="11" fill={C.body} />
      <rect x="335" y="121" width="208" height="144" rx="3" fill="#fff" />
      <rect x="335" y="121" width="208" height="15" fill={C.blue} />
      <rect x="342" y="126" width="24" height="5" rx="1.5" fill="#fff" fillOpacity="0.95" />
      {[0, 1, 2, 3, 4].map((n) => (
        <g key={n}>
          {n === 4 && <rect className="land-row" x="339" y={142 + n * 18} width="132" height="16" rx="2" fill="#e9eff8" fillOpacity="0" />}
          <rect x="345" y={148 + n * 18} width={[64, 52, 70, 46, 58][n]} height="4" rx="2" fill={C.ink} fillOpacity="0.55" />
          <rect x="345" y={154 + n * 18} width="30" height="2.5" rx="1.2" fill={C.blue} fillOpacity="0.45" />
          <rect x="446" y={148 + n * 18} width="20" height="4" rx="2" fill={C.ink} fillOpacity="0.7" />
        </g>
      ))}
      <rect x="477" y="142" width="60" height="117" rx="3" fill={C.paper} />
      <rect x="484" y="150" width="26" height="3" rx="1.5" fill={C.hair} />
      <text x="531" y="174" textAnchor="end" style={{ fontFamily: 'var(--font-serial)' }} fontWeight="600" fontSize="12" fill={C.ink}>
        ₱265.50
      </text>
      <rect x="484" y="186" width="46" height="3" rx="1.5" fill={C.hair} />
      <rect x="484" y="194" width="34" height="3" rx="1.5" fill={C.hair} />
      <rect x="482" y="234" width="50" height="19" rx="3" fill={C.blue} />
      <rect x="494" y="242" width="26" height="3.5" rx="1.5" fill="#fff" />
      <rect x="326" y="112" width="226" height="162" rx="11" fill="url(#land-screen)" />

      {/* Scanner in its cradle, the beam on the counter */}
      <polygon className="land-beam" points="548,300 516,352 556,352" fill={C.blue} fillOpacity="1" opacity="0.15" />
      <rect x="548" y="292" width="40" height="17" rx="6" fill={C.body2} />
      <rect x="562" y="304" width="13" height="32" rx="4" fill={C.body2} />
      <rect x="554" y="330" width="30" height="24" rx="5" fill={C.body} />

      {/* The counter */}
      <rect x="0" y="352" width="600" height="10" rx="3" fill={C.hair} />
      <rect x="40" y="362" width="520" height="6" rx="3" fill={C.ink} fillOpacity="0.06" />
    </svg>
  );
}
