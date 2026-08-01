import { describe, it, expect } from 'vitest';
import { pushPrompt, type PushPromptInput } from './pushPrompt';

const base: PushPromptInput = {
  supported: true,
  permission: 'granted',
  subscribed: false,
  stale: false,
};
const at = (o: Partial<PushPromptInput>) => pushPrompt({ ...base, ...o });

describe('pushPrompt — включение уходит со страницы, отключение живёт в меню кошелька', () => {
  it('подписки нет — предлагаем включить', () => {
    expect(at({ subscribed: false })).toBe('enable');
  });

  it('подписка есть и жива — на странице показывать нечего', () => {
    // Именно это и просил владелец: элемент исчезает. Выключить пуши можно в
    // WalletMenu, там же где отключается чат.
    expect(at({ subscribed: true, stale: false })).toBe('none');
  });

  it('подписка есть, но мертва — способ включить заново ОБЯЗАН остаться', () => {
    // Самый лёгкий способ сломать эту задачу: спрятать протухшую подписку
    // вместе с тумблером. Автоматической перерегистрации больше нет (eae891c),
    // она требовала подписи кошелька без нажатия; единственное, что теперь
    // чинит протухание — вот это нажатие. Спрятать его = вернуть молчаливый
    // отказ доставки.
    expect(at({ subscribed: true, stale: true })).toBe('renew');
  });

  it('«есть и мертва» и «есть и жива» — разные состояния, не одно', () => {
    expect(at({ subscribed: true, stale: true })).not.toBe(at({ subscribed: true, stale: false }));
  });
});

describe('pushPrompt — края', () => {
  it('браузер не умеет пуши — молчим, кнопка была бы враньём', () => {
    expect(at({ supported: false })).toBe('none');
    expect(at({ supported: false, subscribed: true, stale: true })).toBe('none');
  });

  it('разрешение отозвано — объясняем, а не предлагаем нажать', () => {
    // Пока стоит запрет браузера, никакое нажатие подписку не создаст.
    expect(at({ permission: 'denied' })).toBe('blocked');
    expect(at({ permission: 'denied', subscribed: true, stale: true })).toBe('blocked');
  });

  it('permission=default с живой подпиской всё равно ничего не показывает', () => {
    // subscribed уже доказывает, что разрешение когда-то дали; расхождение
    // между ним и Notification.permission не повод показывать тумблер.
    expect(at({ permission: 'default', subscribed: true, stale: false })).toBe('none');
  });

  it('stale без подписки ни на что не влияет — включать всё равно нужно', () => {
    expect(at({ subscribed: false, stale: true })).toBe('enable');
  });
});
