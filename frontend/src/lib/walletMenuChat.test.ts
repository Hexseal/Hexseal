/**
 * walletMenuChat.test.ts — таблица: три состояния ключа × два рода кошелька.
 *
 * ⚠️ ЗАМЕР С ЖИВОГО ТЕЛЕФОНА (9 августа): чат работает, ключ на устройстве,
 * ключ объявлен, кошелёк обычный — а меню показывает «Подключить мессенджер» и
 * «Восстановить по коду». Требование владельца дословно: «меню обязано
 * показывать то, что есть», и «мутация „показывать всё всегда“ обязана
 * краснеть».
 */
import { describe, it, expect } from 'vitest';
import { walletMenuChatItems, type MenuChatInput, type MenuChatItem } from '@/lib/walletMenuChat';
import { publishChatSession, publishedChatSession, forgetPublishedSession,
  subscribeChatSession, _resetChatSessionStoreForTest } from '@/lib/chatSessionStore';
import type { ChatSession } from '@/lib/chatSession';

const BASE: MenuChatInput = {
  hasKey: false, connecting: false, walletKind: 'unknown',
  standing: 'unknown', reach: 'ok',
};

function items(patch: Partial<MenuChatInput>): MenuChatItem[] {
  return [...walletMenuChatItems({ ...BASE, ...patch })].sort();
}

/* ═════════ таблица: ключа нет / есть но не объявлен / всё в порядке ════════ */

describe('три состояния ключа × два рода кошелька', () => {
  it('ключа нет, род неизвестен — «подключить» и дверь к коду', () => {
    // Род без сеанса не определить: его устанавливает сама подпись. Промолчать
    // здесь дороже — владелец кошелька-контракта не нашёл бы входа вовсе.
    expect(items({ hasKey: false })).toEqual(['enable', 'restore']);
  });

  it('ключ есть, НЕ объявлен, обычный кошелёк — ни «подключить», ни кода', () => {
    expect(items({ hasKey: true, walletKind: 'eoa', standing: 'absent' }))
      .toEqual(['disable']);
  });

  it('ключ есть, НЕ объявлен, кошелёк-контракт — код на месте', () => {
    expect(items({ hasKey: true, walletKind: 'contract', standing: 'absent' }))
      .toEqual(['disable', 'restore', 'show-code']);
  });

  it('ВСЁ В ПОРЯДКЕ, обычный кошелёк — только «отключить»', () => {
    // Ровно состояние прибора. Красит: «Подключить мессенджер» у работающего
    // чата и «Восстановить по коду» у кошелька, у которого кода не бывает.
    const shown = items({ hasKey: true, walletKind: 'eoa', standing: 'mine' });
    expect(shown).toEqual(['disable']);
    expect(shown, 'меню предлагает подключить УЖЕ подключённый чат').not.toContain('enable');
    expect(shown, 'обычному кошельку предложен код, которого у него нет').not.toContain('restore');
  });

  it('ВСЁ В ПОРЯДКЕ, кошелёк-контракт — код показать можно и нужно', () => {
    expect(items({ hasKey: true, walletKind: 'contract', standing: 'mine' }))
      .toEqual(['disable', 'restore', 'show-code']);
  });

  it('ключ заводится прямо сейчас — только «подключаем»', () => {
    expect(items({ connecting: true })).toEqual(['connecting']);
  });
});

/* ═════════ кошелёк не отвечает — выход есть при любом состоянии ═══════════ */

describe('запросы на подпись не доходят', () => {
  it.each([
    ['broken' as const], ['quiet' as const],
  ])('состояние «%s» — «переподключить кошелёк» в меню', (reach) => {
    expect(items({ reach })).toContain('reconnect-wallet');
    expect(items({ hasKey: true, walletKind: 'eoa', standing: 'mine', reach }))
      .toContain('reconnect-wallet');
  });

  it('всё в порядке — этого пункта НЕТ (замок, который горит всегда, не замок)', () => {
    expect(items({ reach: 'ok' })).not.toContain('reconnect-wallet');
  });

  it('пункт есть даже пока ключ заводится — там-то подпись и висит', () => {
    expect(items({ connecting: true, reach: 'broken' }))
      .toEqual(['connecting', 'reconnect-wallet']);
  });
});

/* ═════════ общий склад ключа: узнают ВСЕ, кто спрашивал ═══════════════════ */

describe('ключ — общий факт, а не состояние экземпляра', () => {
  const ALICE = '0xA1cE00000000000000000000000000000000CAfE';
  const session = { address: ALICE, walletKind: 'eoa' } as unknown as ChatSession;

  it('завели ключ в одном месте — остальные узнали', () => {
    // ⚠️ РОВНО ТА БЕДА С ПРИБОРА. Меню в шапке спросило ключ на доске заказов и
    // не нашло; человек завёл ключ в чате; меню об этом не узнало НИКОГДА — его
    // эффект зависит от адреса и просьбы завести ключ, а не изменилось ни то,
    // ни другое. Отсюда «Подключить мессенджер» у работающего чата.
    _resetChatSessionStoreForTest();
    let told = 0;
    const stop = subscribeChatSession(() => { told++; });
    try {
      expect(publishedChatSession(ALICE)).toBe(null);
      publishChatSession(ALICE, session);
      expect(told, 'о заведённом ключе никому не сказали').toBe(1);
      expect(publishedChatSession(ALICE), 'ключ не виден другим местам страницы').toBe(session);
      // Адрес спрашивается в любом регистре — меню и чат пишут его по-разному.
      expect(publishedChatSession(ALICE.toLowerCase())).toBe(session);
    } finally { stop(); }
  });

  it('тот же сеанс второй раз — никого не будим', () => {
    _resetChatSessionStoreForTest();
    publishChatSession(ALICE, session);
    let told = 0;
    const stop = subscribeChatSession(() => { told++; });
    try {
      publishChatSession(ALICE, session);
      publishChatSession(ALICE, session);
      expect(told, 'экземпляры будят друг друга по кругу').toBe(0);
    } finally { stop(); }
  });

  it('чат выключили — узнали все, и меню перестаёт предлагать «отключить»', () => {
    _resetChatSessionStoreForTest();
    publishChatSession(ALICE, session);
    let told = 0;
    const stop = subscribeChatSession(() => { told++; });
    try {
      forgetPublishedSession(ALICE);
      expect(told).toBe(1);
      expect(publishedChatSession(ALICE)).toBe(null);
      expect(items({ hasKey: false })).toContain('enable');
    } finally { stop(); }
  });

  it('чужой адрес не выдаётся за свой', () => {
    _resetChatSessionStoreForTest();
    publishChatSession(ALICE, session);
    expect(publishedChatSession('0xb0b1000000000000000000000000000000005eed')).toBe(null);
  });
});
