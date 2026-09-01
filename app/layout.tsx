import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL('https://synmod.jquan287619461.chatgpt.site'),
  title: 'SynMod — Shape ideas with an agent',
  description: 'A WebMCP-powered 3D studio where you and an agent shape scenes together in real time.',
  icons: {
    icon: '/favicon.svg',
  },
  openGraph: {
    title: 'SynMod',
    description: 'Shape ideas with an agent, in real time.',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'SynMod agentic 3D modeling studio' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'SynMod',
    description: 'Shape ideas with an agent, in real time.',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
