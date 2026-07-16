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
      position="bottom-right"
      gutter={8}
      containerStyle={{
        bottom: 24,
        right: 16,
        zIndex: 99999,
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
