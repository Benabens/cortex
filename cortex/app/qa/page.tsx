import { notFound } from "next/navigation";
import { QaHarness } from "./QaHarness";

/** Banc d'essai visuel : outil de développement, introuvable (404) en production. */
export default function QAPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <QaHarness />;
}
