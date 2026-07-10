"use client";

import React, { useEffect, useState, Suspense } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import MobileBottomNav from "@/components/MobileBottomNav";
import Toaster from '@/components/Toaster/ToasterClient';
import OnboardingModal from "@/components/OnboardingModal";
import { XmtpProvider } from "@/contexts/XmtpContext";

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
      className={`min-h-0 flex flex-col flex-1 ${_pageHasLoaded ? 'page-enter' : ''} ${isChat ? 'overflow-hidden' : ''}`}
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

// Reads ?peer to decide which chat layout to use.
// Must be inside Suspense because useSearchParams() needs it in Next.js app router.
//
// Chat LIST  (?peer absent): normal scrollable page + floating MobileBottomNav.
//   Nav appears as a true system element, not embedded in any container.
//
// Chat CONVO (?peer=xxx):    position:fixed full-screen layout + body lock.
//   Prevents iOS Safari from flying the page up when the keyboard opens.
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
  const bodyScrollY = React.useRef(0);

  // body.position=fixed: lock the document only while a conversation is open.
  // iOS Safari fires "scroll to focused input" before the keyboard appears;
  // fixing the body is the only reliable way to stop the page from jumping.
  useEffect(() => {
    const body = document.body;
    const html = document.documentElement;
    if (hasPeer) {
      bodyScrollY.current = window.scrollY;
      body.style.position = 'fixed';
      body.style.top      = `-${bodyScrollY.current}px`;
      body.style.width    = '100%';
      body.style.overflow = 'hidden';
      html.style.overflow = 'hidden';
    } else {
      body.style.position = '';
      body.style.top      = '';
      body.style.width    = '';
      body.style.overflow = '';
      html.style.overflow = '';
      window.scrollTo(0, bodyScrollY.current);
    }
    return () => {
      body.style.position = '';
      body.style.top      = '';
      body.style.width    = '';
      body.style.overflow = '';
      html.style.overflow = '';
      window.scrollTo(0, bodyScrollY.current);
    };
  }, [hasPeer]);

  if (hasPeer) {
    // Conversation: fixed full-screen container.
    // --chat-top-offset: safe-area-only on mobile (pill header hidden),
    //                    4rem + safe-area on desktop.
    // --vvh:            visual viewport height — shrinks when keyboard opens.
    // --vv-offset-top:  iOS visual viewport scroll offset — keeps fixed element
    //                   anchored to visual (not layout) viewport.
    return (
      <>
        <Header />
        <main
          className="flex flex-col overflow-hidden"
          style={{
            position: 'fixed',
            top: 'calc(var(--chat-top-offset) + var(--vv-offset-top, 0px))',
            left: 0,
            right: 0,
            height: 'calc(var(--vvh, 100dvh) - var(--chat-top-offset))',
          }}
        >
          <PageFade pathname={pathname}>{children}</PageFade>
        </main>
        {modal}
        <Toaster />
      </>
    );
  }

  // Chat list: normal scrollable page layout — nav is a real floating element.
  return (
    <>
      {topScrim}
      {bottomScrim}
      <Header />
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
  );
}

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [onboardingForced, setOnboardingForced] = useState(false);
  useEffect(() => {
    const handler = () => setOnboardingForced(true);
    window.addEventListener('hexseal:open-onboarding', handler);
    return () => window.removeEventListener('hexseal:open-onboarding', handler);
  }, []);

  // Early body lock: fires before the Suspense/ChatLayoutInner effect has a chance to run.
  // Reads window.location.search directly to avoid needing useSearchParams here.
  useEffect(() => {
    if (!pathname?.startsWith('/chat')) return;
    const hasPeer = new URLSearchParams(window.location.search).has('peer');
    if (!hasPeer) return;
    const body = document.body;
    const html = document.documentElement;
    const scrollY = window.scrollY;
    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.width = '100%';
    body.style.overflow = 'hidden';
    html.style.overflow = 'hidden';
    return () => {
      body.style.position = '';
      body.style.top = '';
      body.style.width = '';
      body.style.overflow = '';
      html.style.overflow = '';
      window.scrollTo(0, scrollY);
    };
  }, [pathname]);

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
  if (isChatPage) {
    return (
      <XmtpProvider>
        <Suspense fallback={
          <>
            <Header />
            <main className="flex-1" style={{ paddingTop: 'var(--content-top-offset)' }}>
              {children}
            </main>
          </>
        }>
          <ChatLayoutInner pathname={pathname ?? ''} modal={modal}>
            {children}
          </ChatLayoutInner>
        </Suspense>
      </XmtpProvider>
    );
  }

  const isHome = pathname === '/';
  if (isHome) {
    return (
      <XmtpProvider>
        <>
          <Header />
          <main className="flex-1">
            <PageFade pathname={pathname ?? ''}>{children}</PageFade>
          </main>
          <Footer />
          {modal}
          <Toaster />
        </>
      </XmtpProvider>
    );
  }

  return (
    <XmtpProvider>
      <>
        {topScrim}
        {bottomScrim}
        <Header />
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
    </XmtpProvider>
  );
}
