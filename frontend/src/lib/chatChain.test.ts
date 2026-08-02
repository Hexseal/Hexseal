import { describe, it, expect } from 'vitest';
import { buildLink, linkHash, GENESIS_HASH, type ChainLink } from './chatChain';

const ALICE = '0x1111111111111111111111111111111111111111' as const;
const BOB   = '0x2222222222222222222222222222222222222222' as const;
const BODY  = ('0x' + 'aa'.repeat(32)) as `0x${string}`;

describe('buildLink', () => {
  it('первое звено ссылается на генезис и имеет номер 0', () => {
    const link = buildLink(null, BODY, ALICE, 1000);
    expect(link.seq).toBe(0);
    expect(link.prevHash).toBe(GENESIS_HASH);
  });

  it('следующее звено наследует номер и отпечаток предыдущего', () => {
    const first  = buildLink(null, BODY, ALICE, 1000);
    const second = buildLink(first, BODY, BOB, 2000);
    expect(second.seq).toBe(1);
    expect(second.prevHash).toBe(linkHash(first));
  });

  it('адрес отправителя приводится к нижнему регистру', () => {
    const link = buildLink(null, BODY, ALICE.toUpperCase() as `0x${string}`, 1000);
    expect(link.sender).toBe(ALICE);
  });
});

describe('linkHash', () => {
  it('одинаковые звенья дают одинаковый отпечаток', () => {
    const a = buildLink(null, BODY, ALICE, 1000);
    const b = buildLink(null, BODY, ALICE, 1000);
    expect(linkHash(a)).toBe(linkHash(b));
  });

  it('изменение ЛЮБОГО поля меняет отпечаток', () => {
    const base = buildLink(null, BODY, ALICE, 1000);
    const h = linkHash(base);
    const OTHER_BODY = ('0x' + 'bb'.repeat(32)) as `0x${string}`;
    expect(linkHash({ ...base, seq: 1 })).not.toBe(h);
    expect(linkHash({ ...base, bodyHash: OTHER_BODY })).not.toBe(h);
    expect(linkHash({ ...base, sender: BOB })).not.toBe(h);
    expect(linkHash({ ...base, sentAt: 1001 })).not.toBe(h);
    expect(linkHash({ ...base, prevHash: OTHER_BODY })).not.toBe(h);
  });
});
