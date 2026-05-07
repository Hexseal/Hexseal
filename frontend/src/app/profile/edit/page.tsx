"use client";

import React, { useState, useEffect, useRef } from "react";
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

const SPECIALIZATIONS = [
  "Smart Contracts", "Frontend Dev", "Backend Dev", "Full-Stack",
  "UI/UX Design", "Mobile Dev", "Marketing", "Content Writing",
  "Video & Audio", "Data Analysis", "Research", "Consulting",
  "Translation", "Community", "Other",
];

const MAX_NAME_LENGTH = 50;
const MAX_BIO_LENGTH = 500;
const MAX_AVATAR_SIZE = 5 * 1024 * 1024;

const IPFS_GATEWAY = process.env.NEXT_PUBLIC_IPFS_GATEWAY || 'https://cloudflare-ipfs.com';

type Role = 'client' | 'executor' | 'both' | '';

const ROLES: { val: 'client' | 'executor' | 'both'; label: string; hint: string }[] = [
  { val: 'client', label: 'Client', hint: 'I post jobs and hire' },
  { val: 'executor', label: 'Executor', hint: 'I offer services' },
  { val: 'both', label: 'Both', hint: 'I do both' },
];

export default function EditProfilePage() {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const fileInputRef = useRef<HTMLInputElement>(null);

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
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
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

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > MAX_AVATAR_SIZE) {
      setError("Image must be under 5MB");
      return;
    }

    setError(null);
    setAvatarPreview(URL.createObjectURL(file));
    setAvatarUploading(true);

    try {
      const ext = file.name.split('.').pop() || 'jpg';
      const result = await uploadToIPFS(file, `avatar-${address}-${Date.now()}.${ext}`);
      setAvatarCid(result.cid);
      toast.success("Photo uploaded!");
    } catch {
      setError("Failed to upload photo. Please try again.");
      setAvatarPreview(null);
    } finally {
      setAvatarUploading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!isConnected || !address) {
      setError("Please connect your wallet first");
      return;
    }
    if (avatarUploading) {
      setError("Wait for photo upload to finish");
      return;
    }

    const trimmedName = displayName.trim();
    if (!trimmedName) {
      setError("Display name is required");
      return;
    }
    if (trimmedName.length > MAX_NAME_LENGTH) {
      setError(`Display name must be ${MAX_NAME_LENGTH} characters or less`);
      return;
    }

    const trimmedBio = bio.trim();
    if (trimmedBio.length > MAX_BIO_LENGTH) {
      setError(`Bio must be ${MAX_BIO_LENGTH} characters or less`);
      return;
    }

    setSubmitting(true);
    try {
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
        avatarCid: avatarCid || undefined,
        createdAt: originalCreatedAt ?? now,
        updatedAt: now,
      };

      const message = `Signature404 Profile\n${JSON.stringify({
        address: profileData.address,
        displayName: profileData.displayName,
        bio: profileData.bio,
        role: profileData.role,
        specializations: profileData.specializations,
        links: profileData.links,
        avatarCid: profileData.avatarCid,
        createdAt: profileData.createdAt,
        updatedAt: profileData.updatedAt,
      })}\n${profileData.updatedAt}`;

      const signature = await signMessageAsync({ message });
      await publishProfile({ ...profileData, signature });

      setSuccess(true);
      toast.success("Profile saved!");
      setTimeout(() => router.push(`/profile/${address}`), 1500);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save profile");
    } finally {
      setSubmitting(false);
    }
  };

  if (!isConnected) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Card className="w-full max-w-md text-center">
          <CardHeader><CardTitle className="font-mono">Connect Wallet</CardTitle></CardHeader>
          <CardContent>
            <p className="text-muted-foreground mb-4">Please connect your wallet to edit your profile</p>
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
            <h2 className="text-2xl font-bold font-mono mb-2">Profile Saved!</h2>
            <p className="text-muted-foreground mb-4">Redirecting to your profile…</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const avatarSrc = avatarPreview || (avatarCid ? `${IPFS_GATEWAY}/ipfs/${avatarCid}` : null);

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-8 max-w-2xl">
        <div className="mb-8">
          <h1 className="text-3xl font-bold font-mono mb-2">Edit Profile</h1>
          <p className="text-muted-foreground">Stored on IPFS — no gas required</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Profile Details</CardTitle>
            <CardDescription>All fields optional except display name.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-6">

              {/* Avatar */}
              <div className="space-y-3">
                <Label>Profile Photo</Label>
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
                      disabled={avatarUploading}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      {avatarUploading ? (
                        <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Uploading…</>
                      ) : (
                        <><Upload className="w-3.5 h-3.5 mr-1.5" />Upload Photo</>
                      )}
                    </Button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      onChange={handleAvatarChange}
                    />
                    <p className="text-xs text-muted-foreground mt-1.5">JPG, PNG or GIF · Max 5MB · Stored on IPFS</p>
                  </div>
                  {avatarSrc && (
                    <button
                      type="button"
                      onClick={() => { setAvatarPreview(null); setAvatarCid(null); }}
                      title="Remove photo"
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
                  Display Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="displayName"
                  placeholder="Your name or pseudonym"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  maxLength={MAX_NAME_LENGTH}
                />
                <p className="text-xs text-muted-foreground text-right">{displayName.length}/{MAX_NAME_LENGTH}</p>
              </div>

              {/* Bio */}
              <div className="space-y-2">
                <Label htmlFor="bio">Bio</Label>
                <Textarea
                  id="bio"
                  placeholder="Tell others about yourself…"
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  maxLength={MAX_BIO_LENGTH}
                  rows={4}
                />
                <p className="text-xs text-muted-foreground text-right">{bio.length}/{MAX_BIO_LENGTH}</p>
              </div>

              {/* Role */}
              <div className="space-y-2">
                <Label>I primarily act as</Label>
                <div className="grid grid-cols-3 gap-2">
                  {ROLES.map(({ val, label, hint }) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => setRole(role === val ? '' : val)}
                      className={`py-2.5 px-3 rounded-lg text-sm border transition-colors text-center ${
                        role === val
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-background text-muted-foreground border-border hover:bg-muted"
                      }`}
                    >
                      <div className="font-medium">{label}</div>
                      <div className={`text-[11px] mt-0.5 ${role === val ? 'text-primary-foreground/70' : 'text-muted-foreground/60'}`}>{hint}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Specializations */}
              <div className="space-y-2">
                <Label>Skills & Interests</Label>
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
                  Links <span className="text-muted-foreground font-normal text-xs">(optional)</span>
                </Label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <Label htmlFor="telegram" className="text-xs text-muted-foreground">Telegram</Label>
                    <div className="flex">
                      <span className="inline-flex items-center px-3 text-sm border border-r-0 border-border rounded-l-md bg-muted text-muted-foreground select-none">@</span>
                      <Input id="telegram" placeholder="username" value={telegram} onChange={(e) => setTelegram(e.target.value)} className="rounded-l-none" />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="github" className="text-xs text-muted-foreground">GitHub</Label>
                    <div className="flex">
                      <span className="inline-flex items-center px-3 text-sm border border-r-0 border-border rounded-l-md bg-muted text-muted-foreground select-none whitespace-nowrap">github/</span>
                      <Input id="github" placeholder="username" value={github} onChange={(e) => setGithub(e.target.value)} className="rounded-l-none" />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="twitter" className="text-xs text-muted-foreground">Twitter / X</Label>
                    <div className="flex">
                      <span className="inline-flex items-center px-3 text-sm border border-r-0 border-border rounded-l-md bg-muted text-muted-foreground select-none">@</span>
                      <Input id="twitter" placeholder="username" value={twitter} onChange={(e) => setTwitter(e.target.value)} className="rounded-l-none" />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="discord" className="text-xs text-muted-foreground">Discord</Label>
                    <Input id="discord" placeholder="username" value={discord} onChange={(e) => setDiscord(e.target.value)} />
                  </div>
                  <div className="space-y-1 sm:col-span-2">
                    <Label htmlFor="website" className="text-xs text-muted-foreground">Website</Label>
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
                  <Button type="button" variant="outline" className="w-full">Cancel</Button>
                </Link>
                <Button type="submit" className="flex-1" disabled={submitting || avatarUploading}>
                  {submitting ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</>
                  ) : "Save Profile"}
                </Button>
              </div>

              <p className="text-xs text-muted-foreground text-center">
                Your profile is stored on IPFS and signed by your wallet.
              </p>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
