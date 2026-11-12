import { redirect } from "next/navigation";

// /import used to hold only the Intervals.icu connection form, which now lives in its card on the Connectivity Centre (/integrations).
// There is no other manual import on this page: Hevy CSV import is under Strength → Import and lab reports under Biomarkers. The route is kept
// so old bookmarks and links still land in the right place.
export default function ImportPage() {
  redirect("/integrations");
}
