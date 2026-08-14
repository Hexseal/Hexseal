import type { Metadata } from "next";
import {
  Space_Grotesk,
  Space_Mono,
  Syne,
  Noto_Sans_Thai,
  Manrope,
  Chonburi,
  Kanit,
  Unbounded,
  JetBrains_Mono,
} from "next/font/google";
import "./globals.css";
import "@/styles/shadcn.css";
import "@/styles/ui-theme.css";
import "@rainbow-me/rainbowkit/styles.css";
import { Providers } from "./providers";
import ClientLayout from "./client-layout";

const inter = Space_Grotesk({
  variable: "--font-inter",
  subsets: ["latin", "latin-ext"],
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
});

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["cyrillic", "latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const spaceMono = Space_Mono({
  variable: "--font-space-mono",
  subsets: ["latin"],
  weight: ["400", "700"],
  display: "swap",
});

const syne = Syne({
  variable: "--font-syne",
  subsets: ["latin"],
  weight: ["400", "600", "700", "800"],
  display: "swap",
});

const notoSansThai = Noto_Sans_Thai({
  variable: "--font-noto-thai",
  subsets: ["thai"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

// Thai — display + body
const chonburi = Chonburi({
  variable: "--font-chonburi",
  subsets: ["thai", "latin"],
  weight: ["400"],
  display: "swap",
});

const kanit = Kanit({
  variable: "--font-kanit",
  subsets: ["thai", "latin"],
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
});

// Russian — display + mono
const unbounded = Unbounded({
  variable: "--font-unbounded",
  subsets: ["cyrillic", "latin"],
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["cyrillic", "latin"],
  weight: ["400", "500", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Hexseal",
  description: "Reshape Digital Reality",
  other: {
    "talentapp:project_verification": "fde63ee1e6f42eb443f3515c2300bf334806b9ba56414b11b420468b878a9b2d5a5ab77afbd22d99b5268964d05a82ea2a8336fe946cacf494d10152c08b9513"
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="theme-color" content="#000000" />
        <meta name="color-scheme" content="dark" />
        <link rel="manifest" href="/manifest.json" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.svg" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Hexseal" />
      </head>
      <body className={`${inter.variable} ${manrope.variable} ${spaceMono.variable} ${syne.variable} ${notoSansThai.variable} ${chonburi.variable} ${kanit.variable} ${unbounded.variable} ${jetbrainsMono.variable} min-h-screen flex flex-col`}>
        <Providers>
          <ClientLayout>{children}</ClientLayout>
        </Providers>
      </body>
    </html>
  );
}
