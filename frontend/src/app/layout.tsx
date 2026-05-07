import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "SETU AAROGYA DRISHTI",
  description: "Public health signal intelligence console for SETU AAROGYA DRISHTI.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
