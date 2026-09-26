// The on-demand queue the web app writes to: "Run now" on a project and "send test
// message" in settings. Polled every minute by index.mjs. Each request is claimed with
// a lease (claim_run_request); if the worker dies mid-request, it's picked up again once
// the lease expires, at most 3 times.

import * as realDb from "./db.mjs";
import { checkProject, PROJECT_DEADLINE_MS } from "./checkProject.mjs";
import { sendTelegramMessage } from "./telegram.mjs";
import { makeSafeFetch } from "./safeFetch.mjs";
import { sanitizeError } from "./sanitize.mjs";

const LEASE_SECONDS = Math.ceil(PROJECT_DEADLINE_MS / 1000) + 60;
const MAX_PER_POLL = 20;

async function sendTelegramTest({ admin, db, req, telegramBotToken, fetchImpl }) {
  const agency = await db.loadAgency(admin, req.agency_id);
  if (!telegramBotToken) throw new Error("TELEGRAM_BOT_TOKEN is not set on the worker");
  if (!agency?.telegram_chat_id) throw new Error("the agency has no Telegram chat id");

  const text = `✅ RLS Watch test message for ${agency.name}. If you can read this, alerts will reach this chat.`;
  const alert = { agencyId: req.agency_id, projectId: null, runId: null, channel: "telegram", payload: { kind: "telegram_test" } };
  try {
    await sendTelegramMessage(telegramBotToken, agency.telegram_chat_id, text, makeSafeFetch({ fetchImpl }));
  } catch (err) {
    await db.insertAlert(admin, { ...alert, status: "failed", error: sanitizeError(err) });
    throw err;
  }
  await db.insertAlert(admin, { ...alert, status: "sent" });
}

/**
 * @param {Object} opts
 * @param {import("@supabase/supabase-js").SupabaseClient} opts.admin
 * @param {string} [opts.telegramBotToken]
 * @param {string} opts.webUrl
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {Object} [opts.db]       test seam
 * @param {Function} [opts.check]  test seam for checkProject
 */
export async function processRunRequests({
  admin,
  telegramBotToken,
  webUrl,
  fetchImpl = globalThis.fetch,
  db = realDb,
  check = checkProject,
}) {
  const handled = [];

  for (let i = 0; i < MAX_PER_POLL; i++) {
    const req = await db.claimRunRequest(admin, LEASE_SECONDS);
    if (!req) break;

    try {
      if (req.kind === "run") {
        const project = await db.loadProject(admin, req.project_id);
        const result = await check({ admin, project, telegramBotToken, webUrl, fetchImpl });
        if (result.status === "skipped") throw new Error("a run of this project was already in progress");
        if (result.status !== "ok") throw new Error(`the run ended with status '${result.status}'`);
      } else if (req.kind === "telegram_test") {
        await sendTelegramTest({ admin, db, req, telegramBotToken, fetchImpl });
      } else {
        throw new Error(`unknown run_request kind: ${req.kind}`);
      }
      await db.markRunRequestDone(admin, req.id, null);
      handled.push({ id: req.id, status: "ok" });
    } catch (err) {
      console.error(`[rls-watch] run_request ${req.id} (${req.kind}) failed:`, err);
      const error = sanitizeError(err);
      await db.markRunRequestDone(admin, req.id, error);
      handled.push({ id: req.id, status: "error", error });
    }
  }

  return handled;
}
