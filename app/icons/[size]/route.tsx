import { ImageResponse } from "next/og";
import { ICONS, ICON_KEYS, iconElement, isIconKey } from "@/lib/appIcon";

// App icons, drawn at build time (no image files, no new dependency, nothing private): 180 (iOS home screen), 192 and 512 (Android, any purpose),
// "maskable" (512, Android adaptive icon with the mark inside the safe zone) and 32 (browser tab). The design (the A drawn from MARK_PATH) lives in lib/appIcon.ts.
export const dynamic = "force-static";
export function generateStaticParams() { return ICON_KEYS.map((s) => ({ size: s })); }

export async function GET(_req: Request, ctx: { params: Promise<{ size: string }> }) {
  const key = (await ctx.params).size;
  if (!isIconKey(key)) return new Response("Not found", { status: 404 });
  const { px } = ICONS[key];
  return new ImageResponse(iconElement(key), { width: px, height: px });
}
