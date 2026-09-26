// Telegram alert: format the message, send it via the Bot API.

const MAX_MESSAGE_CHARS = 3800; // Bot API limit is 4096 after entity parsing
const MAX_FINDINGS_SHOWN = 10;
const MAX_FINDING_CHARS = 400;
const MAX_NAME_CHARS = 100;

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * @param {{ name: string }} project
 * @param {{critical:number, high:number, medium:number, info:number}} counts
 * @param {Array<{severity:string, message:string}>} newFindings
 * @param {string} webUrl   e.g. https://watch.sixthgear.dev
 * @param {string} projectId
 */
export function formatAlertMessage(project, counts, newFindings, webUrl, projectId) {
  const link = `${webUrl}/projects/${projectId}`;
  const lines = [
    `⚠️ <b>${escapeHtml(truncate(project.name, MAX_NAME_CHARS))}</b> — new security findings`,
    `critical ${counts.critical ?? 0} · high ${counts.high ?? 0} · medium ${counts.medium ?? 0} · info ${counts.info ?? 0}`,
    "",
  ];
  // Room kept for the "…and N more" line and the link.
  const reserved = 60 + link.length;
  let length = lines.join("\n").length;
  let shown = 0;

  for (const f of newFindings.slice(0, MAX_FINDINGS_SHOWN)) {
    const line = `- [${f.severity}] ${escapeHtml(truncate(f.message, MAX_FINDING_CHARS))}`;
    if (length + 1 + line.length + reserved > MAX_MESSAGE_CHARS) break;
    lines.push(line);
    length += 1 + line.length;
    shown++;
  }

  const rest = newFindings.length - shown;
  if (rest > 0) lines.push(`…and ${rest} more, see dashboard`);
  lines.push("", link);
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
    throw new Error(`Telegram sendMessage failed: ${res.status} ${body?.description ?? ""}`.trim());
  }
  return body;
}
