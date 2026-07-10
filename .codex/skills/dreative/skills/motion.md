# Dreative Specialist Skill — Motion & Scroll Choreography

Load this file when `plan.skills` includes `motion`, or the brief/prompt asks for
animation, parallax, scroll storytelling, kinetic type, or "cinematic" feel.
It EXTENDS DESIGN.md §6 (which still applies: 100/300/500 durations, ease-out
exponential curves, reduced-motion fallbacks, no scroll listeners, no bounce).
This file is about doing ambitious motion WELL, not about adding more of it.

## 0. Pick the tool by the job, not by habit

- **CSS only** — hover/focus/press states, one-shot entrances, marquees, simple
  scroll reveals via `animation-timeline: view()`. Zero JS cost; always first choice.
- **Motion (`motion/react`, formerly Framer Motion)** — React apps: presence
  (`AnimatePresence`), layout animation (`layout` prop = free FLIP), springs,
  `whileInView`, gesture props. The default for React product+brand pages.
- **GSAP + ScrollTrigger** — timeline choreography: multiple elements coordinated
  over one scroll range, scrubbed sequences, pinned sections, kinetic type.
  Use when a Motion version would need 4+ manually-synced `useScroll` hooks.
- **Lenis** — smooth scroll wrapper for scroll-driven brand pages. Only on brand
  register with motion dial ≥7; never in product UI. Sync ScrollTrigger with
  `lenis.on('scroll', ScrollTrigger.update)`.

One animation system per page. Motion AND GSAP on the same page = two spring
vocabularies fighting; pick one and commit.

## 1. Springs beat durations for anything interactive

Duration+easing is for one-shot choreography (entrances, exits). Anything that
tracks input or can be interrupted (drag, hover follow, toggles, layout shifts)
uses springs — they redirect mid-flight without a visible restart.

- Motion defaults: `{ type: "spring", stiffness: 300, damping: 30 }` = snappy UI;
  `stiffness: 120, damping: 20` = soft brand movement. Overshoot (`damping < 15`)
  only on playful briefs, and only on small elements — never on layout.
- `visualDuration` (Motion ≥11.13) sets spring feel by time: easier to reason about.
- Never spring opacity or color; springs are for transform. Crossfade those.

## 2. Orchestration: one timeline, one story

The scattered-reveals look (every section fades up independently) is the #1 motion
tell. Instead:

- **Hero entrance** = ONE composed sequence: parent `staggerChildren: 0.08`,
  `delayChildren` after nav settles; elements enter in reading order; total ≤ 900ms.
  Nothing else on the page gets entrance choreography.
- **Below the fold**: at most 2-3 sections get `whileInView` reveals (`once: true`,
  `margin: "-20% 0px"`), and they should differ (a clip reveal here, a stagger
  there) — not the same fade-and-rise stamped on everything.
- Stagger direction carries meaning: top-down for lists, center-out for grids
  (`delay: Math.abs(i - mid) * 0.05`), left-right only for horizontal sequences.
- Exits are faster than entrances (~75%) and simpler (fade + small offset; never
  reverse the full entrance).

## 3. Scroll choreography (motion dial ≥ 7)

- **Scrub vs trigger**: scrub (`scrub: 0.5–1` or Motion `useScroll`+`useTransform`)
  for progress-bound narrative (a product rotating, a number counting, a diagram
  assembling). Triggered one-shots for everything else. Scrubbed text reveals are
  worn out; scrub things that MOVE, trigger things that APPEAR.
- **Pinning**: max ONE pinned sequence per page (`ScrollTrigger pin: true`, or
  `position: sticky` + a tall parent — prefer sticky, it's free and un-janks).
  Pin length ≤ 2.5 viewport heights; past that users feel trapped.
- **Parallax**: subtle = 8-15% differential (`useTransform(scrollYProgress, [0,1],
  ["-8%","8%"])`); apply to media/decoration, never body text. 2-3 layers max.
- **CSS scroll-driven animations** (`animation-timeline: view(); animation-range:
  entry 0% cover 40%`) handle simple reveals/parallax with zero JS — use for
  progressive enhancement, gate with `@supports (animation-timeline: view())`.
- Progress-linked values snap to keyframes users can feel: use eased ranges
  (`useTransform` with cubic arrays), not raw linear mapping.
- Never scroll-jack (hijacking wheel delta into slide-snapping). `scroll-snap` on
  a horizontal strip is fine; taking over vertical page scroll is not.

## 4. Kinetic type and text reveal

- Split text with `SplitText` (GSAP, now free) or manual word-`<span>` wrapping;
  animate **words or lines, not characters** for readability (chars only for short
  display words ≤ 12 chars). Wrap split parents in `overflow-hidden` line masks and
  slide lines up `y: "110%" → 0` — the line-mask reveal reads as premium; per-char
  fade reads as 2021 template.
- `aria-label` the original string on the split container; split spans get
  `aria-hidden`. Re-splitting on resize: debounce, or use `SplitText`'s autoSplit.
- Counters: animate with `useSpring`/gsap `snap: 1`, `tabular-nums` mandatory,
  duration ≤ 1.2s, trigger once in view.

## 5. Layout & presence

- Motion `layout` prop for reflow (filtering grids, expanding cards, reordering) —
  it's FLIP under the hood, transform-only. `layoutId` for shared-element morphs
  (card → modal). Wrap conditional trees in `AnimatePresence mode="popLayout"`.
- Accordion/height: `grid-template-rows: 0fr → 1fr` (CSS, cheap) or Motion
  `height: "auto"` (it measures for you). Never `max-height: 9999px`.
- **View Transitions API** for page-level transitions (`document.startViewTransition`,
  or the framework wrapper e.g. Next `<ViewTransition>`): name persistent elements
  with `view-transition-name` so they morph across routes. Feature-gate; fall back
  to instant navigation, not a JS fade.

## 6. Performance and accessibility (non-negotiable)

- Transform/opacity only in hot paths; promote animating layers sparingly
  (`will-change` set just-in-time, removed after). > 6 simultaneously-animating
  elements = re-choreograph.
- All scroll work driven by IntersectionObserver / ScrollTrigger / `useScroll`
  (rAF-batched) — a raw `scroll` listener is a hard ban (DESIGN.md).
- Test the tab hidden→visible case: loops must not accumulate; `whileInView` must
  not re-fire (`once: true`).
- `prefers-reduced-motion`: scrubbed narratives get a static end-state, entrances
  become plain fades ≤ 200ms, marquees stop. In Motion use `useReducedMotion()`
  and branch the variants — don't just shorten durations.
- Content exists without JS: initial styles are the VISIBLE state; animation
  libraries then hide/offset from JS before first paint (`gsap.set`, Motion
  `initial`). An SSR'd page must never flash-then-hide.

## 7. Recipes (copy the shape, restyle the skin)

- **Hero sequence**: nav fades in (150ms) → headline lines mask-slide up, 80ms
  stagger → subtext + CTA fade-rise together → hero media scales 1.04→1 with 6px
  blur→0. Total 900ms, expo-out.
- **Sticky product walkthrough**: `sticky` media column + scrolling step copy;
  step index from IntersectionObserver on copy blocks; media crossfades/transforms
  per step (springy, 300ms).
- **Marquee**: duplicated track, `animation: scroll Xs linear infinite`,
  `width: max-content`, pause on hover, speed from content width (px/s constant,
  ~60-90px/s), masked edges with `mask-image: linear-gradient`.
- **Scrub showcase**: sticky canvas/image sequence, `useScroll` on the wrapper,
  map progress to frame index / rotation; preload frames; ≤ 2.5 viewports tall.
