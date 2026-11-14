import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Soko",
  description: "Shop from Kenyan sellers. Pay with M-Pesa.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-stone-50 text-stone-900 antialiased">
        <header className="border-b border-stone-200 bg-white">
          <nav className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
            <Link href="/" className="text-xl font-semibold tracking-tight">
              Soko
            </Link>
            {/* No prefetch: a prefetch can trigger a token refresh in the
                proxy, and two racing refreshes would revoke the session. */}
            <Link
              href="/seller/products"
              prefetch={false}
              className="text-sm font-medium text-emerald-800 hover:underline"
            >
              Sell on Soko
            </Link>
          </nav>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
