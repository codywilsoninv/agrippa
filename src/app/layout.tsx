import type { Metadata } from "next";
import { Instrument_Sans, Marcellus } from "next/font/google";
import "./globals.css";

// Display face: Marcellus (headings, the AGRIPPA wordmark). Body: Instrument Sans.
const marcellus = Marcellus({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-marcellus",
  display: "swap",
});

const instrument = Instrument_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-instrument",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Agrippa",
  description: "Operational AI for every business",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-AU" className={`h-full antialiased ${marcellus.variable} ${instrument.variable}`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
