import type { APIRoute } from "astro";
import { sitePath } from "../components/paths";

export const prerender = true;

export const GET: APIRoute = () => {
  const manifest = {
    id: sitePath("/"),
    name: "Det sker på Ærø",
    short_name: "Ærø Events",
    description: "Koncerter, møder og andre offentlige arrangementer på Ærø.",
    lang: "da",
    start_url: sitePath("/"),
    scope: sitePath("/"),
    display: "standalone",
    background_color: "#f4f0e2",
    theme_color: "#315f45",
    icons: [
      {
        src: sitePath("/favicon.svg"),
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any maskable",
      },
    ],
  };

  return new Response(JSON.stringify(manifest), {
    headers: {
      "Content-Type": "application/manifest+json; charset=utf-8",
    },
  });
};
