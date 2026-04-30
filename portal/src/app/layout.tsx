import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Providers } from '@/providers';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { MobileResourcesDrawer } from '@/components/MobileResourcesDrawer';
import { NavTabs } from '@/components/NavTabs';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'wBOB Bridge',
  description: 'Bridge Dobbscoin (BOB) to Wrapped BOB (wBOB) on Gnosis chain',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <Providers>
          <div className="min-h-screen flex flex-col">
            {/* Nav */}
            <header className="sticky top-0 z-50 border-b border-gray-800 bg-gray-950/80 backdrop-blur">
              <div className="mx-auto max-w-5xl flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-2">
                  <MobileResourcesDrawer />
                  <a href="/" className="flex items-center gap-2">
                    <span className="text-sm text-gray-500">The</span>
                    <span className="text-xl font-bold text-bob-400">wBOB</span>
                    <span className="text-sm text-gray-500">Bridge</span>
                  </a>
                </div>
                <ConnectButton
                  chainStatus="icon"
                  showBalance={false}
                  accountStatus="avatar"
                />
              </div>
              <NavTabs />
            </header>

            {/* Page */}
            <main className="flex-1 mx-auto w-full max-w-5xl px-4 py-10">
              {children}
            </main>

            {/* Footer */}
            <footer className="border-t border-gray-800 py-6 text-center text-xs text-gray-600">
              wBOB Bridge — Dobbscoin ↔ Gnosis
            </footer>
          </div>
        </Providers>
      </body>
    </html>
  );
}
