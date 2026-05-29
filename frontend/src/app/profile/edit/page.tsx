"use client";

import React, { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useAccount, useSignMessage } from "wagmi";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { publishProfile } from "@/lib/profiles-ipfs";
import { uploadToIPFS } from "@/lib/ipfs";
import { Loader2, CheckCircle, AlertCircle, X, Upload, UserCircle } from "lucide-react";
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
const MAX_BIO_LENGTH = 500;
const MAX_AVATAR_SIZE = 20 * 1024 * 1024; // 20 MB raw — compressed down before upload

// ─── Client-side image compression ───────────────────────────────────────────
// Resizes to max 800×800 and re-encodes as JPEG 0.82 quality.
// Turns a 5-8 MB iPhone photo into ~150-350 KB — much faster to upload.
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

export default function EditProfilePage() {
  const router = useRouter();
  const { address, isConnected, status } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const t = useTranslations();

  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [role, setRole] = useState<Role>('');
  const [specializations, setSpecializations] = useState<string[]>([]);
  const [telegram, setTelegram] = useState("");
  const [github, setGithub] = useState("");
  const [twitter, setTwitter] = useState("");
  const [discord, setDiscord] = useState("");
  const [website, setWebsite] = useState("");
  const [avatarCid, setAvatarCid] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);    // Storj direct URL
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [pendingAvatarFile, setPendingAvatarFile] = useState<File | null>(null); // file selected but not yet uploaded
  const [originalCreatedAt, setOriginalCreatedAt] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!address) return;
    const raw = localStorage.getItem(`sig404_profile_${address.toLowerCase()}`);
    if (!raw) return;
    try {
      const { data } = JSON.parse(raw);
      setDisplayName(data.displayName || "");
      setBio(data.bio || "");
      setRole((data.role as Role) || '');
      setSpecializations(data.specializations || []);
      setTelegram(data.links?.telegram || "");
      setGithub(data.links?.github || "");
      setTwitter(data.links?.twitter || "");
      setDiscord(data.links?.discord || "");
      setWebsite(data.links?.website || "");
      setAvatarCid(data.avatarCid || null);
      setAvatarUrl(data.avatarUrl || null);
      setOriginalCreatedAt(data.createdAt || null);
    } catch {
      // ignore parse errors
    }
  }, [address]);

  const toggleSpecialization = (spec: string) => {
    setSpecializations((prev) =>
      prev.includes(spec) ? prev.filter((s) => s !== spec) : [...prev, spec]
    );
  };

  // Just store the file + show local preview — no upload yet.
  // Upload happens atomically during handleSubmit to avoid mobile issues
  // (network errors on immediate upload, HEIC conversion timing, etc.).
  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > MAX_AVATAR_SIZE) {
      setError(t("profile.image_size_error"));
      return;
    }

    setError(null);
    setPendingAvatarFile(file);
    setAvatarPreview(URL.createObjectURL(file));
    // Clear previously uploaded values — new file will be uploaded on save
    setAvatarCid(null);
    setAvatarUrl(null);
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

    setSubmitting(true);
    try {
      // ── Upload avatar if a new file was selected ─────────────────────────────
      // Deferred from file-select to save-time so mobile browsers don't drop the
      // request between tap and form submission (avoids HEIC timing / network race).
      let finalAvatarCid  = avatarCid;
      let finalAvatarUrl  = avatarUrl;

      if (pendingAvatarFile) {
        try {
          const compressed = await compressAvatar(pendingAvatarFile);
          const result = await uploadToIPFS(compressed, `avatar-${address}-${Date.now()}.jpg`);
          finalAvatarCid = result.cid || null;
          finalAvatarUrl = result.storjUrl || null;
          setAvatarCid(finalAvatarCid);
          setAvatarUrl(finalAvatarUrl);
          setPendingAvatarFile(null);
        } catch {
          setError(t("profile.upload_failed"));
          setSubmitting(false);
          return;
        }
      }

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

      const message = `Hexseal Profile\n${JSON.stringify({
        address: profileData.address,
        displayName: profileData.displayName,
        bio: profileData.bio,
        role: profileData.role,
        specializations: profileData.specializations,
        links: profileData.links,
        avatarCid: profileData.avatarCid,
        avatarUrl: profileData.avatarUrl,
        createdAt: profileData.createdAt,
        updatedAt: profileData.updatedAt,
      })}\n${profileData.updatedAt}`;

      const signature = await signMessageAsync({ message });
      await publishProfile({ ...profileData, signature });

      setSuccess(true);
      toast.success(t("profile.save_success"));
      setTimeout(() => router.push(`/profile/${address}`), 1500);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save profile");
    } finally {
      setSubmitting(false);
    }
  };

  if (status === 'reconnecting' || status === 'connecting') return null;

  if (!isConnected) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Card className="w-full max-w-md text-center">
          <CardHeader><CardTitle className="font-mono">{t("profile.connect_wallet")}</CardTitle></CardHeader>
          <CardContent>
            <p className="text-muted-foreground mb-4">{t("profile.connect_required")}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (success) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Card className="w-full max-w-md text-center">
          <CardContent className="pt-8 pb-8">
            <CheckCircle className="w-16 h-16 mx-auto mb-4 text-green-500" />
            <h2 className="text-2xl font-bold font-mono mb-2">{t("profile.saved_title")}</h2>
            <p className="text-muted-foreground mb-4">{t("profile.redirecting")}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Prefer: local preview > Storj direct URL > IPFS gateway
  const avatarSrc = avatarPreview || avatarUrl || (avatarCid ? `${IPFS_GATEWAY}/ipfs/${avatarCid}` : null);

  return (
    <div className="min-h-screen bg-background">
      <motion.div
        className="container mx-auto px-4 py-8 max-w-2xl"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22 }}
      >
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">{t("profile.edit_title")}</h1>
          <p className="text-muted-foreground">{t("profile.ipfs_info")}</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{t("profile.details_section")}</CardTitle>
            <CardDescription>{t("profile.fields_info")}</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-6">

              {/* Avatar */}
              <div className="space-y-3">
                <Label>{t("profile.photo_label")}</Label>
                <div className="flex items-center gap-4">
                  <div className="w-20 h-20 rounded-2xl overflow-hidden flex-shrink-0 bg-muted border border-border flex items-center justify-center">
                    {avatarSrc ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={avatarSrc} alt="Avatar" className="w-full h-full object-cover" />
                    ) : (
                      <UserCircle className="w-10 h-10 text-muted-foreground/40" />
                    )}
                  </div>
                  <div className="flex-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={submitting}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Upload className="w-3.5 h-3.5 mr-1.5" />
                      {pendingAvatarFile ? t("profile.photo_ready") : t("profile.upload_photo_btn")}
                    </Button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      onChange={handleAvatarChange}
                    />
                    <p className="text-xs text-muted-foreground mt-1.5">{t("profile.photo_info")}</p>
                  </div>
                  {avatarSrc && (
                    <button
                      type="button"
                      onClick={() => { setAvatarPreview(null); setAvatarCid(null); setAvatarUrl(null); }}
                      title={t("profile.remove_photo")}
                      className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>

              {/* Display Name */}
              <div className="space-y-2">
                <Label htmlFor="displayName">
                  {t("profile.display_name_label")} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="displayName"
                  placeholder={t("profile.display_name_placeholder")}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  maxLength={MAX_NAME_LENGTH}
                />
                <p className="text-xs text-muted-foreground text-right">{displayName.length}/{MAX_NAME_LENGTH}</p>
              </div>

              {/* Bio */}
              <div className="space-y-2">
                <Label htmlFor="bio">{t("profile.bio_label")}</Label>
                <Textarea
                  id="bio"
                  placeholder={t("profile.bio_placeholder")}
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  maxLength={MAX_BIO_LENGTH}
                  rows={4}
                />
                <p className="text-xs text-muted-foreground text-right">{bio.length}/{MAX_BIO_LENGTH}</p>
              </div>

              {/* Role */}
              <div className="space-y-2">
                <Label>{t("profile.role_label")}</Label>
                <div className="grid grid-cols-3 gap-2">
                  {ROLE_VALS.map((val) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => setRole(role === val ? '' : val)}
                      className={`py-2.5 px-3 rounded-[10px] text-sm border transition-colors text-center ${
                        role === val
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-background text-muted-foreground border-border hover:bg-muted"
                      }`}
                    >
                      <div className="font-medium">{t(`profile.role_${val}`)}</div>
                      <div className={`text-[11px] mt-0.5 ${role === val ? 'text-primary-foreground/70' : 'text-muted-foreground/60'}`}>{t(`profile.role_${val}_hint`)}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Specializations */}
              <div className="space-y-2">
                <Label>{t("profile.specializations_label")}</Label>
                <div className="flex flex-wrap gap-2">
                  {SPECIALIZATIONS.map((spec) => (
                    <button
                      key={spec}
                      type="button"
                      onClick={() => toggleSpecialization(spec)}
                      className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-sm border transition-colors ${
                        specializations.includes(spec)
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-background text-muted-foreground border-border hover:bg-muted"
                      }`}
                    >
                      {spec}
                      {specializations.includes(spec) && <X className="w-3 h-3" />}
                    </button>
                  ))}
                </div>
              </div>

              <Separator />

              {/* Links */}
              <div className="space-y-4">
                <Label>
                  {t("profile.links_label")} <span className="text-muted-foreground font-normal text-xs">{t("common.optional")}</span>
                </Label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <Label htmlFor="telegram" className="text-xs text-muted-foreground">{t("profile.link_telegram")}</Label>
                    <div className="flex">
                      <span className="inline-flex items-center px-3 text-sm border border-r-0 border-border rounded-l-md bg-muted text-muted-foreground select-none">@</span>
                      <Input id="telegram" placeholder="username" value={telegram} onChange={(e) => setTelegram(e.target.value)} className="rounded-l-none" />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="github" className="text-xs text-muted-foreground">{t("profile.link_github")}</Label>
                    <div className="flex">
                      <span className="inline-flex items-center px-3 text-sm border border-r-0 border-border rounded-l-md bg-muted text-muted-foreground select-none whitespace-nowrap">github/</span>
                      <Input id="github" placeholder="username" value={github} onChange={(e) => setGithub(e.target.value)} className="rounded-l-none" />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="twitter" className="text-xs text-muted-foreground">{t("profile.link_twitter")}</Label>
                    <div className="flex">
                      <span className="inline-flex items-center px-3 text-sm border border-r-0 border-border rounded-l-md bg-muted text-muted-foreground select-none">@</span>
                      <Input id="twitter" placeholder="username" value={twitter} onChange={(e) => setTwitter(e.target.value)} className="rounded-l-none" />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="discord" className="text-xs text-muted-foreground">{t("profile.link_discord")}</Label>
                    <Input id="discord" placeholder="username" value={discord} onChange={(e) => setDiscord(e.target.value)} />
                  </div>
                  <div className="space-y-1 sm:col-span-2">
                    <Label htmlFor="website" className="text-xs text-muted-foreground">{t("profile.link_website")}</Label>
                    <Input id="website" placeholder="https://…" value={website} onChange={(e) => setWebsite(e.target.value)} />
                  </div>
                </div>
              </div>

              {error && (
                <div className="flex items-center gap-2 text-sm text-destructive">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <div className="flex gap-4">
                <Link href={`/profile/${address}`} className="flex-1">
                  <Button type="button" variant="outline" className="w-full">{t("common.cancel")}</Button>
                </Link>
                <Button type="submit" className="flex-1" disabled={submitting}>
                  {submitting ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{pendingAvatarFile ? t("common.uploading") : t("common.saving")}</>
                  ) : t("profile.save_btn")}
                </Button>
              </div>

              <p className="text-xs text-muted-foreground text-center">
                {t("profile.ipfs_signed_info")}
              </p>
            </form>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
