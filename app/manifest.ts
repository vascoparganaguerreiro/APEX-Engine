import type { MetadataRoute } from "next";

/** Web app manifest: lets the phone add APEX to the home screen and open it full screen. No service worker, no offline caching. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "APEX Engine",
    short_name: "APEX",
    description: "Training, recovery and health data in one place.",
    start_url: "/today",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#06080b",
    theme_color: "#06080b",
    icons: [
      { src: "/icons/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/512", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
