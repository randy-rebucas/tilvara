import { describe, expect, it } from 'vitest';
import { ean13CheckDigit, parseScaleLabel } from '../src/index.js';

const label = (first12: string) => `${first12}${ean13CheckDigit(first12)}`;

describe('scale labels', () => {
  it('computes the EAN-13 check digit (a published example)', () => {
    expect(ean13CheckDigit('400638133393')).toBe(1);
  });

  it('reads the item key and the weight in kilograms, exactly', () => {
    expect(parseScaleLabel(label('212345012340'))).toEqual({ key: '212345', quantity: '1.234' });
    expect(parseScaleLabel(label('212345005000'))).toEqual({ key: '212345', quantity: '0.500' });
    expect(parseScaleLabel(label('212345123450'))).toEqual({ key: '212345', quantity: '12.345' });
    expect(parseScaleLabel(` ${label('212345012340')} `)).toEqual({ key: '212345', quantity: '1.234' });
  });

  it('refuses what is not a scale label: another prefix, a wrong check digit, no weight, other lengths', () => {
    expect(parseScaleLabel(label('480198111607'))).toBeNull();
    const good = label('212345012340');
    expect(parseScaleLabel(`${good.slice(0, 12)}${(Number(good[12]) + 1) % 10}`)).toBeNull();
    expect(parseScaleLabel(label('212345000000'))).toBeNull();
    expect(parseScaleLabel('21234501234')).toBeNull();
    expect(parseScaleLabel('CK-290')).toBeNull();
  });
});
