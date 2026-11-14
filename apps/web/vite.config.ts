import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const API_ORIGIN =
  process.env["MAILCAL_DEV_API_ORIGIN"] ?? "http://localhost:8787";

export default defineConfig({
  plugins: [solid()],
  server: {
    proxy: {
      "/graphql": API_ORIGIN,
      "/api": API_ORIGIN,
      "/files": API_ORIGIN,
    },
  },
});
