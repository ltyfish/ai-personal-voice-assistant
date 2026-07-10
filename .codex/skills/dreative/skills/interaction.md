# Dreative Specialist Skill — Micro-interactions & Effect Craft

Load this file when `plan.skills` includes `interaction`, or the brief/prompt asks
for hover effects, cursor work, tilt, glow, "make it feel alive/tactile/premium".
It EXTENDS DESIGN.md §6/§9/§10 — every ban there still stands (no hover-scale on
`<img>`, custom cursors only on explicit request, one marquee max). This skill is
about the last 5% of feel: small, physical, consistent responses to input.

## 0. The feel system

Micro-interactions are a SYSTEM, not garnish. Before adding any, fix three global
constants and apply them everywhere: one hover response vocabulary, one press
response, one focus style. A page where every card hovers differently reads as
assembled, not designed.

- **Press** (all clickables): `active:scale-[0.98]` (buttons) or
  `active:scale-[0.99]` (large cards) + 100ms ease-out. This single rule adds more
  perceived quality per byte than anything else in this file.
- **Hover** (pick ONE per element class): background tint shift, border-color
  lift, shadow deepen (tinted to bg hue), or underline draw. 150-200ms.
- **Focus**: `:focus-visible` ring, 2px, offset 2px, accent color — identical on
  every interactive element, never removed.
- Everything targets the 80ms "feels instant" threshold for input feedback.

## 1. Pointer-tracking effects (the premium tier)

All pointer tracking is springs/damping (Motion `useSpring` on `useMotionValue`,
or lerp in rAF: `x += (target - x) * 0.12`) — raw 1:1 tracking feels robotic.
Desktop-only: gate behind `@media (hover: hover) and (pointer: fine)`; touch gets
the static design, not a broken half-effect. All of these are decoration — cap at
1-2 distinct pointer effects per page, on the signature element's territory.

- **Magnetic elements**: on pointer-move within a proximity zone, translate the
  element toward the cursor at 15-25% of offset (buttons) with the LABEL moving
  a further ~10% for parallax depth; spring back on leave
  (`stiffness 150, damping 15`). Reserve for 1-2 primary CTAs or nav items.
- **Spotlight cards**: radial-gradient that follows the pointer —
  `background: radial-gradient(240px circle at var(--x) var(--y),
  <accent 6-10% alpha>, transparent 65%)` on an overlay div; update CSS vars in
  rAF. For grids, track on the CONTAINER and light borders of all cards from one
  listener (the Aceternity/Linear look). Alpha ≤ 0.1; visible-but-subtle.
- **3D tilt**: perspective 800-1000px, max tilt 4-8° (10°+ is 2015 flash),
  computed from pointer offset to card center, damped; add a moving specular
  `linear-gradient` highlight at low alpha for material realism. Cards with text:
  ≤ 5° or readability suffers.
- **Image distortion / lens effects** need WebGL — that's `skills/3d.md` §4
  territory; don't fake them with CSS filters.

## 2. Hover reveals and state morphs

- **Underline draw**: `background-image: linear-gradient(accent, accent)` sized
  `0% 1.5px → 100% 1.5px` on hover, 250ms expo-out, origin left. The correct link
  hover for editorial registers.
- **Text swap/scramble**: label slides up revealing a duplicate from below
  (wrap in `overflow-hidden`, translateY both spans). Scramble/decode effects
  only on dark-tech/playful briefs, ≤ 600ms, never on body copy.
- **Card reveals**: secondary info (arrow, meta row, CTA) slides/fades in ON TOP
  of a stable layout — the card must never change size on hover (layout shift =
  amateur tell). Arrows translate 2-4px on hover (`group-hover:translate-x-1`),
  they don't appear from nothing.
- **Icon morphs**: hamburger↔close, play↔pause as two-path SVG morphs or rotated
  strokes, 200ms. Icons that rotate/bounce on every hover = noise; icons respond
  only when the response means something (chevron rotates because the section
  opened).
- Checkbox/toggle/radio: hand-styled with an SVG check that draws in
  (`stroke-dashoffset` 200ms) — the native-looking-but-smoother tier. Toggles
  slide with a spring, thumb squashes slightly at rest ends.

## 3. Surface effects (no pointer needed)

- **Glow borders**: `conic-gradient` rotating behind a masked 1px border
  (`@property --angle` + animation, or padding-box/border-box double background).
  One element per page, dark surfaces only, accent-hued — this is a signature
  move, not a card default.
- **Border beam / tracer**: an accent segment orbiting a card border via
  `offset-path: border-box` (or rect()) — same rationing as glow.
- **Gradient shift**: oversized `background-size: 200%` + position animation on
  a CTA, ≤ 2 hues from the palette. Never on text (gradient text is banned).
- **Noise/grain**: a tiled 128px PNG/data-URI at 2-4% opacity as a fixed overlay
  can kill flat-gradient banding on brand pages; `feTurbulence` inline SVG is
  banned (DESIGN.md §7) — use a pre-baked texture.
- **Blend modes**: `mix-blend-mode: difference` for text crossing light/dark
  boundaries (fixed nav over sections); `multiply/screen` to sit imagery into
  tinted surfaces. Test in both themes; blend modes are the #1 source of
  invisible-text bugs.
- Shadows that feel physical: 2-3 stacked layers, tinted to the background hue,
  y-offset ≈ blur/2 (`0 1px 2px, 0 4px 8px, 0 16px 32px` at descending alpha).
  One elevation scale page-wide.

## 4. Scroll-adjacent feel

(Choreography lives in `skills/motion.md`; these are ambient behaviors.)

- **Sticky nav transform**: past ~80px scroll, nav gains blur backdrop
  (`backdrop-blur-md` + bg at 70-85% alpha + hairline border-b), height eases
  72→60px. Drive from IntersectionObserver on a sentinel, not scroll position.
- **Scroll progress**: thin accent bar (2px) via `scroll-timeline` /
  `animation-timeline: scroll()`, CSS-only. Long-form articles only.
- **Hide-on-scroll-down nav**: product register only, translate ±100% with 300ms
  ease, 8px hysteresis so it doesn't flicker.

## 5. Feedback micro-moments (product register)

- Button loading: label crossfades to spinner INSIDE the button at fixed width
  (measure or `min-w`), never a layout jump; success flashes a check 600ms before
  reverting.
- Copy-to-clipboard: icon morphs to check + 1.2s revert; optional 150ms
  background pulse. No toast for copy.
- Form errors: input border→error color + one 4px x-axis shake (3 oscillations,
  250ms total, reduced-motion: none) + message fades in below. Shake ONCE per
  submit, never loop.
- Optimistic toggles (likes, stars): fill instantly with a 1→1.2→1 spring pop on
  the icon; reconcile silently on failure with an inline note.
- Skeletons: shaped like the real layout, shimmer via one masked gradient sweep
  (1.4s linear infinite), same radius system as the content it becomes.

## 6. Guardrails

- Decorative pointer effects: max 1-2 distinct kinds per page, desktop-only,
  `prefers-reduced-motion` disables tracking (element stays styled, static).
- Nothing in this file may cause layout shift, block scrolling, steal focus, or
  attach a raw `scroll`/`mousemove` listener without rAF batching + cleanup.
- Every effect must survive keyboard use: whatever hover reveals, focus reveals.
- Effects use palette tokens (accent/neutral), never introduce new hues.
- If an effect can't be justified in one sentence of communication value
  (affordance, state, hierarchy, brand voice), it's noise — cut it (DESIGN.md §6).
