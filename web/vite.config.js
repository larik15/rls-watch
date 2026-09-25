import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  // Reuse the repo's root .env (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY) instead
  // of keeping a second copy inside web/.
  envDir: path.resolve(__dirname, ".."),
  build: {
    outDir: "dist",
  },
});
