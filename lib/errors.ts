/** A readable message from anything that was thrown or returned as an error (Error, Supabase error object, string). */
export const errMsg = (e: unknown): string =>
  e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);
