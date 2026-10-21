import { barcodeFor, isEan13Guard } from '@/lib/barcode';

const QUIET = 10;

/**
 * A barcode drawn as SVG by our own encoder (src/lib/barcode.ts): EAN-13 when the code is a valid
 * one, else Code 128. Sized in millimetres for printing; the digits are printed under it.
 */
export function BarcodeSvg({ code, widthMm, heightMm, showText = true }: { code: string; widthMm: number; heightMm: number; showText?: boolean }) {
  const { kind, modules, text } = barcodeFor(code);
  const total = modules.length + QUIET * 2;
  const bars: { x: number; w: number; guard: boolean }[] = [];
  for (let i = 0; i < modules.length; i++) {
    if (modules[i] !== '1') continue;
    const guard = kind === 'EAN13' && isEan13Guard(i);
    const last = bars[bars.length - 1];
    if (last && last.x + last.w === i + QUIET && last.guard === guard) last.w += 1;
    else bars.push({ x: i + QUIET, w: 1, guard });
  }
  const textMm = showText ? Math.min(2.6, heightMm * 0.28) : 0;
  const barsMm = heightMm - textMm;
  return (
    <span className="flex flex-col items-center" style={{ width: `${widthMm}mm` }}>
      <svg
        role="img"
        aria-label={text}
        viewBox={`0 0 ${total} 100`}
        preserveAspectRatio="none"
        style={{ width: `${widthMm}mm`, height: `${barsMm}mm`, display: 'block' }}
        shapeRendering="crispEdges"
      >
        {bars.map((b) => (
          <rect key={b.x} x={b.x} y={0} width={b.w} height={kind === 'EAN13' && !b.guard ? 92 : 100} fill="#000" />
        ))}
      </svg>
      {showText && (
        <span className="serial block leading-none text-black" style={{ fontSize: `${textMm * 0.95}mm`, letterSpacing: '0.04em' }}>
          {text}
        </span>
      )}
    </span>
  );
}
