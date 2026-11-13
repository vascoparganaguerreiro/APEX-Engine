// Shared building blocks for the public legal pages. No client hooks, no authentication, no Supabase: these pages must render signed out.
import Link from "next/link";
import { CONTACT_EMAIL, LEGAL_UPDATED, PRODUCT_NAME, type PlaceholderId } from "@/lib/legal";

/** A value that could not be verified. It is shown highlighted so it can be found and completed before an external beta. */
export function Todo({ id, children }: { id: PlaceholderId; children: React.ReactNode }) {
  return <mark className="legal-todo" data-placeholder={id}>[{children}]</mark>;
}

export function LegalPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="legal">
      <div className="logo">⚡ {PRODUCT_NAME.toUpperCase()}</div>
      <p><Link className="linkbtn" href="/login">← Back to sign in</Link></p>
      <h1>{title}</h1>
      <p className="muted small">Last updated: {LEGAL_UPDATED}. Contact: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></p>
      <div className="notice legal-draft" role="note" data-draft-warning="true">
        <b>DRAFT: not approved for external beta use.</b> The legal details on this page are incomplete and have not been reviewed by a lawyer.
        Parts highlighted like <mark className="legal-todo">[this]</mark> are missing or unresolved and must not be read as final. {PRODUCT_NAME} is run by one
        individual, not a company. The text describes what the app does today; it is not legal advice and does not claim GDPR compliance.
      </div>
      {children}
      <p className="muted small"><Link href="/privacy">Privacy Policy</Link> · <Link href="/terms">Terms of Use</Link></p>
    </main>
  );
}

/** The two links, used on the login page and in Profile → Account. */
export function LegalLinks() {
  return (
    <p className="muted small legal-links">
      <Link href="/privacy">Privacy Policy</Link> · <Link href="/terms">Terms of Use</Link>
    </p>
  );
}
