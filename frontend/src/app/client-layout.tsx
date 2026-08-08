"use client";

import React, { useEffect, useState, useRef, Suspense } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import MobileBottomNav from "@/components/MobileBottomNav";
import Toaster from '@/components/Toaster/ToasterClient';
import OnboardingModal from "@/components/OnboardingModal";
import { useTranslations } from "next-intl";
import { toast } from "react-hot-toast";
import { onPushDeliveryFailure } from "@/lib/webpush";
import { pushOutcomeKey } from "@/lib/chatNotices";
import { RecoveryCodeGate } from "@/components/RecoveryCodeGate";
import {
  APP_BUILD_ID, fetchServedVersion, shouldReloadForVersion,
  reloadAlreadyTried, rememberReloadAttempt, versionCheckDue,
} from '@/lib/appVersion';

// Page transition via pure CSS animation (page-enter keyframe in globals.css).
// CSS animations run on the compositor thread — independent of JS work — so
// the fade stays smooth on iPhone even while React mounts the new page's hooks.
// key={pathname} forces React to remount the div, restarting the animation.
let _pageHasLoaded = false;
function PageFade({ children, pathname }: { children: React.ReactNode; pathname: string }) {
  const isChat = pathname?.startsWith('/chat');
  useEffect(() => { _pageHasLoaded = true; }, []);
  return (
    <div
      key={pathname}
      className={`relative min-h-0 flex flex-col flex-1 ${_pageHasLoaded ? 'page-enter' : ''} ${isChat ? 'overflow-hidden' : ''}`}
    >
      {children}
    </div>
  );
}

// Gradient scrims that hide content scrolling behind pill UI elements on mobile
// Covers the status-bar gap above the floating pill header, then fades through
// the pill's own backdrop-blur zone. Solid only up to pill top (safe-area + 10px);
// the 70px fade after that is hidden behind the pill (z-50 > z-40) and produces
// only a subtle ~10px shadow below it.
const topScrim = (
  <div
    aria-hidden
    className="md:hidden fixed top-0 left-0 right-0 pointer-events-none z-40"
    style={{
      height: 'calc(env(safe-area-inset-top, 0px) + 58px)',
      background: 'linear-gradient(to bottom, #000 calc(env(safe-area-inset-top, 0px) + 10px), transparent calc(env(safe-area-inset-top, 0px) + 58px))',
    }}
  />
);
const bottomScrim = (
  <div
    aria-hidden
    className="md:hidden fixed bottom-0 left-0 right-0 pointer-events-none z-40"
    style={{
      height: 'calc(env(safe-area-inset-bottom, 0px) + 128px)',
      background: 'linear-gradient(to top, #000 0%, #000 70%, transparent 100%)',
    }}
  />
);

// /chat is always a fixed full-screen layout — list view AND conversation view.
// This eliminates the layout seam that occurred when ?peer was added/removed:
// previously the app shell switched between scrollable and fixed, causing a
// visible jump. Now the shell is stable; only internal CSS handles the panel switch.
//
// MobileBottomNav floats (position:fixed) over the list when no peer is selected.
// Body lock is applied by ChatLayoutInner only when a conversation is open (hasPeer).
//
// Must be inside Suspense because useSearchParams() needs it in Next.js app router.
function ChatLayoutInner({
  children,
  pathname,
  modal,
}: {
  children: React.ReactNode;
  pathname: string;
  modal: React.ReactNode;
}) {
  const sp = useSearchParams();
  const hasPeer = !!sp.get('peer');

  // Body lock only when a conversation is open — prevents iOS from scrolling the
  // page behind the keyboard. The list view never has a keyboard, so no lock needed,
  // and locking it was breaking the nav's fixed positioning on iOS.
  const scrollYRef = useRef(0);
  useEffect(() => {
    if (!hasPeer) return;
    const body = document.body;
    const html = document.documentElement;
    scrollYRef.current = window.scrollY;
    body.style.position = 'fixed';
    body.style.top = `-${scrollYRef.current}px`;
    body.style.width = '100%';
    body.style.overflow = 'hidden';
    html.style.overflow = 'hidden';
    return () => {
      body.style.position = '';
      body.style.top = '';
      body.style.width = '';
      body.style.overflow = '';
      html.style.overflow = '';
      window.scrollTo(0, scrollYRef.current);
    };
  }, [hasPeer]);

  return (
    <>
      <main
        className="flex flex-col overflow-hidden"
        style={{
          position: 'fixed',
          top: 'var(--chat-top-offset)',
          left: 0,
          right: 0,
          height: 'calc(var(--vvh, 100dvh) - var(--chat-top-offset))',
        }}
      >
        <PageFade pathname={pathname}>{children}</PageFade>
      </main>
      {!hasPeer && bottomScrim}
      {!hasPeer && <MobileBottomNav />}
      {modal}
      <Toaster />
    </>
  );
}

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const tLayout = useTranslations();

  // ⚠️ ОТКАЗ ДОСТАВКИ УВЕДОМЛЕНИЯ — ЗДЕСЬ, И ЭТО ЗАМЕР, А НЕ ВКУС.
  // Сначала подписка стояла на двух досках. `grep` показал, что уведомления
  // отправляет РОВНО ОДНО место — `notifyPush` из `usePairChat`, то есть
  // чат; на доски событие не приходило никогда. Подписчик был, событие не
  // приходило — подписка, которая ничего не слушает.
  //
  // Почему не в самом чате: отправка — «пожар и забыл», и к моменту отказа
  // вкладка может уже уйти со страницы переписки (человек отправил и
  // перешёл). Общая обёртка живёт на КАЖДОЙ странице и держит `Toaster`.
  useEffect(() => onPushDeliveryFailure((failure) => {
    const key = pushOutcomeKey(failure.outcome);
    if (key) toast.error(tLayout(key as Parameters<typeof tLayout>[0]));
  }), [tLayout]);
  const [onboardingForced, setOnboardingForced] = useState(false);
  useEffect(() => {
    const handler = () => setOnboardingForced(true);
    window.addEventListener('hexseal:open-onboarding', handler);
    return () => window.removeEventListener('hexseal:open-onboarding', handler);
  }, []);


  // Clear App Badge whenever the user brings the PWA to the foreground.
  useEffect(() => {
    const clear = () => {
      if (document.visibilityState === 'visible' && 'clearAppBadge' in navigator) {
        navigator.clearAppBadge().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', clear);
    clear();
    return () => document.removeEventListener('visibilitychange', clear);
  }, []);

  /**
   * НОВАЯ ВЕРСИЯ ВЫКАЧЕНА — узнать и перезагрузиться, один раз.
   *
   * ⚠️ ЗАЧЕМ ЗДЕСЬ, А НЕ В ЧАТЕ. В манифесте `launch_handler: focus-existing`:
   * открытие ярлыка возвращает существующее окно, а не перезагружает страницу.
   * Значит установленное приложение крутит прежний код сколько угодно — 8 августа
   * это стоило нам часов, потому что правки были выкачены, а телефон работал
   * по-старому и выглядел непочиненным. Беда общая для всего приложения, значит и
   * проверка общая.
   *
   * ⚠️ ЗАЩИТА ОТ ПЕТЛИ — ГЛАВНОЕ ЗДЕСЬ, а не сама перезагрузка. Правило и обе
   * меры (номер из одного вкомпилированного места; одна попытка на версию) — в
   * `lib/appVersion.ts`. Ложное «перезагрузиться» ломает приложение целиком;
   * ложное «не надо» всего лишь оставляет старый код.
   *
   * Спрашиваем на ВОЗВРАЩЕНИИ страницы в глаза, не по таймеру: именно тогда
   * человек смотрит на экран, и именно тогда приложение вернулось из кошелька.
   */
  const lastVersionCheck = useRef(0);
  useEffect(() => {
    const check = async () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (!versionCheckDue(lastVersionCheck.current, now)) return;
      lastVersionCheck.current = now;
      const served = await fetchServedVersion();
      if (!served) return;
      if (!shouldReloadForVersion({
        current: APP_BUILD_ID, served, alreadyTried: reloadAlreadyTried(served),
      })) return;
      // Отметка ставится ДО перезагрузки: поставив её после, мы бы не поставили
      // её никогда — страница уже уехала.
      rememberReloadAttempt(served);
      window.location.reload();
    };
    void check();
    document.addEventListener('visibilitychange', check);
    return () => document.removeEventListener('visibilitychange', check);
  }, []);

  // Dynamically measure the real header bottom edge and write --chat-top-offset.
  // Must use .bottom (not .height) because the floating pill header has a top offset.
  // Must scan all <header> elements: on desktop the first one is md:hidden (height=0).
  useEffect(() => {
    const update = () => {
      const headers = Array.from(document.querySelectorAll('header'));
      const bottom = headers.reduce((max, h) => Math.max(max, h.getBoundingClientRect().bottom), 0);
      document.documentElement.style.setProperty('--chat-top-offset', `${bottom || 76}px`);
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  // Track visual viewport dimensions for iOS keyboard handling.
  // --vvh shrinks when the keyboard opens, keeping the input above it.
  // --vv-offset-top counteracts iOS PWA visual-viewport displacement on keyboard open.
  //
  // NOTE: only 'resize' is used, not 'scroll'. The scroll event fires on user
  // swipe gestures too (changing vv.offsetTop), which caused the fixed chat
  // container to slide visibly when swiping in the header area. Keyboard
  // open/close always fires 'resize', so 'resize' alone is sufficient.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      document.documentElement.style.setProperty('--vvh', `${vv.height}px`);
      document.documentElement.style.setProperty('--vv-offset-top', `${vv.offsetTop}px`);
    };
    vv.addEventListener('resize', update);
    update();
    return () => {
      vv.removeEventListener('resize', update);
      document.documentElement.style.removeProperty('--vv-offset-top');
    };
  }, []);

  const modal = (
    <OnboardingModal
      forceOpen={onboardingForced}
      onClose={() => setOnboardingForced(false)}
    />
  );

  const isChatPage = pathname?.startsWith('/chat');
  const isHome = pathname === '/';

  // <Header/> is hoisted above the branches so it isn't remounted on navigation: it used to be
  // rendered separately inside each branch (plus a 4th copy in the chat Suspense
  // fallback), so React treated it as a brand-new subtree on every chat ↔ home ↔
  // other navigation and remounted it — resetting WalletMenu's local state and
  // re-firing every account/profile/contract read it holds. One instance here
  // survives all of that; only the content below it changes per branch.
  return (
    <>
      <Header />
      {/* Код восстановления — РОВНО ОДИН привратник на приложение. Поднят
          сюда, к <Header/>, по той же причине: `useChatSession()` живёт в
          нескольких компонентах сразу и на первом открытии все они получают
          один и тот же объект сеанса — окно в каждом дало бы три окна
          поверх друг друга. Плюс он переживает переходы между страницами,
          то есть «пропустить» не отменяется навигацией.
          Заперто `lib/chatRecoveryWiring.test.ts`. */}
      <RecoveryCodeGate />
      {isChatPage ? (
        <Suspense fallback={
          <main className="flex-1" style={{ paddingTop: 'var(--content-top-offset)' }}>
            {children}
          </main>
        }>
          <ChatLayoutInner pathname={pathname ?? ''} modal={modal}>
            {children}
          </ChatLayoutInner>
        </Suspense>
      ) : isHome ? (
        <>
          <main className="flex-1">
            <PageFade pathname={pathname ?? ''}>{children}</PageFade>
          </main>
          <Footer />
          {modal}
          <Toaster />
        </>
      ) : (
        <>
          {topScrim}
          {bottomScrim}
          <main className="flex-1" style={{ paddingTop: 'var(--content-top-offset)' }}>
            <PageFade pathname={pathname ?? ''}>
              {children}
              <div className="md:hidden" style={{ height: 'calc(5.75rem + env(safe-area-inset-bottom, 0px))' }} />
            </PageFade>
          </main>
          <MobileBottomNav />
          {modal}
          <Toaster />
        </>
      )}
    </>
  );
}
