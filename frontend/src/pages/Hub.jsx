// The Beastmode 82420 brand hub — route "/".
//
// Structure (owner-directed, built to be re-skinned/re-arted without
// restructuring):
//   1. Hero artwork — a single <img> (/images/beastmode-logo-emblem.svg),
//      the owner's Beast-form portrait emblem supplied on 2026-11-07
//      (replacing the Beast Gohan emblem he supplied on 2026-11-01,
//      which replaced the original stadium banner; the old asset stays
//      at /images/logo-hero.svg for revert). It sits centered at a
//      constrained width (.hub-hero); its black surround blends into
//      the page. The buttons below are real HTML links.
//   2. The keystone feature block — Friends With Benefits, the
//      flagship product, spotlit in a black feature card directly
//      under the hero (owner direction 2026-11-05).
//   3. The pill link row — real pill buttons centered under the
//      feature block, styled to match the artwork (gold outline,
//      black fill, gold text). In the owner's order.
//   4. About 824 — the owner's company blurb below the links, led by
//      Friends With Benefits as the keystone product.
//   5. Support 824 — the donate panel closing the page (owner
//      direction 2026-11-06): project chips + amount presets + a big
//      gold Donate button into Stripe Checkout. Until STRIPE_SECRET_KEY
//      is set on the deployment (/api/payments/config reports
//      stripeEnabled: false), the button wears an UNDER CONSTRUCTION
//      tag and stays disabled; setting the key is the only switch.

import { useEffect, useState } from 'react';

const HERO_ART = '/images/beastmode-logo-emblem.svg';

const FWB_APP_URL = 'https://nv-friends-with-benefits.dp8t78cvgc.workers.dev';

const BANK_APP_URL = 'https://nv-824-bank.dp8t78cvgc.workers.dev';

const HUB_LINKS = [
  { label: 'LinkedIn', href: 'https://www.LinkedIn.com/in/beastmode82420' },
  { label: 'Biometric Screening Research', href: 'https://github.com/nds20/nv-genomic-trial-match' },
  { label: '824 Shield', href: 'https://github.com/nds20/824-shield' },
  { label: 'Shop 824', href: 'https://github.com/nds20/nv-beastmode82420' },
  { label: 'Friends With Benefits', href: FWB_APP_URL },
  { label: 'Friends With Benefits (GitHub)', href: 'https://github.com/nds20/nv-friends-with-benefits' },
  { label: 'Unofficial Muse AI for Windows', href: 'https://github.com/nds20/nv-unofficial-MuseAI-windows-app' },
  { label: '3D Cube Game', href: 'https://muse.ai/s/3d-cube-game-xbxt6xixyxgxwxzxvsxx/2qoD5ps4YhV1YcHPNRi6nfm4bAZTiRccuapyZZ99eaI' },
];

const DONATE_PROJECTS = [
  { slug: 'where-needed', label: "Where it's needed most" },
  { slug: 'friends-with-benefits', label: 'Friends With Benefits' },
  { slug: '824-shield', label: '824 Shield' },
  { slug: '824-bank', label: '824 Bank' },
  { slug: 'queen-victoria', label: 'Queen Victoria' },
];

const DONATE_PRESETS = [
  { cents: 824, label: '$8.24' },
  { cents: 2000, label: '$20' },
  { cents: 5000, label: '$50' },
  { cents: 10000, label: '$100' },
];

const CUSTOM = 'custom';
const DONATE_MIN_CENTS = 100;
const DONATE_MAX_CENTS = 1000000;

// Strict dollars -> cents for the custom field: digits with an
// optional 1–2 decimal part, nothing else. Returns null on any
// mismatch — an amount is never silently rounded or guessed.
function parseCustomAmount(raw) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(raw || '').trim());
  if (!match) return null;
  const cents =
    Number(match[1]) * 100 + (match[2] ? Number(match[2].padEnd(2, '0')) : 0);
  if (!Number.isSafeInteger(cents) || cents < DONATE_MIN_CENTS || cents > DONATE_MAX_CENTS) {
    return null;
  }
  return cents;
}

function formatMoney(cents) {
  const dollars = cents / 100;
  return `$${dollars.toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(dollars) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function DonateSection() {
  // null = still asking the server; donations are presented dormant
  // until the config probe proves Stripe is live.
  const [stripeLive, setStripeLive] = useState(null);
  const [stats, setStats] = useState(null);
  const [project, setProject] = useState('where-needed');
  const [preset, setPreset] = useState(824);
  const [custom, setCustom] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [returned, setReturned] = useState(null); // '1' | '0' | null

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const donated = params.get('donated');
    if (donated === '1' || donated === '0') {
      setReturned(donated);
      params.delete('donated');
      const query = params.toString();
      window.history.replaceState(
        null,
        '',
        window.location.pathname + (query ? `?${query}` : '') + window.location.hash
      );
    }
    fetch('/api/payments/config')
      .then((res) => res.json())
      .then((data) => setStripeLive(Boolean(data && data.stripeEnabled)))
      .catch(() => setStripeLive(false));
    fetch('/api/donate/stats')
      .then((res) => res.json())
      .then((data) => {
        if (data && Number.isFinite(data.totalCents) && Number.isFinite(data.donationCount)) {
          setStats(data);
        }
      })
      .catch(() => {});
  }, []);

  const live = stripeLive === true;

  async function donate() {
    setError('');
    const amountCents = preset === CUSTOM ? parseCustomAmount(custom) : preset;
    if (amountCents === null) {
      setError('Enter a custom amount between $1 and $10,000 — dollars and cents, like 25 or 25.50.');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch('/api/donate/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amountCents, project }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.url) {
        throw new Error(data.error || `Could not start the donation (${response.status})`);
      }
      window.location.href = data.url;
    } catch (err) {
      setError(err.message || 'Could not start the donation. Please try again.');
      setBusy(false);
    }
  }

  return (
    <section className="hub-donate" aria-labelledby="support-824">
      <div className="hub-donate-card">
        <p className="hub-feature-eyebrow">Fuel the Build</p>
        <h2 className="hub-donate-name" id="support-824">
          Support 824
        </h2>
        <p className="hub-donate-pitch">
          Every dollar goes straight into building the projects above — Friends
          With Benefits, 824 Shield, 824 Bank, and the Queen Victoria prototype.
          Pick a project, or send it where it&apos;s needed most.
        </p>

        {returned === '1' && (
          <p className="hub-donate-thanks" role="status">
            Thank you for fueling the build 💙 Your support keeps 824 shipping.
          </p>
        )}
        {returned === '0' && (
          <p className="hub-donate-note" role="status">
            No worries — the door&apos;s always open.
          </p>
        )}
        {stats && stats.donationCount > 0 && (
          <p className="hub-donate-raised">
            {stats.donationCount} {stats.donationCount === 1 ? 'supporter has' : 'supporters have'}{' '}
            raised {formatMoney(stats.totalCents)} so far 💙
          </p>
        )}

        <div className="hub-donate-group">
          <span className="hub-donate-label" id="donate-project-label">
            Aim my gift at
          </span>
          <div className="hub-donate-chips" role="group" aria-labelledby="donate-project-label">
            {DONATE_PROJECTS.map((p) => (
              <button
                key={p.slug}
                type="button"
                className="hub-donate-chip"
                aria-pressed={project === p.slug}
                onClick={() => setProject(p.slug)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="hub-donate-group">
          <span className="hub-donate-label" id="donate-amount-label">
            Amount
          </span>
          <div className="hub-donate-chips" role="group" aria-labelledby="donate-amount-label">
            {DONATE_PRESETS.map((p) => (
              <button
                key={p.cents}
                type="button"
                className="hub-donate-chip hub-donate-chip-amount"
                aria-pressed={preset === p.cents}
                onClick={() => setPreset(p.cents)}
              >
                {p.label}
              </button>
            ))}
            <button
              type="button"
              className="hub-donate-chip hub-donate-chip-amount"
              aria-pressed={preset === CUSTOM}
              onClick={() => setPreset(CUSTOM)}
            >
              Custom
            </button>
          </div>
          {preset === CUSTOM && (
            <div className="hub-donate-custom">
              <label htmlFor="donate-custom-amount">Custom amount (USD)</label>
              <input
                id="donate-custom-amount"
                type="text"
                inputMode="decimal"
                placeholder="25.00"
                value={custom}
                onChange={(event) => {
                  setCustom(event.target.value);
                  setError('');
                }}
              />
            </div>
          )}
        </div>

        {error && (
          <p className="hub-donate-error" role="alert">
            {error}
          </p>
        )}

        <div className="hub-donate-btnwrap">
          {!live && (
            <span className="hub-donate-tag" aria-hidden="true">
              <span>Under Construction</span>
            </span>
          )}
          <button
            type="button"
            className="hub-donate-btn"
            disabled={!live || busy}
            onClick={donate}
          >
            {busy ? 'Opening Stripe…' : 'Donate'}
          </button>
        </div>
        <p className="hub-donate-helper">
          {live
            ? 'Secure checkout by Stripe.'
            : 'Donations open as soon as Stripe is hooked up — very soon.'}
        </p>
      </div>
    </section>
  );
}

export default function Hub() {
  return (
    <main className="hub-page">
      <section className="hub-lockup">
        <img className="lockup-img-builtby" src="/images/logo-builtby.svg" alt="824 — Built by BeastMode82420" />
      </section>
      <section className="hub-hero">
        <img
          src={HERO_ART}
          alt="BeastMode82420 emblem — Nicholas in Beast form"
          width="700"
          height="792"
        />
      </section>

      <section className="hub-feature" aria-labelledby="fwb-feature">
        <div className="hub-feature-card">
          <p className="hub-feature-eyebrow">The Keystone of 824</p>
          <h2 className="hub-feature-name" id="fwb-feature">
            Friends With Benefits
          </h2>
          <p className="hub-feature-pitch">
            Every friend comes with benefits — skills, intros, gigs, and good company.
          </p>
          <a
            className="hub-feature-cta"
            href={FWB_APP_URL}
            target="_blank"
            rel="noreferrer"
          >
            Enter Friends With Benefits
          </a>
          <p className="hub-feature-meta">
            Live now — launched November 2026 · Coming soon to the App Store &amp;
            Google Play
          </p>
        </div>
      </section>

      <nav className="hub-links" aria-label="Beastmode 82420 projects">
        {HUB_LINKS.map((link) => (
          <a
            key={link.label}
            className="hub-pill"
            href={link.href}
            target="_blank"
            rel="noreferrer"
          >
            {link.label}
          </a>
        ))}
      </nav>

      <section className="hub-about" aria-labelledby="about-824">
        <h2 className="section-title" id="about-824">
          About 824
        </h2>
        <p>
          824 is an applied AI company founded by Nicholas Smith. The name comes from
          August 24 — his wedding anniversary and his father&apos;s birthday — a date that
          stands for building things that last.
        </p>
        <p>
          The keystone of 824 is{' '}
          <a href={FWB_APP_URL} target="_blank" rel="noreferrer">
            Friends With Benefits
          </a>{' '}
          — an original social platform that brings professional networking, friends
          and community, video, and photo sharing together in one place. Built on
          React and Cloudflare, protected by 824 Shield, and launched in November
          2026 — with apps for the App Store and Google Play in progress.
        </p>
        <p>
          We build AI that earns its keep: 824 Shield, our AI-driven defense system;
          an enterprise code review engine that goes deep on everything from HTML5
          and React to Kubernetes, Terraform, and Azure DevOps — with human approval
          gates on every call; Shop 824, the 824 merchandise storefront; and the
          unofficial Muse AI app for Windows, because if the tool is good, it should
          run where you work.
        </p>
        <p>
          And watch this space:{' '}
          <a href={BANK_APP_URL} target="_blank" rel="noreferrer">
            824 Bank&trade;
          </a>{' '}
          — banking that knows your name, inspired by an idea from Nicholas&apos;s
          father — is live today in demo mode, with simulated balances while we
          build toward a licensed banking partner. When it fully launches, 824 Bank
          becomes our top product on beastmode82420.com.
        </p>
        <p>
          And because 824 thinks in machines as well as software: the Queen Victoria,
          our 824 Beastmode Concept prototype — a gloss-black widebody sedan on gold
          wheels, scissor doors up front, and a Kai-blue-stitched cockpit. Her
          showcase is below.
        </p>
        <p>
          No vaporware. No hype decks. Just applied intelligence — built bold, shipped
          for real.
        </p>
      </section>

      <section className="hub-concept" aria-labelledby="queen-victoria">
        <div className="hub-concept-card">
          <p className="hub-feature-eyebrow">The 824 Beastmode Concept</p>
          <h2 className="hub-concept-name" id="queen-victoria">
            Queen Victoria
          </h2>
          <p className="hub-concept-pitch">
            Our concept prototype — gloss black, gold wheels, scissor doors, and
            Kai blue running through the cockpit like a current.
          </p>
          <img
            className="hub-concept-img"
            src="/images/queen-victoria-exterior.svg"
            alt="824 Beastmode Concept — the Queen Victoria prototype exterior: gloss-black widebody sedan with gold wheels and scissor doors open, front and rear views"
            width="1206"
            height="679"
            loading="lazy"
          />
          <img
            className="hub-concept-img"
            src="/images/queen-victoria-interior.svg"
            alt="Inside Beastmode — the Queen Victoria cockpit with 824 touchscreen and Kai-blue ambient lighting, rear seats, and trunk with 824 bags and lacrosse sticks"
            width="1206"
            height="679"
            loading="lazy"
          />
        </div>
      </section>

      <DonateSection />
    </main>
  );
}
