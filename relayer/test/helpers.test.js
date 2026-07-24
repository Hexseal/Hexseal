import { describe, it, expect } from 'vitest';
import {
  safeKey, pairIdFromAddresses, safeLogPath, deriveLogKey,
  encryptEntry, decryptEntry, isKnownPushServiceEndpoint, checkRateLimit,
} from '../app.js';

describe('safeKey', () => {
  it('strips path traversal sequences', () => {
    expect(safeKey('../../etc/passwd')).toBe('....etcpasswd');
  });
  it('strips a leading absolute path down to the basename', () => {
    expect(safeKey('/etc/passwd')).toBe('etcpasswd');
  });
  it('keeps a normal filename unchanged', () => {
    expect(safeKey('1700000000-abc123.bin')).toBe('1700000000-abc123.bin');
  });
  it('truncates to 200 characters', () => {
    expect(safeKey('a'.repeat(300)).length).toBe(200);
  });
});

describe('pairIdFromAddresses', () => {
  const A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const B = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

  it('is order-independent (sorted, lowercased)', () => {
    expect(pairIdFromAddresses(A, B)).toBe(pairIdFromAddresses(B, A));
  });
  it('produces the expected lowercase-sorted format', () => {
    expect(pairIdFromAddresses(A, B)).toBe(`${A.toLowerCase()}-${B.toLowerCase()}`);
  });
});

describe('safeLogPath', () => {
  it('accepts a well-formed pairId', () => {
    const pairId = pairIdFromAddresses(
      '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    );
    expect(() => safeLogPath(pairId)).not.toThrow();
  });
  it('rejects a malformed pairId (path-escape attempt)', () => {
    expect(() => safeLogPath('../../etc/passwd')).toThrow(/invalid pairId/);
  });
});

describe('encryptEntry / decryptEntry', () => {
  it('round-trips an object through AES-256-GCM', () => {
    const key = deriveLogKey('0xaaaa-0xbbbb');
    const entry = { ts: 1700000000000, from: '0xabc', text: 'hello', dealId: null };
    const encrypted = encryptEntry(key, entry);
    expect(encrypted).toHaveProperty('iv');
    expect(encrypted).toHaveProperty('ct');
    expect(encrypted).toHaveProperty('authTag');
    expect(decryptEntry(key, encrypted)).toEqual(entry);
  });
  it('fails to decrypt with the wrong key (tamper/integrity check)', () => {
    const key1 = deriveLogKey('0xaaaa-0xbbbb');
    const key2 = deriveLogKey('0xcccc-0xdddd');
    const encrypted = encryptEntry(key1, { text: 'secret' });
    expect(() => decryptEntry(key2, encrypted)).toThrow();
  });
});

describe('isKnownPushServiceEndpoint', () => {
  it('accepts a real FCM endpoint', () => {
    expect(isKnownPushServiceEndpoint('https://fcm.googleapis.com/fcm/send/abc123')).toBe(true);
  });
  it('accepts a Mozilla endpoint', () => {
    expect(isKnownPushServiceEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true);
  });
  it('rejects a lookalike subdomain', () => {
    expect(isKnownPushServiceEndpoint('https://fcm.googleapis.com.attacker.com/push')).toBe(false);
  });
  it('rejects http (wrong scheme)', () => {
    expect(isKnownPushServiceEndpoint('http://fcm.googleapis.com/push')).toBe(false);
  });
  it('rejects an arbitrary external host', () => {
    expect(isKnownPushServiceEndpoint('https://evil.example/steal')).toBe(false);
  });
  it('rejects a malformed URL without throwing', () => {
    expect(isKnownPushServiceEndpoint('not a url')).toBe(false);
  });
});

describe('checkRateLimit', () => {
  it('allows the first RATE_MAX (10) requests from one IP within the window', () => {
    const ip = `test-ip-${Math.random()}`;
    for (let i = 0; i < 10; i++) {
      expect(checkRateLimit(ip)).toBe(true);
    }
  });
  it('rejects the 11th request within the same window', () => {
    const ip = `test-ip-${Math.random()}`;
    for (let i = 0; i < 10; i++) checkRateLimit(ip);
    expect(checkRateLimit(ip)).toBe(false);
  });
  it('tracks separate IPs independently', () => {
    const ipA = `test-ip-a-${Math.random()}`;
    const ipB = `test-ip-b-${Math.random()}`;
    for (let i = 0; i < 10; i++) checkRateLimit(ipA);
    expect(checkRateLimit(ipA)).toBe(false);
    expect(checkRateLimit(ipB)).toBe(true);
  });
});
