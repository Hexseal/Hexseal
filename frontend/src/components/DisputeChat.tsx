"use client";

import React, { useState, useEffect, useRef } from "react";
import { useAccount } from "wagmi";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Loader2, MessageCircle, Shield } from "lucide-react";
import { verifyMessage } from "viem";

interface DisputeMessage {
  id: string;
  sender: string;
  content: string;
  timestamp: number;
  signature: string;
}

interface DisputeChatProps {
  participants: string[];
  dealAddress: string;
}

const STORAGE_KEY = "s404_dispute_messages";

function getStorageKey(dealAddress: string): string {
  return `${STORAGE_KEY}_${dealAddress.toLowerCase()}`;
}

function loadMessages(dealAddress: string): DisputeMessage[] {
  try {
    const data = localStorage.getItem(getStorageKey(dealAddress));
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

function saveMessages(dealAddress: string, messages: DisputeMessage[]) {
  try {
    localStorage.setItem(getStorageKey(dealAddress), JSON.stringify(messages));
  } catch {
    // Storage full or unavailable
  }
}

export function DisputeChat({ participants, dealAddress }: DisputeChatProps) {
  const { address, isConnected } = useAccount();
  const [messages, setMessages] = useState<DisputeMessage[]>([]);
  const [messageInput, setMessageInput] = useState("");
  const [isSigning, setIsSigning] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages(loadMessages(dealAddress));
  }, [dealAddress]);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSignAndSend = async () => {
    if (!messageInput.trim() || !address || !isConnected) return;

    setIsSigning(true);
    try {
      // Sign the message with wallet
      const signature = await (window as any).ethereum.request({
        method: "personal_sign",
        params: [
          `0x${Buffer.from(messageInput.trim()).toString("hex")}`,
          address,
        ],
      });

      const newMessage: DisputeMessage = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        sender: address,
        content: messageInput.trim(),
        timestamp: Date.now(),
        signature,
      };

      const updated = [...messages, newMessage];
      setMessages(updated);
      saveMessages(dealAddress, updated);
      setMessageInput("");
    } catch (error) {
      console.error("Failed to sign message:", error);
    } finally {
      setIsSigning(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSignAndSend();
    }
  };

  const isParticipant = participants.some(
    (p) => p.toLowerCase() === address?.toLowerCase()
  );

  if (!isConnected) {
    return (
      <Card className="mt-6">
        <CardContent className="py-8 text-center">
          <MessageCircle className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
          <p className="text-muted-foreground">Connect your wallet to use dispute chat</p>
        </CardContent>
      </Card>
    );
  }

  if (!isParticipant) {
    return null;
  }

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Shield className="w-5 h-5" />
          Dispute Messages
          <Badge variant="outline" className="ml-2">Signed</Badge>
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Messages are signed with your wallet for verification
        </p>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[400px] pr-4">
          <div className="space-y-4">
            {messages.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <p>No messages yet</p>
                <p className="text-sm mt-2">Sign and send a message to start the dispute discussion</p>
              </div>
            ) : (
              messages.map((msg) => {
                const isOwn = msg.sender.toLowerCase() === address?.toLowerCase();
                return (
                  <div
                    key={msg.id}
                    className={`flex ${isOwn ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[70%] rounded-lg px-4 py-2 ${
                        isOwn
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      <p className="text-sm break-words">{msg.content}</p>
                      <div className="flex items-center justify-between mt-1">
                        <p className="text-xs opacity-70">
                          {new Date(msg.timestamp).toLocaleTimeString()}
                        </p>
                        <p className="text-xs opacity-50 font-mono">
                          {msg.sender.slice(0, 6)}...{msg.sender.slice(-4)}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
            <div ref={scrollRef} />
          </div>
        </ScrollArea>

        <Separator className="my-4" />

        <div className="flex gap-2">
          <Input
            placeholder="Type and sign your message..."
            value={messageInput}
            onChange={(e) => setMessageInput(e.target.value)}
            onKeyDown={handleKeyPress}
            disabled={isSigning}
          />
          <Button
            onClick={handleSignAndSend}
            disabled={isSigning || !messageInput.trim()}
          >
            {isSigning ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Shield className="w-4 h-4" />
            )}
            {isSigning ? "Signing..." : "Sign & Send"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
