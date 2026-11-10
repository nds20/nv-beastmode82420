// GET/POST /api/admin/mail-debug — ADMIN-ONLY email diagnostics
// (2026-11-10, docs/EMAIL.md). The owner's proof tool after wiring
// the GOOGLE_OAUTH_* secrets:
//
//   GET  -> { configured, missing, from, fromName, adminEmail }
//           `missing` names the env vars still unset; the response
//           NEVER contains a secret value — names only.
//   POST -> sends ONE test email ("Shop 824 mail test") to the
//           admin address and returns Gmail's result:
//           { ok, messageId?, status?, errorCode? }. When mail is
//           not configured it sends nothing and says so.
//
// Admin-gated with requireAdmin like every other /api/admin surface
// (401 without a valid admin bearer token).

import { handle, json } from '../_lib/http.js';
import { requireAdmin } from '../_lib/auth.js';
import { mailConfigStatus, sendMail, shopAdminEmail } from '../_lib/mail.js';

export const onRequestGet = handle(async (context) => {
  await requireAdmin(context);
  return json(mailConfigStatus(context.env));
});

export const onRequestPost = handle(async (context) => {
  await requireAdmin(context);
  const env = context.env;
  const status = mailConfigStatus(env);
  if (!status.configured) {
    return json({ ok: false, configured: false, missing: status.missing });
  }
  const result = await sendMail(env, {
    to: shopAdminEmail(env),
    subject: 'Shop 824 mail test',
    text: [
      'This is a test email from Shop 824.',
      '',
      'If you are reading this in the admin inbox, email notifications',
      'are wired: order confirmations, new-order alerts, offer alerts',
      'and PAID alerts will land here.',
      '',
      `Sent: ${new Date().toISOString()}`,
      '',
      '— Shop 824 (via /api/admin/mail-debug)',
    ].join('\n'),
  });
  return json({
    configured: true,
    ok: result.ok,
    to: status.adminEmail,
    ...(result.id ? { messageId: result.id } : {}),
    ...(result.status ? { status: result.status } : {}),
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
  });
});
