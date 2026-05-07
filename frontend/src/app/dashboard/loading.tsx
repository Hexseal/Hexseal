import React from 'react';

export default function DashboardLoading() {
  return (
    <div className="min-h-screen bg-black text-white flex flex-col items-center justify-center p-4">
      <div className="text-center">
        <div className="inline-block h-12 w-12 border-4 border-white border-t-transparent rounded-full animate-spin mb-4"></div>
        <h2 className="text-2xl font-mono mb-2">Loading data...</h2>
        <p className="text-gray-400 text-sm">Please wait while we check your access</p>
      </div>
    </div>
  );
}
