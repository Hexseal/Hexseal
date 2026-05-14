"use client";

import React, { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import MobileBottomNav from "@/components/MobileBottomNav";
import Toaster from '@/components/Toaster/ToasterClient';
import OnboardingModal from "@/components/OnboardingModal";

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [onboardingForced, setOnboardingForced] = useState(false);

  useEffect(() => {
    const handler = () => setOnboardingForced(true);
    window.addEventListener('sig404:open-onboarding', handler);
    return () => window.removeEventListener('sig404:open-onboarding', handler);
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
      <>
        <Header />
        <main className="h-dvh flex flex-col overflow-hidden" style={{ paddingTop: 'calc(4rem + env(safe-area-inset-top))' }}>
          {children}
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
        <Header />
        <main className="flex-1">
          {children}
        </main>
        <Footer />
        {modal}
        <Toaster />
      </>
    );
  }

  return (
    <>
      <Header />
      <main className="flex-1" style={{ paddingTop: 'calc(4.5rem + env(safe-area-inset-top))' }}>
        {children}
        <div className="md:hidden" style={{ height: 'calc(6.5rem + env(safe-area-inset-bottom, 0px))' }} />
      </main>
      <MobileBottomNav />
      {modal}
      <Toaster />
    </>
  );
}
