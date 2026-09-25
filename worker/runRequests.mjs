// Handles the small on-demand queue the web app writes to: "Run now" on a project,
// and "send test message" in settings. Polled every minute by index.mjs.

import * as db from "./db.mjs";
import { checkProject } from "./checkProject.mjs";
import { sendTelegramMessage } from "./telegram.mjs";
import { withTimeout } from "./pool.mjs";

const PER_REQUEST_TIMEOUT_MS = 60_000;

/**
 * @param {Object} opts
 * @param {import("@supabase/supabase-js").SupabaseClient} opts.admin
 * @param {string} [opts.telegramBotToken]
 * @param {string} opts.webUrl
 * @param {typeof fetch} [opts.fetchImpl]
 */
export async function processRunRequests({ admin, telegramBotToken, webUrl, fetchImpl = globalThis.fetch }) {
  const pending = await db.loadPendingRunRequests(admin);
  const handled = [];

  for (const req of pending) {
    await db.markRunRequestPicked(admin, req.id);
    try {
      if (req.kind === "run") {
        const project = await db.loadProject(admin, req.project_id);
        await withTimeout(
          checkProject({ admin, project, telegramBotToken, webUrl, fetchImpl }),
          PER_REQUEST_TIMEOUT_MS,
          `run request ${req.id}`
        );
      } else if (req.kind === "telegram_test") {
        const agency = await db.loadAgency(admin, req.agency_id);
        if (!agency?.telegram_chat_id) throw new Error("agency has no telegram_chat_id set");
        if (!telegramBotToken) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
        await sendTelegramMessage(
          telegramBotToken,
          agency.telegram_chat_id,
          `✅ RLS Watch test message for ${agency.name}. If you can read this, alerts will reach this chat.`,
          fetchImpl
        );
      } else {
        throw new Error(`unknown run_request kind: ${req.kind}`);
      }
      await db.markRunRequestDone(admin, req.id, null);
      handled.push({ id: req.id, status: "ok" });
    } catch (err) {
      await db.markRunRequestDone(admin, req.id, err.message);
      handled.push({ id: req.id, status: "error", error: err.message });
    }
  }

  return handled;
}
