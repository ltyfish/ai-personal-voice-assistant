# Dreative Design Doctrine

You MUST read this file before servicing any `propose-skeletons`, `propose-variants`,
`design-page`, or `edit-element` request, and run §12 before every respond. It exists
because LLM-designed UIs converge on one templated look. Every rule corrects a known
model default; none is a suggestion. Requests may carry a `plan` (Dreative's
pre-computed decision: dials, per-section layout families, budgets, lints) — execute
the plan, apply this doctrine to everything the plan doesn't specify. When
`plan.skills` names specialist skills (`motion`, `3d`, `interaction`), the matching
`skills/<name>.md` files extend this doctrine for that request — read them first;
where they go deeper than a section here, they win.

## 1. Register: the first decision

Every page is one of two registers. Misclassifying it is the biggest single error.

**BRAND** (design IS the product): landing pages, marketing, portfolios, campaign
pages, about pages, long-form content. Bar = distinctiveness. A visitor should ask
"how was this made?", not "which AI made this?". Average is no longer findable;
restraint without intent reads as mediocre. Go big or go home.

**PRODUCT** (design SERVES the product): app UI, dashboards, settings, tables, tools,
authenticated surfaces. Bar = earned familiarity. Would a user fluent in Linear,
Figma, Notion, Stripe trust this instantly, or pause at every subtly-off component?
Failure mode is not flatness, it is strangeness without purpose. The tool should
disappear into the task.

Pick by the page's job, not the project. One app can hold both registers.

## 2. The design read and the slop tests

Before generating, state a one-line read: "<page kind> for <audience>, <vibe>
language, leaning <aesthetic family>". If the request carries a `brief`, obey it —
it is the user's explicit direction.

Then run three tests on your intended output; restart if any fails:

1. **First-order reflex**: could someone guess your palette + theme from the category
   alone ("cookware → cream + brass", "devtool → dark + mono")? That's the
   training-data default. Rework. The three most-shipped default aesthetics: warm
   cream + high-contrast serif + terracotta accent; near-black + acid-green/vermilion;
   broadsheet hairline-rules-and-columns. Where the brief leaves an axis free, never
   spend that freedom on one of these.
2. **Second-order reflex**: could someone guess it from category + anti-reference
   ("fintech that's not navy → terminal-dark", "SaaS that's not cream → editorial
   serif + mono labels")? The trap one tier deeper. Rework again.
3. **Competitor sentence**: describe what you're about to build as a competitor would
   describe theirs. If the sentence fits the modal page in the category, restart.

### The working process: commit before code

Never design by accretion. Two passes:

1. **Commit** — before any code, write a compact spec: 4-6 named colors (hex/OKLCH),
   2+ type roles with actual font names, a one-sentence layout description per
   section, and ONE **signature element** — the single memorable move (an
   interaction, a typographic device, a composition) that carries the page's
   distinctiveness. Spend your boldness there; keep everything around it disciplined
   and quiet. Ground choices in the subject's world: its materials, instruments,
   artifacts, and vernacular ("a coffee brand's world: burlap, roast curves,
   thermometers, cupping notes") — not in web-design tropes.
2. **Review** — test the spec against the slop tests below. If any part could apply
   to any similar project, revise that part. Only then build.

**Hero thesis:** open with the most characteristic thing in the subject's world —
a headline, an image, a live demo, an interactive moment. Whatever form fits.

### Aesthetic presets (brief.aesthetic)

- `minimal` — Linear-clean: restrained neutrals, one accent, generous space.
- `editorial` — magazine: strong type hierarchy, asymmetric grid, real imagery.
  NOTE: editorial is ONE lane, not the default "tasteful" answer. The
  serif-italic + mono-labels + ruled-columns look is now saturated AI grammar.
- `premium` — confident type, rich imagery, refined motion, zero clutter.
- `playful` — bold committed color, springy motion, asymmetry, still disciplined.
- `brutalist` — raw 1px borders, mono, flat color, radius 0, no shadows/gradients.
- `dark-tech` — off-black surfaces, restrained neon, terminal cues used sparingly.
- `trust` — public-sector/regulated: symmetric, motion ≤2, maximum legibility.

### The three dials (1-10, resolved in `plan.dials`)

- `variance` — 1 symmetry → 10 masonry/offsets/20vw empty zones. >4 forbids the
  centered-hero default. Any asymmetry collapses to clean single-column < 768px.
- `motion` — 1 static → 10 scroll choreography. >3 requires reduced-motion fallbacks.
- `density` — 1 art-gallery (py-32+) → 10 cockpit (hairlines, tabular-nums, no cards).

## 3. Typography

**Font selection procedure (brand register, never skip):**
1. Write three physical-object brand-voice words ("warm, mechanical, opinionated" —
   never "modern" or "elegant").
2. List the three fonts you'd reach for by reflex. Reject any on the ban list below.
3. Pick for the brand as a physical object (museum caption, 1970s terminal manual,
   concert poster, mid-century receipt). Reject the first thing that "looks designy".
4. If the final pick matches the original reflex, start over.

**Reflex-reject fonts (training-data defaults, banned as defaults):** Fraunces,
Newsreader, Lora, Crimson (all), Playfair Display, Cormorant (all), Syne, IBM Plex
(all), Space Mono, Space Grotesk, Inter, DM Sans/Serif, Outfit, Plus Jakarta Sans,
Instrument Sans/Serif. Inter/system stacks ARE legitimate in the product register
and for trust briefs. When an existing app already uses one, identity-preservation
wins — keep it.

**Serif discipline:** "creative/premium brief = serif" is the most-tested AI tell.
Default is sans display. Serif only when the brief is genuinely editorial/luxury/
publication AND you can articulate why this serif fits this brand. Emphasis inside a
headline = italic/bold of the SAME family, never a serif word dropped into a sans
headline. Italic display words with descenders (y g j p q) need `leading-[1.1]`+ and
bottom padding reserve.

**Scale — pick by register:**
- Brand: fluid `clamp()` headings, ratio ≥1.25 between steps, clamp max ≤ 6rem and
  ≤ 2.5× its min. Display tracking floor −0.04em (tighter = letters touch).
- Product: fixed rem scale, ratio 1.125–1.2, one family in 3-4 weights is usually
  right. No fluid type in app UI — no major design system uses it.
- Both: body ≥ 16px and fixed; 45–75ch measure (`max-width: 65ch`); headings
  `text-wrap: balance`, prose `text-wrap: pretty`; ≤ 2-3 families total; never pair
  two similar sans — contrast on a real axis (serif+sans, geometric+humanist) or use
  one family.

**Details that read as craft:** line-height 1.1–1.2 headings, 1.5–1.7 body; ALL-CAPS
labels get `letter-spacing: 0.05–0.12em`; `tabular-nums` on data columns; vertical
rhythm = spacing in multiples of the body line-box (16px × 1.5 → 24px grid);
light-on-dark text compensates on three axes: +0.05–0.1 line-height, +0.01–0.02em
tracking, one weight step down (400→350 effect). `font-display: swap`, preload only
the critical weight, variable font when using 3+ weights.

## 4. Color

**Use OKLCH.** `oklch(L C H)` is perceptually uniform. Build ramps by holding
chroma+hue and varying lightness; reduce chroma near white/black. The hue is a brand
decision — never blue-250 or warm-60 by reflex.

**Pick a color strategy before picking colors:**
- **Restrained** — tinted neutrals + one accent ≤10% visual weight. Product floor.
- **Committed** — one saturated color carries 30-60% of the surface. Brand default
  for identity-driven pages.
- **Full palette** — 3-4 named roles used deliberately. Campaigns, data viz.
- **Drenched** — the surface IS the color. Brand heroes.

Name a real reference before committing ("Stripe purple-on-white restraint", "Klim
#ff4500 drench", "Vercel pure-black monochrome"). Unnamed ambition becomes beige.
On brand surfaces, palette IS voice — don't hedge a Committed palette with neutral
edges. On product surfaces, accent = primary action + selection + state, never
decoration, with a full semantic state vocabulary (hover/focus/active/disabled/
selected/loading/error/warning/success/info) and a second neutral layer for
sidebars/panels.

**Mechanics:**
- Tinted neutrals: chroma 0.005–0.015 toward THIS brand's hue. Pure gray is dead;
  reflex-warm or reflex-cool tinting is the monoculture move.
- 60-30-10 by visual weight: 60% neutral surface, 30% text/borders, 10% accent.
  Accents work because they are rare.
- One accent, one neutral family, locked page-wide and project-wide. No blue CTA
  appearing in section 7 of a warm-gray page.
- Contrast: body 4.5:1 (AAA 7:1 target for hero copy), large text 3:1, UI components
  3:1, placeholders 4.5:1. Gray text on colored backgrounds looks washed out — use a
  darker shade of the background's own hue or alpha of the text color. Audit every
  CTA and form before responding.
- No pure #000/#fff. Dark mode is not inverted light mode: depth from a 3-step
  surface-lightness scale (≈15/20/25% L, brand hue, chroma constant), desaturate
  accents slightly, reduce body weight. Redefine only semantic tokens for dark.
- Heavy alpha usage = incomplete palette. Define explicit overlay colors.

**Banned palettes as default reaches:** AI-purple/violet gradients + glow; the
premium-artisan cream/sand/beige bg (#f5f1ea family, OKLCH L .84-.97 C<.06 hue
40-100) + brass/clay/oxblood accents + espresso text — token names like --cream,
--sand, --bone are tells in themselves. Alternatives to rotate: cold luxury
(silver/chrome/smoke), forest + bone + amber, true black + tan, cobalt + cream,
terracotta + slate, olive + brick + paper, monochrome + one saturated pop. "Warmth"
is carried by accent, type, and imagery — not by a beige body background.
Override: a palette is fine when the existing brand or explicit brief names it.
When redesigning an extracted app, its `theme` colors are the brand — preserve.

## 5. Layout

**Hard rules (failing any = broken work):**
- Hero fits the initial viewport: headline ≤ 2 lines, subtext ≤ 20 words, CTA visible
  without scroll, top padding ≤ pt-24. 4-line headline is a font-size error. Max 4
  text elements (one eyebrow OR brand strip, headline, subtext, CTAs 1+1). Trust
  strips, pricing teasers, feature bullets, avatar rows: all move below the hero.
- Hero needs a real visual. Text + gradient blob is a placeholder, not a hero.
- variance > 4 forbids centered-hero-over-gradient: split 50/50, left-content/
  right-asset, or asymmetric whitespace. Centered is fine for manifesto/launch copy.
- Nav: one line at desktop, height 64–72px (cap 80px).
- A layout family appears at most ONCE per page; 8 sections need ≥ 4 families. Max 2
  consecutive image+text zigzags. No 3-identical-cards row, ever — asymmetric grid,
  2-col, bento, or horizontal scroll instead.
- Bento: exactly as many cells as content (no filler tiles); 2-3 cells carry real
  visual variation (image/tint/pattern), never all white-on-white text.
- Cards only when elevation = hierarchy; otherwise border-t/divide-y/whitespace.
  Nested cards are always wrong. Tint shadows to the background hue.
- Lists > 5 items: group into chunks, 2-col card grid, tabs, or marquee — never one
  hairline-divided stack, never border-t AND border-b per row.
- Split-header pattern (big left headline + small floating right paragraph) banned
  as default; stack vertically at 65ch.
- Grid over flex-math (`grid-cols-3 gap-6`, never `w-[calc(33%-1rem)]`);
  `repeat(auto-fit, minmax(280px, 1fr))` for breakpoint-free card grids;
  `min-h-[100dvh]` never `h-screen`; explicit mobile collapse per section; contain
  at `max-w-7xl mx-auto`; semantic z-index scale, no z-[999].
- ONE radius system: all-sharp, all-soft (12-16px), or documented mixed rule
  ("buttons pill, cards 16, inputs 8"). Cards never above 16px radius.
- Spacing has rhythm: vary generous separations against tight groupings on a
  consistent base unit; brand surfaces use fluid `clamp()` spacing that breathes.
- Structure encodes truth, never decoration: numbering, eyebrows, dividers, and
  labels appear only when they say something true about the content (a real
  sequence, a real category). If removing the device loses nothing, remove it.
- Product register: responsive behavior is structural (collapse sidebar, responsive
  table), not fluid type.

## 6. Motion

Every animation answers "what does this communicate?" — hierarchy, storytelling,
feedback, or state change. "It looked cool" = delete it.

**The 100/300/500 rule:** 100-150ms instant feedback (press, toggle) · 200-300ms
state changes (menu, tooltip, hover) · 300-500ms layout changes (accordion, modal)
· 500-800ms entrances (hero reveal, brand only). Exits run ~75% of enter duration.
Feedback over 500ms feels laggy. Micro-interactions target the 80ms "feels instant"
threshold.

**Easing:** ease-out exponential only — `cubic-bezier(0.25,1,0.5,1)` quart,
`cubic-bezier(0.22,1,0.36,1)` quint, `cubic-bezier(0.16,1,0.3,1)` expo. Bounce and
elastic are dated; banned.

**Register:** brand = one well-orchestrated hero entrance beats scattered
micro-interactions; the uniform fade-and-rise on every scrolled section is the
saturated AI tell. Some brands skip entrance motion entirely — restraint as voice.
Product = 150-250ms, state-conveying only, zero page-load choreography.

**Mechanics:** animate transform/opacity by default; blur/backdrop-filter/clip-path/
masks/shadow allowed when they materially improve the effect, bounded to small areas,
verified smooth. Never casually animate width/height/top/left/margins (use FLIP or
grid-template-rows). Sibling stagger `calc(var(--i) * 50ms)` capped at ~500ms total.
IntersectionObserver (unobserve after firing), CSS scroll-driven animations, or
Motion/GSAP scroll tools — `window.addEventListener("scroll")` is a hard ban. Reveals
enhance an already-visible default; never gate content visibility on a JS-triggered
class (hidden tabs and headless renderers ship blank sections). Max one marquee per
page. `prefers-reduced-motion: reduce` alternative for everything. Optimistic UI for
low-stakes actions; never for payments or destructive ops.

## 7. Imagery

When the brief implies imagery (restaurant, hotel, product, travel, fashion,
portfolio), zero images is a bug, not restraint. Even a minimalist page needs 2-3
real images. Priority: (1) image-gen tool if available in your environment, at the
section's aspect ratio; (2) real photography —
`https://picsum.photos/seed/<descriptive-seed>/<w>/<h>` always resolves; Unsplash
only with verified photo IDs (guessed IDs 404 into broken placeholders); (3)
clearly-labeled placeholder slots + tell the user what's needed. Search for the
brand's physical object ("hand-cut pasta on a scratched wooden table"), not the
category ("Italian food"). One decisive photo beats five mediocre ones. Alt text
carries voice.

Banned: div-built fake screenshots/terminals/dashboards (the #1 AI tell), hand-drawn
"sketchy" SVG illustrations, `feTurbulence` paper-grain, repeating-gradient stripe
backgrounds, decorative grid-line overlays, hand-rolled icon paths. Icons from ONE
library (Phosphor/Radix/Tabler/HugeIcons; Lucide only on request), one strokeWidth
globally. Logo walls: real SVG marks (`https://cdn.simpleicons.org/<slug>`) or
generated monograms — logos only, no category captions, below the hero.

## 8. Content and copy

≤ 8-word section headlines, ≤ 25-word subtext, one copy register per page, quotes
≤ 3 lines with name + role attribution. No filler verbs (elevate, seamless, unleash,
revolutionize). No fake-precise numbers unless real or labeled mock; use believable
messy data ("47.2%", not "99.99%"). No "Jane Doe"/"Acme"/generic avatars — realistic
locale-appropriate names, credible invented brands. Re-read every visible string
before responding; rewrite anything grammatically broken, cutely meta, or
performative-craftsman ("From the field", "We respect the French ones"). Plain
beats clever. Data-dump tables on marketing pages → top 3-5 + "view all".

**UX writing:** write from the user's side of the screen — name things by what
people control and recognize, never by how the system is built. Active voice ("Save
changes", not "Submit"). Action names stay consistent through the flow (button
"Publish" → toast "Published"). Errors and empty states are direction, not mood:
say what happened and what to do next; never apologize vaguely. Sentence case,
plain verbs, no filler.

## 9. States and interaction (product floor)

Every interactive component ships default/hover/focus/active/disabled/loading/error.
Skeletons shaped like the final layout, not centered spinners. Empty states teach
the interface. Errors inline for forms, toasts only for transient events. Labels
above inputs; placeholder-as-label never; helper text present. `:active` gives
tactile press (`scale-[0.98]`). Same button shape, form vocabulary, and icon style
on every screen — if "save" looks different in two places, one is wrong. Modals are
usually laziness; exhaust inline/progressive first. Dropdowns escape
overflow-hidden ancestors via popover API/position-fixed/portal. Touch targets
≥ 44px. Never disable zoom.

## 10. Banned AI tells (match-and-refuse)

- **Em-dash (—) and en-dash separators (–): zero anywhere visible.** Periods,
  commas, colons, plain hyphens.
- Eyebrow kickers (small caps tracked labels above headings) on every section — max
  1 per 3 sections, and only as a deliberate system. Numbered section markers
  (`01 · About`) unless the content is a real sequence.
- Side-stripe borders (border-left > 1px as accent) — full hairline border, 4-8%
  background tint, or leading glyph instead.
- Gradient text (background-clip). Glassmorphism as default. Hero-metric template
  (big number + label + gradient accent). Identical icon+heading+text card grids.
- 1px border + soft ≥16px drop shadow on the same element ("ghost card") — pick one.
- Hero version labels (BETA, V0.6), scroll cues ("↓ scroll to explore"),
  locale/weather strips, decoration strips (`DESIGN · BUILD · SHIP`), vertical
  rotated text, custom cursors, decorative status dots, pills overlaid on photos,
  fake photo credits, version footers on marketing pages, "Quietly trusted by".
- Duplicate CTA intent: one label per intent per page ("Get in touch" + "Let's
  talk" = fail). CTA labels never wrap at desktop; 1-3 words.
- Middle-dot separators rationed to 1 per line. Never hover-scale on `<img>`
  elements (animate the card's border/background/shadow instead).
- Headline text that overflows its container at any breakpoint — test the actual
  copy; the viewport is part of the design.

## 11. Redesign and preservation (extracted apps)

Dreative pages usually come FROM a real app. Detect the mode: preserve (evolve the
existing brand) vs overhaul (new language, same content/IA). When preserving: keep
route slugs, nav labels, form field names, logo, legal copy; extract brand tokens
before applying §4 (a purple brand stays purple); apply modernisation levers in
order — typography → spacing/rhythm → color recalibration → motion layer → hero
recomposition → full replacement only when unsalvageable. Honor existing
accessibility wins and analytics hooks. Preserve prior element-level edits when
`previousFile` is set.

## 12. Pre-flight checklist (run before EVERY respond)

Mentally verify; fix failures, then respond. If a box cannot be honestly ticked,
the output is not done.

0. Commit pass done: named palette, named fonts, one signature element, subject-
   grounded. The quality floor (responsive to mobile, visible keyboard focus,
   reduced motion) is built silently — never announced in copy or comments.
1. Register named (brand/product); design read stated; brief and plan obeyed.
2. All three slop tests pass (first-order, second-order, competitor sentence).
3. Zero em/en-dashes visible. Zero banned tells from §10.
4. One accent + one tinted-neutral family + one theme + one radius system + one
   icon family, locked page-wide; matches sibling pages of this project.
5. Fonts: not on the reflex-reject list (or justified by existing brand); scale
   ratio committed; body ≥16px at 45-75ch; caps tracked; data tabular.
6. Every CTA/form/placeholder passes WCAG AA; no CTA wraps; no duplicate CTA intent.
7. Hero: ≤2-line headline, ≤20-word subtext, ≤4 elements, real visual, CTA above
   fold; centered only if variance ≤ 4 or manifesto brief.
8. Eyebrows ≤ ceil(sections/3); no two sections share a layout family; ≤2
   consecutive zigzags; no 3-identical-cards; bento cells = content count.
9. Real images or labeled slots; no div fake-screenshots; no sketchy SVG; logos are
   real marks.
10. Motion: each animation justified in one sentence; durations per 100/300/500;
    ease-out curves; exits faster; reduced-motion safe; content visible without JS;
    ≤1 marquee; no scroll-listener.
11. States complete (loading/empty/error/disabled); labels above inputs; tactile
    :active.
12. Mobile collapse explicit; 100dvh; no text overflow at any breakpoint; semantic
    z-index.
13. Copy self-audit done: no broken/AI-cute strings, realistic data, one register.
14. Every block id from the layout appears as `data-dreative-id` (design-page only).
15. Dark mode (when in scope): semantic-token swap, surface-lightness depth,
    desaturated accents, tested both modes.
