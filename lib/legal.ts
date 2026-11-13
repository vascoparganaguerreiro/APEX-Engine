// Facts shared by the public Privacy Policy and Terms pages. Everything marked as a placeholder is information that cannot be verified from
// the code and must be completed (or confirmed by legal review) before an external beta. The pages render each placeholder visibly, so
// nothing unverified can be mistaken for a final statement. Keep LEGAL_PLACEHOLDERS in step with the <Todo> markers in app/privacy and app/terms.

/** Temporary project contact. The brand name and this address may change later. */
export const CONTACT_EMAIL = "apexengine.project@gmail.com";
export const PRODUCT_NAME = "APEX Engine";
/** Date the texts were last edited by hand (not generated). */
export const LEGAL_UPDATED = "13 November 2026";

export const LEGAL_PLACEHOLDERS = [
  { id: "operator-name", what: "Full name of the individual who operates the project (identification of the controller), and whether a postal address or other contact details must be published for the controller." },
  { id: "operator-country", what: "Country of residence of the operator, and the governing law and courts for the Terms." },
  { id: "article-9-basis", what: "The legal basis for processing health and physiological data (GDPR Article 9) and whether in-app consent is sufficient." },
  { id: "retention", what: "Retention periods for each data category (none are defined or enforced in the code today)." },
  { id: "processors", what: "Processor terms and data location for Supabase, Vercel and Google (Gemini), including whether the AI plan used allows Google to keep or reuse prompts, and any international transfers." },
  { id: "minimum-age", what: "Minimum age for using the service." },
  { id: "liability", what: "Any limitation-of-liability wording, and how the service should be described for regulatory purposes (for example whether it could count as a medical device); both need legal review before they are published." },
  { id: "response-time", what: "How quickly privacy requests will be answered." },
] as const;
export type PlaceholderId = (typeof LEGAL_PLACEHOLDERS)[number]["id"];
