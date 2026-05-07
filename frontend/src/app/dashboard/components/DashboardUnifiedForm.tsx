"use client";

import React from "react";
import { DashboardForms } from './DashboardForms';

export function DashboardUnifiedForm() {
  return (
    <div className="bg-black/60 backdrop-blur-sm border border-gray-800 rounded-xl p-6">
      <DashboardForms />
    </div>
  );
}
