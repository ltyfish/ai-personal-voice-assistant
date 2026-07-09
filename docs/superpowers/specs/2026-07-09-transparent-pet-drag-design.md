# Transparent Pet Drag Design

## Goal

Keep the desktop pet fully transparent during hover, press, and dragging, and preserve the current idle image after a drag finishes.

## Root Causes

The shared `button:hover:not(:disabled)` rule has higher selector specificity than `.pet-character`, so it paints a translucent rectangular background and border over the pet hit area. The shared active rule can also apply a button translation to the animated pet.

The image-selection effect selects a random image whenever the visual state changes. A drag changes `idle` to `dragging` and then back to `idle`, so ending a drag currently rerolls the idle pool immediately.

## Behavior

- Hovering the pet does not alter its image, background, border, opacity, or position.
- The cursor remains `grab` while hovering and becomes `grabbing` while pressed.
- Dragging still uses the configured dragging image pool.
- Ending or cancelling a drag restores the exact idle image that was visible before dragging.
- The restored idle image remains until the five-minute idle timer rotates it or another non-drag state transition occurs.
- Prompt buttons retain their existing hover and active feedback.
- Keyboard activation and focus accessibility on the pet button remain intact.

## Implementation

Add pet-specific hover and active rules after the generic button interaction rules. These rules force a transparent background and border and prevent the generic active translation. Focus remains available without painting the shared translucent fill.

Track the previous visual state in the renderer. When the next state is `idle` and the previous state was `dragging`, restore `lastPetImagesRef.current.idle` instead of calling the random selector. All other state changes retain the existing random selection behavior.

## Testing

Extend the desktop contract check to require:

- Transparent pet hover and active CSS overrides.
- A previous-visual-state reference.
- Explicit drag-to-idle restoration.

Run the unit tests, TypeScript typecheck, and renderer production build. Install the packaged app and visually verify that hover/drag no longer paints a rectangle and drag completion preserves the idle image.
