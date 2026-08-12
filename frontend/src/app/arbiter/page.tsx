"use client";

import { useState, useCallback, useEffect, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAccount, useReadContract, useWalletClient, usePublicClient, useWriteContract } from "wagmi";
import { isAddress } from "viem";
import { DIAMOND_ABI, ARBITER_REGISTRY_ABI, AGREEMENT_ABI, CONTRACTS } from "@/config/contracts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Loader2, AlertTriangle, CheckCircle, History, ShieldCheck, Scale,
  UserCheck, UserX, Search, Crown, UserPlus, UserMinus, MessageCircle,
  Coins, Lock, Inbox,
} from "lucide-react";
import { toast } from "react-hot-toast";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  commitDisputeClaimGasless, claimDisputeGasless, releaseDisputeGasless,
  setArbiterChatKeyGasless,
} from "@/lib/relay";
import { keccak256, encodePacked, parseAbi } from "viem";
import type { Abi, Address, Hex, TransactionReceipt } from "viem";
import { shortAddr } from "@/lib/utils";
import { DISPUTE_WINDOW_DAYS, FINALIZE_DELAY } from "@/config/constants";
import { computeArbiterReward } from "@/lib/disputeBounty";
import { withWalletLock } from "@/lib/walletLock";
import { loadPass, savePass, clearPass, type DisputeLogPass } from "@/lib/disputeLogPass";
import {
  deriveClaimChatKeys, createGatedSignChatKey, rethrowIfSignatureDeferred, runGatedKeyAction,
  type GatedSignChatKey,
} from "@/lib/arbiterClaimKeys";
import { isSignatureDeferred } from "@/lib/chatSignatureGate";
import {
  decideNoKeyNotice, decideDirectoryDivergenceNotice, readArbiterChatKeysFromChain,
  compareChainWithDirectory, type ChainChatKeys, type DirectoryVerdict,
} from "@/lib/arbiterChatKey";
import { fetchPeerChatKeys } from "@/hooks/useChatSession";
import { requestBagPass } from "@/lib/chatTransport";
import { ArbiterPresentationsTab, type ArbiterCase } from "@/components/ArbiterPresentations";

// viem's waitForTransactionReceipt resolves on a REVERTED receipt too — it
// only rejects if the receipt never arrives. Every call site below must check
// this explicitly, or a reverted tx (e.g. finalizeVerdict called before
// FINALIZE_DELAY has passed) shows the same success toast as a real one,
// telling the arbiter a case is resolved when nothing actually happened.
function assertMined(receipt: TransactionReceipt): void {
  if (receipt.status === 'reverted') throw new Error('Transaction reverted on-chain');
}

// Agreement.Status: 0=CREATED 1=FUNDED 2=ACTIVE 3=COMPLETED 4=DISPUTED 5=RESOLVED 6=REFUNDED
const AGREEMENT_STATUS_DISPUTED = 4;
const TERMINAL = new Set([3, 5, 6]);

const STATUS_KEYS: Record<number, string> = {
  0: "arbiter.status_created", 1: "arbiter.status_funded",  2: "arbiter.status_active",
  3: "arbiter.status_completed", 4: "arbiter.status_disputed", 5: "arbiter.status_resolved",
  6: "arbiter.status_refunded",
};

const HIST_DETAIL_ABI = parseAbi([
  'function getDetails() view returns (address,address,address,uint256,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint8)',
]);
interface HistDetail { client: string; executor: string; amount: bigint; resolvedAt: bigint; status: number; }

type AgreementRecord = {
  agreement: string; client: string; executor: string;
  amount: bigint; status: number; createdAt: bigint; resolvedAt: bigint;
};

type PendingVerdict = {
  arbiter: string; clientWins: boolean; submittedAt: bigint;
  frozen: boolean; finalized: boolean; overturned: boolean;
};

function fmtUSDC(v: bigint)   { return (Number(v) / 1e6).toFixed(2); }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fmtTimeLeft(seconds: bigint | number | undefined, t: (k: any, v?: any) => string): string {
  if (!seconds) return "—";
  const s = Number(BigInt(seconds));
  if (s <= 0) return t("arbiter.time_expired");
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return t("arbiter.time_left_dhm", { d, h });
  if (h > 0) return t("arbiter.time_left_hm", { h, m });
  return t("arbiter.time_left_m", { m });
}

// ─── Tab component ────────────────────────────────────────────────────────────

function Tab({ active, onClick, children, count }: {
  active: boolean; onClick: () => void; children: ReactNode; count?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium rounded-[10px] transition-colors flex items-center gap-1.5 flex-shrink-0 ${
        active ? "bg-white/10 text-white" : "text-white/40 hover:text-white/70 hover:bg-white/5"
      }`}
    >
      {children}
      {count !== undefined && count > 0 && (
        <span className={`text-[11px] px-1.5 py-0.5 rounded-md font-mono ${
          active ? "bg-white/15 text-white/80" : "bg-white/8 text-white/35"
        }`}>{count}</span>
      )}
    </button>
  );
}

function SectionEmpty({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="text-center py-10">
      <div className="w-10 h-10 rounded-[12px] bg-white/[0.03] border border-white/[0.06] flex items-center justify-center mx-auto mb-3">
        {icon}
      </div>
      <p className="text-sm text-white/30">{text}</p>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type TabKey = "disputes" | "mine" | "presentations" | "history" | "manage";

export default function ArbiterPage() {
  const t = useTranslations();
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  // Ключ = действие + дело, а не один голый адрес дела. По одному делу на
  // экране стоят «Вернуть клиенту», «Заплатить исполнителю» и «Отказаться от
  // дела» разом, а на вкладке споров — «Взяться» и «Отказаться»: общий на всех
  // ключ зажигал крутилку сразу на нескольких кнопках. Блокировка остаётся
  // общей — вердикты и клеймы идут из одного кошелька по очереди.
  const [busy, setBusy]           = useState<string | null>(null);
  const [refresh, setRefresh]     = useState(0);
  const [tab, setTab]             = useState<TabKey>("disputes");
  const [historyQ, setHistoryQ]   = useState("");
  const [histDetails, setHistDetails] = useState<Record<string, HistDetail>>({});
  const bump = useCallback(() => setRefresh(k => k + 1), []);

  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

  const { data: ownerAddr } = useReadContract({
    address: CONTRACTS.diamond, abi: DIAMOND_ABI as Abi,
    functionName: "owner", query: { enabled: !!address },
  }) as { data: string | undefined };

  const { data: chiefArbiterAddr } = useReadContract({
    address: CONTRACTS.diamond, abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: "getChiefArbiter", query: { enabled: !!address },
  }) as { data: string | undefined };

  const { data: isArbiter } = useReadContract({
    address: CONTRACTS.diamond, abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: "isRegisteredArbiter", args: [address ?? ZERO_ADDR as Address],
    query: { enabled: !!address },
  }) as { data: boolean | undefined };

  // Есть ли у меня ключ в цепи, и совпадает ли он с тем, что знает справочник
  // на нашем сервере. Ключ ЧИТАЕТСЯ ИЗ ЦЕПИ через readArbiterChatKeysFromChain
  // (arbiterChatKey.ts) — не своим инлайновым useReadContract: там объявлена
  // «точка доверия», где порядок boxKey/signKey прибит к исходнику контракта
  // и заперт claimAbiMatchesContract.test.ts. Свой инлайновый вызов рядом был
  // бы вторым, несинхронизированным чтением того же самого.
  //
  // Справочник (решение владельца 9 августа) — только свидетель: он живёт на
  // нашем сервере, и кто до сервера добрался, подсунул бы свой ключ вместо
  // моего. Решает ВСЕГДА цепь; справочник лишь позволяет заметить подмену —
  // и об этом расхождении (`directory_differs`) МЫ ГОВОРИМ ВСЛУХ
  // (arbiter.key_directory_mismatch). Отставший справочник (`directory_missing`)
  // — не тревога, молчим (compareChainWithDirectory, decideDirectoryDivergenceNotice).
  const [myChainKeys, setMyChainKeys] = useState<ChainChatKeys | null>(null);
  const [myChainKeysError, setMyChainKeysError] = useState<unknown>(null);
  const [directoryVerdict, setDirectoryVerdict] = useState<DirectoryVerdict | null>(null);
  const [chainKeysTick, setChainKeysTick] = useState(0);
  const refetchMyChainKeys = useCallback(() => setChainKeysTick(k => k + 1), []);

  useEffect(() => {
    if (!address || !publicClient) {
      setMyChainKeys(null); setMyChainKeysError(null); setDirectoryVerdict(null);
      return;
    }
    let cancelled = false;
    readArbiterChatKeysFromChain(publicClient, address)
      .then(async (keys) => {
        if (cancelled) return;
        setMyChainKeys(keys);
        setMyChainKeysError(null);
        // Справочник — только свидетель. Провал его чтения РАВЕН
        // directory_missing (compareChainWithDirectory увидит null здесь) —
        // молчим, как и задумано, а не превращаем отказ сети в тревогу.
        let directory: { boxKey: Uint8Array; signKey: Uint8Array | null } | null = null;
        try {
          const peer = await fetchPeerChatKeys(address);
          directory = { boxKey: peer.boxKey, signKey: peer.signKey };
        } catch { /* directory_missing ниже и так покрывает молчание справочника */ }
        if (cancelled) return;
        setDirectoryVerdict(compareChainWithDirectory(keys, directory));
      })
      .catch((err) => {
        if (cancelled) return;
        setMyChainKeys(null);
        setMyChainKeysError(err);
        setDirectoryVerdict(null);
      });
    return () => { cancelled = true; };
  }, [address, publicClient, chainKeysTick]);

  // Решение вынесено в decideNoKeyNotice (arbiterChatKey.ts) и НЕ повторяется
  // здесь условием на месте: отказ чтения (функции ещё нет в даймонде до
  // разреза) — это НЕ «ключа нет», и различать их обязана ОДНА функция с
  // замером на неё, а не копия условия в разметке.
  const showNoKeyNotice = decideNoKeyNotice({
    keys: myChainKeys ? [myChainKeys.boxKey, myChainKeys.signKey] : undefined,
    error: myChainKeysError,
  });
  const showDirectoryMismatchNotice = decideDirectoryDivergenceNotice(directoryVerdict);

  const { data: myReward, refetch: refetchReward } = useReadContract({
    address: CONTRACTS.diamond, abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: "getArbiterReward", args: [address ?? ZERO_ADDR as Address],
    scopeKey: `arbiter-${refresh}`,
    query: { enabled: !!address && !!isArbiter },
  }) as { data: bigint | undefined; refetch: () => void };

  const isOwner       = !!address && !!ownerAddr && ownerAddr.toLowerCase() === address.toLowerCase();
  const isChiefArbiter = !!address && !!chiefArbiterAddr &&
    chiefArbiterAddr !== ZERO_ADDR &&
    chiefArbiterAddr.toLowerCase() === address.toLowerCase();
  const showManage = isOwner || isChiefArbiter;

  const { data: disputed, isLoading: loadingDisputed } = useReadContract({
    address: CONTRACTS.diamond, abi: DIAMOND_ABI as Abi,
    functionName: "getDisputed",
    scopeKey: `arbiter-${refresh}`, query: { gcTime: 0, staleTime: 0 },
  }) as { data: AgreementRecord[] | undefined; isLoading: boolean };

  const { data: myHistory, isLoading: loadingMine } = useReadContract({
    address: CONTRACTS.diamond, abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: "getArbiterDeals",
    args: [address ?? ZERO_ADDR as Address],
    scopeKey: `arbiter-${refresh}`,
    query: { enabled: !!address, gcTime: 0, staleTime: 0 },
  }) as { data: string[] | undefined; isLoading: boolean };

  useEffect(() => {
    if (!myHistory?.length || !publicClient) return;
    Promise.all(myHistory.map(addr =>
      publicClient.readContract({
        address: addr as `0x${string}`, abi: HIST_DETAIL_ABI, functionName: "getDetails",
      }).then((r: any) => [addr, {
        client: r[0] as string, executor: r[1] as string,
        amount: r[3] as bigint, resolvedAt: r[10] as bigint, status: Number(r[11]),
      }] as const).catch(() => null)
    )).then(pairs => {
      const map: Record<string, HistDetail> = {};
      pairs.forEach(p => { if (p) map[p[0]] = p[1]; });
      setHistDetails(map);
    });
  }, [myHistory, publicClient]);

  const disputedList = disputed ?? [];

  // Дела, где ящик спора МОЖЕТ быть мне доступен.
  //
  // ⚠️ ОТБИРАТЬ ПО СТАТУСУ ЗДЕСЬ ЗАПРЕЩЕНО (договор шапки плана, §4). Право
  // читать ящик даёт `disputeArbiterOf`, а не статус сделки: после вердикта
  // дело уходит в RESOLVED (а при дележе без вердикта — в REFUNDED), клеймо
  // спора обнуляется `_clearDisputeClaim`, и правило держится второй
  // половиной — `getPendingVerdict().arbiter` при `submittedAt != 0`.
  // Апелляцию арбитр разбирает ИМЕННО в этом промежутке, и Задача 2
  // специально держит мешки живыми до её конца. Фильтр `status === 4` сделал
  // бы предъявленное недостижимым ровно в тот момент, ради которого его
  // хранили и оплачивали местом на диске.
  //
  // Список приходит из цепи: `getArbiterDeals(me)` — это дела, где спор брал Я.
  // Статус употребляется РОВНО НА ОДНО: порядок (живой спор выше) — тот же
  // приём, что с `sealedFor` у мешков, где заявление годится для очерёдности и
  // не годится для выбрасывания. Ответ «ящик не ваш» даёт СЕРВЕР, прочитав
  // цепь, и печатается строками `presentations_not_mine` /
  // `presentations_box_closed`.
  const myBoxCases: ArbiterCase[] = [...(myHistory ?? [])]
    .sort((x, y) =>
      Number(histDetails[y]?.status === AGREEMENT_STATUS_DISPUTED) -
      Number(histDetails[x]?.status === AGREEMENT_STATUS_DISPUTED))
    .map(a => ({
      agreement: a as `0x${string}`,
      client: (histDetails[a]?.client ?? ZERO_ADDR) as `0x${string}`,
      executor: (histDetails[a]?.executor ?? ZERO_ADDR) as `0x${string}`,
    }));

  // Подписчик ключа чата — тот же раскрой, что у заявки и публикации ключа.
  // Создаётся ЗДЕСЬ, а не в панели: гейт «места подписи наперечёт»
  // (lib/signaturePaths.test.ts) перечисляет файлы поимённо, и панель, позвав
  // кошелёк сама, добавила бы в список новый файл — то есть потребовала бы
  // осознанного решения там, где его можно не заметить.
  const signChatKeyForBox = useCallback((): GatedSignChatKey | null => {
    if (!walletClient || !address) return null;
    return createGatedSignChatKey((typedData) =>
      withWalletLock(address, () => walletClient.signTypedData({
        account: walletClient.account!,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(typedData as any),
      })) as Promise<`0x${string}`>,
    );
  }, [walletClient, address]);

  // Пропуск склада — НЕ через `getBagPass`: та стоит за порогом «наш ключ
  // объявлен в справочнике», а ящик спора закрыт ЦЕПЬЮ, и справочник к нему
  // отношения не имеет. Подпись при этом остаётся под общим мьютексом кошелька.
  const getBoxPass = useCallback(async (): Promise<string> => {
    if (!walletClient || !address) throw new Error("wallet");
    const { pass } = await requestBagPass(
      (message) => withWalletLock(address, () => walletClient.signMessage({ account: address, message })),
      address.toLowerCase() as `0x${string}`,
    );
    return pass;
  }, [walletClient, address]);

  const handleClaim = async (agreement: string) => {
    if (!walletClient || !publicClient || !address) { toast.error(t("common.error")); return; }
    // Отметка ухода к кошельку и сам вызов подписи — из общей обёртки
    // (`createGatedSignChatKey`, arbiterClaimKeys.ts), а НЕ повторены здесь
    // руками. Тип `GatedSignChatKey` (не голый `SignChatKey`) — граница
    // компилятора, не только соглашение: подставить сюда неотмеченного
    // подписчика (`signChatKey = <голая функция>`) теперь не проходит
    // `npm run type-check`, а не просто «расходится с тестом».
    //
    // ⚠️ ОБЩИЙ МЬЮТЕКС КОШЕЛЬКА — НАХОДКА РАУНДА УСИЛЕНИЯ ГЕЙТА
    // (`lib/signaturePaths.test.ts`, 10 августа 2026). Этот вызов подписи
    // существовал в файле рядом с импортом `withWalletLock` (тот берётся
    // ниже, для «View history»), но сам НЕ был им обёрнут — прежний, слабый
    // гейт проверял только факт импорта и такой пропуск не видел. Без
    // обёртки заявка на спор из этой вкладки могла столкнуться в кошельке с
    // любым другим окном подписи приложения (страница сделки, профиль,
    // пуши, вторая вкладка того же арбитра) — ровно тот -32002, ради
    // которого мьютекс и заведён.
    const signChatKey: GatedSignChatKey = createGatedSignChatKey((typedData) =>
      withWalletLock(address, () => walletClient.signTypedData({
        account: walletClient.account!,
        ...(typedData as any),
      })) as Promise<`0x${string}`>,
    );
    setBusy(`claim:${agreement}`);
    // The salt used to live only in this closure's local memory — if the tab
    // closed/reloaded (or the wallet/network hung and the user gave up) in the
    // ~100s window between the commit landing and the reveal completing, it
    // was permanently and unrecoverably lost: the on-chain commitment sat
    // forever unused, and completing the claim needed starting over from a
    // brand-new commit. Persist it immediately so a resumed attempt for the
    // same agreement can go straight to the reveal instead.
    const storageKey = `hexseal-arb-salt-${agreement.toLowerCase()}`;
    const commitToast = toast.loading(t("arbiter.claim_step1"));
    try {
      let salt = (() => { try { return localStorage.getItem(storageKey) as Hex | null; } catch { return null; } })();
      if (salt) {
        try {
          // Коммит уже был замайнен раньше (другая вкладка, прерванная
          // попытка) — ждать блок не нужно, но ключ всё равно добывается
          // только сейчас, по нажатию, тем же вызовом, что и в полном пути.
          toast.loading(t("arbiter.claim_key"), { id: commitToast });
          // Гейт-последовательность (сброс отметки → гейт перед добычей ключа
          // → добыча → гейт перед заявкой) — из общей runGatedKeyAction
          // (arbiterClaimKeys.ts), не пересобрана здесь руками: три места
          // страницы обязаны вести себя одинаково, а не разъехаться со
          // временем.
          const { txHash: claimTx } = await runGatedKeyAction(
            () => deriveClaimChatKeys(address as Address, signChatKey),
            (keys) => {
              toast.loading(t("arbiter.claim_step2"), { id: commitToast });
              return claimDisputeGasless(
                walletClient, publicClient, agreement as Address, salt as Hex,
                keys.boxKey, keys.signKey,
              );
            },
          );
          assertMined(await publicClient.waitForTransactionReceipt({ hash: claimTx as `0x${string}` }));
          try { localStorage.removeItem(storageKey); } catch { /* unavailable */ }
          toast.success(t("arbiter.claim_success"), { id: commitToast });
          bump();
          // Заявка только что записала ключ в цепь (claimDisputeGasless возит
          // boxKey/signKey) — без этого плашка «нет ключа» осталась бы висеть
          // до следующего действия на странице, хотя ключ уже на месте.
          // handlePublishKey уже так делает — здесь тот же случай.
          refetchMyChainKeys();
          return;
        } catch (revealErr) {
          // Проброс отсрочки гейта — из общего ДЕЙСТВИЯ
          // (`rethrowIfSignatureDeferred`, arbiterClaimKeys.ts), не решение,
          // переписанное заново здесь: отсрочка гейта — НЕ провалившееся
          // предъявление, коммит остаётся валиден, соль остаётся на
          // устройстве. Жечь свежий коммит из-за того, что страница ушла в
          // кошелёк, было бы неверно — нужно просто нажать ещё раз. Функция
          // либо бросает сама (и код ниже не выполнится), либо не бросает —
          // смотреть на результат нечего, у вызова нет ничего, что можно
          // забыть проверить.
          rethrowIfSignatureDeferred(revealErr);
          try { localStorage.removeItem(storageKey); } catch { /* unavailable */ }
          salt = null;
          // A failed reveal doesn't necessarily mean the commitment is stale —
          // e.g. two tabs on the same arbiter wallet both claiming the same
          // dispute: the second tab's reveal correctly fails because the FIRST
          // tab's claim already landed. Falling through to a brand-new commit
          // in that case burns a real relayer-paid transaction for a claim
          // that can never succeed. Check on-chain first and stop here if
          // someone (including this same arbiter, via another tab) already
          // claimed it.
          const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
          try {
            const claimer = await publicClient.readContract({
              address: CONTRACTS.diamond, abi: ARBITER_REGISTRY_ABI as Abi,
              functionName: "getDisputeClaimer", args: [agreement as Address],
            }) as Address;
            if (claimer && claimer !== ZERO_ADDR) {
              toast.error(
                claimer.toLowerCase() === address.toLowerCase()
                  ? 'You already claimed this dispute in another tab.'
                  : 'Someone else already claimed this dispute.',
                { id: commitToast },
              );
              bump();
              // Если клеймер — это МЫ (другая вкладка), ключ уже лёг в цепь
              // оттуда, а эта вкладка ещё не знает.
              if (claimer.toLowerCase() === address.toLowerCase()) refetchMyChainKeys();
              return;
            }
          } catch { /* on-chain check failed — fall through and try a fresh commit */ }
        }
      }

      const saltBytes = crypto.getRandomValues(new Uint8Array(32));
      salt = ("0x" + Array.from(saltBytes).map(b => b.toString(16).padStart(2, "0")).join("")) as Hex;
      try { localStorage.setItem(storageKey, salt); } catch { /* unavailable — resume just won't work */ }
      const commitment = keccak256(encodePacked(
        ["address", "address", "bytes32"],
        [agreement as Address, address as Address, salt],
      ));
      toast.loading(t("arbiter.claim_step1"), { id: commitToast });
      const { txHash: commitTx } = await commitDisputeClaimGasless(walletClient, publicClient, commitment);
      toast.loading(t("arbiter.claim_confirming"), { id: commitToast });
      assertMined(await publicClient.waitForTransactionReceipt({ hash: commitTx as `0x${string}` }));

      // Ключ добывается ЗДЕСЬ — в мёртвом времени между двумя ходами заявки.
      // Порядок выбран владельцем: только по его действию, никаких «заранее».
      // На критический путь это не ложится: гонку за спор решает claimDispute,
      // а не коммит.
      toast.loading(t("arbiter.claim_key"), { id: commitToast });
      const { txHash: claimTx } = await runGatedKeyAction(
        () => deriveClaimChatKeys(address as Address, signChatKey),
        (keys) => {
          toast.loading(t("arbiter.claim_step2"), { id: commitToast });
          return claimDisputeGasless(
            walletClient, publicClient, agreement as Address, salt as Hex,
            keys.boxKey, keys.signKey,
          );
        },
      );
      assertMined(await publicClient.waitForTransactionReceipt({ hash: claimTx as `0x${string}` }));
      try { localStorage.removeItem(storageKey); } catch { /* unavailable */ }
      toast.success(t("arbiter.claim_success"), { id: commitToast });
      bump();
      // См. комментарий у того же вызова на быстром пути выше: заявка только
      // что записала ключ в цепь, плашка «нет ключа» обязана это увидеть.
      refetchMyChainKeys();
    } catch (err: any) {
      // Гейт отложил подпись, потому что страница уходила к кошельку. Это не
      // ошибка: человеку надо нажать ещё раз, и тогда окно откроется по его
      // действию, а не в замороженную вкладку.
      if (isSignatureDeferred(err)) {
        toast(t("arbiter.claim_press_again"), { id: commitToast });
        return;
      }
      toast.error(err?.message || t("common.error"), { id: commitToast });
    } finally { setBusy(null); }
  };

  const handleRelease = async (agreement: string) => {
    if (!walletClient || !publicClient) { toast.error(t("common.error")); return; }
    setBusy(`release:${agreement}`);
    try {
      toast(t("arbiter.releasing"));
      const { txHash } = await releaseDisputeGasless(walletClient, publicClient, agreement as Address);
      assertMined(await publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}` }));
      toast.success(t("arbiter.release_success"));
      bump();
    } catch (err: any) {
      toast.error(err?.message || t("common.error"));
    } finally { setBusy(null); }
  };

  // Для арбитра, взявшего спор ДО апгрейда 9 августа: тогда заявка ключей не
  // возила, и в цепи их нет. Одна транзакция публикует их отдельно от заявки —
  // сторона на предъявлении наконец получит, кому предъявлять.
  const handlePublishKey = async () => {
    if (!walletClient || !publicClient || !address) { toast.error(t("common.error")); return; }
    // Тот же защищённый подписчик, что уже применяется в handleClaim выше —
    // не свой отдельный. GatedSignChatKey — фирменный тип: подставить сюда
    // голый SignChatKey не даст скомпилироваться.
    //
    // ⚠️ ОБЩИЙ МЬЮТЕКС КОШЕЛЬКА — та же находка раунда усиления гейта, что и
    // у handleClaim выше: см. комментарий там.
    const signChatKey: GatedSignChatKey = createGatedSignChatKey((typedData) =>
      withWalletLock(address, () => walletClient.signTypedData({
        account: walletClient.account!,
        ...(typedData as any),
      })) as Promise<`0x${string}`>,
    );
    setBusy("publish-key");
    const id = toast.loading(t("arbiter.claim_key"));
    try {
      // Ключ добывается ЗДЕСЬ, по нажатию — не на входе на страницу. Гейт —
      // из общей runGatedKeyAction (arbiterClaimKeys.ts), той же, что
      // handleClaim выше: третье место с тем же приёмом не заводит свою копию.
      const { txHash } = await runGatedKeyAction(
        () => deriveClaimChatKeys(address as Address, signChatKey),
        (keys) => setArbiterChatKeyGasless(walletClient, publicClient, keys.boxKey, keys.signKey),
      );
      assertMined(await publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}` }));
      toast.success(t("arbiter.key_published"), { id });
      refetchMyChainKeys();
    } catch (err: any) {
      if (isSignatureDeferred(err)) { toast(t("arbiter.claim_press_again"), { id }); return; }
      toast.error(err?.message || t("common.error"), { id });
    } finally { setBusy(null); }
  };

  // submitVerdict only — finalizeVerdict is a SEPARATE step, gated by the
  // contract's own FINALIZE_DELAY (24h) after submittedAt. Calling it right
  // after submit is guaranteed to revert every time, and viem's
  // waitForTransactionReceipt resolves on a reverted receipt too (it doesn't
  // throw), so an auto-chained call here used to show a false "resolved"
  // success toast for a verdict that was never actually finalized — no funds
  // moved, Agreement.status stayed DISPUTED, and the arbiter believed the
  // case was closed when it wasn't. The MyCaseCard's own "Finalize Verdict"
  // button (verdictReady state, gated on the 24h window below) is the only
  // place finalizeVerdict is called from now.
  const handleSubmitVerdict = async (agreement: string, clientWins: boolean) => {
    if (!publicClient) { toast.error(t("common.error")); return; }
    setBusy(`verdict:${clientWins ? 'client' : 'executor'}:${agreement}`);
    const id = toast.loading(clientWins ? t("arbiter.submitting_refund") : t("arbiter.submitting_pay"));
    try {
      const hash1 = await writeContractAsync({
        address: CONTRACTS.diamond as Address, abi: ARBITER_REGISTRY_ABI as Abi,
        functionName: "submitVerdict", args: [agreement as Address, clientWins],
      });
      assertMined(await publicClient.waitForTransactionReceipt({ hash: hash1 }));

      toast.success(t("arbiter.verdict_pending"), { id });
      bump();
    } catch (err: any) {
      toast.error(err?.shortMessage || err?.message || t("arbiter.resolve_failed"), { id });
    } finally { setBusy(null); }
  };

  // Finalize an already-submitted verdict, once FINALIZE_DELAY has passed.
  const handleFinalizeVerdict = async (agreement: string) => {
    if (!publicClient) { toast.error(t("common.error")); return; }
    setBusy(`finalize:${agreement}`);
    const id = toast.loading(t("arbiter.finalizing"));
    try {
      const hash = await writeContractAsync({
        address: CONTRACTS.diamond as Address, abi: ARBITER_REGISTRY_ABI as Abi,
        functionName: "finalizeVerdict", args: [agreement as Address],
      });
      assertMined(await publicClient.waitForTransactionReceipt({ hash }));
      toast.success(t("arbiter.pay_success"), { id });
      bump();
    } catch (err: any) {
      toast.error(err?.shortMessage || err?.message || t("arbiter.resolve_failed"), { id });
    } finally { setBusy(null); }
  };

  const handleWithdraw = async () => {
    if (!publicClient) return;
    setBusy("reward");
    const id = toast.loading(t("arbiter.withdrawing"));
    try {
      const hash = await writeContractAsync({
        address: CONTRACTS.diamond as Address, abi: ARBITER_REGISTRY_ABI as Abi,
        functionName: "withdrawArbiterReward",
      });
      assertMined(await publicClient.waitForTransactionReceipt({ hash }));
      toast.success(t("arbiter.reward_withdrawn"), { id });
      refetchReward();
      bump();
    } catch (err: any) {
      toast.error(err?.shortMessage || err?.message || t("common.error"), { id });
    } finally { setBusy(null); }
  };

  return (
    <div className="mx-auto px-4 py-5 max-w-6xl space-y-4">

      {/* ── Page header ── */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-[14px] bg-white/[0.06] border border-white/[0.06] flex items-center justify-center flex-shrink-0">
          <ShieldCheck className="w-5 h-5 text-white/50" />
        </div>
        <div>
          <h1 className="text-2xl font-bold font-syne leading-tight">{t("arbiter.title")}</h1>
          <p className="text-xs text-white/40 mt-0.5">{t("arbiter.subtitle")}</p>
        </div>
      </div>

      {/* ── Расхождение ключа со справочником ── Решает всегда цепь; это
          только СЛОВО о том, что наш сервер называет другой ключ — иначе о
          подмене на сервере мы бы не узнали никогда (решение владельца
          9 августа). Не гейтится isArbiter: если ключ уже был опубликован,
          знать об этом важно и разжалованному арбитру с открытым делом
          (submitVerdict проверяет только disputeClaims, не isArbiter). */}
      {showDirectoryMismatchNotice && (
        <div className="rounded-[16px] border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3 flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-400/70 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-300/85 leading-relaxed">{t("arbiter.key_directory_mismatch")}</p>
        </div>
      )}

      {/* ── Reward strip ── */}
      {isArbiter && myReward !== undefined && myReward > 0n && (
        <div
          className="rounded-[16px] border border-emerald-500/20 bg-emerald-500/[0.04] px-4 py-3 flex items-center justify-between gap-3"
          style={{ boxShadow: "0 0 0 1px rgba(16,185,129,0.06) inset" }}
        >
          <div className="flex items-center gap-2.5">
            <Coins className="w-4 h-4 text-emerald-400/70 shrink-0" />
            <div>
              <p className="text-[11px] text-emerald-400/60 uppercase tracking-wider font-semibold">{t("arbiter.reward_title")}</p>
              <p className="text-lg font-bold font-mono text-emerald-300">${fmtUSDC(myReward)} USDC</p>
            </div>
          </div>
          {/* `disabled` — общий `!!busy`, как у всех остальных кнопок страницы.
              Раньше здесь стоял `busy === "reward"`: вывод награды оставался
              нажимаемым поверх летящего клейма или вердикта, перетирал их ключ
              своим, и его собственный finally оживлял кнопки спора, пока та
              транзакция ещё не приземлилась. */}
          <Button
            size="sm"
            onClick={handleWithdraw}
            disabled={!!busy}
            className="bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/25 shrink-0"
          >
            {busy === "reward" ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
            {t("arbiter.withdraw_btn")}
          </Button>
        </div>
      )}

      {/* ── Main panel ── */}
      <div
        className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] overflow-hidden"
        style={{ boxShadow: "0 4px 24px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.04)" }}
      >
        {/* Tab bar */}
        <div className="flex gap-1 p-2 border-b border-white/[0.06] overflow-x-auto scrollbar-none">
          <Tab active={tab === "disputes"} onClick={() => setTab("disputes")} count={disputedList.length}>
            <AlertTriangle className="w-3.5 h-3.5" />
            {t("arbiter.tab_disputes")}
          </Tab>
          <Tab active={tab === "mine"} onClick={() => setTab("mine")}>
            <Scale className="w-3.5 h-3.5" />
            {t("arbiter.tab_my_cases")}
          </Tab>
          {/* Число на вкладке = сколько КАРТОЧЕК внутри, то есть сколько споров я
              когда-либо брал, а не сколько живых. Обещать «столько-то ждут вас»
              нечем: доступен ящик или нет, знает сервер, и только по нажатию. */}
          <Tab active={tab === "presentations"} onClick={() => setTab("presentations")} count={myBoxCases.length}>
            <Inbox className="w-3.5 h-3.5" />
            {t("arbiter.tab_presentations")}
          </Tab>
          <Tab active={tab === "history"} onClick={() => setTab("history")}>
            <History className="w-3.5 h-3.5" />
            {t("arbiter.tab_history")}
          </Tab>
          {showManage && (
            <Tab active={tab === "manage"} onClick={() => setTab("manage")}>
              <Crown className="w-3.5 h-3.5 text-amber-400" />
              {t("arbiter.tab_manage")}
            </Tab>
          )}
        </div>

        {/* ── Tab content ── */}
        <div className="p-3 sm:p-4">
          <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18 }}
          >

          {/* ── Open Disputes ── */}
          {tab === "disputes" && (
            loadingDisputed ? (
              <div className="flex items-center justify-center py-12 gap-2 text-white/30">
                <Loader2 className="w-4 h-4 animate-spin" /><span className="text-sm">{t("common.loading")}</span>
              </div>
            ) : disputedList.length === 0 ? (
              <SectionEmpty
                icon={<CheckCircle className="w-5 h-5 text-white/15" />}
                text={t("arbiter.no_disputes")}
              />
            ) : (
              <div className="space-y-3">
                {disputedList.map(rec => (
                  <DisputeCard
                    key={`${rec.agreement}-${refresh}`}
                    rec={rec}
                    myAddress={address}
                    busy={busy}
                    onClaim={handleClaim}
                    onRelease={handleRelease}
                  />
                ))}
              </div>
            )
          )}

          {/* ── My Active Cases ── */}
          {tab === "mine" && (
            loadingMine ? (
              <div className="flex items-center justify-center py-12 gap-2 text-white/30">
                <Loader2 className="w-4 h-4 animate-spin" /><span className="text-sm">{t("common.loading")}</span>
              </div>
            ) : !myHistory || myHistory.length === 0 ? (
              <SectionEmpty
                icon={<Scale className="w-5 h-5 text-white/15" />}
                text={t("arbiter.no_cases")}
              />
            ) : (
              <div className="space-y-3">
                {/* Срок явки арбитра. Строка существовала, но не рендерилась
                    нигде — и врала про «7-дневное окно» через год после того,
                    как DISPUTE_WINDOW стала четырёхдневной. Именно это и стоит
                    арбитру судейской ошибки за неявку, поэтому окно теперь
                    показывается, и число берётся из константы. */}
                <p className="text-xs text-white/30 leading-relaxed">
                  {t("arbiter.my_cases_desc", { days: DISPUTE_WINDOW_DAYS })}
                </p>
                {myHistory.map(addr => (
                  <MyCaseCard
                    key={`${addr}-${refresh}`}
                    agreement={addr}
                    myAddress={address}
                    busy={busy}
                    refresh={refresh}
                    onRelease={handleRelease}
                    onSubmitVerdict={handleSubmitVerdict}
                    onFinalizeVerdict={handleFinalizeVerdict}
                    showNoKeyNotice={showNoKeyNotice}
                    onPublishKey={handlePublishKey}
                    isArbiter={!!isArbiter}
                  />
                ))}
              </div>
            )
          )}

          {/* ── Предъявления ── */}
          {tab === "presentations" && (
            <ArbiterPresentationsTab
              cases={myBoxCases}
              me={address}
              chainKeys={myChainKeys}
              publicClient={publicClient}
              signChatKey={signChatKeyForBox}
              getBoxPass={getBoxPass}
            />
          )}

          {/* ── History ── */}
          {tab === "history" && (
            loadingMine ? (
              <div className="flex items-center justify-center py-12 gap-2 text-white/30">
                <Loader2 className="w-4 h-4 animate-spin" /><span className="text-sm">{t("common.loading")}</span>
              </div>
            ) : !myHistory || myHistory.length === 0 ? (
              <SectionEmpty
                icon={<History className="w-5 h-5 text-white/15" />}
                text={t("arbiter.no_history")}
              />
            ) : (
              <>
                <div className="relative mb-4">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30 pointer-events-none" />
                  <Input
                    placeholder={t("arbiter.search_placeholder")}
                    value={historyQ}
                    onChange={e => setHistoryQ(e.target.value)}
                    className="pl-9 bg-transparent border-white/[0.08] placeholder:text-white/20 rounded-[14px] text-sm"
                  />
                </div>
                <p className="text-xs text-white/25 font-mono mb-3">{t("arbiter.total_cases", { count: myHistory.length })}</p>
                <div>
                  {myHistory
                    .filter(addr => {
                      if (!historyQ) return true;
                      const q = historyQ.toLowerCase();
                      const d = histDetails[addr];
                      return addr.toLowerCase().includes(q) ||
                        d?.client.toLowerCase().includes(q) ||
                        d?.executor.toLowerCase().includes(q);
                    })
                    .map(addr => (
                      <HistoryRow key={`${addr}-${refresh}`} agreement={addr} prefetched={histDetails[addr]} />
                    ))
                  }
                </div>
              </>
            )
          )}

          {/* ── Manage ── */}
          {tab === "manage" && showManage && <ManagePanel isOwner={isOwner} />}

          </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

// ─── DisputeCard ─────────────────────────────────────────────────────────────

function DisputeCard({
  rec, myAddress, busy, onClaim, onRelease,
}: {
  rec: AgreementRecord; myAddress?: string;
  busy: string | null; onClaim: (a: string) => void; onRelease: (a: string) => void;
}) {
  const t = useTranslations();
  const { data: claimer } = useReadContract({
    address: CONTRACTS.diamond, abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: "getDisputeClaimer", args: [rec.agreement as Address],
  }) as { data: string | undefined };

  const { data: timeLeft } = useReadContract({
    address: rec.agreement as Address, abi: AGREEMENT_ABI as Abi,
    functionName: "arbiterTimeLeft",
  }) as { data: bigint | undefined };

  // Суммарная награда за спор — собственные 80% сбора плюс доплата стороны.
  // Это и есть весь механизм «вызова»: арбитр видит, что дело оплачено, и
  // берёт его. Арифметика — в lib/disputeBounty.ts (computeArbiterReward),
  // покрыта тестами: own share по возможности решается из уравнения самого
  // контракта (floor - topUp), а не из константы доли.
  //
  // Четвёртое чтение — сбор самой сделки. Нужно ровно в одном состоянии:
  // когда котировка вернула 0, потому что котёл и так покрывает порог. Там
  // уравнение выше не решается, и раньше награда в этом состоянии просто
  // исчезала — то есть пропадала на всех спорах от ~$417 и выше, ровно там,
  // где она максимальна. Сбор берётся У СДЕЛКИ (disputeFee()), а не
  // пересчитывается из котла: формула 3% с потолком $500 живёт в Agreement.
  const { data: topUp } = useReadContract({
    address: CONTRACTS.diamond, abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: "quoteDisputeTopUp", args: [rec.agreement as Address],
  }) as { data: bigint | undefined };
  const { data: arbiterFloor } = useReadContract({
    address: CONTRACTS.diamond, abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: "getArbiterFloor",
  }) as { data: bigint | undefined };
  const { data: bounty } = useReadContract({
    address: CONTRACTS.diamond, abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: "getDisputeBounty", args: [rec.agreement as Address],
  }) as { data: bigint | undefined };
  const { data: disputeFee } = useReadContract({
    address: rec.agreement as Address, abi: AGREEMENT_ABI as Abi,
    functionName: "disputeFee",
  }) as { data: bigint | undefined };
  const reward = (topUp !== undefined && arbiterFloor !== undefined && bounty !== undefined)
    ? computeArbiterReward(arbiterFloor, topUp, bounty, disputeFee)
    : undefined;

  const [disputeReason, setDisputeReason] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/api/dispute-reason?agreement=${rec.agreement.toLowerCase()}`)
      .then(r => r.json())
      .then((d: { reason?: string | null }) => { if (d.reason) setDisputeReason(d.reason); })
      // Читающая половина того же денежного пути, что и отправка причины
      // (см. lib/disputeReason). Молчать здесь нельзя по той же причине:
      // отсутствие изложения в карточке спора читается арбитром как «сторона
      // ничего не написала», хотя это могло быть просто неудавшееся чтение.
      // Решение арбитра распоряжается эскроу — цена такой подмены высокая.
      .catch((err: unknown) => {
        console.warn(
          `[dispute] изложение дела по ${rec.agreement} не прочитано — ` +
          `карточка спора покажет его как отсутствующее:`, err,
        );
      });
  }, [rec.agreement]);

  const ZERO = "0x0000000000000000000000000000000000000000";
  const isClaimed   = claimer && claimer !== ZERO;
  const isMineClaim = isClaimed && claimer?.toLowerCase() === myAddress?.toLowerCase();
  const claimBusy   = busy === `claim:${rec.agreement}`;
  const releaseBusy = busy === `release:${rec.agreement}`;
  const urgent      = timeLeft !== undefined && timeLeft > 0n && Number(timeLeft) < 86400;

  return (
    <div
      className="rounded-[18px] border border-white/[0.07] bg-white/[0.02] overflow-hidden"
      style={{ boxShadow: "0 1px 8px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.025)" }}
    >
      <div className="px-4 pt-3.5 pb-3">
        <div className="flex items-center gap-2 flex-wrap mb-2">
          <Link href={`/deal/${rec.agreement}`} className="font-mono text-sm text-primary hover:underline">
            {shortAddr(rec.agreement)}
          </Link>
          {isClaimed ? (
            <Badge variant="secondary" className="text-[11px] h-5 px-1.5">
              {isMineClaim ? t("arbiter.claimed_by_you") : t("arbiter.claimed_by", { address: shortAddr(claimer!) })}
            </Badge>
          ) : (
            <Badge variant="destructive" className="text-[11px] h-5 px-1.5">{t("arbiter.unclaimed")}</Badge>
          )}
          {timeLeft !== undefined && timeLeft > 0n && (
            <span className={`text-xs font-mono ${urgent ? "text-red-400" : "text-orange-400"}`}>
              {fmtTimeLeft(timeLeft, t)}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-white/40">
          <span>{t("arbiter.client_label")} <span className="font-mono text-white/55">{shortAddr(rec.client)}</span></span>
          <span>{t("arbiter.executor_label")} <span className="font-mono text-white/55">{shortAddr(rec.executor)}</span></span>
          <span className="font-mono text-emerald-400/70">${fmtUSDC(rec.amount)} USDC</span>
          {reward !== undefined && (
            <span className="flex items-center gap-1 font-mono text-amber-400/80">
              <Coins className="w-3 h-3" />${fmtUSDC(reward)}
            </span>
          )}
        </div>
      </div>

      {disputeReason ? (
        <div className="mx-3 mb-3 rounded-[12px] border border-red-500/20 bg-red-500/[0.04] px-3 py-2.5">
          <p className="text-[10px] text-red-400/60 font-semibold uppercase tracking-wider mb-1">
            {t("arbiter.dispute_reason_title")}
          </p>
          <p className="text-xs text-white/65 leading-relaxed">{disputeReason}</p>
        </div>
      ) : (
        <p className="text-xs text-white/20 px-4 pb-3 italic">{t("arbiter.no_reason")}</p>
      )}

      <div className="px-3 pb-3 flex items-center gap-3">
        {!isClaimed && (
          <p className="text-[11px] text-white/25 leading-tight flex-1">{t("arbiter.claim_hint")}</p>
        )}
        <div className="flex gap-2 ml-auto">
          {!isClaimed && (
            <Button size="sm" onClick={() => onClaim(rec.agreement)} disabled={!!busy}>
              {claimBusy ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : null}
              {t("arbiter.claim_btn")}
            </Button>
          )}
          {isMineClaim && (
            <Button size="sm" variant="outline" onClick={() => onRelease(rec.agreement)} disabled={!!busy}
              className="border-white/15 text-white/60 hover:text-white hover:border-white/30">
              {releaseBusy ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : null}
              {t("arbiter.release_btn")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── DisputeLog ───────────────────────────────────────────────────────────────

const RELAYER_URL_ARB = process.env.NEXT_PUBLIC_RELAYER_URL ?? 'http://localhost:3001';
type LogEntry = { ts: number; from: string; text: string; dealId: string | null };

// Module-level cache, keyed by ADDRESS + dealId — survives DisputeLog remounting.
// The parent page bakes a single page-wide `refresh` counter into every card's
// React key so ANY action anywhere on the page (release, submit/finalize verdict,
// withdraw reward — not just an action on this specific case) remounts every card,
// including this one, collapsing an already-fetched log back to its "View
// history" button. Without this cache, re-viewing it demands a brand-new
// hexseal:dispute-log:... signature caused by unrelated page activity rather
// than the arbiter's own intent to re-view.
//
// The address is part of the key, not just the deal: switching wallets inside the
// same tab must not leave the previous arbiter's private chat log on screen for
// whoever connected next. Same rule as the session pass (lib/disputeLogPass.ts).
const _disputeLogCache = new Map<string, LogEntry[]>();
const cacheKey = (address: string | undefined, dealId: string) =>
  `${(address ?? '').toLowerCase()}:${dealId.toLowerCase()}`;

type DisputeLogResponse = { entries: LogEntry[]; pass?: DisputeLogPass };
type DisputeLogError    = { error?: string; code?: string };

function DisputeLog({ dealId, client, executor }: { dealId: string; client?: string; executor?: string }) {
  const { data: walletClient } = useWalletClient();
  const { address } = useAccount();
  const [entries, setEntries] = useState<LogEntry[] | null>(
    () => _disputeLogCache.get(cacheKey(address, dealId)) ?? null,
  );
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState<string | null>(null);
  const t = useTranslations();

  // Switching wallets inside the tab does NOT remount this card (the page-wide
  // `refresh` key only moves on actions), so without this the previous arbiter's
  // private chat log would stay on screen for whoever connected next. Re-reads
  // the cache under the new address instead of just blanking, so switching back
  // and forth doesn't cost a signature either.
  useEffect(() => {
    setEntries(_disputeLogCache.get(cacheKey(address, dealId)) ?? null);
    setErr(null);
  }, [address, dealId]);

  const requestLog = async (headers: Record<string, string>) => {
    const res = await fetch(`${RELAYER_URL_ARB}/dispute-log/${dealId}`, { headers });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as DisputeLogError;
      return { ok: false as const, status: res.status, code: body.code, error: body.error };
    }
    return { ok: true as const, data: await res.json() as DisputeLogResponse };
  };

  const fetchLog = async () => {
    if (!walletClient || !address) return;
    setLoading(true); setErr(null);
    try {
      // 1. Пропуск этого сеанса, если он есть. Подписи не требует вовсе —
      //    релеер всё равно перепроверит в цепи, держим ли мы этот спор.
      const pass = loadPass(address, dealId);
      if (pass) {
        const attempt = await requestLog({ 'x-dispute-pass': pass });
        if (attempt.ok) {
          _disputeLogCache.set(cacheKey(address, dealId), attempt.data.entries ?? []);
          setEntries(attempt.data.entries ?? []);
          return;
        }
        // 401 от пропуска — он протух или испорчен: выбрасываем и просим
        // подпись ниже, в этом же нажатии. 403 — это уже не про пропуск, а про
        // права (спор отпущен, дело у другого арбитра), и подпись тут не
        // поможет: показываем причину как есть.
        clearPass(address, dealId);
        if (attempt.status !== 401) {
          throw new Error(attempt.error ?? `HTTP ${attempt.status}`);
        }
      }

      // 2. Подпись — первое чтение в сеансе либо истёкший пропуск.
      const ts = String(Math.floor(Date.now() / 1000));
      const message = `hexseal:dispute-log:${dealId.toLowerCase()}:${ts}`;
      // Под общим мьютексом кошелька (lib/walletLock.ts): страница арбитра —
      // единственное место, где подпись «просто на чтение» (журнал спора)
      // соседствует с гейслесс-действиями по тем же делам.
      const sig = await withWalletLock(address, () =>
        walletClient.signMessage({ account: address, message }));
      const signed = await requestLog({ 'x-ts': ts, 'x-sig': sig });
      if (!signed.ok) throw new Error(signed.error ?? `HTTP ${signed.status}`);

      if (signed.data.pass) savePass(address, dealId, signed.data.pass);
      _disputeLogCache.set(cacheKey(address, dealId), signed.data.entries ?? []);
      setEntries(signed.data.entries ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load');
    } finally { setLoading(false); }
  };

  const roleOf = (from: string): 'client' | 'executor' | 'bot' => {
    const f = from.toLowerCase();
    if (client && f === client.toLowerCase()) return 'client';
    if (executor && f === executor.toLowerCase()) return 'executor';
    return 'bot';
  };

  if (entries === null) {
    // `err` can only ever be set while entries is still null — a failed fetchLog()
    // never populates entries, so the (err) branch that used to follow this one was
    // unreachable dead code: on failure, the button just silently reverted to idle
    // with zero explanation, including for a signature that arrived too late for the
    // server's 5-minute replay window. Render the error alongside the (still
    // clickable, to retry) button instead of only after it.
    return (
      <div className="space-y-1">
        <button
          onClick={fetchLog}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] text-xs font-medium border border-white/15 text-white/50 hover:bg-white/[0.06] transition-colors disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <MessageCircle className="w-3 h-3" />}
          {t("arbiter.view_history_btn")}
        </button>
        {err && (
          <p className="text-xs text-red-400/70 px-1">
            {err.toLowerCase().includes('timestamp out of window')
              ? t("arbiter.dispute_log_sign_timeout")
              : err}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mt-1 rounded-[14px] border border-white/[0.07] bg-[#080809] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/[0.05]">
        <div className="flex items-center gap-2">
          <MessageCircle className="w-3.5 h-3.5 text-white/25" />
          <span className="text-[11px] text-white/35 font-medium">{t("arbiter.view_history_btn")}</span>
          {entries.length > 0 && <span className="text-[10px] text-white/20 font-mono">{entries.length}</span>}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-white/20">
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-sky-400/60 inline-block" />{t("arbiter.client_label")}</span>
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-violet-400/60 inline-block" />{t("arbiter.executor_label")}</span>
        </div>
        <button onClick={() => setEntries(null)} className="text-white/20 hover:text-white/50 transition-colors text-[10px]">✕</button>
      </div>
      {entries.length === 0 ? (
        <p className="text-xs text-white/25 px-3 py-4 italic text-center">{t("arbiter.no_history_log")}</p>
      ) : (
        <div className="max-h-72 overflow-y-auto px-3 py-3 space-y-2 [scrollbar-width:thin] [scrollbar-color:rgba(255,255,255,0.08)_transparent]">
          {entries.map((e, i) => {
            const role = roleOf(e.from);
            const time = new Date(e.ts).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
            // Entries whose deal_ctx tag doesn't match the deal being viewed are
            // context from another deal (or from before any deal existed) between
            // this same pair — shown, but visually de-emphasized and labeled.
            const isOtherContext = (e.dealId ?? '').toLowerCase() !== dealId.toLowerCase();
            const contextLabel = !isOtherContext ? null
              : e.dealId ? `#${e.dealId.slice(2, 8).toUpperCase()}`
              : t("arbiter.general_chat_label");
            if (role === 'bot') {
              return (
                <div key={i} className="flex justify-center">
                  <span className="text-[10px] text-white/20 italic px-2">{e.text} · {time}</span>
                </div>
              );
            }
            const isClient = role === 'client';
            return (
              <div key={i} className={`flex flex-col gap-0.5 ${isClient ? 'items-start' : 'items-end'} ${isOtherContext ? 'opacity-40' : ''}`}>
                <span className={`text-[10px] font-medium px-0.5 ${isClient ? 'text-sky-400/50' : 'text-violet-400/50'}`}>
                  {isClient ? t("arbiter.client_label") : t("arbiter.executor_label")}
                  {' · '}<span className="font-mono font-normal">{e.from.slice(0, 6)}…{e.from.slice(-4)}</span>
                </span>
                <div className={`max-w-[85%] rounded-[10px] px-3 py-2 text-xs leading-relaxed ${
                  isClient
                    ? 'bg-sky-500/[0.08] border border-sky-500/15 text-white/80 rounded-tl-[3px]'
                    : 'bg-violet-500/[0.08] border border-violet-500/15 text-white/80 rounded-tr-[3px]'
                }`}>{e.text}</div>
                <span className="text-[10px] text-white/15 px-0.5">
                  {time}{contextLabel && <span className="ml-1 text-white/25">· {contextLabel}</span>}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── MyCaseCard ───────────────────────────────────────────────────────────────

function MyCaseCard({
  agreement, myAddress, busy, refresh, onRelease, onSubmitVerdict, onFinalizeVerdict,
  showNoKeyNotice, onPublishKey, isArbiter,
}: {
  agreement: string; myAddress?: string; busy: string | null; refresh: number;
  onRelease: (a: string) => void;
  onSubmitVerdict: (a: string, clientWins: boolean) => void;
  onFinalizeVerdict: (a: string) => void;
  showNoKeyNotice: boolean;
  onPublishKey: () => void;
  /** Разжалованный арбитр (третья судейская ошибка) остаётся судьёй по
   *  открытому делу — submitVerdict проверяет только disputeClaims, а не
   *  реестр, — но setArbiterChatKey гейтится isArbiter и он ключ записать
   *  больше не может. Кнопка показывается только когда isArbiter истинно;
   *  иначе — честное объяснение вместо кнопки, которая гарантированно
   *  ревертит (NotArbiter). */
  isArbiter: boolean;
}) {
  const t = useTranslations();
  const MINI_ABI = [
    { inputs: [], name: "status",          outputs: [{ internalType: "uint8",   name: "", type: "uint8" }],   stateMutability: "view", type: "function" },
    { inputs: [], name: "amount",          outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "client",          outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "executor",        outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "arbiterTimeLeft", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "disputedAt",      outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  ] as const;

  const { data: statusVal  } = useReadContract({ address: agreement as Address, abi: MINI_ABI, functionName: "status" })          as { data: number  | undefined };
  const { data: amount     } = useReadContract({ address: agreement as Address, abi: MINI_ABI, functionName: "amount" })          as { data: bigint  | undefined };
  const { data: client     } = useReadContract({ address: agreement as Address, abi: MINI_ABI, functionName: "client" })          as { data: string  | undefined };
  const { data: executor   } = useReadContract({ address: agreement as Address, abi: MINI_ABI, functionName: "executor" })        as { data: string  | undefined };
  const { data: timeLeft   } = useReadContract({ address: agreement as Address, abi: MINI_ABI, functionName: "arbiterTimeLeft" }) as { data: bigint  | undefined };
  const { data: disputedAt } = useReadContract({ address: agreement as Address, abi: MINI_ABI, functionName: "disputedAt" })      as { data: bigint  | undefined };

  const { data: claimer } = useReadContract({
    address: CONTRACTS.diamond, abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: "getDisputeClaimer", args: [agreement as Address],
  }) as { data: string | undefined };

  const { data: pendingVerdict } = useReadContract({
    address: CONTRACTS.diamond, abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: "getPendingVerdict", args: [agreement as Address],
    scopeKey: `arbiter-${refresh}`,
  }) as { data: PendingVerdict | undefined };

  const [disputeReason, setDisputeReason] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/api/dispute-reason?agreement=${agreement.toLowerCase()}`)
      .then(r => r.json())
      .then((d: { reason?: string | null }) => { if (d.reason) setDisputeReason(d.reason); })
      // См. комментарий у такого же чтения в карточке спора выше.
      .catch((err: unknown) => {
        console.warn(
          `[dispute] изложение дела по ${agreement} не прочитано — ` +
          `карточка спора покажет его как отсутствующее:`, err,
        );
      });
  }, [agreement]);

  const ZERO        = "0x0000000000000000000000000000000000000000";
  const isDisputed  = statusVal === AGREEMENT_STATUS_DISPUTED;
  const isTerminal  = statusVal !== undefined && TERMINAL.has(statusVal);
  const isMineClaim = claimer?.toLowerCase() === myAddress?.toLowerCase() && claimer !== ZERO;
  const finalizeBusy       = busy === `finalize:${agreement}`;
  const verdictClientBusy  = busy === `verdict:client:${agreement}`;
  const verdictExecBusy    = busy === `verdict:executor:${agreement}`;
  const releaseBusy        = busy === `release:${agreement}`;
  const expired     = timeLeft !== undefined && timeLeft === 0n && disputedAt && disputedAt > 0n;
  const urgent      = timeLeft !== undefined && timeLeft > 0n && Number(timeLeft) < 86400;

  // Verdict state
  const hasVerdict   = pendingVerdict && pendingVerdict.submittedAt > 0n;
  const verdictReady = hasVerdict && !pendingVerdict!.finalized && !pendingVerdict!.frozen;
  const verdictFrozen = hasVerdict && pendingVerdict!.frozen && !pendingVerdict!.finalized;
  // finalizeVerdict() reverts on-chain until FINALIZE_DELAY has passed since
  // submittedAt — the button used to be always-clickable here regardless,
  // guaranteed to fail (and, before assertMined was added, to show a false
  // success toast) for the entire 24h window after every single verdict.
  const finalizeEligibleIn = hasVerdict
    ? pendingVerdict!.submittedAt + FINALIZE_DELAY - BigInt(Math.floor(Date.now() / 1000))
    : 0n;
  const finalizeEligible = finalizeEligibleIn <= 0n;

  if (!isMineClaim && !isDisputed) return null;
  if (isTerminal) return null;

  const statusLabel = statusVal !== undefined ? t(STATUS_KEYS[statusVal] ?? "arbiter.status_unknown") : "…";

  return (
    <div
      className="rounded-[18px] border border-white/[0.07] bg-white/[0.02] overflow-hidden"
      style={{ boxShadow: "0 1px 8px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.025)" }}
    >
      {/* Case info */}
      <div className="px-4 pt-3.5 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Link href={`/deal/${agreement}`} className="font-mono text-sm text-primary hover:underline">
              {shortAddr(agreement)}
            </Link>
            <Badge variant={isDisputed ? "destructive" : "secondary"} className="text-[11px] h-5 px-1.5">
              {statusLabel}
            </Badge>
            {timeLeft !== undefined && timeLeft > 0n && (
              <span className={`text-xs font-mono ${urgent ? "text-red-400" : "text-orange-400"}`}>
                {fmtTimeLeft(timeLeft, t)}
              </span>
            )}
            {expired && (
              <span className="text-xs font-semibold text-red-400">{t("arbiter.window_expired")}</span>
            )}
          </div>
          <Link href={`/deal/${agreement}`}>
            <Button size="sm" variant="ghost" className="h-7 text-xs text-white/40 hover:text-white shrink-0">
              {t("common.details")}
            </Button>
          </Link>
        </div>

        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-white/40 mt-2">
          <span>{t("arbiter.client_label")} <span className="font-mono text-white/55">{client ? shortAddr(client) : "…"}</span></span>
          <span>{t("arbiter.executor_label")} <span className="font-mono text-white/55">{executor ? shortAddr(executor) : "…"}</span></span>
          <span className="font-mono text-emerald-400/70">${amount ? fmtUSDC(amount) : "…"} USDC</span>
          {disputedAt && disputedAt > 0n && (
            <span>{new Date(Number(disputedAt) * 1000).toLocaleString()}</span>
          )}
        </div>
      </div>

      {/* Dispute reason */}
      {disputeReason ? (
        <div className="mx-3 mb-3 rounded-[12px] border border-red-500/20 bg-red-500/[0.04] px-3 py-2.5">
          <p className="text-[10px] text-red-400/60 font-semibold uppercase tracking-wider mb-1">
            {t("arbiter.dispute_reason_title")}
          </p>
          <p className="text-xs text-white/65 leading-relaxed">{disputeReason}</p>
        </div>
      ) : (
        <p className="text-xs text-white/20 px-4 pb-3 italic">{t("arbiter.no_reason")}</p>
      )}

      {/* Communication */}
      {(client || executor) && (
        <div className="px-3 pb-3 flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {client && (
              <Link href={`/chat?peer=${client.toLowerCase()}`}>
                <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] text-xs font-medium border border-sky-500/25 text-sky-400/80 hover:bg-sky-500/[0.12] transition-colors">
                  {t("arbiter.chat_client_btn")}
                </button>
              </Link>
            )}
            {executor && (
              <Link href={`/chat?peer=${executor.toLowerCase()}`}>
                <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] text-xs font-medium border border-violet-500/25 text-violet-400/80 hover:bg-violet-500/[0.12] transition-colors">
                  {t("arbiter.chat_executor_btn")}
                </button>
              </Link>
            )}
          </div>
          <DisputeLog dealId={agreement} client={client ?? undefined} executor={executor ?? undefined} />
        </div>
      )}

      {/* No-key notice: спор взят ДО апгрейда 9 августа, ключа в цепи нет.
          Классы — амбер из соседних блоков этой же карточки (Dispute reason,
          кнопка «Завершить вердикт» в Verdict panel ниже), не свои. */}
      {isMineClaim && showNoKeyNotice && (
        <div className="mx-3 mb-3 rounded-[12px] border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2.5">
          {isArbiter ? (
            <>
              <p className="text-xs text-amber-300/85 leading-relaxed">{t("arbiter.no_key_notice")}</p>
              <button
                onClick={onPublishKey}
                disabled={!!busy}
                className="mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] text-xs font-semibold border border-amber-500/30 text-amber-400 hover:bg-amber-500/10 transition-colors disabled:opacity-40"
              >
                {busy === "publish-key" && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {t("arbiter.publish_key")}
              </button>
            </>
          ) : (
            // Разжалован, но всё ещё судья по этому открытому делу (см.
            // комментарий у пропа isArbiter выше) — кнопка гарантированно
            // ревертнула бы (NotArbiter в контракте). Молчать нельзя: он не
            // должен решить, что предъявление просто прошло гладко.
            <p className="text-xs text-amber-300/85 leading-relaxed">{t("arbiter.no_key_notice_demoted")}</p>
          )}
        </div>
      )}

      {/* Verdict panel */}
      {isDisputed && isMineClaim && (
        <div className="mx-3 mb-3 rounded-[14px] border border-white/[0.07] bg-[#0d0d0f] p-3 space-y-3">

          {/* FROZEN state */}
          {verdictFrozen && (
            <div className="flex items-center gap-2 py-2">
              <Lock className="w-4 h-4 text-amber-400/70 shrink-0" />
              <p className="text-xs text-amber-400/80">{t("arbiter.verdict_frozen")}</p>
            </div>
          )}

          {/* PENDING finalization state */}
          {verdictReady && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                <p className="text-xs text-white/50">{t("arbiter.verdict_pending")}</p>
                <span className="text-[10px] font-mono text-white/25 ml-auto">
                  {pendingVerdict!.clientWins ? t("arbiter.refund_client_btn") : t("arbiter.pay_executor_btn")}
                </span>
              </div>
              {!finalizeEligible && (
                <p className="text-[11px] text-white/35">
                  {t("arbiter.finalize_available_in", { time: fmtTimeLeft(finalizeEligibleIn, t) })}
                </p>
              )}
              <button
                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-[10px] text-xs font-semibold border border-amber-500/30 text-amber-400 hover:bg-amber-500/10 transition-colors disabled:opacity-40"
                disabled={!!busy || !finalizeEligible}
                onClick={() => onFinalizeVerdict(agreement)}
              >
                {finalizeBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
                {t("arbiter.finalize_btn")}
              </button>
            </div>
          )}

          {/* VERDICT SUBMIT state (no verdict yet, not expired) */}
          {!hasVerdict && !expired && (
            <>
              <div className="flex items-center gap-2">
                <Scale className="w-3.5 h-3.5 text-white/30 shrink-0" />
                <p className="text-xs font-semibold text-white/50">{t("arbiter.resolve_hint")}</p>
                <span className="text-[10px] text-red-400/55 ml-auto">{t("arbiter.resolve_irreversible")}</span>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-[10px] border border-sky-500/20 bg-sky-500/[0.05] px-3 py-2.5">
                  <p className="text-[11px] font-semibold text-sky-400/90 mb-1">{t("arbiter.refund_client_btn")}</p>
                  <p className="text-[10px] text-white/35 leading-relaxed">{t("arbiter.resolve_client_desc")}</p>
                </div>
                <div className="rounded-[10px] border border-violet-500/20 bg-violet-500/[0.05] px-3 py-2.5">
                  <p className="text-[11px] font-semibold text-violet-400/90 mb-1">{t("arbiter.pay_executor_btn")}</p>
                  <p className="text-[10px] text-white/35 leading-relaxed">{t("arbiter.resolve_executor_desc")}</p>
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-[10px] text-xs font-semibold border border-sky-500/30 text-sky-400 hover:bg-sky-500/10 transition-colors disabled:opacity-40"
                  disabled={!!busy}
                  onClick={() => onSubmitVerdict(agreement, true)}
                >
                  {verdictClientBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserCheck className="w-3.5 h-3.5" />}
                  {t("arbiter.refund_client_btn")}
                </button>
                <button
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-[10px] text-xs font-semibold border border-violet-500/30 text-violet-400 hover:bg-violet-500/10 transition-colors disabled:opacity-40"
                  disabled={!!busy}
                  onClick={() => onSubmitVerdict(agreement, false)}
                >
                  {verdictExecBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserX className="w-3.5 h-3.5" />}
                  {t("arbiter.pay_executor_btn")}
                </button>
              </div>

              <button
                className="w-full flex items-center justify-center gap-1.5 text-xs text-white/25 hover:text-white/50 transition-colors py-0.5 disabled:opacity-40"
                disabled={!!busy}
                onClick={() => onRelease(agreement)}
              >
                {releaseBusy && <Loader2 className="w-3 h-3 animate-spin" />}
                {t("arbiter.release_claim_btn")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── HistoryRow ───────────────────────────────────────────────────────────────

function HistoryRow({ agreement, prefetched }: { agreement: string; prefetched?: HistDetail }) {
  const t = useTranslations();
  const skip = prefetched !== undefined;
  const MINI_ABI = [
    { inputs: [], name: "status",     outputs: [{ internalType: "uint8",   name: "", type: "uint8" }],   stateMutability: "view", type: "function" },
    { inputs: [], name: "amount",     outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "resolvedAt", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  ] as const;

  const { data: statusRaw     } = useReadContract({ address: agreement as Address, abi: MINI_ABI, functionName: "status",     query: { enabled: !skip } }) as { data: number  | undefined };
  const { data: amountRaw     } = useReadContract({ address: agreement as Address, abi: MINI_ABI, functionName: "amount",     query: { enabled: !skip } }) as { data: bigint  | undefined };
  const { data: resolvedAtRaw } = useReadContract({ address: agreement as Address, abi: MINI_ABI, functionName: "resolvedAt", query: { enabled: !skip } }) as { data: bigint  | undefined };

  const statusVal  = skip ? prefetched.status     : (statusRaw !== undefined ? Number(statusRaw) : undefined);
  const amount     = skip ? prefetched.amount     : amountRaw;
  const resolvedAt = skip ? prefetched.resolvedAt : resolvedAtRaw;

  if (statusVal === undefined || !TERMINAL.has(statusVal)) return null;

  const isResolved = statusVal === 5;
  const isRefunded = statusVal === 6;
  const verdictLabel = isResolved ? t("arbiter.verdict_executor_paid")
    : isRefunded ? t("arbiter.verdict_client_refunded")
    : (t(STATUS_KEYS[statusVal] ?? "arbiter.status_unknown"));
  const verdictCls = isResolved ? "border-violet-500/30 text-violet-400"
    : isRefunded ? "border-sky-500/30 text-sky-400"
    : "border-white/15 text-white/40";

  return (
    <div className="flex items-center justify-between gap-3 py-2.5 border-b border-white/[0.04] last:border-0">
      <div className="flex items-center gap-2 flex-wrap min-w-0">
        <Link href={`/deal/${agreement}`} className="font-mono text-sm text-primary hover:underline shrink-0">
          {shortAddr(agreement)}
        </Link>
        <Badge variant="outline" className={`text-[11px] h-5 px-1.5 ${verdictCls}`}>
          {verdictLabel}
        </Badge>
        <span className="text-xs text-white/35 font-mono shrink-0">
          ${amount ? fmtUSDC(amount) : "…"}
        </span>
        {resolvedAt && resolvedAt > 0n && (
          <span className="text-[11px] text-white/20 shrink-0">
            {new Date(Number(resolvedAt) * 1000).toLocaleDateString()}
          </span>
        )}
      </div>
      <Link href={`/deal/${agreement}`}>
        <Button size="sm" variant="ghost" className="h-6 text-xs px-2 shrink-0 text-white/35 hover:text-white">
          {t("common.open")}
        </Button>
      </Link>
    </div>
  );
}

// ─── ManagePanel ─────────────────────────────────────────────────────────────

function ManagePanel({ isOwner }: { isOwner: boolean }) {
  const t = useTranslations();
  const { data: arbiters, refetch } = useReadContract({
    address: CONTRACTS.diamond as Address,
    abi: ARBITER_REGISTRY_ABI as Abi,
    functionName: "getArbiters",
  }) as { data: string[] | undefined; refetch: () => void };

  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const [newArbiter,   setNewArbiter]   = useState("");
  const [removingAddr, setRemovingAddr] = useState<string | null>(null);
  const [isAdding,     setIsAdding]     = useState(false);

  // `useWriteContract().isPending` — единственное, чем эти две кнопки гейтились
  // раньше, — гаснет на БРОДКАСТЕ, а не на включении в блок. Между этими двумя
  // мигами кнопка «Добавить» снова нажимаема, `refetch()` уходит по ещё не
  // изменившемуся состоянию, а тост об успехе печатается для транзакции,
  // которая могла отревертить (viem резолвит квитанцию и на реверте, он не
  // бросает). Тот же разбор и то же лечение — `hooks/useWalletAccountData.ts`
  // в `handleApplyAsArbiter`. `isPending` вдобавок был общим на обе кнопки:
  // удаление арбитра гасило кнопку добавления.
  const handleAdd = async () => {
    if (!isAddress(newArbiter)) { toast.error(t("profile.invalid_address")); return; }
    if (!publicClient) { toast.error(t("common.error")); return; }
    setIsAdding(true);
    try {
      const hash = await writeContractAsync({
        address: CONTRACTS.diamond as Address, abi: ARBITER_REGISTRY_ABI as Abi,
        functionName: "addArbiter", args: [newArbiter as Address], gas: BigInt(120_000),
      });
      assertMined(await publicClient.waitForTransactionReceipt({ hash }));
      toast.success(t("arbiter.added_success"));
      setNewArbiter("");
      refetch();
    } catch (err: any) { toast.error(err?.shortMessage || err?.message || t("common.error")); }
    finally { setIsAdding(false); }
  };

  const handleRemove = async (addr: string) => {
    if (!publicClient) { toast.error(t("common.error")); return; }
    setRemovingAddr(addr);
    try {
      const hash = await writeContractAsync({
        address: CONTRACTS.diamond as Address, abi: ARBITER_REGISTRY_ABI as Abi,
        functionName: "removeArbiter", args: [addr as Address], gas: BigInt(120_000),
      });
      assertMined(await publicClient.waitForTransactionReceipt({ hash }));
      toast.success(t("arbiter.removed_success"));
      refetch();
    } catch (err: any) { toast.error(err?.shortMessage || err?.message || t("common.error")); }
    finally { setRemovingAddr(null); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Crown className="w-4 h-4 text-amber-400 shrink-0" />
        <p className="text-sm font-semibold text-white/70">{t("arbiter.manage_title")}</p>
      </div>
      <p className="text-xs text-white/35 -mt-2">{t("arbiter.chief_desc")}</p>

      {!arbiters || arbiters.length === 0 ? (
        <p className="text-sm text-white/30 py-4 text-center">{t("arbiter.no_arbiters")}</p>
      ) : (
        <div className="space-y-2">
          {arbiters.map(addr => (
            <div key={addr} className="flex items-center justify-between gap-3 rounded-[14px] border border-white/[0.07] bg-[#0d0d0f] px-3 py-2.5">
              <span className="font-mono text-xs text-white/60 truncate">{addr}</span>
              {isOwner && (
                <button
                  className="flex items-center gap-1 text-xs text-red-400/60 hover:text-red-400 transition-colors shrink-0 disabled:opacity-40"
                  disabled={!!removingAddr || isAdding}
                  onClick={() => handleRemove(addr)}
                >
                  {removingAddr === addr
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <UserMinus className="w-3.5 h-3.5" />}
                  {t("arbiter.remove_btn")}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {isOwner && (
        <>
          <div className="h-px bg-white/[0.06]" />
          <div className="space-y-2">
            <Label className="text-xs text-white/40 uppercase tracking-wider">{t("arbiter.add_arbiter")}</Label>
            <div className="flex gap-2">
              <Input
                placeholder="0x..."
                value={newArbiter}
                onChange={e => setNewArbiter(e.target.value)}
                className="font-mono text-sm bg-transparent border-white/[0.08] rounded-[14px]"
              />
              <Button onClick={handleAdd} disabled={isAdding || !!removingAddr || !newArbiter} className="gap-1 shrink-0">
                {isAdding ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
                {t("arbiter.add_btn")}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
