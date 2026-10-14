import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agrippa",
  description: "Operational AI for every business",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-AU" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
