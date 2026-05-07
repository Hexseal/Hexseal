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
      toastOptions={{
        style: {
          background: '#1a1a1a',
          color: '#fff',
          border: '1px solid #333',
          borderRadius: '0.25rem',
          padding: '1rem',
        },
      }} 
    />
  );
}
