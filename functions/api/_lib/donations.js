// Donations — one-time gifts to 824's projects via Stripe Checkout
// (owner direction 2026-11-06). Donations are the ONLY new Stripe
// surface on this app: the shop's order checkout is untouched, and
// these helpers are used by exactly three routes —
//   POST /api/donate/checkout   (start a hosted Checkout session)
//   POST /api/stripe/webhook    (records kind=donation sessions)
//   GET  /api/donate/stats      (public aggregate only)
//
// The `donations` table is created lazily at runtime (the FWB house
// pattern: CREATE TABLE IF NOT EXISTS, cached per isolate), so no
// migration step is needed on the live database; cloudflare/schema.sql
// carries the same table for fresh installs. Money is integer cents
// end-to-end (Stripe's amount_total is already cents).
//
// Privacy rule: donor emails live only in this table for the owner's
// records. The public stats endpoint exposes ONLY a summed total and
// a count — never rows, emails, or individual amounts.

import { fail } from './http.js';

// The projects a donor can aim a gift at. Slugs are stable (they are
// stored in the donations table and in Stripe metadata); labels are
// the display names used in the UI and in the Stripe product name.
export const DONATION_PROJECTS = [
  { slug: 'where-needed', name: 'Where It Is Needed Most' },
  { slug: 'friends-with-benefits', name: 'Friends With Benefits' },
  { slug: '824-shield', name: '824 Shield' },
  { slug: '824-bank', name: '824 Bank' },
  { slug: 'queen-victoria', name: 'Queen Victoria' },
  // Added 2026-11-10 (owner direction): Project Gamma is the
  // highlighted donation target; the Sports App joins the roster.
  { slug: 'project-gamma', name: 'Project Gamma' },
  { slug: 'sports-app', name: 'Sports App' },
];

// The highlighted default (owner direction 2026-11-10): a donation
// with no project chosen aims at Project Gamma.
export const DEFAULT_DONATION_PROJECT = 'project-gamma';

const PROJECT_BY_SLUG = new Map(DONATION_PROJECTS.map((p) => [p.slug, p]));

export function donationProject(slug) {
  return PROJECT_BY_SLUG.get(slug) || null;
}

export const DONATION_MIN_CENTS = 100; // $1
export const DONATION_MAX_CENTS = 1000000; // $10,000

/**
 * Validate a POST /api/donate/checkout body. Returns
 * { amountCents, project } (project defaulted) or throws a 400
 * HttpError via fail(). amountCents must be a true integer number of
 * cents — strings, floats, NaN, and out-of-range values are rejected,
 * never coerced or rounded.
 */
export function validateDonationInput(body) {
  const data = body && typeof body === 'object' ? body : {};
  const amount = data.amountCents;
  if (
    typeof amount !== 'number' ||
    !Number.isInteger(amount) ||
    amount < DONATION_MIN_CENTS ||
    amount > DONATION_MAX_CENTS
  ) {
    fail(
      400,
      `Donation amount must be between $${DONATION_MIN_CENTS / 100} and $${
        DONATION_MAX_CENTS / 100
      } (whole cents).`
    );
  }
  const slug =
    data.project === undefined || data.project === null || data.project === ''
      ? DEFAULT_DONATION_PROJECT
      : data.project;
  const project = donationProject(slug);
  if (!project) fail(400, 'Please choose one of the listed projects.');
  return { amountCents: amount, project };
}

// ----- Table (lazy, cached per isolate) --------------------------------------

let donationsTablePromise = null;

export function ensureDonationsTable(env) {
  if (!donationsTablePromise) {
    donationsTablePromise = env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS donations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stripe_session_id TEXT UNIQUE,
        amount_cents INTEGER NOT NULL,
        project TEXT NOT NULL,
        donor_email TEXT,
        created_at TEXT NOT NULL
      )`
    )
      .run()
      .then(() => true)
      .catch((err) => {
        // Do not poison the isolate on a transient failure — the next
        // request retries the CREATE.
        donationsTablePromise = null;
        throw err;
      });
  }
  return donationsTablePromise;
}

// ----- Writes / reads ----------------------------------------------------------

/**
 * Record one completed donation from a Stripe Checkout Session.
 * Idempotent: the session id is UNIQUE and INSERT OR IGNORE makes a
 * redelivered webhook a no-op. Returns true when a row was inserted.
 */
export async function recordDonation(env, session) {
  await ensureDonationsTable(env);
  const amount = Number(session && session.amount_total);
  if (!session || !session.id || !Number.isInteger(amount) || amount <= 0) {
    return false;
  }
  const projectSlug =
    session.metadata && donationProject(session.metadata.project)
      ? session.metadata.project
      : DEFAULT_DONATION_PROJECT;
  const email =
    (session.customer_details && session.customer_details.email) ||
    session.customer_email ||
    null;
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO donations (stripe_session_id, amount_cents, project, donor_email, created_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(
      String(session.id),
      amount,
      projectSlug,
      email ? String(email) : null,
      new Date().toISOString()
    )
    .run();
  return Boolean(result && result.meta && result.meta.changes > 0);
}

/**
 * Public aggregate ONLY: summed cents + gift count. Column aliases are
 * camelCased here so the route can return the row shape directly.
 */
export async function getDonationStats(env) {
  await ensureDonationsTable(env);
  const row = await env.DB.prepare(
    'SELECT COALESCE(SUM(amount_cents), 0) AS totalCents, COUNT(*) AS donationCount FROM donations'
  ).first();
  return {
    totalCents: row ? Number(row.totalCents) || 0 : 0,
    donationCount: row ? Number(row.donationCount) || 0 : 0,
  };
}
