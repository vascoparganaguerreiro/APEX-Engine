import type { Metadata } from "next";
import { LegalPage, Todo } from "@/components/legal/Legal";
import { CONTACT_EMAIL, PRODUCT_NAME } from "@/lib/legal";

export const metadata: Metadata = { title: `Privacy Policy · ${PRODUCT_NAME}` };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy">
      <h2>1. Who is responsible</h2>
      <p>
        {PRODUCT_NAME} is a private-beta project run by one individual, not by a company. The person responsible for your data (the &quot;controller&quot;
        under the GDPR) is <Todo id="operator-name">operator&apos;s full name, to be completed</Todo>, based in <Todo id="operator-country">country, to be completed</Todo>.
        There is no registered business name, postal address or data protection officer at this time.
      </p>
      <p>
        Temporary contact for everything in this policy: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. The product name and this address may
        change; the page will be updated if they do.
      </p>

      <h2>2. What data the app handles</h2>
      <p>Much of this is health and physiological data, which the GDPR treats as a special category needing extra care. Only what you enter, upload or connect is stored.</p>
      <ul>
        <li><b>Account:</b> your email address and sign-in credentials, handled by Supabase Authentication.</li>
        <li><b>Profile:</b> display name, date of birth, height, weight, body fat, resting and maximum heart rate, VO2 max, thresholds, FTP, sleep goal, sports, goals, experience level, time zone and units.</li>
        <li><b>Training and wellness:</b> activities (sport, date, duration, distance, heart rate, power, load, effort, your notes) and daily metrics such as HRV, resting heart rate and sleep, from manual entry, file import, Intervals.icu or WHOOP.</li>
        <li><b>Strength training:</b> workouts, exercises, sets, weights, routines, custom exercises and imported history (for example a Hevy CSV file you upload).</li>
        <li><b>Health records:</b> blood test results, supplements and doses, and any laboratory report file you upload (kept in private file storage).</li>
        <li><b>Plans:</b> races, training calendar entries and wearable-device export settings.</li>
        <li><b>AI content:</b> your Coach conversations and answers, assessments, and AI summaries of activities and weeks, stored so you can read them again.</li>
        <li><b>Connections:</b> which services you connected, sync status, and the access tokens or API key needed to talk to them (stored encrypted, server-side only).</li>
        <li><b>Technical records:</b> usage counters used for rate limits and cost monitoring, and error logs on the server. The app&apos;s own logs are designed to avoid passwords, keys and token values. The hosting providers also keep their own logs under their own settings, which I do not control.</li>
      </ul>
      <p>Some features depend on database setup that may not be switched on yet in every environment of this beta; the descriptions here cover the features as built.</p>

      <h2>3. Why it is used</h2>
      <p>To run the features you use: showing your training and health data, calculating load and readiness, syncing from services you connect, and (only if you allow it) generating AI coaching and summaries. Data is not sold, and the app contains no advertising.</p>
      <p>
        <b>Legal basis.</b> Health data is a special category under GDPR Article 9. The legal basis for processing it is{" "}
        <Todo id="article-9-basis">to be confirmed by legal review</Todo>. In the app, AI features ask for your permission per data category before anything is sent.
        That is a product control; this policy does not claim that it alone makes the processing compliant with the GDPR.
      </p>

      <h2>4. AI processing (Google Gemini)</h2>
      <ul>
        <li>The Coach, Ask APEX, activity and weekly summaries, and automatic reading of laboratory reports use Google&apos;s Gemini API, called from the app&apos;s server with the project&apos;s own key. Your browser never receives that key.</li>
        <li>Nothing is sent to the AI unless you agree. The Coach and summaries have a separate switch for each category (profile baselines, activities, daily wellness, training load, races, blood results, supplements, strength). Each switch lists what it sends. The structured Coach and summary requests leave out your email address, name, date of birth and credentials. Notes are only included for a session you ask about. Text you type yourself (questions, notes, goals) is sent as you wrote it, and may contain personal details if you write them.</li>
        <li>Reading a laboratory report needs your confirmation each time you send a file. The file is sent to Gemini exactly as you uploaded it, so anything printed on it (for example your name or date of birth) goes with it.</li>
        <li>Your consent choices are saved in your browser, separately per account. They are not synced across devices, so each browser asks again.</li>
        <li>AI answers can be wrong or incomplete (see the Terms). Requests are rate limited per user.</li>
        <li>How Google handles the content you send (including whether it may keep or reuse it) depends on the Gemini plan and terms in use: <Todo id="processors">to be confirmed and described here</Todo>.</li>
      </ul>

      <h2>5. Who else receives data</h2>
      <ul>
        <li><b>Supabase</b>: sign-in, database and file storage.</li>
        <li><b>Vercel</b>: the project documentation names Vercel as the host of the website and its server functions. Whether and how it processes your personal data, and the arrangements for that, <Todo id="processors">need to be confirmed</Todo>.</li>
        <li><b>Google</b>: Gemini API, as described above.</li>
        <li><b>Intervals.icu and WHOOP</b>: only if you connect them. The app then reads your data from them and stores it. You can disconnect in the Connectivity Centre; the app asks the service to revoke access where it can (best effort) and deletes the stored tokens or key. Data already imported stays in your account.</li>
        <li><b>Garmin, COROS, Polar, Suunto, Zepp and others</b> are only reachable through your own Intervals.icu account. Apple Health, Samsung Health and Oura are not connected.</li>
      </ul>
      <p>Data location, processor agreements and any transfers outside the EU/EEA: <Todo id="processors">to be confirmed</Todo>.</p>

      <h2>6. On your device</h2>
      <ul>
        <li>Your sign-in session is kept in your browser&apos;s storage. &quot;Remember me&quot; chooses between staying signed in on that device and until you close the browser.</li>
        <li>Strength workouts in progress and anything waiting to upload are kept on your device, separately for each account, so you can log offline. Signing out keeps this data on the device for your next sign-in; it is not visible to another account.</li>
        <li>Your AI consent choices, rest timer, equipment choice and a few cached lists (history, routines, custom exercises) are also stored per account on your device.</li>
        <li>While connecting WHOOP, a short-lived security cookie is used to protect the sign-in step.</li>
        <li>I have not added analytics, advertising or tracking tools. There is no service worker; the on-device data described above is the only offline storage.</li>
      </ul>

      <h2>7. How long data is kept</h2>
      <p>
        Data stays until you delete it or it is removed with your account. No fixed retention periods are enforced by the app yet: <Todo id="retention">retention periods to be decided</Todo>.
        Technical logs are kept by the hosting providers under their own settings.
      </p>

      <h2>8. Security</h2>
      <ul>
        <li>The database setup scripts for supplements, blood tests and results, Coach data, strength workouts and routines, the training calendar and connected services turn on per-user access rules (row-level security) on those tables. Signed-in users can read and change only their own rows there, with these exceptions: Coach conversations, answers and assessments are written only by the server, and you can read and delete them but not edit them; usage records, connection credentials and sign-in state for connected services are server-only and not readable from your browser. I have not yet verified the same rules for the older core tables (activities, daily metrics, profile and races), so I make no claim about them here. Laboratory report files are in a private bucket, in a folder for your account.</li>
        <li>Connection tokens and the Intervals.icu API key are encrypted before being stored and are only used on the server. The AI key is server-only.</li>
        <li>Requests to the AI and other costly features are rate limited per user.</li>
        <li>No service is perfectly secure, and this is a one-person beta: there is no independent security audit or certification, and hardening continues.</li>
      </ul>

      <h2>9. Your rights</h2>
      <p>
        If the GDPR applies to you, you have the right to access your data, correct it, have it erased, restrict or object to its use, receive it in a portable
        form, and withdraw consent at any time (withdrawal does not affect earlier use). You can also complain to your local data protection authority.
      </p>
      <p><b>What you can do in the app today:</b></p>
      <ul>
        <li>View and edit your profile, activities, metrics, races, supplements, blood tests and workouts.</li>
        <li>Delete individual items such as Coach conversations and blood panels. Deleting a blood panel also tries to remove its uploaded report file, but removal of the file is not guaranteed.</li>
        <li>Turn AI consent categories on or off, change your password, and disconnect services.</li>
        <li>Export a single workout (FIT, calendar or JSON) for your watch or calendar.</li>
      </ul>
      <p><b>What is not available yet:</b></p>
      <ul>
        <li><b>Deleting your whole account is not available in the app.</b> There is no automatic erasure yet; the project may not be able to remove every record (including uploaded files and data at connected services) without manual work.</li>
        <li><b>A complete export of all your data is not available in the app.</b> Only the single-workout export above exists.</li>
        <li>There is no screen that shows the consent you have given or withdraws it across devices.</li>
      </ul>
      <p>
        For account deletion, a copy of your data, or any other request, email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> from the address you signed up with.
        Requests are handled manually, and the response time is <Todo id="response-time">to be defined</Todo>.
      </p>

      <h2>10. Children</h2>
      <p>The service is not meant for children. Minimum age: <Todo id="minimum-age">to be defined</Todo>.</p>

      <h2>11. Changes</h2>
      <p>If this policy changes, this page is updated and the date at the top changes. For significant changes I will try to tell invited users directly.</p>
    </LegalPage>
  );
}
