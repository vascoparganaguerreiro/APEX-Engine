import type { MetadataRoute } from "next";
import { APP_DESCRIPTION } from "../lib/appMeta.ts";

/** Web app manifest: lets the phone add APEX to the home screen and open it full screen. No service worker, no offline caching.
 *  `id` is the app's identity for installs: it stays "/" even if the product name, short name or start page change later. No orientation is set, so the app
 *  rotates with the device. The maskable icon is its own file, so the "any" icons are not cropped. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "APEX Engine",
    short_name: "APEX",
    description: APP_DESCRIPTION,
    lang: "en",
    categories: ["health", "fitness", "sports"],
    start_url: "/today",
    scope: "/",
    display: "standalone",
    background_color: "#06080b",
    theme_color: "#06080b",
    icons: [
      { src: "/icons/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
