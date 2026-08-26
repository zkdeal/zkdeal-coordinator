import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'

const geistSans = Geist({
  subsets: ['latin'],
  variable: '--font-geist-sans',
})

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
})

export const metadata: Metadata = {
  metadataBase: new URL('https://zkdeal.org'),
  title: 'zkdeal - Proof-backed rooms for Ethereum',
  description:
    'Run a bounded, multi-step workflow as one provable episode, then checkpoint the verified result to Ethereum.',
  applicationName: 'zkdeal',
  alternates: {
    canonical: '/',
  },
  openGraph: {
    type: 'website',
    url: '/',
    siteName: 'zkdeal',
    title: 'zkdeal - Proof-backed rooms for Ethereum',
    description:
      'Run a bounded, multi-step workflow as one provable episode, then checkpoint the verified result to Ethereum.',
    images: [
      {
        url: '/og-v2.png',
        width: 1200,
        height: 630,
        type: 'image/png',
        alt: 'zkdeal turns one bounded workflow into one proof-backed Ethereum checkpoint',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'zkdeal - Proof-backed rooms for Ethereum',
    description:
      'Run a bounded, multi-step workflow as one provable episode, then checkpoint the verified result to Ethereum.',
    images: ['/og-v2.png'],
  },
  icons: {
    icon: '/zkdeal-icon.ico',
    shortcut: '/zkdeal-icon.ico',
  },
}

export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#0a0f14',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} bg-background`}>
      {/*
       * No analytics script. This build is deployed as a static export served
       * by the coordinator on a self-hosted stand, where `@vercel/analytics`
       * requests `/_vercel/insights/script.js` - a path only Vercel's edge
       * answers - and 404s on every page load. A demo console is judged partly
       * on its console, and there is nothing here worth measuring anyway.
       */}
      <body className="font-sans antialiased">{children}</body>
    </html>
  )
}
