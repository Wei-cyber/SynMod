# Case study: making agentic 3D work visible and reversible

## Problem

Text-to-3D demos often hide either the modeling process or the model's state. A person can request a result, but cannot easily inspect the hierarchy, make a precise manual correction, or understand what the agent changed. Traditional browser modelers provide direct manipulation but usually do not expose a browser-native agent contract.

SynMod treats collaboration as shared state rather than chat UI. The person works in the editor; the agent receives narrowly scoped tools from the page. Both act on the same document and history.

## Product and engineering decisions

- **A seeded scene instead of an empty canvas.** Rover Study immediately demonstrates hierarchy, scale, realistic materials, emissive lighting, a procedural Boolean, an articulated crane, and a gripper.
- **One validated command layer.** Human controls and WebMCP callbacks call the same Zustand store commands, keeping validation, activity, undo/redo, and autosave behavior aligned.
- **Visible agent authorship.** Agent mutations pulse orange in the scene and are labeled Agent in the activity feed.
- **Parametric and procedural before mesh editing.** Primitive parameters, hierarchy, and non-destructive Booleans provide useful design control without the complexity of topology editing.
- **Local-first persistence.** IndexedDB, editable JSON, GLB, PNG, checkpoints, branches, and embedded read-only links provide continuity without a signed-in backend.
- **Draft-aligned browser tools.** Registrations use human-readable titles, the exact two draft annotations, cancellation-aware async callbacks, structured verification data, fresh-revision boundaries for destructive/history changes, and explicit browser confirmation for deletion, restoration, and data-bearing links.

## Blank-left-panel regression

The installed Base UI Tabs implementation marks the selected tab trigger with `data-active` and only mounts the active panel by default. A stylesheet assumed Radix-style `data-state="active"` on the panel and set every left panel to `display: none`, so the primitive palette and all five outliner rows existed in the DOM but were invisible.

The fix recognizes Base UI's mounted/not-hidden panel contract while retaining compatibility selectors for `data-active` and `data-state="active"`. A Playwright regression now asserts that the complete primitive palette and seeded rover hierarchy are visible.

## Outcome

The release now has automated coverage at three levels: pure command/store behavior, WebMCP registration and callback behavior, and real-browser UI/registration execution. The production build is gated on accessibility lint, unit tests, browser E2E tests, and compilation. The human modeling surface remains fully usable when WebMCP is unavailable.

## Remaining product questions

External user research is still needed to measure whether users understand where to type agent requests in the ChatGPT browser, whether transaction previews build appropriate trust, and which scene-health suggestions are most actionable. These are research items, not claims of validated demand.
