// GET /api/donate/stats — public donation aggregate for the hub's
// "raised so far" line: { totalCents, donationCount } and nothing
// else. Individual gifts, donor emails, and rows are NEVER exposed
// here (they exist only in the donations table for the owner).

import { handle, json } from '../_lib/http.js';
import { getDonationStats } from '../_lib/donations.js';

export const onRequestGet = handle(async ({ env }) => json(await getDonationStats(env)));
