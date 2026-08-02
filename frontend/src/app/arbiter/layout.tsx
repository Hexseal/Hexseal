"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import { useRouter } from "next/navigation";
import { ARBITER_REGISTRY_ABI, DIAMOND_ABI, CONTRACTS } from "@/config/contracts";
import { Loader2, ShieldQuestion } from "lucide-react";
import { useTranslations } from "next-intl";
import { roleDenied, roleFromRead, roleGranted, roleUnreadable } from "@/lib/roleCheck";
import type { Abi } from "viem";

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Защита маршрута `/arbiter`.
 *
 * ⚠️ ЗДЕСЬ БЫЛА САМАЯ ЖЁСТКАЯ ФОРМА ТОГО ЖЕ БАГА, что унёс вкладку «Арбитр»
 * из шапки 2 августа 2026. Условие было `if (!isArbiter && !isOwner && !isChief)
 * → router.replace("/")`, а `isArbiter` — это `boolean | undefined`. Один
 * перебойный `502` от нашего же `/api/rpc` — и настоящего арбитра, открывшего
 * `/arbiter` по ссылке, ВЫКИДЫВАЛО на главную. Не «панель пустая», а «вас тут
 * нет»: `isLoading` в этот момент уже `false` (запрос завершился — ошибкой),
 * ветки `isError` не было вовсе, и провал чтения проваливался прямо в редирект.
 *
 * Теперь три ответа вместо двух (`lib/roleCheck.ts`):
 *   • хоть одно подтверждённое 'yes' → пускаем;
 *   • ВСЕ три подтверждённо 'no'     → редирект, как и раньше;
 *   • иначе (что-то не прочиталось)  → НИ пускаем, НИ выгоняем: экран
 *     «не смогли проверить» с кнопкой «повторить». Права не выданы (осторожность
 *     сохранена), но и молчаливого выброса на главную больше нет.
 */
export default function ArbiterLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const t = useTranslations();
  const { address, isConnected } = useAccount();
  const [checked, setChecked] = useState(false);

  const ownerRead = useReadContract({
    address: CONTRACTS.diamond,
    abi: DIAMOND_ABI as Abi,
    functionName: "owner",
    query: { enabled: !!address },
  }) as { data: string | undefined; isError: boolean; error: unknown; isPending: boolean; isFetching: boolean; refetch: () => void };

  const arbiterRead = useReadContract({
    address: CONTRACTS.diamond,
    abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: "isRegisteredArbiter",
    args: [address ?? ZERO],
    query: { enabled: !!address },
  }) as { data: boolean | undefined; isError: boolean; error: unknown; isPending: boolean; isFetching: boolean; refetch: () => void };

  const chiefRead = useReadContract({
    address: CONTRACTS.diamond,
    abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: "getChiefArbiter",
    query: { enabled: !!address },
  }) as { data: string | undefined; isError: boolean; error: unknown; isPending: boolean; isFetching: boolean; refetch: () => void };

  const enabled = !!address;
  const arbiterCheck = roleFromRead({ ...arbiterRead, enabled }, Boolean);
  const ownerCheck = roleFromRead(
    { ...ownerRead, enabled },
    owner => !!address && !!owner && owner.toLowerCase() === address.toLowerCase(),
  );
  const chiefCheck = roleFromRead(
    { ...chiefRead, enabled },
    chief => !!address && !!chief && chief !== ZERO && chief.toLowerCase() === address.toLowerCase(),
  );

  const allowed = roleGranted(arbiterCheck) || roleGranted(ownerCheck) || roleGranted(chiefCheck);
  /** Все три ответили, и все три — «нет». ЕДИНСТВЕННОЕ основание для редиректа. */
  const refused = roleDenied(arbiterCheck) && roleDenied(ownerCheck) && roleDenied(chiefCheck);
  const unreadable = roleUnreadable(arbiterCheck, ownerCheck, chiefCheck);
  const rechecking = arbiterRead.isFetching || ownerRead.isFetching || chiefRead.isFetching;

  const refetchArbiter = arbiterRead.refetch;
  const refetchOwner   = ownerRead.refetch;
  const refetchChief   = chiefRead.refetch;
  const recheck = useCallback(() => {
    refetchArbiter();
    refetchOwner();
    refetchChief();
  }, [refetchArbiter, refetchOwner, refetchChief]);

  useEffect(() => {
    if (!isConnected) {
      router.replace("/");
      return;
    }
    // Подключены, но адрес ещё не подтянулся — проверять нечего и выгонять не
    // за что. Без этой строки `roleFromRead` вернул бы 'no' на все три чтения
    // (запросы выключены), и `refused` выбросил бы на главную на ровном месте.
    if (!address) { setChecked(false); return; }
    if (allowed) { setChecked(true); return; }
    if (!refused) {
      // Ещё читаем или не прочиталось — не выгоняем. `checked` при этом
      // обязательно сбрасывается: иначе после смены кошелька на непроверенный
      // адрес дети успевали отрисоваться на один коммит по старому `true`.
      setChecked(false);
      return;
    }
    setChecked(false);
    router.replace("/");
  }, [isConnected, address, allowed, refused, router]);

  if (!checked && unreadable) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="max-w-sm text-center">
          <ShieldQuestion className="w-8 h-8 mx-auto text-amber-400/70" />
          <p className="mt-4 text-sm leading-snug text-amber-400/80">
            {t("arbiter.role_unreadable")}
          </p>
          <button
            type="button"
            onClick={recheck}
            disabled={rechecking}
            className="mt-4 inline-flex items-center gap-2 rounded-[12px] border border-white/15 px-4 py-2 text-sm text-white/70 hover:text-white hover:bg-white/5 transition-colors disabled:opacity-50"
          >
            {rechecking && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {rechecking ? t("common.loading") : t("common.retry")}
          </button>
        </div>
      </div>
    );
  }

  if (!checked) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <>{children}</>;
}
