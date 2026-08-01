import { describe, it, expect, afterEach } from 'vitest';
import { isMobileUserAgent, isMobileClient, buildWalletGroups, type WalletGroup } from './walletList';

// Настоящие строки User-Agent, а не выдуманные: смысл теста в том, что
// конкретный Samsung Galaxy + Chrome, на котором баг снят, обязан попасть в
// мобильную ветку, а десктоп — не попасть ни при каких обстоятельствах.
const UA = {
  androidChrome:  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  androidMetaMask:'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 MetaMaskMobile',
  iphoneSafari:   'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ipad:           'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  macChrome:      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  winChrome:      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  linuxFirefox:   'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
};

describe('isMobileUserAgent', () => {
  it('на сервере (UA нет) отвечает «не мобильный»', () => {
    // Конфиг wagmi собирается один раз на eval модуля, в том числе при SSR.
    // Серверный рендер кошелёк не подключает, поэтому падать сюда безопасно —
    // но отвечать «мобильный» нельзя: это молча урезало бы десктопный набор.
    expect(isMobileUserAgent(undefined)).toBe(false);
    expect(isMobileUserAgent(null)).toBe(false);
    expect(isMobileUserAgent('')).toBe(false);
  });

  it('узнаёт устройство, на котором баг воспроизведён', () => {
    expect(isMobileUserAgent(UA.androidChrome)).toBe(true);
  });

  it('узнаёт встроенный браузер MetaMask на Android', () => {
    // Там провайдер инжектирован и диплинка нет, но коннектор MetaMask всё
    // равно уходит в SDK — так что этот случай должен ловить injectedWallet,
    // который на мобильном намеренно оставлен в списке.
    expect(isMobileUserAgent(UA.androidMetaMask)).toBe(true);
  });

  it('узнаёт iOS', () => {
    expect(isMobileUserAgent(UA.iphoneSafari)).toBe(true);
    expect(isMobileUserAgent(UA.ipad)).toBe(true);
  });

  it('не трогает десктоп', () => {
    expect(isMobileUserAgent(UA.macChrome)).toBe(false);
    expect(isMobileUserAgent(UA.winChrome)).toBe(false);
    expect(isMobileUserAgent(UA.linuxFirefox)).toBe(false);
  });
});

describe('isMobileClient', () => {
  // Этот признак — ОДИН на всё приложение: по нему и вычитается MetaMask из
  // мобильного списка (providers.tsx), и решается, звать ли на нажатии
  // коннектор WalletConnect напрямую мимо модалки RainbowKit
  // (hooks/useConnectWallet). Второй способ отличить телефон от компьютера
  // разъехался бы с этим молча, поэтому проверяем именно общую точку.
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const setUA = (ua: string | undefined) => {
    if (ua === undefined) {
      Reflect.deleteProperty(globalThis, 'navigator');
      return;
    }
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: ua },
      configurable: true,
      writable: true,
    });
  };

  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });

  it('без navigator (SSR) отвечает «не мобильный»', () => {
    setUA(undefined);
    expect(isMobileClient()).toBe(false);
  });

  it('на телефоне отвечает «мобильный»', () => {
    setUA(UA.androidChrome);
    expect(isMobileClient()).toBe(true);
    setUA(UA.iphoneSafari);
    expect(isMobileClient()).toBe(true);
  });

  it('на десктопе отвечает «не мобильный»', () => {
    setUA(UA.macChrome);
    expect(isMobileClient()).toBe(false);
    setUA(UA.winChrome);
    expect(isMobileClient()).toBe(false);
  });
});

describe('buildWalletGroups', () => {
  // Заглушки вместо настоящих фабрик RainbowKit: сравнение внутри идёт по
  // ссылке, а тянуть сюда весь пакет кошельков ради этого незачем.
  const metaMask = { id: 'metaMask' };
  const rabby    = { id: 'rabby' };
  const wc       = { id: 'walletConnect' };
  const injected = { id: 'injected' };

  const groups: WalletGroup<{ id: string }>[] = [
    { groupName: 'Popular', wallets: [metaMask, rabby] },
    { groupName: 'More',    wallets: [wc, injected] },
  ];

  it('на десктопе отдаёт полный набор, включая MetaMask', () => {
    // Десктопный MetaMask инжектированный: диплинков нет, SDK не мешает,
    // лишать его смысла нет.
    const out = buildWalletGroups(groups, false, [metaMask]);
    expect(out.map(g => g.groupName)).toEqual(['Popular', 'More']);
    expect(out[0].wallets).toEqual([metaMask, rabby]);
    expect(out[1].wallets).toEqual([wc, injected]);
  });

  it('на мобильном убирает MetaMask и оставляет WalletConnect', () => {
    const out = buildWalletGroups(groups, true, [metaMask]);
    expect(out[0].wallets).toEqual([rabby]);
    expect(out[1].wallets).toEqual([wc, injected]);
    const all = out.flatMap(g => g.wallets);
    expect(all).not.toContain(metaMask);
    expect(all).toContain(wc);       // транспорт мимо мёртвого SDK
    expect(all).toContain(injected); // встроенный браузер кошелька
  });

  it('выбрасывает группу, опустевшую после вычитания', () => {
    const single: WalletGroup<{ id: string }>[] = [
      { groupName: 'Popular', wallets: [metaMask] },
      { groupName: 'More',    wallets: [wc] },
    ];
    const out = buildWalletGroups(single, true, [metaMask]);
    expect(out.map(g => g.groupName)).toEqual(['More']);
  });

  it('не мутирует исходные группы', () => {
    // Один и тот же объект WALLET_GROUPS живёт в модуле providers.tsx; порча
    // его на месте была бы разной при SSR и на клиенте.
    buildWalletGroups(groups, true, [metaMask]);
    expect(groups[0].wallets).toEqual([metaMask, rabby]);
    buildWalletGroups(groups, false, [metaMask]);
    expect(groups[0].wallets).toEqual([metaMask, rabby]);
  });

  it('пустой список исключений ничего не меняет и на мобильном', () => {
    const out = buildWalletGroups(groups, true, []);
    expect(out[0].wallets).toEqual([metaMask, rabby]);
  });
});
