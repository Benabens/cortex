import type { Metadata } from "next";
import "./globals.css";
import Nav from "./components/Nav";

export const metadata: Metadata = {
  title: "Cortex — Computer Systems",
  description: "Second cerveau de révision : recherche, faiblesses, examens générés.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <Nav />
        <div className="flex-1">{children}</div>
      </body>
    </html>
  );
}
