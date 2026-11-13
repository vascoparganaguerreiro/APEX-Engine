import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, Todo } from "@/components/legal/Legal";
import { CONTACT_EMAIL, PRODUCT_NAME } from "@/lib/legal";

export const metadata: Metadata = { title: `Terms of Use · ${PRODUCT_NAME}` };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Use">
      <h2>1. Who provides the service</h2>
      <p>
        {PRODUCT_NAME} is a private-beta project operated by one individual, <Todo id="operator-name">operator&apos;s full name, to be completed</Todo>, not by a
        company. Contact: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> (temporary; the product name and address may change).
      </p>

      <h2>2. Private beta and access</h2>
      <ul>
        <li>Access is by invitation only. Use the email address you were invited with and keep your password to yourself.</li>
        <li>The service is an unfinished beta. Features can change, break or be removed, and data or features may be unavailable at times.</li>
        <li>Minimum age: <Todo id="minimum-age">to be defined</Todo>.</li>
      </ul>

      <h2>3. Not medical advice</h2>
      <ul>
        <li>{PRODUCT_NAME} gives training and wellness information for general fitness purposes. It is not intended to be used as a medical device, and it does not diagnose, treat or prevent any condition. <Todo id="liability">How it should be described for regulatory purposes needs legal review</Todo>.</li>
        <li>Calculations (such as training load, readiness, estimated maximum strength) and everything produced by the AI are estimates. They can be wrong, incomplete or based on data you or a connected service entered incorrectly.</li>
        <li>Blood test values and supplements are shown for your own tracking. Talk to a qualified professional before changing medication, supplements, diet or training because of anything you see here, and seek urgent care for symptoms or emergencies. Do not rely on this service in an emergency.</li>
      </ul>

      <h2>4. Your account and your data</h2>
      <ul>
        <li>You are responsible for what you enter, upload or connect, and for having the right to use it (for example your own data, and files you are allowed to share).</li>
        <li>Your data remains yours. You allow the service to store and process it to provide the features you use, as described in the <Link href="/privacy">Privacy Policy</Link>.</li>
        <li>AI features only send data you have agreed to send. You can change those choices at any time.</li>
        <li>Deleting your whole account and exporting all your data are not yet available inside the app. Until they are, ask by email; requests are handled manually, as explained in the Privacy Policy.</li>
      </ul>

      <h2>5. Acceptable use</h2>
      <ul>
        <li>Do not try to access other people&apos;s data, break or overload the service, bypass limits (the AI features are rate limited per user), or use it to break the law.</li>
        <li>Do not upload content you have no right to share, or malicious files.</li>
        <li>Access may be suspended or ended if the service or other users are put at risk.</li>
      </ul>

      <h2>6. Connected services</h2>
      <p>
        If you connect Intervals.icu, WHOOP or another service, that service&apos;s own terms and privacy policy also apply, and {PRODUCT_NAME} is not
        affiliated with or endorsed by them unless stated. You can disconnect at any time in the Connectivity Centre. Those services may change or stop
        their access, which can stop syncing.
      </p>

      <h2>7. Availability and changes</h2>
      <p>The service is provided as it is during the beta, without a promise of uptime, backups or that every feature will continue. Keep your own copy of anything important. These terms may change; the date at the top shows the latest version, and I will try to tell invited users about significant changes.</p>

      <h2>8. Liability and governing law</h2>
      <p>
        Nothing in these terms limits any right you have under mandatory consumer or data protection law. Limits on liability: <Todo id="liability">wording to be reviewed before an external beta</Todo>.
        Governing law and courts: <Todo id="operator-country">to be completed</Todo>.
      </p>

      <h2>9. Contact</h2>
      <p>Questions, privacy requests or problems: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.</p>
    </LegalPage>
  );
}
