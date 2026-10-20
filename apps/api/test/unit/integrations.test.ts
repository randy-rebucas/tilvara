import { WEBHOOK_TOPICS } from '@1pos/database';
import { API_KEY_SCOPES, WEBHOOK_TOPIC_NAMES } from '@1pos/validation';
import { describe, expect, it } from 'vitest';
import { API_KEY_FORMAT, hashApiKey } from '../../src/integrations/integrations.service.js';

describe('integrations (ADR-0019)', () => {
  it('the topics a webhook may listen for are the ones the worker fans out', () => {
    expect([...WEBHOOK_TOPIC_NAMES].sort()).toEqual([...WEBHOOK_TOPICS].sort());
  });

  it('API key scopes are read permissions only', () => {
    expect(API_KEY_SCOPES.every((s) => s.endsWith('.read'))).toBe(true);
  });

  it('keys have a fixed shape and are looked up by the hash of the whole key', () => {
    const key = `tlv_ab12cd34ef_${'A'.repeat(43)}`;
    expect(API_KEY_FORMAT.exec(key)?.[1]).toBe('ab12cd34ef');
    expect(API_KEY_FORMAT.test(`tlv_AB12CD34EF_${'A'.repeat(43)}`)).toBe(false);
    expect(hashApiKey(key)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey(key)).not.toBe(hashApiKey(key.replace(/A$/, 'B')));
  });
});
