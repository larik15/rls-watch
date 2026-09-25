// The RLS Watch project's own Supabase client — the dashboard's data source.
// Not to be confused with a monitored client project's URL/anon key, which only
// ever live in `projects` rows and are used by the worker, never by this app.

import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Set them in the repo root .env (see .env.example)."
  );
}

export const supabase = createClient(url, anonKey);
