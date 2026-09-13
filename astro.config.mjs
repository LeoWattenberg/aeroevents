import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

const site = process.env.PUBLIC_SITE_URL ?? "http://localhost:4321";
const configuredBase = process.env.PUBLIC_BASE_PATH ?? "/";
const base = configuredBase === "/" ? undefined : `/${configuredBase.replace(/^\/+|\/+$/g, "")}`;

export default defineConfig({
  site,
  base,
  output: "static",
  integrations: [sitemap()],
  vite: {
    define: {
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
  },
});
