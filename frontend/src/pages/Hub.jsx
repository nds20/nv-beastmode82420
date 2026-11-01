// The Beastmode 82420 brand hub — route "/".
//
// Structure (owner-directed, built to be re-skinned/re-arted without
// restructuring):
//   1. Hero artwork — a single <img> (/images/hero-art.svg). The owner
//      may send an updated front-page image; swap the file (or the
//      HERO_ART src) and nothing else changes. The baked-in buttons in
//      the original artwork are cropped off on purpose: the buttons
//      below are real HTML links.
//   2. The pill link row — real pill buttons centered under the hero,
//      styled to match the artwork (gold outline, black fill, gold
//      text). Exactly five, in the owner's order.
//   3. About 824 — the owner's company blurb, verbatim, below the
//      links.

const HERO_ART = '/images/hero-art.svg';

const HUB_LINKS = [
  { label: 'LinkedIn', href: 'https://www.LinkedIn.com/in/beastmode82420' },
  { label: 'Biometric Screening Research', href: 'https://github.com/nds20/nv-genomic-trial-match' },
  { label: '824 Shield', href: 'https://github.com/nds20/824-shield' },
  { label: 'Smoke Shop', href: 'https://github.com/nds20/nv-beastmode82420' },
  { label: 'Unofficial Muse AI for Windows', href: 'https://github.com/nds20/nv-unofficial-MuseAI-windows-app' },
];

export default function Hub() {
  return (
    <main>
      <section className="hub-hero">
        <img
          src={HERO_ART}
          alt="Beastmode 82420 — Beast Gohan logo over a black and gold stadium"
          width="1206"
          height="690"
        />
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
          We build AI that earns its keep: AI-driven defense systems, a regulated
          dispensary ordering platform, and an enterprise code review engine that goes
          deep on everything from HTML5 and React to Kubernetes, Terraform, and Azure
          DevOps — with human approval gates on every call. We also ship the unofficial
          Muse AI app for Windows, because if the tool is good, it should run where
          you work.
        </p>
        <p>
          No vaporware. No hype decks. Just applied intelligence — built bold, shipped
          for real.
        </p>
      </section>
    </main>
  );
}
