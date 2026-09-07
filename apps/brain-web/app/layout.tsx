import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "NEUROSA-HB — Żywy mózg",
  description: "Natywny interfejs pamięci i aktywacji dla agentów AI",
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="pl">
      <body>{children}</body>
    </html>
  );
}
