# SynMod product brief

## Product promise

**Shape ideas with an agent, in real time.** SynMod gives a person a legible 3D workspace and gives a browser agent a precise, inspectable tool surface. Every participant sees the same scene revision and can reverse the other's modeling operations.

## Target user and job

The initial user is a designer, builder, educator, or prototyper who can describe a spatial idea but does not want to translate every change into low-level modeling actions. Their job is to assemble and refine scene-scale concepts quickly while retaining direct control over geometry, hierarchy, materials, lighting, history, and exports.

## Core experience

1. Open an editable Lamp Study rather than a blank canvas.
2. Add or select objects through the visible primitive palette and scene outliner.
3. Manipulate the scene directly, or ask an agent to inspect and change it through WebMCP.
4. Watch agent changes appear immediately with orange scene feedback and an Agent-attributed activity entry.
5. Refine geometry, materials, environment, hierarchy, and Boolean features.
6. Undo, redo, checkpoint, branch, export, or create a read-only link.

## Competitive release scope

- Five parametric primitives with transform, visibility, geometry, and PBR material controls.
- Orbitable React Three Fiber viewport with grid, camera presets, framing, snapping, transform gizmos, HDRI-style presets, shadows, and reflections.
- Hierarchical outliner, grouping/ungrouping, non-destructive Boolean union/subtract/intersect, and procedural feature history.
- JSON and GLB round trips, opaque imported-model transforms, embedded textures, and 2× PNG output.
- Local autosave, up to 100 undo steps, named checkpoints, local branches/copies, comparison, health warnings, and read-only embedded links.
- WebMCP reads, immediate edits, atomic preview/apply transactions, inspection, versions, sharing, selection/focus, and history control.

## Trust and privacy principles

- Human and agent actions use one command layer; no hidden agent-only state mutation path.
- Inputs are schema-validated and finite before state changes; transactions apply atomically.
- Tool results are marked untrusted when they can include browser, user, or imported data.
- Destructive/history calls require a fresh scene revision; delete, restore, and link-sharing tools also cross an in-page confirmation boundary, while the host browser retains its own invocation review.
- Projects are device-local. Sharing is explicit and produces a URL containing the project; there is no account database.

## Non-goals for this release

No signed-in cloud storage, real-time multi-human cursors, comments, animation timeline, rigging, sculpting, or face/edge/vertex editing. Imported GLB internals remain opaque except for discovered node transforms/material overrides.

## Release success criteria

- A first-time user can see and use the primitive palette and all five seeded outliner rows.
- A browser agent can register, inspect, mutate, validate, cancel, and undo through the documented contract.
- Human and agent changes create equivalent revisions, autosave behavior, activity attribution, and reversibility.
- Lint, unit, browser E2E, and production build gates all pass before deployment.
