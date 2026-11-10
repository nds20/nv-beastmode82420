// GET / DELETE /api/admin/error-logs — ADMIN-ONLY read + clear for
// the Error Logs airlock (2026-11-10, docs/ERROR_LOGS.md).
//
//   GET     ?limit=  newest first; default 50, clamped 1..200.
//                    Rows carry the parsed detail object alongside
//                    the flat fields, so the admin page renders the
//                    stage/context JSON without a second parse.
//   DELETE           clears the whole log and answers
//                    { ok: true, removed } — clearing is the owner's
//                    broom after a fix lands, not a routine action.
//
// Admin-gated with requireAdmin like every other /api/admin surface
// (401 without a valid admin bearer token). The log's privacy rules
// are enforced at WRITE time in _lib/errorLog.js (no bodies, no
// headers, no secrets ever stored), so this read can show rows
// verbatim.

import { handle, json } from '../_lib/http.js';
import { requireAdmin } from '../_lib/auth.js';
import { listErrorLogs, clearErrorLogs } from '../_lib/errorLog.js';

function shapeRow(row) {
  let detail = null;
  if (row.detail) {
    try {
      detail = JSON.parse(row.detail);
    } catch {
      detail = row.detail;
    }
  }
  return {
    id: row.id,
    ts: row.ts,
    requestId: row.request_id,
    source: row.source,
    method: row.method,
    path: row.path,
    status: row.status,
    errorName: row.error_name,
    errorMessage: row.error_message,
    detail,
    actor: row.actor,
    userAgent: row.user_agent,
  };
}

export const onRequestGet = handle(async (context) => {
  await requireAdmin(context);
  const url = new URL(context.request.url);
  let limit = Number(url.searchParams.get('limit') || 50);
  if (!Number.isFinite(limit)) limit = 50;
  limit = Math.min(200, Math.max(1, Math.floor(limit)));
  const rows = await listErrorLogs(context.env, limit);
  return json({ logs: rows.map(shapeRow) });
});

export const onRequestDelete = handle(async (context) => {
  await requireAdmin(context);
  const removed = await clearErrorLogs(context.env);
  return json({ ok: true, removed });
});
