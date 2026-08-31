# Model Room

Model Room is a desktop-first 3D collaboration studio for one person and a browser agent. People edit through a conventional modeling UI while ChatGPT/Codex uses page-registered WebMCP tools. Both paths share the same validated command layer, revision history, activity feed, autosave, and undo/redo stack.

The first visit opens an editable five-object **Lamp Study**. The app supports parametric boxes, spheres, cylinders, cones, and toruses; transforms and PBR materials; grouping; non-destructive Boolean operations; local checkpoints and branches; JSON/GLB import and export; viewport PNG export; environment lighting; and read-only links embedded entirely in the URL.

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
- `lib/webmcp.ts` — top-level WebMCP registration, JSON Schemas, annotations, execution cancellation, structured results, and revision guards.
- `lib/persistence.ts` — versioned IndexedDB project recovery.
- `lib/share-links.ts` — compressed read-only project links with no cloud account or upload.
- `e2e/model-room.spec.ts` — visibility regression and browser-level WebMCP contract/execution coverage.

## WebMCP contract and safety

Each registered tool has a human-readable title and the draft `readOnlyHint` and `untrustedContentHint` annotations. Execution callbacks accept `ToolExecuteCallbackOptions.signal`; cancelled calls reject before a synchronous mutation begins, and asynchronous sharing races against the signal. Results containing scene names, imported asset metadata, or other browser/user-supplied values are marked untrusted.

High-impact delete, restore, undo, and redo calls require the exact current scene revision. This prevents stale agent intent from changing a scene that a person edited after the agent last inspected it. The host browser remains responsible for its invocation review and user-confirmation UI. Model Room deliberately exposes no agent-accessible “clear everything” command.

## Storage and privacy

Projects and imported assets stay in the browser's IndexedDB. A read-only share link embeds the scene document in the URL; anyone with that link can read its contents. There is no signed-in cloud storage, multi-user synchronization, animation timeline, rigging, or face/vertex editing.

More context is in the [product brief](docs/product-brief.md), [case study](docs/case-study.md), and [evidence notes](docs/user-evidence.md).
