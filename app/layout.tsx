import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PeopleDiff",
  description:
    "Chinese and Japanese People's Daily narrative difference dashboard."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
