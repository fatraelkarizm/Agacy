import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agacy | Agentic Privacy for AI Agents",
  description:
    "A confidential wallet for AI agents on Solana. Your agent transacts autonomously; the amounts stay encrypted on-chain.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
