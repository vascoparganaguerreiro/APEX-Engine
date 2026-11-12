import { ImageResponse } from "next/og";

// Home-screen / favicon icons, drawn at build time (no image files, no new dependency, nothing private). Sizes: 180 (iOS), 192 and 512 (Android).
export const dynamic = "force-static";
const SIZES = [180, 192, 512] as const;
export function generateStaticParams() { return SIZES.map((s) => ({ size: String(s) })); }

export async function GET(_req: Request, ctx: { params: Promise<{ size: string }> }) {
  const n = Number((await ctx.params).size);
  const size = (SIZES as readonly number[]).includes(n) ? n : 192;
  // A solid APEX-dark tile with a green-to-blue bolt-like "A" mark, centred inside the maskable safe zone (inner 80%).
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#06080b" }}>
        <div style={{ width: size * 0.62, height: size * 0.62, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: size * 0.16, background: "linear-gradient(135deg,#2ee6a6,#4da3ff)", color: "#031210", fontSize: size * 0.42, fontWeight: 800 }}>
          A
        </div>
      </div>
    ),
    { width: size, height: size },
  );
}
