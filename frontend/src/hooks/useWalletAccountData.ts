'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAccount, useBalance, useReadContract, useWriteContract, usePublicClient } from 'wagmi';
import type { Abi } from 'viem';
import { useTranslations } from 'next-intl';
import { toast } from 'react-hot-toast';
import { appChainId } from '@/config/chain';
import { CONTRACTS, ARBITER_REGISTRY_ABI, REPUTATION_ABI, DIAMOND_ABI } from '@/config/contracts';
import { useProfile } from '@/hooks/useProfile';
import { pollForFact } from '@/lib/pollForFact';
import { roleDenied, roleFailureKind, roleFromRead, roleGranted, roleUnreadable } from '@/lib/roleCheck';
import { shortAddr } from '@/lib/utils';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Single source of truth for the account/profile/contract reads that both the
 * mobile and desktop WalletMenu instances (and Header's own nav) need. Header
 * calls this once and passes the result down as props — calling it separately
 * inside each WalletMenu instance would still resolve to one network request
 * per query (react-query dedupes by queryKey), but it'd mean two live
 * observers, two re-renders, and duplicate derived-state math for every
 * balance/XP/role read, on every page, for as long as the wallet is connected.
 */
export function useWalletAccountData() {
  const t = useTranslations();
  const { address, isConnected, status, chain, chainId } = useAccount();
  // Считаем по СЫРОМУ `chainId`, а не по объекту `chain`.
  //
  // `chain` у wagmi — это `config.chains.find(c => c.id === connection.chainId)`
  // (@wagmi/core/dist/esm/actions/getAccount.js:7), а в конфиге приложения ровно
  // одна сеть (`providers.tsx`: `const chains = [appChain]`). Отсюда прежнее
  // условие `isConnected && !!chain && chain.id !== appChainId` было тождественно
  // ложным:
  //   • кошелёк в нашей сети  → chain = appChain → chain.id === appChainId → false;
  //   • кошелёк в чужой сети  → find() ничего не нашёл → chain === undefined
  //                             → `!!chain` false → тоже false.
  // То есть ровно в том случае, ради которого проверка написана, она молчала.
  //
  // Цена молчания высокая, и оно было идеально незаметным: баланс, XP и роль
  // читаются через наш собственный RPC-прокси и потому отвечают правильно даже
  // когда кошелёк стоит в чужой сети, — меню выглядело совершенно обычным.
  // Ни оранжевой точки на аватаре, ни надписи «Wrong Network», ни кнопки
  // «Switch to …» (всё это уже написано в WalletMenu и просто никогда не
  // показывалось), а любая транзакция уходила в чужую сеть по адресу, где
  // нашего кода нет.
  //
  // `chainId` в том же объекте — это `connection.chainId`, настоящий номер сети
  // кошелька, который обновляется по событию chainChanged независимо от того,
  // сконфигурирована сеть или нет. Так это уже сделано в двух других местах
  // репозитория: `app/board/client/post/page.tsx` и
  // `app/board/executor/post/page.tsx` (`chainId !== EXPECTED_CHAIN_ID`).
  //
  // Проверка на `undefined` обязательна: в статусе reconnecting адрес уже есть,
  // а номер сети может ещё не подтянуться — без неё меню моргало бы ложным
  // «Wrong Network» на каждом восстановлении сессии.
  const isWrongChain = isConnected && chainId !== undefined && chainId !== appChainId;

  const { displayName, avatarUrl: profileAvatarUrl } = useProfile(address);

  // ─────────────────────────────────────────────────────────────────────
  // РОЛИ. Три ответа, а не два — см. `lib/roleCheck.ts`.
  //
  // Здесь стояло `const isArbiter = !!isArbiterRaw` над `data: boolean |
  // undefined`, и 2 августа 2026 это стоило владельцу роли: один перебойный
  // 502 от нашего же `/api/rpc` — и `!!undefined` объявил его не арбитром.
  // Вкладка «Арбитр» исчезла из шапки, пункты арбитра — из меню, намёка на
  // то, что дело в связи, не было никакого, а вернуть всё могла только
  // перезагрузка: `refetchInterval: false` + `refetchOnWindowFocus: false`
  // (providers.tsx) означают, что упавший запрос сам не переспрашивается.
  //
  // Права по-прежнему выдаются ТОЛЬКО по подтверждённому 'yes' — осторожность
  // тут верна. Изменилось второе: молчаливое «нет» больше не выдаётся за ответ,
  // непрочитанность видна человеку и переспрашивается кнопкой.
  const arbiterRead = useReadContract({
    address: CONTRACTS.diamond,
    abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: 'isRegisteredArbiter',
    args: [address ?? ZERO_ADDRESS],
    query: { enabled: !!address },
  }) as {
    data: boolean | undefined; isError: boolean; error: unknown;
    isPending: boolean; isFetching: boolean; refetch: () => void;
  };
  const arbiterCheck = roleFromRead(
    { ...arbiterRead, enabled: !!address },
    Boolean,
  );
  const isArbiter = roleGranted(arbiterCheck);
  const refetchIsArbiter = arbiterRead.refetch;

  const { data: daoActive } = useReadContract({
    address: CONTRACTS.diamond,
    abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: 'isDaoActive',
    query: { enabled: !!address },
  }) as { data: boolean | undefined };

  const { data: onchainXP, refetch: refetchXP } = useReadContract({
    address: CONTRACTS.diamond,
    abi: REPUTATION_ABI as Abi,
    functionName: 'getXP',
    args: [address ?? ZERO_ADDRESS],
    query: { enabled: !!address },
  }) as { data: bigint | undefined; refetch: () => void };

  // Та же болезнь ровно того же вида: `!!diamondOwner` прятал ссылку на
  // «Панель админа» при любом сбое чтения `owner()`.
  const ownerRead = useReadContract({
    address: CONTRACTS.diamond,
    abi: DIAMOND_ABI as Abi,
    functionName: 'owner',
    query: { enabled: !!address },
  }) as {
    data: string | undefined; isError: boolean; error: unknown;
    isPending: boolean; isFetching: boolean; refetch: () => void;
  };
  const ownerCheck = roleFromRead(
    { ...ownerRead, enabled: !!address },
    owner => !!address && !!owner && owner.toLowerCase() === address.toLowerCase(),
  );
  const isOwner = roleGranted(ownerCheck);

  /** Хотя бы одну роль прочитать не удалось — это и есть третье состояние,
   *  которое видит человек (амбер-строка в меню + значок в шапке). */
  const rolesUnreadable = roleUnreadable(arbiterCheck, ownerCheck);
  /** Идёт повторная проверка — чтобы кнопка «Повторить» показывала крутилку,
   *  а не выглядела нажатой в пустоту. */
  const rolesRechecking = rolesUnreadable && (arbiterRead.isFetching || ownerRead.isFetching);

  // Зависимости — сами `refetch`, а не объекты чтений: объект wagmi новый на
  // каждом рендере, и `useCallback` по нему не запоминал бы ничего.
  const refetchOwner = ownerRead.refetch;
  const recheckRoles = useCallback(() => {
    refetchIsArbiter();
    refetchOwner();
  }, [refetchIsArbiter, refetchOwner]);

  // След в журнале. Разницу 'transport' (RPC отвалился) / 'contract' (цепь
  // ответила отказом — селектора нет, фасет снят) человеку показывать нечего:
  // ему в обоих случаях одинаково нечего делать. А расследованию она стоит
  // недели — именно её отсутствие 2 августа и увело диагностику в прокси.
  // `lastLoggedRef` — против записи на каждом перерендере (их у шапки много).
  const lastLoggedRef = useRef<string>('');
  const arbiterFailure = roleFailureKind(arbiterRead);
  const ownerFailure   = roleFailureKind(ownerRead);
  useEffect(() => {
    const key = [
      arbiterFailure ? `isRegisteredArbiter:${arbiterFailure}` : '',
      ownerFailure   ? `owner:${ownerFailure}`                 : '',
    ].filter(Boolean).join('|');
    if (key === lastLoggedRef.current) return;
    lastLoggedRef.current = key;
    if (!key) return;
    console.warn(
      `[roles] не прочитались: ${key}. Права не выданы, но и «нет роли» не ` +
      `утверждается — в меню кошелька показана строка «не смогли проверить».`,
    );
  }, [arbiterFailure, ownerFailure]);

  const usdcRead = useBalance({
    address,
    token: CONTRACTS.usdc as `0x${string}`,
    query: { enabled: !!address },
  });
  const usdcBalance = usdcRead.data?.value ?? BigInt(0);
  /** Тот же класс, что «оборот $0 при сбое сабграфа»: `?? 0n` превращает
   *  непрочитанный баланс в уверенные «0.00 USDC». Прав это не меняет и
   *  интерфейса не прячет, поэтому чинится мягко — прочерком вместо нуля
   *  (как в `AgreementsStats`), а не отдельным предупреждением. */
  const usdcBalanceUnavailable = !!address && usdcRead.data === undefined && usdcRead.isError;

  const [isApplying, setIsApplying] = useState(false);
  const publicClient = usePublicClient();
  const { writeContractAsync: applyAsArbiterWrite } = useWriteContract();
  // ⚠️ `roleDenied`, а НЕ `!isArbiter`. Разница ровно та, ради которой написан
  // `lib/roleCheck.ts`: «Стать арбитром» имеет смысл только для того, про кого
  // мы ТОЧНО знаем, что он ещё не арбитр. При непрочитанной роли прежнее
  // условие `!isArbiter` было истинным (`!false`), и настоящему арбитру
  // предлагалась кнопка, ведущая в гарантированный реверт `applyAsArbiter`.
  // `onchainXP !== undefined` по той же причине заменил `!!onchainXP`: там ноль
  // и «не прочиталось» были неразличимы (на пороге 3000 это ни на что не
  // влияло, но правило одно на файл).
  const canApplyAsArbiter =
    daoActive === true && roleDenied(arbiterCheck) && onchainXP !== undefined && onchainXP >= 3000n;

  const handleApplyAsArbiter = async () => {
    if (!publicClient || !address) { toast.error(t('common.error')); return; }
    setIsApplying(true);
    try {
      const hash = await applyAsArbiterWrite({
        address: CONTRACTS.diamond,
        abi: ARBITER_REGISTRY_ABI as Abi,
        functionName: 'applyAsArbiter',
      });
      // wagmi's own useWriteContract().isPending flips false as soon as the tx
      // is BROADCAST, not mined — waiting for the receipt here, then
      // explicitly refetching isRegisteredArbiter/getXP, closes the window
      // where "Become Arbiter" stayed enabled with stale pre-application
      // state and could fire a second, guaranteed-to-revert applyAsArbiter().
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === 'reverted') throw new Error('Transaction reverted on-chain');
      toast.success(t('wallet.arbiter_apply_success'));

      // Квитанция доказывает, что транзакция замайнена, и НИЧЕГО не обещает про
      // то, какой узел ответит на следующее чтение: RPC за одним URL — это пул
      // реплик, и `isRegisteredArbiter` сразу после квитанции спокойно
      // возвращает всё ещё false. Одно такое чтение и стояло здесь: тост
      // «вы арбитр», а меню без пунктов арбитра — и починить это можно было
      // только перезагрузкой страницы, потому что второго чтения не будет.
      // Опрашиваем до факта тем же помощником, что и счётчик форвардера
      // (lib/pollForFact). Блокировка кнопки держится всё это время — она
      // снимается в finally, то есть по приезду данных, а не по квитанции.
      const { satisfied } = await pollForFact(
        () => publicClient.readContract({
          address: CONTRACTS.diamond,
          abi: ARBITER_REGISTRY_ABI as Abi,
          functionName: 'isRegisteredArbiter',
          args: [address],
        }) as Promise<boolean>,
        (registered) => registered === true,
      );
      if (!satisfied) {
        // Молчать нельзя даже здесь: след в журнале — единственный способ
        // отличить «узел отстал сильнее обычного» от «мы что-то читаем не то».
        console.warn(
          `[arbiter] узел не подтвердил регистрацию ${address} за отведённые пробы — ` +
          `меню обновится следующим обычным перечитыванием`,
        );
      }
      refetchIsArbiter();
      refetchXP();
    } catch (err: unknown) {
      const e = err as { shortMessage?: string; message?: string };
      toast.error(e?.shortMessage || e?.message || t('common.error'));
    } finally {
      setIsApplying(false);
    }
  };

  // Display name priority: profile > truncated address
  const displayText = displayName || (address ? shortAddr(address) : '');
  // Avatar priority: profile > effigy identicon
  const avatarUrl = profileAvatarUrl || (address ? `https://effigy.im/a/${address}.svg` : '');

  return {
    address,
    isConnected,
    status,
    chain,
    isWrongChain,
    displayText,
    avatarUrl,
    usdcBalance,
    usdcBalanceUnavailable,
    isArbiter,
    isOwner,
    /** Вердикты целиком — для мест, где важно отличить «нет» от «не знаем».
     *  `isArbiter`/`isOwner` остаются булевыми и по-прежнему истинны ТОЛЬКО
     *  на подтверждённом 'yes': ни одна проверка прав ниже по коду не меняется. */
    arbiterCheck,
    ownerCheck,
    rolesUnreadable,
    rolesRechecking,
    recheckRoles,
    canApplyAsArbiter,
    applyPending: isApplying,
    handleApplyAsArbiter,
  };
}

export type WalletAccountData = ReturnType<typeof useWalletAccountData>;
