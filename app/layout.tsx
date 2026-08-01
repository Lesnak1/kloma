import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Loaf League Trader",
  description: "Risk-controlled serverless competition trading bot.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
