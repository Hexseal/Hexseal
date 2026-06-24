'use client';

import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const PREFIX = 'hexseal_hint_';

export function useHint(key: string) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!localStorage.getItem(PREFIX + key)) setVisible(true);
  }, [key]);

  const dismiss = () => {
    localStorage.setItem(PREFIX + key, '1');
    setVisible(false);
  };

  return { visible, dismiss };
}

export function ContextHint({ hintKey, children }: { hintKey: string; children: React.ReactNode }) {
  const { visible, dismiss } = useHint(hintKey);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.2 }}
          className="flex items-start gap-2 rounded-[14px] border border-white/[0.07] bg-white/[0.03] px-3.5 py-2.5"
        >
          <p className="flex-1 text-xs text-white/35 leading-relaxed">{children}</p>
          <button
            onClick={dismiss}
            className="shrink-0 text-white/20 hover:text-white/50 transition-colors mt-0.5"
            aria-label="Dismiss hint"
          >
            <X className="w-3 h-3" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
