import { authUser, errorResponse } from "@/lib/serverAuth";
import { configuredNames } from "@/lib/integrations/configs";

export const runtime = "nodejs";

/** GET -> which server variables are set (names only, never values), so the Connectivity Centre can say truthfully whether a
 *  direct connection can be started. Signed-in users only. */
export async function GET(req: Request): Promise<Response> {
  try {
    await authUser(req);
    return Response.json({ configured: configuredNames(process.env) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e, "integrations status failed");
  }
}
