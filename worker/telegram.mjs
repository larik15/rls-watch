// Telegram alert: format the message, send it via the Bot API.

const MAX_FINDINGS_SHOWN = 10;

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * @param {{ name: string }} project
 * @param {{critical:number, high:number, medium:number, info:number}} counts
 * @param {Array<{severity:string, message:string}>} newFindings
 * @param {string} webUrl   e.g. https://watch.sixthgear.dev
 * @param {string} projectId
 */
export function formatAlertMessage(project, counts, newFindings, webUrl, projectId) {
  const lines = [];
  lines.push(`⚠️ <b>${escapeHtml(project.name)}</b> — new security findings`);
  lines.push(
    `critical ${counts.critical ?? 0} · high ${counts.high ?? 0} · medium ${counts.medium ?? 0} · info ${counts.info ?? 0}`
  );
  lines.push("");
  const shown = newFindings.slice(0, MAX_FINDINGS_SHOWN);
  for (const f of shown) {
    lines.push(`- [${f.severity}] ${escapeHtml(f.message)}`);
  }
  if (newFindings.length > shown.length) {
    lines.push(`… and ${newFindings.length - shown.length} more`);
  }
  lines.push("");
  lines.push(`${webUrl}/projects/${projectId}`);
  return lines.join("\n");
}

/**
 * @param {string} botToken
 * @param {string} chatId
 * @param {string} text
 * @param {typeof fetch} [fetchImpl]
 */
export async function sendTelegramMessage(botToken, chatId, text, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.ok === false) {
    throw new Error(`Telegram sendMessage failed: ${res.status} ${body ? JSON.stringify(body) : await res.text()}`);
  }
  return body;
}
