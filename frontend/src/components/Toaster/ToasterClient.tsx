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
      containerStyle={{
        top: 'calc(env(safe-area-inset-top, 0px) + 84px)',
      }}
      toastOptions={{
        style: {
          background: '#1a1a1d',
          color: 'rgba(255,255,255,0.85)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '14px',
          fontSize: '13px',
          padding: '10px 14px',
          zIndex: 9999,
        },
        success: { iconTheme: { primary: '#4ade80', secondary: '#0d0d0f' } },
        error:   { iconTheme: { primary: '#f87171', secondary: '#0d0d0f' } },
      }}
    />
  );
}
