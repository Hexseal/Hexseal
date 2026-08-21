'use client';

/**
 * AdminArbiterAccountability.tsx — то, чем заменяется умирающая кнопка сноса.
 *
 * ⚠️ ПОЧЕМУ ЭТО ЦЕЛЫЙ ФАЙЛ, А НЕ ДВЕ СТРОЧКИ В `admin/page.tsx`.
 * `removeArbiter(address)` (селектор `0x3487e08c`) уходит из даймонда
 * единственным элементом `Remove` в разрезе
 * `script/UpgradeArbiterAccountability.s.sol`. Заменяет её не другая кнопка, а
 * ПРОЦЕСС (замысел `2026-08-21-arbiter-screens-design.md`, раздел 4):
 * предложить → ждать 48 часов → исполнить или отозвать. У процесса есть
 * состояния, и каждое надо показать словами.
 *
 * ⚠️ ЭТА СТРАНИЦА ПИШЕТСЯ ДО РАЗРЕЗА. Фасета в даймонде сегодня НЕТ, и любое
 * чтение отсюда ревертит в его fallback. Экран обязан сказать это человеческими
 * словами, а не отказом кошелька: иначе владелец откроет страницу и пойдёт
 * искать поломку, которой нет. Разбор — `lib/facetPresence.ts`, проба одна на
 * весь экран (`useRemovalRules`).
 *
 * ⚠️ ЖЁСТКОГО `gas:` ЗДЕСЬ НЕТ НИ У ОДНОГО ВЫЗОВА, и это правило, а не
 * случайность: явный лимит означает «кошелёк, не оценивай», то есть отказ
 * контракта доезжает до цепи и берёт деньги, ничего не объяснив. До разреза это
 * особенно важно — все четыре кнопки ниже сегодня отсутствуют в даймонде, и без
 * литерала оценка провалится ЗАРАНЕЕ, локально и бесплатно. Замок —
 * `lib/arbiterWritesEstimateGas.test.ts`.
 *
 * ⚠️ ГЕЙСЛЕССА ЗДЕСЬ НЕТ НАМЕРЕННО. Правило проекта требует гейслесс-путь
 * ПОЛЬЗОВАТЕЛЬСКОМУ действию, включая арбитрское. Это же — админская дверь
 * владельца и директора, у которых ETH есть по определению: они и так платят
 * газ за `addArbiter`, `setChiefArbiter` и настройки комиссии на этой же
 * странице.
 *
 * ⚠️ ЯЗЫК — АНГЛИЙСКИЙ ЛИТЕРАЛАМИ, КАК ВЕСЬ `admin/page.tsx`. В админке нет ни
 * одного `useTranslations` и нет пространства `admin` в `messages/*.json`;
 * подключать i18n одному блоку значило бы сделать страницу наполовину
 * переведённой. Панель видит один кошелёк — владелец.
 */

import { useEffect, useState } from 'react';
import { useWriteContract, usePublicClient } from 'wagmi';
import type { Address, Hex } from 'viem';
import { toast } from 'react-hot-toast';
import {
  AlertTriangle, Ban, CheckCircle2, Clock, Crown, FileUp, Gavel,
  Loader2, Scale, ShieldOff, Undo2, Upload,
} from 'lucide-react';

import { ARBITER_ACCOUNTABILITY_ABI, CONTRACTS } from '@/config/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { fmtUSDC } from '@/lib/notifications';
import { useArbiterStanding, type ArbiterStanding } from '@/hooks/useArbiterStanding';
import { useRemovalProposal } from '@/hooks/useRemovalProposal';
import { useChainAccusation } from '@/hooks/useChainAccusation';
import type { RemovalRules } from '@/hooks/useRemovalRules';
import type { FacetPresence } from '@/lib/facetPresence';
import type { RemovalCauseName } from '@/lib/arbiterRemovalCause';
import {
  REMOVAL_CAUSE_OPTIONS, causeByValue, causeOption,
  checkExecution, checkProposal, formatSecondsLeft, mistakeOutlook,
  reasonByteLength, reasonBytesLeft, removalStage,
} from '@/lib/arbiterRemovalFlow';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const ZERO_DIGEST = `0x${'00'.repeat(32)}` as Hex;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const stamp = (seconds: number) =>
  seconds > 0 ? new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—';

/* ══════════════════ 0. «этой части ещё нет в цепи» ══════════════════ */

/**
 * ⚠️ ЧЕТЫРЕ СОСТОЯНИЯ, А НЕ ДВА, И РАЗНИЦА МЕЖДУ ДВУМЯ ИЗ НИХ — ГЛАВНОЕ.
 * «Фасета ещё нет» лечится разрезом, и ждать тут нечего: кнопки просто не
 * существует. «Сеть не ответила» лечится обновлением. Один текст на оба
 * посоветовал бы ждать разреза человеку, у которого отвалился RPC.
 */
export function ArbiterAccountabilityNotice({ presence }: { presence: FacetPresence }) {
  if (presence === 'ready') return null;

  if (presence === 'checking') {
    return (
      <div className="flex items-center gap-2 rounded-[14px] border border-white/[0.06] bg-white/[0.02] px-4 py-3">
        <Loader2 className="w-3.5 h-3.5 animate-spin text-white/30 shrink-0" />
        <p className="text-xs text-white/40">Asking the chain what the removal rules are…</p>
      </div>
    );
  }

  if (presence === 'absent') {
    return (
      <div className="rounded-[14px] border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3 space-y-1.5">
        <p className="flex items-center gap-2 text-sm font-medium text-amber-300">
          <Clock className="w-4 h-4 shrink-0" />
          This part is not on chain yet — it starts working right after the cut.
        </p>
        <p className="text-[11px] leading-relaxed text-amber-200/60">
          <code>ArbiterAccountabilityFacet</code> has not been cut into the diamond, so every
          call this panel makes lands in the diamond&apos;s fallback and reverts with
          <code> Diamond: function not found</code>. Nothing is broken and nothing needs
          fixing: the accountability flow — propose, wait 48 hours, execute or withdraw —
          appears here by itself once <code>script/UpgradeArbiterAccountability.s.sol</code>
          has run.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-[14px] border border-white/[0.08] bg-white/[0.02] px-4 py-3 space-y-1.5">
      <p className="flex items-center gap-2 text-sm font-medium text-white/60">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        The chain did not answer.
      </p>
      <p className="text-[11px] leading-relaxed text-white/35">
        This is the network, not a missing feature — the removal rules could not be read at
        all. Reload the page; if it keeps happening, check the RPC.
      </p>
    </div>
  );
}

/* ══════════════════ 1. пара чисел и состояние ══════════════════ */

function Pill({ tone, children }: { tone: 'red' | 'amber' | 'sky' | 'plain'; children: React.ReactNode }) {
  const cls = {
    red:   'border-red-500/30 text-red-300 bg-red-500/[0.07]',
    amber: 'border-amber-500/30 text-amber-300 bg-amber-500/[0.07]',
    sky:   'border-sky-500/30 text-sky-300 bg-sky-500/[0.07]',
    plain: 'border-white/[0.12] text-white/45 bg-white/[0.02]',
  }[tone];
  return <span className={cn('text-[10px] px-1.5 py-0.5 rounded border shrink-0', cls)}>{children}</span>;
}

/**
 * Пара чисел решения 16 — РАЗОБРАНО и ПЕРЕВЁРНУТО, рядом и порознь.
 *
 * ⚠️ ДЕЛИТ ЧИТАТЕЛЬ, И ПОРОГА ЗДЕСЬ НЕТ НИ ОДНОГО. Ни цвета по отношению, ни
 * «хороший/плохой»: пара заведена на ступенях «видно → посчитано», последствий
 * у неё нет по решению владельца. Показать её одним процентом значило бы
 * сделать третью ступень под видом оформления.
 *
 * ⚠️ И ПОКАЗЫВАТЬ ИХ ПОРОЗНЬ НЕЛЬЗЯ. `cleanVerdicts` в одиночку показывает
 * терпеливого плохого арбитра лучше честного новичка, `overturnedVerdicts` в
 * одиночку наказывает выслугу.
 */
function StandingNumbers({ standing }: { standing: ArbiterStanding }) {
  const cells: [string, string][] = [
    ['judged', standing.cleanVerdicts.toString()],
    ['overturned', standing.overturnedVerdicts.toString()],
    ['bond', fmtUSDC(standing.bond)],
    ['open claims', standing.openClaims.toString()],
    ['XP', standing.xp.toString()],
    ['clean streak', standing.cleanStreak.toString()],
  ];
  return (
    <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
      {cells.map(([label, value]) => (
        <div key={label} className="rounded-[10px] border border-white/[0.06] bg-white/[0.02] px-2 py-1.5">
          <p className="text-[10px] text-white/30 truncate">{label}</p>
          <p className="font-mono text-xs text-white/75">{value}</p>
        </div>
      ))}
    </div>
  );
}

/**
 * Третья ошибка не должна быть сюрпризом (замысел, раздел 3).
 *
 * ⚠️ ЭТА СТРОКА СТОИТ НА КАРТОЧКЕ, А НЕ У КНОПКИ ПЕРЕВОРОТА, ПОТОМУ ЧТО КНОПКИ
 * ПЕРЕВОРОТА ВО ФРОНТЕ НЕТ ВОВСЕ. `overturnVerdict` есть в ABI и не зовётся ни
 * одним экраном — замерено грепом по `src/`. Предупреждать «станет 2 из 3»
 * ровно в момент нажатия сегодня негде; повесить его на карточку — то же
 * знание, доставленное раньше, а не вместо. Появится экран переворота — строку
 * взять оттуда же, `mistakeOutlook` для того и вынесена.
 */
function MistakeOutlookLine({ standing, rules }: { standing: ArbiterStanding; rules: RemovalRules }) {
  if (rules.maxMistakes === null || rules.mistakeThreshold === null) return null;
  const o = mistakeOutlook(Number(standing.mistakeStreak), rules.maxMistakes, rules.mistakeThreshold);

  return (
    <p className={cn(
      'text-[11px] leading-relaxed',
      o.nextTips ? 'text-red-300/80' : o.nextProves ? 'text-amber-300/70' : 'text-white/35',
    )}>
      <Scale className="w-3 h-3 inline-block mr-1 -mt-0.5" />
      Judicial mistakes in a row: <b className="font-mono">{o.streak}</b> of {o.max}.{' '}
      {o.nextTips ? (
        <>Overturn one more verdict and it becomes {o.next} of {o.max} — the chain suspends him
        on the spot and opens an accusation in its own name. A clean verdict resets the row to zero.</>
      ) : o.nextProves ? (
        <>Overturn one more verdict and it becomes {o.next} of {o.max}; at {o.max} the chain
        suspends him and opens an accusation itself. A clean verdict resets the row to zero.</>
      ) : (
        <>The row counts consecutive mistakes — a clean verdict resets it to zero.</>
      )}
    </p>
  );
}

/* ══════════════════ 2. поток сноса ══════════════════ */

interface FlowProps {
  arbiter: Address;
  rules: RemovalRules;
  standing: ArbiterStanding | null;
  onChanged: () => void;
}

export function ArbiterRemovalFlow({ arbiter, rules, standing, onChanged }: FlowProps) {
  const { record, refetch: refetchProposal } = useRemovalProposal(arbiter, rules.presence === 'ready');
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [cause, setCause] = useState<RemovalCauseName>('Collusion');
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState<{ digest: Hex; url: string; name: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [disputeRef, setDisputeRef] = useState('');
  const [busy, setBusy] = useState<null | 'propose' | 'execute' | 'withdraw'>(null);

  // ⚠️ ЧАСЫ ОТДЕЛЬНЫМ СОСТОЯНИЕМ, КАК В `useNoResponseRecord`. Без тика
  // обратный отсчёт замирает: кнопка «исполнить» не появляется сама, и человек
  // узнаёт о готовности перезагрузкой страницы — то есть ровно тогда, когда
  // догадается, что экран мог соврать. Тикаем только пока обвинение живо,
  // иначе каждая карточка перерисовывалась бы дважды в минуту без причины.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const ticking = !!record?.live;
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, [ticking]);

  const stage = removalStage(
    record,
    now,
    rules.removalDelay ?? 0,
    rules.proposalTTL ?? 0,
  );
  const clocksKnown = rules.removalDelay !== null && rules.proposalTTL !== null;

  const chainSeries = useChainAccusation(arbiter, rules.presence === 'ready' && stage.byChain);

  const after = () => { refetchProposal(); onChanged(); };

  /** Один путь для всех четырёх кнопок — чтобы отказ читался одинаково. */
  const send = async (
    label: 'propose' | 'execute' | 'withdraw',
    functionName: 'proposeRemoval' | 'removeArbiterForCause' | 'executeChainRemoval' | 'withdrawProposal',
    args: readonly unknown[],
    done: string,
  ) => {
    if (!publicClient) { toast.error('No RPC client'); return; }
    setBusy(label);
    try {
      // Жёсткого `gas:` здесь нет намеренно — см. шапку файла.
      const hash = await writeContractAsync({
        address: CONTRACTS.diamond as Address, abi: ARBITER_ACCOUNTABILITY_ABI,
        functionName,
        // ⚠️ Один путь на четыре разные подписи, поэтому кортеж аргументов
        // здесь по необходимости нетипизирован. Состав каждого вызова стоит у
        // его кнопки и сверен с ABI глазами; типизировать это по-настоящему
        // значило бы завести четыре одинаковых обработчика отказа.
        args: args as never,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === 'reverted') throw new Error('Transaction reverted on-chain');
      toast.success(done);
      after();
    } catch (err: unknown) {
      const e = err as { shortMessage?: string; message?: string };
      toast.error(e?.shortMessage ?? e?.message ?? 'Failed');
    } finally { setBusy(null); }
  };

  const pickEvidence = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const { uploadRemovalEvidence } = await import('@/lib/removalEvidence');
      const up = await uploadRemovalEvidence(file);
      setEvidence({ digest: up.digest, url: up.url, name: up.name });
      toast.success('Evidence stored — only its digest goes on chain');
    } catch (err: unknown) {
      toast.error((err as Error)?.message ?? 'Evidence upload failed');
    } finally { setUploading(false); }
  };

  /* ── 2a. живое обвинение ── */

  if (stage.kind === 'waiting' || stage.kind === 'ready') {
    const proposalCause = record ? causeByValue(record.cause) : null;

    /**
     * ⚠️ ВОРОТА ВТОРОЙ ДВЕРИ ПРОВЕРЯЮТСЯ ЗДЕСЬ, А НЕ В ЦЕПИ (круг правок 1).
     * Раньше кнопка гейтилась только занятостью, и нажатие с пустыми словами
     * или без адреса спора уходило в цепь и ревертило там — за деньги
     * подписавшего и без единого слова о причине.
     */
    const exec = checkExecution({
      recordedCause: record!.cause,
      recordedDigest: record!.evidenceDigest,
      reason,
      maxReasonBytes: rules.maxReasonBytes,
      disputeRef,
      mistakeStreak: standing ? Number(standing.mistakeStreak) : null,
      mistakeThreshold: rules.mistakeThreshold,
    });
    const needsWords = exec.needsWords;
    const needsDisputeRef = exec.needsDisputeRef;

    return (
      <div className="space-y-3 rounded-[14px] border border-red-500/20 bg-red-500/[0.04] p-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Pill tone="red">accusation standing</Pill>
          {stage.byChain
            ? <Pill tone="amber">laid by the chain itself</Pill>
            : <Pill tone="plain">laid by {short(record!.by)}</Pill>}
          <Pill tone="plain">{proposalCause?.name ?? `unknown cause ${record!.cause}`}</Pill>
          {proposalCause && (
            <Pill tone={proposalCause.verifiedByChain ? 'sky' : 'plain'}>
              {proposalCause.verifiedByChain ? 'chain verifies this itself' : 'chain does not verify this'}
            </Pill>
          )}
        </div>

        <p className="text-[11px] text-white/40 leading-relaxed">
          Proposed {stamp(record!.proposedAt)}. The 48 hours run from the proposal and an answer
          does not move them. Expires {stamp(stage.expiresAt)} — after that it can only be
          proposed again, not executed.
        </p>

        {!clocksKnown && (
          <p className="text-[11px] text-amber-300/70">
            The chain has not told us the pause length yet, so the clock below is not shown.
          </p>
        )}

        {stage.kind === 'waiting' ? (
          <p className="flex items-center gap-1.5 text-xs text-amber-300">
            <Clock className="w-3.5 h-3.5 shrink-0" />
            Execution opens in {formatSecondsLeft(stage.secondsLeft)} — at {stamp(stage.readyAt)}.
          </p>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-red-300">
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
            The pause is over — this can be executed now.
          </p>
        )}

        {record!.evidenceDigest !== ZERO_DIGEST && (
          <p className="text-[10px] font-mono text-white/30 break-all">
            evidence digest {record!.evidenceDigest}
          </p>
        )}

        {stage.byChain && <ChainSeries series={chainSeries} max={rules.maxMistakes} />}

        {standing?.answer.digest && (
          <p className="text-[11px] text-sky-300/70 break-all">
            The accused has answered — reply digest <span className="font-mono">{standing.answer.digest}</span>.
            The words are in the <code>RemovalReplyGiven</code> log, not in storage.
          </p>
        )}

        {stage.kind === 'ready' && !stage.byChain && (
          <div className="space-y-2 rounded-[12px] border border-white/[0.07] bg-white/[0.02] p-2.5">
            <p className="text-[11px] text-white/40 leading-relaxed">
              Executing repeats the cause of the proposal — the chain refuses any other
              (<code>CauseDiffersFromProposal</code>).
              {needsWords && ' The words are required again, and they are public.'}
              {needsDisputeRef && ' Silence needs the dispute it happened in.'}
            </p>
            {needsDisputeRef && (
              <Input
                placeholder="dispute (agreement) address"
                value={disputeRef} onChange={e => setDisputeRef(e.target.value)}
                className="font-mono text-xs bg-transparent border-white/[0.08] rounded-[12px]"
              />
            )}
            {needsWords && (
              <ReasonField
                value={reason} onChange={setReason} maxBytes={rules.maxReasonBytes}
              />
            )}
            {!exec.ok && <ProblemList problems={exec.problems} />}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {stage.kind === 'ready' && (
            stage.byChain ? (
              <Button
                size="sm" disabled={busy !== null}
                onClick={() => send('execute', 'executeChainRemoval', [arbiter], 'Arbiter removed')}
                className="gap-1.5 bg-red-500/15 border border-red-500/30 text-red-300 hover:bg-red-500/25"
              >
                {busy === 'execute' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldOff className="w-3.5 h-3.5" />}
                Execute the chain&apos;s removal
              </Button>
            ) : (
              <Button
                size="sm" disabled={busy !== null || !proposalCause || !exec.ok}
                onClick={() => send('execute', 'removeArbiterForCause', [
                  arbiter,
                  record!.cause,
                  record!.evidenceDigest,
                  needsDisputeRef ? (disputeRef as Address) : ZERO_ADDRESS,
                  reason,
                ], 'Arbiter removed')}
                className="gap-1.5 bg-red-500/15 border border-red-500/30 text-red-300 hover:bg-red-500/25"
              >
                {busy === 'execute' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldOff className="w-3.5 h-3.5" />}
                Execute removal
              </Button>
            )
          )}
          <Button
            size="sm" variant="outline" disabled={busy !== null}
            onClick={() => send('withdraw', 'withdrawProposal', [arbiter], 'Accusation withdrawn')}
            className="gap-1.5 border-white/15 text-white/50"
          >
            {busy === 'withdraw' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Undo2 className="w-3.5 h-3.5" />}
            Withdraw
          </Button>
        </div>

        <p className="text-[10px] text-white/25 leading-relaxed">
          Withdrawing is free and unpunished, but it is recorded: the arbiter keeps
          &laquo;was accused and it was withdrawn&raquo;, not a blank.
        </p>
      </div>
    );
  }

  /* ── 2b. предложить ── */

  const draft = {
    arbiter,
    cause,
    evidenceDigest: evidence?.digest ?? null,
    reason,
    maxReasonBytes: rules.maxReasonBytes,
    hasLiveProposal: false,
  };
  const check = checkProposal(draft);
  const selected = causeOption(cause);

  return (
    <div className="space-y-3 rounded-[14px] border border-white/[0.07] bg-white/[0.02] p-3">
      {stage.kind === 'stale' && record && (
        <p className="text-[11px] text-white/35 leading-relaxed">
          An earlier accusation ({causeByValue(record.cause)?.name ?? record.cause}, proposed{' '}
          {stamp(record.proposedAt)}) expired on {stamp(stage.expiresAt)} without being executed.
          It can no longer be executed — propose again if it still stands.
        </p>
      )}

      <div className="space-y-1.5">
        <p className="text-xs font-medium text-white/50">Cause</p>
        <select
          value={cause}
          onChange={e => setCause(e.target.value as RemovalCauseName)}
          className="w-full rounded-[12px] border border-white/[0.08] bg-transparent px-3 py-2 text-sm text-white/75"
        >
          {REMOVAL_CAUSE_OPTIONS.map(o => (
            <option key={o.name} value={o.name} className="bg-[#0d0d0f]">
              {o.name}{o.verifiedByChain ? ' — the chain verifies this itself' : ' — the chain does not verify this'}
            </option>
          ))}
        </select>
        <p className={cn('text-[11px] leading-relaxed', selected.verifiedByChain ? 'text-sky-300/70' : 'text-amber-300/70')}>
          {selected.verifiedByChain ? (
            <>The chain checks this cause against its own state, so evidence and words are optional.
            What it proves is that the sign the cause points at exists — not that the wording is right.</>
          ) : (
            <>The chain cannot check this cause at all. Evidence and words are required, and the
            words are public — they are what the accused answers during the 48 hours.</>
          )}
        </p>
      </div>

      <div className="space-y-1.5">
        <p className="text-xs font-medium text-white/50">Evidence</p>
        <label className="flex items-center gap-2 cursor-pointer rounded-[12px] border border-dashed border-white/[0.12] px-3 py-2 hover:border-white/25 transition-colors">
          {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin text-white/40" /> : <FileUp className="w-3.5 h-3.5 text-white/40" />}
          <span className="text-xs text-white/45 truncate">
            {evidence ? evidence.name : uploading ? 'Uploading…' : 'Attach a file'}
          </span>
          <input type="file" className="hidden" onChange={e => pickEvidence(e.target.files?.[0])} />
        </label>
        {evidence && (
          <p className="text-[10px] font-mono text-white/30 break-all">digest {evidence.digest}</p>
        )}
        <p className="text-[11px] text-white/30 leading-relaxed">
          <Upload className="w-3 h-3 inline-block mr-1 -mt-0.5" />
          Only the digest goes on chain — never the contents. The file is kept in permanent
          storage, alongside profiles, and stays readable for as long as the record does. Keep
          your own copy: the accused gets one too, and any of them can be checked against the
          digest.
        </p>
      </div>

      <div className="space-y-1.5">
        <p className="text-xs font-medium text-white/50">
          Words {selected.verifiedByChain ? <span className="text-white/25">(optional)</span> : <span className="text-amber-300/60">(required)</span>}
        </p>
        <ReasonField value={reason} onChange={setReason} maxBytes={rules.maxReasonBytes} />
      </div>

      {!check.ok && <ProblemList problems={check.problems} />}

      <Button
        size="sm"
        disabled={busy !== null || !check.ok}
        onClick={() => send('propose', 'proposeRemoval', [
          arbiter, selected.value, evidence?.digest ?? ZERO_DIGEST, reason,
        ], 'Removal proposed — 48 hours start now')}
        className="gap-1.5 bg-amber-500/15 border border-amber-500/30 text-amber-300 hover:bg-amber-500/25"
      >
        {busy === 'propose' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Gavel className="w-3.5 h-3.5" />}
        Propose removal
      </Button>

      <p className="text-[10px] text-white/25 leading-relaxed">
        Proposing takes nothing away by itself. The seat, the bond and the disputes stay where
        they are for 48 hours, during which the accused may answer on chain. Only then can the
        removal be executed — with the same cause, or the chain refuses it.
      </p>
    </div>
  );
}

/* ── слова: счётчик в БАЙТАХ ── */

/**
 * ⚠️ СЧЁТЧИК В БАЙТАХ, А НЕ В СИМВОЛАХ, И ЭТО НЕ ПРИДИРКА. Контракт меряет
 * `bytes(reason).length` (`_requireWithinCap`), а в UTF-8 кириллическая буква
 * занимает два байта. Считай мы символы, на русском тексте счётчик показал бы
 * «осталось 256» ровно там, где у цепи не осталось ничего, и транзакция вернула
 * бы `ReasonTooLong` уже после подписи. Хозяин счёта один —
 * `reasonByteLength`; своей арифметики здесь нет.
 */
export function ReasonField({ value, onChange, maxBytes }: {
  value: string; onChange: (v: string) => void; maxBytes: number | null;
}) {
  const used = reasonByteLength(value);
  const left = maxBytes === null ? null : reasonBytesLeft(value, maxBytes);
  const over = left !== null && left < 0;

  return (
    <div className="space-y-1">
      <Textarea
        value={value} onChange={e => onChange(e.target.value)}
        placeholder="What happened, in your own words. Public."
        className="text-sm bg-transparent border-white/[0.08] rounded-[12px] min-h-[72px]"
      />
      <p className={cn('text-[10px] font-mono', over ? 'text-red-400' : 'text-white/30')}>
        {maxBytes === null
          ? `${used} bytes — the chain has not told us the cap yet`
          : `${used} / ${maxBytes} bytes${over ? ` — ${-left!} over` : ''}`}
        <span className="ml-2 font-sans text-white/20">
          bytes, not characters: Cyrillic and emoji cost 2–4 each
        </span>
      </p>
    </div>
  );
}

const PROBLEM_TEXT: Record<string, string> = {
  arbiterMissing: 'No arbiter address.',
  causeUnknown: 'The cause on this record is a number this frontend does not know — do not execute it blind.',
  disputeRefRequired: 'Silence needs the dispute it happened in.',
  disputeRefNotApplicable: 'This cause takes no dispute address — the chain refuses one.',
  evidenceMissing: 'The record carries no evidence digest, and this cause needs one.',
  streakBelowThreshold: 'The mistake streak has dropped below the threshold — a clean verdict reset it, and the chain will answer CauseNotProven.',
  evidenceRequired: 'This cause is not verified by the chain — attach evidence.',
  reasonRequired: 'This cause is not verified by the chain — the words are required.',
  reasonTooLong: 'The words are over the cap the chain allows.',
  proposalAlreadyLive: 'An accusation already stands against this arbiter — withdraw it first.',
  capUnknown: 'The chain has not told us the cap on the words yet, so nothing is sent.',
};

function ProblemList({ problems }: { problems: string[] }) {
  return (
    <ul className="space-y-0.5">
      {problems.map(p => (
        <li key={p} className="flex items-start gap-1.5 text-[11px] text-amber-300/70">
          <Ban className="w-3 h-3 mt-0.5 shrink-0" />
          {PROBLEM_TEXT[p] ?? p}
        </li>
      ))}
    </ul>
  );
}

/* ── все споры серии ── */

/**
 * ⚠️ ВСЕ СПОРЫ, А НЕ ТОТ, ЧТО ПЕРЕВЕСИЛ (решение владельца 15а). Событие цепи
 * несёт один договор, обвинение стоит на трёх — остальные лежат в ленте.
 * «Спросить не у кого» и «споров нет» здесь РАЗНЫЕ новости: сабграф с этой
 * сущностью сегодня не выкачен, и молчание вместо честного «лента не ответила»
 * читалось бы как «обвинение стоит ни на чём».
 */
function ChainSeries({ series, max }: {
  series: ReturnType<typeof useChainAccusation>; max: number | null;
}) {
  if (series.isLoading) {
    return <p className="text-[11px] text-white/30">Reading the disputes behind this accusation…</p>;
  }
  if (series.unavailable) {
    return (
      <p className="text-[11px] text-amber-300/70 leading-relaxed">
        The disputes behind this accusation could not be read — the feed that carries them is
        not deployed yet. The chain named only the one that tipped him over
        {series.tippingAgreement ? <span className="font-mono"> ({short(series.tippingAgreement)})</span> : null};
        the rest are in the logs and will appear here once the subgraph is out.
      </p>
    );
  }
  if (!series.disputes || series.disputes.length === 0) {
    return <p className="text-[11px] text-white/30">No disputes recorded against this accusation.</p>;
  }
  const short_ = max !== null && series.disputeCount !== null && series.disputeCount < max;
  return (
    <div className="space-y-1">
      <p className="text-[11px] text-white/40">
        Every dispute this accusation stands on, oldest first — the one that tipped him over is last.
      </p>
      <ul className="space-y-0.5">
        {series.disputes.map(d => (
          <li key={d} className="font-mono text-[10px] text-white/45 break-all">{d}</li>
        ))}
      </ul>
      {short_ && (
        <p className="text-[11px] text-amber-300/70">
          The feed lists {series.disputeCount} of the {max} the chain counted — something was
          missed, and it is worth a look rather than a shrug.
        </p>
      )}
    </div>
  );
}

/* ══════════════════ 3. карточка арбитра ══════════════════ */

export function ArbiterAccountabilityCard({ arbiter, isChief, rules, onChanged }: {
  arbiter: Address; isChief: boolean; rules: RemovalRules; onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { standing } = useArbiterStanding(arbiter, rules.presence === 'ready');
  // Момент один на всю жизнь карточки: конец приостановки — часы, а не
  // секунды, и тикать ради него значило бы перерисовывать весь список.
  const [now] = useState(() => Math.floor(Date.now() / 1000));

  const suspended = !!standing && standing.suspendedUntil > now;

  return (
    <div className={cn(
      'rounded-[14px] border px-3 py-2.5 space-y-2.5',
      isChief ? 'border-amber-500/20 bg-amber-500/[0.05]' : 'border-white/[0.06] bg-white/[0.02]',
    )}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          {isChief && <Crown className="w-3.5 h-3.5 text-amber-400 shrink-0" />}
          <span className="font-mono text-xs text-white/60 truncate">{arbiter}</span>
          {isChief && <Pill tone="amber">Chief</Pill>}
          {suspended && <Pill tone="red">suspended until {stamp(standing!.suspendedUntil)}</Pill>}
          {standing?.hasLiveRemovalProposal && <Pill tone="red">accusation standing</Pill>}
          {standing && standing.removalCount > 0n && (
            <Pill tone="plain">removed {standing.removalCount.toString()}× · last {stamp(standing.lastRemovalAt)}</Pill>
          )}
        </div>
        {rules.presence === 'ready' && (
          <button
            onClick={() => setOpen(v => !v)}
            className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70 transition-colors shrink-0"
          >
            <Gavel className="w-3.5 h-3.5" />
            {open ? 'Hide' : 'Accountability'}
          </button>
        )}
      </div>

      {rules.presence === 'ready' && standing && (
        <>
          <StandingNumbers standing={standing} />
          <MistakeOutlookLine standing={standing} rules={rules} />
        </>
      )}

      {rules.presence === 'ready' && open && (
        <ArbiterRemovalFlow arbiter={arbiter} rules={rules} standing={standing} onChanged={onChanged} />
      )}
    </div>
  );
}
