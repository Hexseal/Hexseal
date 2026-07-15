'use client';

import dynamic from 'next/dynamic';

const Toaster = dynamic(
  () => import('react-hot-toast').then((c) => {
    const ToasterComponent = c.Toaster;
    return (props: any) => <ToasterComponent {...props} />;
  }),
  { ssr: false }
);

export default function ToasterClient() {
  return (
    <Toaster
      position="top-center"
      gutter={10}
      containerStyle={{
        // True vertical center of the viewport.
        // Container top lands at ~50% — react-hot-toast adds a 16px gutter then
        // the first toast (~44px tall), so its visual center sits at ≈ 50dvh.
        top: 'calc(50dvh - 60px)',
        zIndex: 99999,
        // Prevent the invisible container div from eating pointer events
        // between toasts; individual toasts restore pointer-events themselves.
        pointerEvents: 'none',
      }}
      toastOptions={{
        style: {
          background: '#141416',
          color: 'rgba(255,255,255,0.88)',
          border: '1px solid rgba(255,255,255,0.09)',
          borderRadius: '16px',
          fontSize: '13px',
          fontWeight: 500,
          padding: '12px 16px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.35)',
          backdropFilter: 'blur(16px)',
          pointerEvents: 'auto',
          maxWidth: '320px',
        },
        duration: 3500,
        success: { iconTheme: { primary: '#4ade80', secondary: '#141416' } },
        error:   { iconTheme: { primary: '#f87171', secondary: '#141416' } },
      }}
    />
  );
}
