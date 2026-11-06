// The Beastmode 82420 brand hub — route "/".
//
// Structure (owner-directed, built to be re-skinned/re-arted without
// restructuring):
//   1. Hero artwork — a single <img> (/images/logo-hero.svg), the
//      Beast Gohan emblem the owner supplied on 2026-11-01 (replacing
//      the original stadium banner). It sits centered at a constrained
//      width (.hub-hero); its black surround blends into the page.
//      The buttons below are real HTML links.
//   2. The keystone feature block — Friends With Benefits, the
//      flagship product, spotlit in a black feature card directly
//      under the hero (owner direction 2026-11-05).
//   3. The pill link row — real pill buttons centered under the
//      feature block, styled to match the artwork (gold outline,
//      black fill, gold text). In the owner's order.
//   4. About 824 — the owner's company blurb below the links, led by
//      Friends With Benefits as the keystone product.

const HERO_ART = '/images/logo-hero.svg';

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

export default function Hub() {
  return (
    <main className="hub-page">
      <section className="hub-lockup">
        <img className="lockup-img-builtby" src="/images/logo-builtby.svg" alt="824 — Built by BeastMode82420" />
      </section>
      <section className="hub-hero">
        <img
          src={HERO_ART}
          alt="Beastmode 82420 — Beast Gohan emblem"
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
    </main>
  );
}
