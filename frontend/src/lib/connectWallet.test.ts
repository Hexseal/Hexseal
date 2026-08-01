import { describe, it, expect, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  shouldOpenWalletConnectDirectly,
  hasInjectedProvider,
  findWalletConnectModalConnector,
  classifyConnectError,
  beginConnectAttempt,
  endConnectAttempt,
  isConnectAttemptInFlight,
  CONNECT_ATTEMPT_STALE_MS,
  type ConnectorLike,
} from './connectWallet';

/**
 * Формы коннекторов здесь — не выдуманные, а ровно те, что RainbowKit 2.2.8
 * кладёт в конфиг wagmi. Главное свойство, ради которого тест существует:
 * `id` у ВСЕХ кошельков RainbowKit на WalletConnect одинаковый
 * (`'walletConnect'` — он приходит из коннектора wagmi), различает их только
 * `rkDetails`. Выбор «по id» выглядел бы рабочим и молча брал бы первый
 * попавшийся — например, Trust.
 */
const trust: ConnectorLike = {
  id: 'walletConnect',
  rkDetails: { id: 'trust' },
};
const okx: ConnectorLike = {
  id: 'walletConnect',
  rkDetails: { id: 'okx' },
};
/** Кошелёк `walletConnect` заводится ДВУМЯ коннекторами. Этот — с
 *  `showQrModal: false`: модалку рисует сам RainbowKit своим QR-кодом. */
const wcQr: ConnectorLike = {
  id: 'walletConnect',
  rkDetails: { id: 'walletConnect' },
};
/** А этот — с `showQrModal: true`. Только он открывает РОДНУЮ модалку
 *  WalletConnect с полным списком кошельков. Нам нужен строго он. */
const wcModal: ConnectorLike = {
  id: 'walletConnect',
  rkDetails: { id: 'walletConnect', isWalletConnectModalConnector: true },
};
/** Инжектированный: `rkDetails` у коннекторов EIP-6963 нет вовсе. */
const injected: ConnectorLike = { id: 'injected' };

describe('shouldOpenWalletConnectDirectly', () => {
  it('на телефоне в обычном браузере — сразу WalletConnect', () => {
    // Ради этого всё и делалось: лишний экран RainbowKit предлагает выбор,
    // которого на телефоне нет, и прячет полный список кошельков
    // (MetaMask, Binance, Bitget, TokenPocket, Ledger…) за лишним нажатием.
    expect(shouldOpenWalletConnectDirectly({ isMobile: true, hasInjectedProvider: false })).toBe(true);
  });

  it('на десктопе — никогда', () => {
    // Там расширение MetaMask первым пунктом модалки RainbowKit, а прямой
    // WalletConnect показал бы QR-код человеку, у которого кошелёк уже в
    // браузере. Это было бы ухудшением.
    expect(shouldOpenWalletConnectDirectly({ isMobile: false, hasInjectedProvider: false })).toBe(false);
    expect(shouldOpenWalletConnectDirectly({ isMobile: false, hasInjectedProvider: true })).toBe(false);
  });

  it('во встроенном браузере кошелька — тоже нет', () => {
    // Единственное место на телефоне, где выбор действительно есть:
    // инжектированный провайдер подключает в одно нажатие, не выходя из
    // приложения. Увести отсюда в WalletConnect — это заменить работающее
    // подключение диплинком кошелька в самого себя.
    expect(shouldOpenWalletConnectDirectly({ isMobile: true, hasInjectedProvider: true })).toBe(false);
  });
});

describe('hasInjectedProvider', () => {
  it('узнаёт встроенный браузер кошелька', () => {
    expect(hasInjectedProvider({ ethereum: { isMetaMask: true } })).toBe(true);
  });

  it('обычный браузер и SSR — провайдера нет', () => {
    expect(hasInjectedProvider({})).toBe(false);
    expect(hasInjectedProvider(undefined)).toBe(false);
  });

  it('null в window.ethereum за провайдера не считается', () => {
    // Встречается у расширений, которые «застолбили» поле и не заполнили.
    expect(hasInjectedProvider({ ethereum: null })).toBe(false);
  });
});

describe('findWalletConnectModalConnector', () => {
  it('берёт коннектор родной модалки, а не первый попавшийся walletConnect', () => {
    // Порядок намеренно такой, чтобы выбор «по id» вернул Trust.
    const out = findWalletConnectModalConnector([trust, okx, wcQr, wcModal, injected]);
    expect(out).toBe(wcModal);
  });

  it('не путает его с QR-близнецом того же кошелька', () => {
    // Оба — `walletConnect`, оба с одинаковым rkDetails.id. Если ошибиться и
    // взять QR-вариант (showQrModal: false), нажатие не покажет ничего и будет
    // молча ждать: рисовать модалку в этом случае должен был RainbowKit.
    const out = findWalletConnectModalConnector([wcQr, wcModal]);
    expect(out).toBe(wcModal);
    expect(out).not.toBe(wcQr);
  });

  it('без коннектора WalletConnect отвечает null, а не бросает', () => {
    // Так выглядит запасная ветка конфига: не задан
    // NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID → один injected(). Вызывающий
    // обязан откатиться на модалку RainbowKit, а не упасть.
    expect(findWalletConnectModalConnector([injected])).toBeNull();
    expect(findWalletConnectModalConnector([trust, okx, wcQr])).toBeNull();
    expect(findWalletConnectModalConnector([])).toBeNull();
    expect(findWalletConnectModalConnector(null)).toBeNull();
    expect(findWalletConnectModalConnector(undefined)).toBeNull();
  });

  it('переживает дыры в массиве коннекторов', () => {
    const holey = [undefined as unknown as ConnectorLike, wcModal];
    expect(findWalletConnectModalConnector(holey)).toBe(wcModal);
  });

  it('флаг читается строго как true, а не как «похоже на правду»', () => {
    const falsy: ConnectorLike = {
      id: 'walletConnect',
      rkDetails: { id: 'walletConnect', isWalletConnectModalConnector: false },
    };
    expect(findWalletConnectModalConnector([falsy])).toBeNull();
  });
});

describe('classifyConnectError', () => {
  it('закрытие модалки WalletConnect — это отмена, а не поломка', () => {
    // Тот самый текст, который Web3Modal отдаёт на закрытие; RainbowKit у себя
    // считает его отказом ровно так же.
    expect(classifyConnectError(new Error('Connection request reset. Please try again.')))
      .toBe('cancelled');
  });

  it('узнаёт отказ по имени ошибки wagmi', () => {
    const err = Object.assign(new Error('anything'), { name: 'UserRejectedRequestError' });
    expect(classifyConnectError(err)).toBe('cancelled');
  });

  it('узнаёт код 4001 из EIP-1193 — числом и строкой', () => {
    expect(classifyConnectError({ code: 4001, message: 'x' })).toBe('cancelled');
    expect(classifyConnectError({ code: '4001', message: 'x' })).toBe('cancelled');
  });

  it('достаёт причину из вложенного cause', () => {
    // viem и wagmi заворачивают ошибку провайдера в свою, WalletConnect — ещё
    // и в свою: на верхнем уровне текст обычно безликий.
    const err = new Error('An unknown RPC error occurred.');
    (err as Error & { cause?: unknown }).cause = {
      cause: { name: 'UserRejectedRequestError', message: 'User rejected the request.' },
    };
    expect(classifyConnectError(err)).toBe('cancelled');
  });

  it('не зацикливается на кольцевом cause', () => {
    const err = new Error('boom') as Error & { cause?: unknown };
    err.cause = err;
    expect(classifyConnectError(err)).toBe('failed');
  });

  it('«уже подключён» — отдельный исход, не отказ и не поломка', () => {
    const err = Object.assign(new Error('Connector already connected.'), {
      name: 'ConnectorAlreadyConnectedError',
    });
    expect(classifyConnectError(err)).toBe('already-connected');
  });

  it('настоящий сбой остаётся сбоем — иначе он притворится нормой', () => {
    // Ровно тот класс бага, который здесь уже чинили: отказ, проглоченный как
    // будто ничего не произошло. Всё, что не опознано, обязано быть показано.
    expect(classifyConnectError(new Error('WebSocket connection failed'))).toBe('failed');
    expect(classifyConnectError(new Error('Proposal expired'))).toBe('failed');
    expect(classifyConnectError(new Error('Unsupported chain id'))).toBe('failed');
    expect(classifyConnectError(undefined)).toBe('failed');
    expect(classifyConnectError(null)).toBe('failed');
    expect(classifyConnectError('')).toBe('failed');
  });

  it('разбирает и голую строку вместо объекта ошибки', () => {
    expect(classifyConnectError('User rejected the request')).toBe('cancelled');
    expect(classifyConnectError('something exploded')).toBe('failed');
  });

  it('читает shortMessage viem, а не только message', () => {
    expect(classifyConnectError({ shortMessage: 'User rejected the request.' })).toBe('cancelled');
  });
});

describe('замок на одну попытку', () => {
  beforeEach(() => { endConnectAttempt(); });

  it('второе нажатие, пока первое в полёте, не проходит', () => {
    expect(beginConnectAttempt(1_000)).toBe(true);
    expect(beginConnectAttempt(1_100)).toBe(false);
    expect(beginConnectAttempt(1_200)).toBe(false);
  });

  it('после освобождения нажатие снова проходит', () => {
    expect(beginConnectAttempt(1_000)).toBe(true);
    endConnectAttempt();
    expect(beginConnectAttempt(1_050)).toBe(true);
  });

  it('брошенная попытка отпускает замок сама', () => {
    // Обещание connect() может не разрешиться никогда: человек ушёл в
    // приложение кошелька и не вернулся, сессия отвалилась молча. Без потолка
    // одно такое нажатие навсегда выключило бы кнопку во всём приложении.
    expect(beginConnectAttempt(1_000)).toBe(true);
    expect(beginConnectAttempt(1_000 + CONNECT_ATTEMPT_STALE_MS - 1)).toBe(false);
    expect(beginConnectAttempt(1_000 + CONNECT_ATTEMPT_STALE_MS)).toBe(true);
  });

  it('замок общий на всё приложение, а не на одну кнопку', () => {
    // Кнопка «Подключить» рендерится дважды (мобильный и десктопный экземпляры
    // WalletMenu) плюс CTA на главной. Локальное состояние каждой из них про
    // соседнюю ничего не знает — поэтому замок живёт в модуле.
    expect(isConnectAttemptInFlight(1_000)).toBe(false);
    beginConnectAttempt(1_000);
    expect(isConnectAttemptInFlight(1_001)).toBe(true);
    endConnectAttempt();
    expect(isConnectAttemptInFlight(1_002)).toBe(false);
  });

  it('нулевая метка времени держит замок так же, как любая другая', () => {
    // Ноль — законное значение Date.now(); если хранить «попытки нет» нулём,
    // то на этой метке замок молча перестаёт держать что-либо.
    expect(isConnectAttemptInFlight(0)).toBe(false);
    expect(beginConnectAttempt(0)).toBe(true);
    expect(isConnectAttemptInFlight(0)).toBe(true);
    expect(beginConnectAttempt(1)).toBe(false);
  });
});

/**
 * Структурный гейт: точка запуска подключения обязана быть ОДНА.
 *
 * Проверяется чтением исходников, а не запуском браузера, — намеренно, по той
 * же причине, что и в `signaturePaths.test.ts`: браузерного раннера у фронта
 * нет вовсе (jsdom и testing-library на этой файловой системе не ставятся), а
 * ломается это свойство одинаково — кто-то добавляет третью кнопку
 * «Подключить», зовёт `useConnectModal()` напрямую, и на телефоне снова
 * появляется лишний экран. Ни в типах, ни в тестах модулей это не видно.
 *
 * Цена промаха несоразмерна цене теста: расхождение молчаливое — на десктопе
 * разработчика всё выглядит правильно, а мобильный путь у половины кнопок
 * тихо возвращается к двум экранам.
 */
const SRC = fileURLToPath(new URL('..', import.meta.url)); // frontend/src

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules') continue;
      out.push(...walk(full));
      continue;
    }
    if (!/\.tsx?$/.test(name)) continue;
    if (/\.test\.tsx?$/.test(name)) continue; // сами тесты не в счёт
    out.push(full);
  }
  return out;
}

const FILES = walk(SRC).map(f => ({
  path: relative(SRC, f).split(/[\\/]/).join('/'),
  raw:  readFileSync(f, 'utf8'),
}));

/** Единственный файл, которому позволено решать, как открывается выбор
 *  кошелька. Всё остальное обязано звать `useConnectWallet()`. */
const THE_HOOK = 'hooks/useConnectWallet.ts';

describe('точка запуска подключения одна', () => {
  it('модалку RainbowKit открывает только сам хук', () => {
    const offenders = FILES
      .filter(f => f.path !== THE_HOOK)
      .filter(f => /useConnectModal|openConnectModal/.test(f.raw))
      .map(f => f.path);

    expect(offenders).toEqual([]);
  });

  it('коннектор wagmi зовёт только сам хук', () => {
    // Прямой `useConnect()` мимо хука — это подключение без замка на повторное
    // нажатие и без разбора «отказ или поломка».
    const offenders = FILES
      .filter(f => f.path !== THE_HOOK)
      .filter(f => /\buseConnect\s*\(/.test(f.raw))
      .map(f => f.path);

    expect(offenders).toEqual([]);
  });

  it('обе кнопки подключения ходят через хук', () => {
    // Не «сколько-то файлов», а именно эти. Новый файл в списке — повод
    // осознанно проверить, что кнопка ведёт себя как остальные, а не молча
    // пройти гейт.
    const callers = FILES
      .filter(f => /from ['"]@\/hooks\/useConnectWallet['"]/.test(f.raw))
      .map(f => f.path)
      .sort();

    expect(callers).toEqual([
      'components/Hero.tsx',       // терминальный CTA на главной
      'components/WalletMenu.tsx', // кнопка в шапке, на каждой странице
    ]);
  });

  it('признак мобильности берётся из общего места, а не заводится заново', () => {
    // Второй способ отличить телефон от компьютера разъехался бы с первым
    // молча: список кошельков собрался бы по одному правилу, а маршрут
    // подключения пошёл бы по другому.
    //
    // Ловим два способа завести его заново: свой разбор User-Agent и
    // медиазапрос по ширине окна. Ширина — это НЕ мобильность: узкое окно на
    // десктопе это по-прежнему инжектированный MetaMask, которому родная
    // модалка WalletConnect показала бы QR-код вместо расширения. Прочие
    // matchMedia (например, prefers-reduced-motion в BackgroundFX) к вопросу
    // отношения не имеют и под гейт не попадают.
    const OWN_UA_SNIFF   = /navigator\.userAgent/;
    const WIDTH_BREAKPOINT = /matchMedia\(\s*[`'"][^`'"]*(?:max|min)-width/;

    const offenders = FILES
      .filter(f => f.path !== 'lib/walletList.ts')
      .filter(f => OWN_UA_SNIFF.test(f.raw) || WIDTH_BREAKPOINT.test(f.raw))
      .map(f => f.path);

    expect(offenders).toEqual([]);
  });
});
