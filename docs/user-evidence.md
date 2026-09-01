# Lightweight user evidence

This is an honest evidence log, not a claim of a formal usability study. It separates direct observations and automated acceptance evidence from hypotheses that still require external participants.

## Direct observations

### 2026-08-31 — agent-created orange sphere

- In the live ChatGPT Site, an agent read the scene, added a sphere beside the lamp, and recolored it safety orange through two separate WebMCP calls.
- The scene revision advanced once per operation, the returned object snapshot reported `#f15722`, and the object remained independently undoable.
- This demonstrates the central loop: request in conversation, visible scene change, structured verification, and reversible history.

### 2026-08-31 — blank left editor rail

- The Objects tab was selected and its palette/outliner content existed in the DOM, but the rail appeared empty.
- Inspection isolated the mismatch between Base UI's active-tab/mounted-panel attributes and the panel CSS.
- Impact: the failure hid all five primitive controls and all five seeded outliner rows, blocking the primary human side of collaboration even though agent tools still worked.

## Automated browser evidence

The Playwright suite now proves in a fresh browser context that:

- the primitive palette heading and Box, Sphere, Cylinder, Cone, and Torus buttons are visible;
- Base, Lower arm, Joint, Upper arm, and Shade are five visible outliner rows;
- 29 WebMCP tools register with non-empty titles and only the draft annotations;
- a browser execution can read the scene, add a sphere, recolor it, and observe consecutive revisions;
- invalid object IDs reject without changing selection;
- an already-cancelled execution rejects with `AbortError` and does not increment the revision.
- dismissing the browser confirmation for an agent deletion rejects with `NotAllowedError` and leaves the object visible.

## Hypotheses to validate next

- People will understand that agent requests belong in the ChatGPT conversation beside the Site, not inside SynMod.
- Seeing agent actions in the activity feed and undo stack will improve confidence enough for iterative modeling.
- Revision-guarded destructive calls and transaction previews will feel safe without adding excessive friction.
- Designers will value procedural primitives/Booleans before they ask for topology-level editing.

Recommended next study: five moderated 20-minute sessions using three tasks—create a primitive composition, refine it collaboratively with the agent, and recover from an unwanted edit—while measuring task completion, first-request discoverability, undo use, and trust comments.
