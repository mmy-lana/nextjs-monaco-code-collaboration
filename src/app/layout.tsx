import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Real-Time Code Collaboration Editor',
  description: 'VS Code web layout code collaboration editor powered by Next.js and Monaco',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="vscode-chrome bg-[#1e1e1e] text-[#cccccc] antialiased overflow-hidden">
        {children}
      </body>
    </html>
  );
}
