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
  // Sets --vvh on <html> so the chat container can use it instead of dvh/vh.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      document.documentElement.style.setProperty('--vvh', `${vv.height}px`);
    };
    vv.addEventListener('resize', update);
    update(); // set immediately
    return () => vv.removeEventListener('resize', update);
  }, []);

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
        height: 'calc(env(safe-area-inset-bottom, 0px) + 150px)',
        background: 'linear-gradient(to top, #000 0%, #000 70%, transparent 100%)',
      }}
    />
  );

  const isChatPage = pathname?.startsWith('/chat');
  if (isChatPage) {
    return (
      <>
        {topScrim}
        <Header />
        {/* height = visual viewport height (--vvh) minus the header clearance.
            --vvh is set by the VisualViewport listener above and shrinks when
            the keyboard opens, so the flex layout stays correct on iOS. */}
        <main
          className="flex flex-col overflow-hidden"
          style={{
            height: 'calc(var(--vvh, 100dvh) - 4rem - env(safe-area-inset-top, 0px))',
            marginTop: 'calc(4rem + env(safe-area-inset-top, 0px))',
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
          <div className="md:hidden" style={{ height: 'calc(7.5rem + env(safe-area-inset-bottom, 0px))' }} />
        </PageFade>
      </main>
      <MobileBottomNav />
      {modal}
      <Toaster />
    </>
  );
}
