# SynMod
![Screenshot](./public/og.png)
SynMod is a desktop-first 3D collaboration studio for one person and a browser agent. People edit through a conventional modeling UI while ChatGPT/Codex uses page-registered WebMCP tools. Both paths share the same validated command layer, revision history, activity feed, autosave, and undo/redo stack.

The first visit opens an editable **Rover Study** with a procedural axle tunnel, articulated crane, gripper, sensor rig, emissive headlights, and PBR materials. The app supports parametric boxes, spheres, cylinders, cones, and toruses; transforms and PBR materials; grouping; non-destructive Boolean operations; local checkpoints and branches; JSON/GLB import and export; viewport PNG export; environment lighting; and read-only links embedded entirely in the URL. Fast WebMCP tools resolve normalized names, place primitives relative to world-space bounds, and apply up to 50 safe operations as one reversible transaction.

Try [SynMod](https://synmod.jquan287619461.chatgpt.site/)
## Why WebMCP fits SynMod

3D modeling combines visual judgment with precise, structured operations. A person may decide that a rover’s gripping tips looks too small, while an agent can translate that direction into exact changes to position, scale, geometry, or material. WebMCP connects those two ways of working.

SynMod registers its modeling capabilities directly with the browser through `document.modelContext.registerTool(...)`. This lets ChatGPT inspect and modify the open scene using tools defined by the application. SynMod does not need an embedded chatbot or a separate OpenAI API key.

The person and agent operate on the same scene state. A person can select and reshape one component through the visual editor while the agent adds or refines another component. Agent operations appear immediately in the viewport, are identified in the activity history, and use the same validation, autosave, and undo/redo system as human edits.

Together, people and agents can:

- Find objects by name and inspect their dimensions and transforms.
- Add boxes, spheres, cylinders, cones, and toruses.
- Move, rotate, scale, rename, recolor, duplicate, group, or hide objects.
- Adjust PBR properties such as roughness, metalness, opacity, and emission.
- Create non-destructive Boolean unions, subtractions, and intersections.
- Change scene lighting, exposure, shadows, and environment presets.
- Undo or redo changes made by either participant.

WebMCP is useful here because the agent does not need to guess where to click or manipulate the canvas indirectly. It receives focused modeling tools, stable object references, validation errors, scene revisions, and structured results. The person remains responsible for creative direction and visual evaluation, while the agent can handle precise or repetitive scene operations.

## Run locally

Requirements: Node.js 22.13 or newer and a Chromium-family browser.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Human editing remains available in browsers that do not expose `document.modelContext`.

## Quality gates

```bash
npm run lint       # oxlint, including accessibility rules
npm run test:unit  # scene/store/WebMCP unit tests
npm run test:e2e   # Playwright UI and browser registration tests
npm run build      # mandatory lint + all tests + production Sites build
```

Pull requests and pushes run the same `npm run quality` gate in GitHub Actions. Playwright uses installed Microsoft Edge locally and the workflow installs Chromium in CI.

## Architecture

- `components/model-room-preview.tsx` — editor shell, palette, outliner, inspectors, activity, versions, and file actions.
- `components/studio-canvas.tsx` — React Three Fiber viewport, materials, lighting, shadows, gizmos, camera controls, and GLB rendering.
- `lib/studio-store.ts` — Zustand state and the shared reversible command boundary used by people and agents.
- `lib/webmcp.ts` — top-level WebMCP registration, JSON Schemas, compact lookup, one-call transactions, execution cancellation, structured results, and conflict guards.
- `lib/scene-targeting.ts` — normalized object resolution, compact object indexes, world-relative placement, and dependency closure.
- `lib/persistence.ts` — versioned IndexedDB project recovery.
- `lib/share-links.ts` — compressed read-only project links with no cloud account or upload.
- `e2e/model-room.spec.ts` — visibility regression and browser-level WebMCP contract/execution coverage.

## Storage and privacy

Projects and imported assets stay in the browser's IndexedDB. A read-only share link embeds the scene document in the URL; anyone with that link can read its contents. There is no signed-in cloud storage, multi-user synchronization, animation timeline, rigging, or face/vertex editing.

## License

SynMod is open-source software available under the [MIT License](LICENSE).
