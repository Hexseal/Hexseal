"use client";

import React, { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import MobileBottomNav from "@/components/MobileBottomNav";
import Toaster from '@/components/Toaster/ToasterClient';
import OnboardingModal from "@/components/OnboardingModal";

// Re-mounts on each navigation via key={pathname}, triggering the fade-in.
function PageFade({ children, pathname }: { children: React.ReactNode; pathname: string }) {
  return (
    <div key={pathname} className="animate-in fade-in duration-200 min-h-0 flex flex-col flex-1">
      {children}
    </div>
  );
}

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [onboardingForced, setOnboardingForced] = useState(false);

  useEffect(() => {
    const handler = () => setOnboardingForced(true);
    window.addEventListener('sig404:open-onboarding', handler);
    return () => window.removeEventListener('sig404:open-onboarding', handler);
  }, []);

  // Track the true visible-viewport height (shrinks when keyboard opens on iOS).
  // Also listen to 'scroll' so we catch the visual-viewport offset iOS applies
  // when focusing an input (prevents the "flies up" effect).
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      document.documentElement.style.setProperty('--vvh', `${vv.height}px`);
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  // For chat pages: prevent iOS Safari from scrolling the document when the
  // keyboard opens (its "scroll-to-focused-input" fires immediately on tap,
  // before the keyboard even appears, and "flies" the whole chat up).
  // body.position=fixed is the only reliable stopper on iOS; we compensate the
  // scroll-position snap by saving scrollY first so there's no visual jump.
  const isChatPageRef = React.useRef(false);
  const bodyScrollY   = React.useRef(0);
  const currentIsChatPage = pathname?.startsWith('/chat') ?? false;
  useEffect(() => {
    isChatPageRef.current = currentIsChatPage;
    const body = document.body;
    const html = document.documentElement;
    if (currentIsChatPage) {
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
      if (isChatPageRef.current) {
        body.style.position = '';
        body.style.top      = '';
        body.style.width    = '';
        body.style.overflow = '';
        html.style.overflow = '';
        window.scrollTo(0, bodyScrollY.current);
      }
    };
  }, [currentIsChatPage]);

  const modal = (
    <OnboardingModal
      forceOpen={onboardingForced}
      onClose={() => setOnboardingForced(false)}
    />
  );

  // Gradient scrims that hide content scrolling behind pill UI elements on mobile
  const topScrim = (
    <div
      aria-hidden
      className="md:hidden fixed top-0 left-0 right-0 pointer-events-none z-40"
      style={{
        height: 'calc(env(safe-area-inset-top, 0px) + 80px)',
        background: 'linear-gradient(to bottom, #000 0%, #000 40%, transparent 100%)',
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

  const isChatPage = pathname?.startsWith('/chat');
  if (isChatPage) {
    return (
      <>
        {/* topScrim is skipped for chat — the ChatPanel has its own fixed header
            and the flex layout prevents messages from scrolling behind it. */}
        <Header chatMode />
        {/* --chat-top-offset is a CSS variable: env(safe-area-inset-top) on mobile
            (pill header is hidden in chatMode) and 4rem + safe-area on desktop.
            --vvh is set by the VisualViewport listener and shrinks when the
            keyboard opens, keeping the input above the keyboard on iOS. */}
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
        {modal}
        <Toaster />
      </>
    );
  }

  const isHome = pathname === '/';
  if (isHome) {
    return (
      <>
        {topScrim}
        <Header />
        <main className="flex-1">
          <PageFade pathname={pathname}>{children}</PageFade>
        </main>
        <Footer />
        {modal}
        <Toaster />
      </>
    );
  }

  return (
    <>
      {topScrim}
      {bottomScrim}
      <Header />
      <main className="flex-1" style={{ paddingTop: 'calc(4.5rem + env(safe-area-inset-top))' }}>
        <PageFade pathname={pathname}>
          {children}
          <div className="md:hidden" style={{ height: 'calc(6.5rem + env(safe-area-inset-bottom, 0px))' }} />
        </PageFade>
      </main>
      <MobileBottomNav />
      {modal}
      <Toaster />
    </>
  );
}
