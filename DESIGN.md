---
version: alpha
name: NEAR Rehearsal
description: A local, consequence-first interface for reproducing a Sputnik DAO obligation, repairing pinned source, and reviewing the resulting evidence.
colors:
  background: "#101312"
  panel: "#171b19"
  line: "#2b322f"
  text: "#edf2ef"
  muted: "#9aa7a0"
  primary: "#65d39a"
  red: "#ff7b72"
  amber: "#e8bd69"
  blue: "#85b8ff"
typography:
  body:
    fontFamily: Inter
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.45
  h1:
    fontFamily: Inter
    fontSize: 22px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: -0.02em
  h2:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.2
  h3:
    fontFamily: Inter
    fontSize: 17px
    fontWeight: 700
    lineHeight: 1.3
  label:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: 0.12em
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.45
spacing:
  shell: 24px
  grid: 20px
  panel: 18px
  card: 12px
  control: 10px
rounded:
  panel: 16px
  card: 12px
  control: 10px
  pill: 999px
components:
  primary-button:
    backgroundColor: "{colors.primary}"
    textColor: "#07130d"
    height: "44px"
    rounded: "{rounded.control}"
    typography: "{typography.body}"
  secondary-button:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    height: "44px"
    rounded: "{rounded.control}"
  panel:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.panel}"
  status-pill:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
  consequence-card:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.card}"
  danger-status:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.red}"
    rounded: "{rounded.pill}"
  warning-status:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.amber}"
    rounded: "{rounded.pill}"
  technical-link:
    textColor: "{colors.blue}"
  divider:
    backgroundColor: "{colors.line}"
    height: "1px"
    width: "100%"
---

## Overview

NEAR Rehearsal is a local review surface for one supported Sputnik DAO v2 obligation. The first task is to show the money consequence before the technical evidence: the failed async proposal retains a 1 NEAR bond, a generated source repair returns it without a second refund, and the healthy 0.1 NEAR Transfer still pays the declared recipient. The interface is deliberately dark, compact and evidence-led; it should feel like an operator's local console, not a public product dashboard or a live custody screen.

The root `/` is the maintainer front door: it names the supported stranded proposal-bond problem and offers two clear actions, **Generate a fresh repair** at `/repair` and **Independently review a repair** at `/review`. The older authored three-branch comparison is available at `/compare`; `/index.html` remains a legacy alias of that comparison.

The `/repair` route reuses the existing Sputnik app shell and adds a single supported repair journey. Every accepted result names the boundary in plain language: this is a local reproduction from pinned upstream source, not a live DAO, a public-state migration, an audit or production approval.

The `/review` route is the reviewer-facing handoff for a downloaded repair bundle. It verifies the bundle before starting either a source build or a recorded-WASM replay, shows the money and preservation checks, keeps addressable history and offers distinct input, evidence and sanitized result downloads only after acceptance. It does not call a model.

## Colors

The palette comes from the existing `ui/sputnik/public/styles.css` variables.

- **Background `#101312`** is the page canvas, with a low green radial wash from the existing shell.
- **Panel `#171b19`** carries setup, evidence and result surfaces; **line `#2b322f`** is the standard border.
- **Text `#edf2ef`** is primary copy; **muted `#9aa7a0`** carries labels, provenance and supporting detail.
- **Primary green `#65d39a`** is the single action and accepted/positive signal. It is used for the primary button, accepted checks and the saved/preserved evidence.
- **Red `#ff7b72`** marks rejected, failed or unsafe outcomes; **amber `#e8bd69`** marks an active phase or an honest warning. **Blue `#85b8ff`** remains available for neutral technical links.
- Semantic colour is never the only signal: each consequence card and status chip also carries a word and a readable sentence.

## Typography

The existing app uses Inter with a system-sans fallback; figures, hashes and receipt references use the existing monospace stack. Body copy is 15px/1.45. Headings are bold and compact, with `h1` at 22px and negative tracking; `h2` is 24px and `h3` is 17px. The small uppercase labels use the existing 11px, 700-weight, 0.12em treatment. Keep hashes, run IDs and transaction references in tabular monospace rather than body type.

## Layout

The `/repair` page uses the existing two-column shell: a 360px setup column and a flexible workspace, stacking at 980px. The setup column keeps the single case, pinned source revision, money obligation and the one primary action visible before technical detail. The workspace leads with an empty explanation, then a four-step actual-phase rail, then the result. The result order is consequence cards, a separate gas note, the readable source diff, then expandable evidence and replay reports.

No made-up percentage or timer is used as progress. Elapsed time is measured from the run's `startedAt`; the current phase is the phase the job actually reports. Controls are at least 44px tall, the narrow layout stacks cards and download actions, and the long diff and JSON areas scroll inside their own containers. The existing dark shell, `.panel`, `.primary`, `.secondary`, `.status-pill`, `.eyebrow` and `.badge` classes are reused.

## Components

Use native buttons, labels, selects and `<details>` elements. The primary action starts one fresh run; it is disabled while that run is active. A run's history is a list of real run IDs, not a fabricated demo. The patch download is a direct link to the canonical patch generated by the controller; the review bundle is offered only after an accepted run. A rejected or unavailable run may retain diagnostics and a generated patch, but it must not offer an accepted bundle.

The consequence cards must lead with the observed money: baseline contract delta, candidate contract delta, retry behavior and healthy recipient payout. Gas is shown separately from returned principal. The evidence disclosure may be technical, but it sits after the consequence and uses the recorded reports rather than a cached narrative.

## Do's and Don'ts

Do keep the supported case, pinned commit, source file, bond amount, recipient and healthy Transfer visible in context. Do show fresh reproduction, one model generation, build, replay and acceptance as separate phases with truthful terminal states. Do preserve completed runs across refresh and server restart, mark interrupted work as interrupted, and keep older run IDs addressable. Do keep the browser free of credentials, arbitrary host paths and model configuration.

Don't describe the result as repairing a live DAO, a public-state migration or arbitrary contracts. Don't substitute a committed report or authored patch for the fresh run. Don't mark a model, build or runtime failure accepted. Don't offer a review bundle from a non-accepted run, and don't expose account runtime files or absolute machine paths in a download. Don't add animation, a new framework, decorative charts or a second product track; the reduced-motion rule in `repair.css` removes the only operational pulse.
