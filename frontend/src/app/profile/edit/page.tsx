"use client";

import React, { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { publishProfile, fetchProfile } from "@/lib/profiles-ipfs";
import { uploadToIPFS } from "@/lib/ipfs";
import { Loader2, CheckCircle, AlertCircle, X, Upload, UserCircle, ChevronLeft } from "lucide-react";
import Link from "next/link";
import { toast } from "react-hot-toast";
import { useTranslations } from "next-intl";

const SPECIALIZATIONS = [
  "Smart Contracts", "Frontend Dev", "Backend Dev", "Full-Stack",
  "UI/UX Design", "Mobile Dev", "Marketing", "Content Writing",
  "Video & Audio", "Data Analysis", "Research", "Consulting",
  "Translation", "Community", "Other",
];

const MAX_NAME_LENGTH = 50;
const MAX_BIO_LENGTH  = 500;
const MAX_AVATAR_SIZE = 20 * 1024 * 1024;

async function compressAvatar(file: File): Promise<File> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const MAX = 800;
      let { width, height } = img;
      if (width > MAX || height > MAX) {
        const ratio = Math.min(MAX / width, MAX / height);
        width  = Math.round(width  * ratio);
        height = Math.round(height * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width  = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(file); return; }
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        blob => blob
          ? resolve(new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' }))
          : reject(new Error('Canvas compression failed')),
        'image/jpeg',
        0.82,
      );
    };
    img.onerror = reject;
    img.src = objectUrl;
  });
}

const IPFS_GATEWAY = process.env.NEXT_PUBLIC_IPFS_GATEWAY || 'https://cloudflare-ipfs.com';

type Role = 'client' | 'executor' | 'both' | '';
const ROLE_VALS: ('client' | 'executor' | 'both')[] = ['client', 'executor', 'both'];

type SaveStage = 'idle' | 'uploading-photo' | 'saving' | 'done';

export default function EditProfilePage() {
  const router = useRouter();
  const { address, isConnected, status } = useAccount();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const t = useTranslations();

  const [loadingProfile, setLoadingProfile] = useState(true);
  const [displayName, setDisplayName]       = useState("");
  const [bio, setBio]                       = useState("");
  const [role, setRole]                     = useState<Role>('');
  const [specializations, setSpecializations] = useState<string[]>([]);
  const [telegram, setTelegram]             = useState("");
  const [github, setGithub]                 = useState("");
  const [twitter, setTwitter]               = useState("");
  const [discord, setDiscord]               = useState("");
  const [website, setWebsite]               = useState("");
  const [avatarCid, setAvatarCid]           = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl]           = useState<string | null>(null);
  const [avatarPreview, setAvatarPreview]   = useState<string | null>(null);
  const [pendingAvatarFile, setPendingAvatarFile] = useState<File | null>(null);
  const [originalCreatedAt, setOriginalCreatedAt] = useState<number | null>(null);
  const [stage, setStage]                   = useState<SaveStage>('idle');
  const [error, setError]                   = useState<string | null>(null);

  const submitting = stage !== 'idle' && stage !== 'done';

  // Load profile: localStorage first (fast), fallback to API
  useEffect(() => {
    if (!address) return;

    const populateFrom = (data: Record<string, unknown>) => {
      setDisplayName((data.displayName as string) || "");
      setBio((data.bio as string) || "");
      setRole(((data.role as Role) || '') as Role);
      setSpecializations((data.specializations as string[]) || []);
      const links = (data.links as Record<string, string>) || {};
      setTelegram(links.telegram || "");
      setGithub(links.github || "");
      setTwitter(links.twitter || "");
      setDiscord(links.discord || "");
      setWebsite(links.website || "");
      setAvatarCid((data.avatarCid as string) || null);
      setAvatarUrl((data.avatarUrl as string) || null);
      setOriginalCreatedAt((data.createdAt as number) || null);
    };

    // Try localStorage first (fast path)
    try {
      const raw = localStorage.getItem(`hexseal-public_${address.toLowerCase()}`);
      if (raw) {
        const { data } = JSON.parse(raw);
        if (data?.displayName) {
          populateFrom(data);
          setLoadingProfile(false);
          return;
        }
      }
    } catch { /* ignore */ }

    // Fallback: fetch from API (cache miss or first time)
    setLoadingProfile(true);
    fetchProfile(address.toLowerCase())
      .then(profile => {
        if (profile) populateFrom(profile as unknown as Record<string, unknown>);
      })
      .catch(() => {})
      .finally(() => setLoadingProfile(false));
  }, [address]);

  const toggleSpecialization = (spec: string) => {
    setSpecializations(prev =>
      prev.includes(spec) ? prev.filter(s => s !== spec) : [...prev, spec]
    );
  };

  // File picker — only stores file + shows local preview, NO upload
  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_AVATAR_SIZE) {
      toast.error(t("profile.image_size_error"));
      return;
    }
    setPendingAvatarFile(file);
    setAvatarPreview(URL.createObjectURL(file));
    setAvatarCid(null);
    setAvatarUrl(null);
    // Reset input so the same file can be re-selected if needed
    e.target.value = '';
  };

  const handleRemoveAvatar = () => {
    setAvatarPreview(null);
    setAvatarCid(null);
    setAvatarUrl(null);
    setPendingAvatarFile(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!isConnected || !address) {
      setError(t("common.wallet_not_connected"));
      return;
    }

    const trimmedName = displayName.trim();
    if (!trimmedName) {
      setError(t("profile.display_name_required"));
      return;
    }
    if (trimmedName.length > MAX_NAME_LENGTH) {
      setError(t("profile.display_name_max"));
      return;
    }
    const trimmedBio = bio.trim();
    if (trimmedBio.length > MAX_BIO_LENGTH) {
      setError(t("profile.bio_max"));
      return;
    }

    let finalAvatarCid = avatarCid;
    let finalAvatarUrl = avatarUrl;

    try {
      // Step 1: upload avatar if selected
      if (pendingAvatarFile) {
        setStage('uploading-photo');
        try {
          const fileToUpload = await compressAvatar(pendingAvatarFile).catch(() => pendingAvatarFile);
          const result = await uploadToIPFS(fileToUpload, `avatar-${address}-${Date.now()}.jpg`);
          finalAvatarCid = result.cid || null;
          finalAvatarUrl = result.storjUrl || null;
          setAvatarCid(finalAvatarCid);
          setAvatarUrl(finalAvatarUrl);
          setPendingAvatarFile(null);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          toast.error(`${t("profile.upload_failed")}: ${msg.slice(0, 80)}`);
          // Continue without new avatar — keep old values
          finalAvatarCid = avatarCid;
          finalAvatarUrl = avatarUrl;
        }
      }

      // Step 2: publish profile
      setStage('saving');
      const now = Math.floor(Date.now() / 1000);
      const profileData = {
        address: address.toLowerCase(),
        displayName: trimmedName,
        bio: trimmedBio,
        role: (role || undefined) as 'client' | 'executor' | 'both' | undefined,
        specializations,
        links: {
          telegram: telegram.trim() || undefined,
          github: github.trim() || undefined,
          twitter: twitter.trim() || undefined,
          discord: discord.trim() || undefined,
          website: website.trim() || undefined,
        },
        avatarCid: finalAvatarCid || undefined,
        avatarUrl: finalAvatarUrl || undefined,
        createdAt: originalCreatedAt ?? now,
        updatedAt: now,
      };

      await publishProfile(profileData);

      // Invalidate localStorage cache so profile view re-fetches fresh data
      try {
        localStorage.removeItem(`hexseal-public_${address.toLowerCase()}`);
        localStorage.removeItem(`sig404_profile_${address.toLowerCase()}`);
      } catch { /* ignore */ }

      setStage('done');
      toast.success(t("profile.save_success"));
      setTimeout(() => router.push(`/profile/${address}`), 1200);

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to save profile";
      setError(msg);
      toast.error(msg.slice(0, 120));
      setStage('idle');
    }
  };

  if (status === 'reconnecting' || status === 'connecting') return null;

  if (!isConnected) {
    return (
      <div className="flex-1 flex items-center justify-center px-4">
        <div className="text-center">
          <p className="text-white/40 text-sm mb-4">{t("profile.connect_required")}</p>
          <Link href="/"><Button variant="outline">{t("dashboard.go_home")}</Button></Link>
        </div>
      </div>
    );
  }

  if (stage === 'done') {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <CheckCircle className="w-14 h-14 mx-auto mb-4 text-emerald-400" />
          <h2 className="text-xl font-bold text-white mb-1">{t("profile.saved_title")}</h2>
          <p className="text-white/40 text-sm">{t("profile.redirecting")}</p>
        </div>
      </div>
    );
  }

  const avatarSrc = avatarPreview || avatarUrl || (avatarCid ? `${IPFS_GATEWAY}/ipfs/${avatarCid}` : null);

  const stageLabel = () => {
    switch (stage) {
      case 'uploading-photo': return t("common.uploading") + " (1/2)…";
      case 'saving':          return t("common.saving")    + " (2/2)…";
      default:                return t("profile.save_btn");
    }
  };

  return (
    <div className="mx-auto px-4 py-6 max-w-2xl w-full">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22 }}
        className="space-y-5"
      >
        {/* Header */}
        <div className="flex items-center gap-3">
          <Link href={`/profile/${address}`}>
            <button className="w-8 h-8 rounded-[10px] flex items-center justify-center text-white/30 hover:text-white/70 hover:bg-white/[0.06] transition-colors">
              <ChevronLeft className="w-4 h-4" />
            </button>
          </Link>
          <div>
            <h1 className="text-xl font-bold text-white">{t("profile.edit_title")}</h1>
            <p className="text-xs text-white/35">{t("profile.ipfs_info")}</p>
          </div>
        </div>

        {/* Loading skeleton */}
        {loadingProfile ? (
          <div className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] px-6 py-8 space-y-5 animate-pulse"
            style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)" }}>
            <div className="flex gap-4">
              <div className="w-20 h-20 rounded-2xl bg-white/[0.06] flex-shrink-0" />
              <div className="flex-1 space-y-2 pt-1">
                <div className="h-3 w-24 rounded bg-white/[0.06]" />
                <div className="h-8 w-32 rounded-lg bg-white/[0.06]" />
              </div>
            </div>
            {[1,2,3].map(i => (
              <div key={i} className="space-y-1.5">
                <div className="h-2.5 w-20 rounded bg-white/[0.06]" />
                <div className="h-10 rounded-xl bg-white/[0.06]" />
              </div>
            ))}
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div
              className="rounded-[22px] border border-white/[0.08] bg-[#0d0d0f] px-6 py-6 space-y-6"
              style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}
            >

              {/* Error banner */}
              {error && (
                <div className="flex items-start gap-2.5 px-4 py-3 rounded-[14px] border border-red-500/20 bg-red-500/5">
                  <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-red-400/80">{error}</p>
                  <button type="button" onClick={() => setError(null)} className="ml-auto text-red-400/40 hover:text-red-400/70">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {/* ── Avatar ── */}
              <div className="space-y-3">
                <Label className="text-xs text-white/50 uppercase tracking-wider font-semibold">{t("profile.photo_label")}</Label>
                <div className="flex items-center gap-4">
                  <div className="relative flex-shrink-0">
                    <div className="w-20 h-20 rounded-2xl overflow-hidden bg-white/[0.06] border border-white/[0.08] flex items-center justify-center">
                      {avatarSrc ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={avatarSrc} alt="Avatar" className="w-full h-full object-cover" />
                      ) : (
                        <UserCircle className="w-10 h-10 text-white/15" />
                      )}
                    </div>
                    {pendingAvatarFile && (
                      <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-violet-500 border border-[#0d0d0f] flex items-center justify-center">
                        <div className="w-1.5 h-1.5 rounded-full bg-white" />
                      </div>
                    )}
                  </div>
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={submitting}
                        onClick={() => fileInputRef.current?.click()}
                        className="border-white/15 text-white/60 hover:text-white"
                      >
                        <Upload className="w-3.5 h-3.5 mr-1.5" />
                        {pendingAvatarFile ? t("profile.photo_ready") : t("profile.upload_photo_btn")}
                      </Button>
                      {avatarSrc && (
                        <button
                          type="button"
                          onClick={handleRemoveAvatar}
                          className="w-7 h-7 rounded-[8px] flex items-center justify-center text-white/25 hover:text-red-400/70 hover:bg-red-400/10 transition-colors"
                          title={t("profile.remove_photo")}
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                    <p className="text-[11px] text-white/30">
                      {pendingAvatarFile
                        ? `📎 ${pendingAvatarFile.name} · ${(pendingAvatarFile.size / 1024 / 1024).toFixed(1)} MB → ${t("profile.photo_will_upload")}`
                        : t("profile.photo_info")}
                    </p>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={handleAvatarChange}
                  />
                </div>
              </div>

              <Separator className="border-white/[0.07]" />

              {/* ── Display Name ── */}
              <div className="space-y-2">
                <Label className="text-xs text-white/50 uppercase tracking-wider font-semibold">
                  {t("profile.display_name_label")} <span className="text-red-400/70 ml-0.5">*</span>
                </Label>
                <input
                  placeholder={t("profile.display_name_placeholder")}
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  maxLength={MAX_NAME_LENGTH}
                  disabled={submitting}
                  className="w-full bg-white/[0.04] border border-white/[0.08] rounded-[12px] px-3 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/20 transition-colors disabled:opacity-50"
                />
                <p className="text-[11px] text-white/25 text-right">{displayName.length}/{MAX_NAME_LENGTH}</p>
              </div>

              {/* ── Bio ── */}
              <div className="space-y-2">
                <Label className="text-xs text-white/50 uppercase tracking-wider font-semibold">{t("profile.bio_label")}</Label>
                <textarea
                  placeholder={t("profile.bio_placeholder")}
                  value={bio}
                  onChange={e => setBio(e.target.value)}
                  maxLength={MAX_BIO_LENGTH}
                  rows={4}
                  disabled={submitting}
                  className="w-full bg-white/[0.04] border border-white/[0.08] rounded-[12px] px-3 py-2.5 text-sm text-white placeholder:text-white/20 resize-none focus:outline-none focus:border-white/20 transition-colors disabled:opacity-50"
                />
                <p className="text-[11px] text-white/25 text-right">{bio.length}/{MAX_BIO_LENGTH}</p>
              </div>

              {/* ── Role ── */}
              <div className="space-y-2">
                <Label className="text-xs text-white/50 uppercase tracking-wider font-semibold">{t("profile.role_label")}</Label>
                <div className="grid grid-cols-3 gap-2">
                  {ROLE_VALS.map(val => (
                    <button
                      key={val}
                      type="button"
                      disabled={submitting}
                      onClick={() => setRole(role === val ? '' : val)}
                      className={`py-2.5 px-3 rounded-[12px] text-sm border transition-colors text-center ${
                        role === val
                          ? "bg-white/10 text-white border-white/20"
                          : "bg-white/[0.03] text-white/40 border-white/[0.08] hover:bg-white/[0.06] hover:text-white/60"
                      }`}
                    >
                      <div className="font-medium">{t(`profile.role_${val}`)}</div>
                      <div className={`text-[11px] mt-0.5 ${role === val ? 'text-white/50' : 'text-white/25'}`}>{t(`profile.role_${val}_hint`)}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* ── Specializations ── */}
              <div className="space-y-2">
                <Label className="text-xs text-white/50 uppercase tracking-wider font-semibold">{t("profile.specializations_label")}</Label>
                <div className="flex flex-wrap gap-2">
                  {SPECIALIZATIONS.map(spec => (
                    <button
                      key={spec}
                      type="button"
                      disabled={submitting}
                      onClick={() => toggleSpecialization(spec)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs border transition-colors ${
                        specializations.includes(spec)
                          ? "bg-white/10 text-white border-white/20"
                          : "bg-white/[0.03] text-white/40 border-white/[0.08] hover:bg-white/[0.06] hover:text-white/60"
                      }`}
                    >
                      {spec}
                      {specializations.includes(spec) && <X className="w-2.5 h-2.5" />}
                    </button>
                  ))}
                </div>
              </div>

              <Separator className="border-white/[0.07]" />

              {/* ── Links ── */}
              <div className="space-y-4">
                <Label className="text-xs text-white/50 uppercase tracking-wider font-semibold">
                  {t("profile.links_label")} <span className="text-white/20 font-normal normal-case tracking-normal">{t("common.optional")}</span>
                </Label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {[
                    { id: 'telegram', label: t("profile.link_telegram"), prefix: '@', value: telegram, set: setTelegram, placeholder: 'username' },
                    { id: 'github',   label: t("profile.link_github"),   prefix: 'github/', value: github,   set: setGithub,   placeholder: 'username' },
                    { id: 'twitter',  label: t("profile.link_twitter"),  prefix: '@',       value: twitter,  set: setTwitter,  placeholder: 'username' },
                    { id: 'discord',  label: t("profile.link_discord"),  prefix: null,      value: discord,  set: setDiscord,  placeholder: 'username' },
                  ].map(({ id, label, prefix, value, set, placeholder }) => (
                    <div key={id} className="space-y-1">
                      <label className="text-[11px] text-white/35">{label}</label>
                      <div className="flex">
                        {prefix && (
                          <span className="inline-flex items-center px-3 text-xs border border-r-0 border-white/[0.08] rounded-l-[10px] bg-white/[0.03] text-white/30 select-none whitespace-nowrap">
                            {prefix}
                          </span>
                        )}
                        <input
                          id={id}
                          placeholder={placeholder}
                          value={value}
                          onChange={e => set(e.target.value)}
                          disabled={submitting}
                          className={`flex-1 bg-white/[0.04] border border-white/[0.08] ${prefix ? 'rounded-r-[10px]' : 'rounded-[10px]'} px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/20 transition-colors disabled:opacity-50 min-w-0`}
                        />
                      </div>
                    </div>
                  ))}
                  <div className="space-y-1 sm:col-span-2">
                    <label className="text-[11px] text-white/35">{t("profile.link_website")}</label>
                    <input
                      id="website"
                      placeholder="https://…"
                      value={website}
                      onChange={e => setWebsite(e.target.value)}
                      disabled={submitting}
                      className="w-full bg-white/[0.04] border border-white/[0.08] rounded-[10px] px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/20 transition-colors disabled:opacity-50"
                    />
                  </div>
                </div>
              </div>

            </div>

            {/* ── Actions ── */}
            <div className="flex gap-3 mt-4">
              <Link href={`/profile/${address}`} className="flex-1">
                <Button type="button" variant="outline" className="w-full border-white/15 text-white/50" disabled={submitting}>
                  {t("common.cancel")}
                </Button>
              </Link>
              <Button type="submit" className="flex-2 flex-1 min-w-0" disabled={submitting}>
                {submitting ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin flex-shrink-0" /><span className="truncate">{stageLabel()}</span></>
                ) : t("profile.save_btn")}
              </Button>
            </div>

            <p className="text-[11px] text-white/25 text-center mt-3">{t("profile.ipfs_signed_info")}</p>
          </form>
        )}
      </motion.div>
    </div>
  );
}
