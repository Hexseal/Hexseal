'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useDirectChat } from '@/hooks/useDirectChat';
import { Send, Loader2, MessageCircle, X, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Props = {
  recipientAddress: string;
  recipientLabel?: string;
  currentUser: string;
  isOpen: boolean;
  onClose: () => void;
};

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function JobChat({ recipientAddress, recipientLabel, currentUser, isOpen, onClose }: Props) {
  const { messages, sendMessage, isLoading, isInitialized, error } = useDirectChat(
    isOpen ? recipientAddress : '',
  );

  const [text, setText]     = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || !isInitialized) return;
    setSending(true);
    try {
      await sendMessage(trimmed);
      setText('');
    } catch (err) {
      console.error('[JobChat] send error:', err);
    } finally {
      setSending(false);
    }
  };

  if (!isOpen) return null;

  const label = recipientLabel || shortAddr(recipientAddress);

  return (
    <div className="fixed bottom-4 right-4 w-80 bg-[#0c0c0e] border border-white/15 rounded-xl shadow-2xl z-50 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-white/10 bg-white/[0.03]">
        <div className="flex items-center gap-2 text-sm text-white/80">
          <MessageCircle className="w-4 h-4 text-primary" />
          <span className="font-semibold truncate max-w-[180px]">{label}</span>
        </div>
        <button onClick={onClose} className="text-white/30 hover:text-white/70 transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Messages */}
      <div className="h-60 overflow-y-auto p-3 space-y-2 flex flex-col">
        {isLoading && (
          <div className="flex items-center justify-center flex-1 h-full gap-2 text-white/30">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-xs">Connecting…</span>
          </div>
        )}
        {!isLoading && error && (
          <div className="flex items-center justify-center flex-1 h-full gap-2">
            <AlertCircle className="w-4 h-4 text-red-400/60" />
            <p className="text-xs text-red-400/70">{error}</p>
          </div>
        )}
        {!isLoading && !error && messages.length === 0 && (
          <p className="text-center text-xs text-white/25 py-8">No messages yet. Say hi!</p>
        )}
        {!isLoading && !error && messages.map((msg) => {
          const isMe = msg.from === currentUser.toLowerCase();
          return (
            <div key={msg.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-lg px-2.5 py-1.5 text-xs break-words ${
                isMe ? 'bg-primary/80 text-white' : 'bg-white/10 text-white/80'
              }`}>
                {msg.text}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="flex gap-2 p-2 border-t border-white/10">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          placeholder={isLoading ? 'Connecting…' : error ? 'Unavailable' : 'Message…'}
          disabled={isLoading || !!error || !isInitialized}
          className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white placeholder:text-white/25 focus:outline-none focus:border-primary/40 disabled:opacity-40"
        />
        <Button
          size="sm"
          onClick={handleSend}
          disabled={sending || !text.trim() || isLoading || !!error || !isInitialized}
          className="h-8 w-8 p-0 flex-shrink-0"
        >
          {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
        </Button>
      </div>
    </div>
  );
}
