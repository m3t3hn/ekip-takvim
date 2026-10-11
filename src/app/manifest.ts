import type { MetadataRoute } from "next";

// Lets phones add the app to the home screen with its own icon, opening
// without the browser's address bar.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Ekip Takvim",
    short_name: "Ekip Takvim",
    description: "Who's free when, across everyone's calendars.",
    start_url: "/",
    display: "standalone",
    background_color: "#f5f5f7",
    theme_color: "#f5f5f7",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
