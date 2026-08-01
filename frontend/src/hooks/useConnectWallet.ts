"use client";

/**
 * useConnectWallet — ЕДИНСТВЕННАЯ точка запуска подключения кошелька.
 *
 * Нажатий «Подключить» в приложении два — кнопка в шапке (`WalletMenu`, видна
 * на каждой странице) и терминальный CTA на главной (`Hero`). Обе обязаны
 * вести себя одинаково, поэтому решение «куда идти по нажатию» живёт здесь, а
 * не в каждой кнопке. Все остальные экраны с текстом «подключите кошелёк»
 * (борды, дашборд, чат, уведомления, профиль) кошелёк не подключают — они
 * уводят на главную, к тому же CTA.
 *
 * Что делает:
 *
 *  • на мобильном — зовёт коннектор WalletConnect напрямую, минуя модалку
 *    RainbowKit. Родная модалка WalletConnect («All Wallets», поиск, полный
 *    список кошельков) открывается сама. Разбор, почему промежуточный экран на
 *    телефоне вреден и по какому признаку ищется нужный коннектор, — в шапке
 *    `lib/connectWallet.ts`;
 *  • на десктопе — открывает модалку RainbowKit, ровно как раньше. Там
 *    расширение MetaMask первым пунктом, а прямой WalletConnect показал бы QR
 *    человеку, у которого кошелёк уже в браузере;
 *  • если коннектора WalletConnect в конфиге нет (не задан
 *    `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` — конфиг тогда собран запасной
 *    веткой с одним `injected()`) — пишет в журнал и откатывается на модалку
 *    RainbowKit, а не молча ничего не делает.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useConnect } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { toast } from "react-hot-toast";
import { useTranslations } from "next-intl";
import { appChainId } from "@/config/chain";
import { isMobileClient } from "@/lib/walletList";
import {
  shouldOpenWalletConnectDirectly,
  hasInjectedProvider,
  findWalletConnectModalConnector,
  classifyConnectError,
  beginConnectAttempt,
  endConnectAttempt,
  CONNECT_ATTEMPT_STALE_MS,
} from "@/lib/connectWallet";

export interface ConnectWalletHandle {
  /** Запускает подключение. Звать можно сколько угодно: пока попытка в полёте,
   *  лишние нажатия проглатываются (см. замок в `lib/connectWallet.ts`). */
  connect: () => void;
  /** Идёт ли попытка прямо сейчас — чтобы кнопка могла показать это и не
   *  выглядеть мёртвой, пока человек в приложении кошелька. */
  connecting: boolean;
}

export function useConnectWallet(): ConnectWalletHandle {
  const t = useTranslations();
  const { openConnectModal } = useConnectModal();
  const { connectAsync, connectors } = useConnect();

  const [connecting, setConnecting] = useState(false);
  // Размонтированный компонент состояние не трогает: кнопка в шапке исчезает
  // ровно в момент успешного подключения, то есть пока `connect()` ещё в
  // `finally`.
  const aliveRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const finish = useCallback(() => {
    endConnectAttempt();
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (aliveRef.current) setConnecting(false);
  }, []);

  const connect = useCallback(() => {
    // Десктоп и встроенный браузер кошелька: как было, модалка RainbowKit
    // (разбор обоих случаев — в шапке `lib/connectWallet.ts`). Среду
    // спрашиваем в момент нажатия, а не на рендере: иначе разметка сервера и
    // клиента разъедутся на гидрации.
    const direct = shouldOpenWalletConnectDirectly({
      isMobile: isMobileClient(),
      hasInjectedProvider: hasInjectedProvider(),
    });
    if (!direct) {
      openConnectModal?.();
      return;
    }

    const wc = findWalletConnectModalConnector(connectors);
    if (!wc) {
      console.warn(
        "[connect] коннектор WalletConnect не найден среди [" +
          connectors.map(c => c.id).join(", ") +
          "] — открываем модалку RainbowKit",
      );
      openConnectModal?.();
      return;
    }

    // Второе нажатие, пока модалка WalletConnect открыта, завело бы вторую
    // сессию — а кошелёк держит ровно один открытый запрос.
    if (!beginConnectAttempt()) return;
    setConnecting(true);
    // Страховка на случай, если обещание не разрешится никогда (ушёл в кошелёк
    // и не вернулся, сессия отвалилась молча): и замок, и подпись на кнопке
    // обязаны отпустить сами, иначе подключиться станет нечем до перезагрузки.
    timerRef.current = setTimeout(finish, CONNECT_ATTEMPT_STALE_MS);

    // chainId передаём тот же, что подставляет RainbowKit своим коннекторам:
    // в конфиге сеть одна, и его собственный выбор всегда сводится к ней. Без
    // него подключение приходило бы на той сети, где кошелёк стоял, и человек
    // сразу упирался бы в «Wrong Network».
    void connectAsync({ connector: wc, chainId: appChainId })
      .catch((err: unknown) => {
        const outcome = classifyConnectError(err);
        if (outcome === "failed") {
          // Настоящий провал — обязан быть виден. Молчаливый отказ, выглядящий
          // как норма, — ровно тот класс бага, который здесь уже чинили.
          console.error("[connect] WalletConnect не подключился:", err);
          toast.error(t("wallet.connect_failed"));
          return;
        }
        // Закрыл модалку или уже подключён — ничего не сломалось, показывать
        // нечего. В журнал всё равно пишем: иначе отладка «нажал, ничего не
        // произошло» упирается в пустоту.
        console.warn(`[connect] попытка завершилась без подключения (${outcome}):`, err);
      })
      .finally(finish);
  }, [connectAsync, connectors, finish, openConnectModal, t]);

  return { connect, connecting };
}
