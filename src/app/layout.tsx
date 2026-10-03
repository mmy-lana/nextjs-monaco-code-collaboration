import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Real-Time Code Collaboration Editor',
  description:
    'Offline-first peer-to-peer code collaboration editor with a VS Code Web layout, powered by Next.js, Monaco, Yjs CRDTs and WebRTC.',
  applicationName: 'LAN Code Collaboration',
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }],
    apple: [{ url: '/icon.svg', type: 'image/svg+xml' }],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#1e1e1e',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="vscode-chrome antialiased">{children}</body>
    </html>
  );
}