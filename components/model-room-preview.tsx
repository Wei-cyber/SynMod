'use client';

import dynamic from 'next/dynamic';
import { useRef, useState, type ChangeEvent } from 'react';
import {
  AlertCircle,
  Box,
  Check,
  ChevronDown,
  Circle,
  CircleDashed,
  CircleDot,
  Cone,
  Copy,
  Cylinder,
  Download,
  FileJson,
  Focus,
  Grid3X3,
  Group,
  Layers3,
  MousePointer2,
  PanelLeft,
  Redo2,
  Rotate3D,
  Scale3D,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Undo2,
  Ungroup,
  Upload,
  X,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { exportSceneGlb, validateAndEncodeGlb } from '@/lib/gltf-files';
import { downloadJson, readJsonProject } from '@/lib/persistence';
import { useStudioStore } from '@/lib/studio-store';
import { PRIMITIVE_LABELS, type PrimitiveType, type StudioObject, type Vec3 } from '@/lib/studio-types';

const StudioCanvas = dynamic(
  () => import('@/components/studio-canvas').then((module) => module.StudioCanvas),
  { ssr: false, loading: () => <div className="canvas-loading">Preparing the modeling table…</div> },
);

const primitives: Array<{ type: PrimitiveType; icon: typeof Box }> = [
  { type: 'box', icon: Box },
  { type: 'sphere', icon: CircleDot },
  { type: 'cylinder', icon: Cylinder },
  { type: 'cone', icon: Cone },
  { type: 'torus', icon: CircleDashed },
];

function WebMcpBadge() {
  const status = useStudioStore((state) => state.webmcpStatus);
  const copy = status === 'ready' ? 'Site tools ready' : status === 'unavailable' ? 'Human editing' : status === 'error' ? 'Tools unavailable' : 'Checking tools';
  return <Badge variant="outline" className={`webmcp-badge status-${status}`}><Sparkles /> {copy}</Badge>;
}

function FileActions() {
  const fileInput = useRef<HTMLInputElement>(null);
  const doc = useStudioStore((state) => state.doc);
  const execute = useStudioStore((state) => state.execute);
  const replaceDocument = useStudioStore((state) => state.replaceDocument);
  const setError = useStudioStore((state) => state.setError);

  const onImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      if (file.name.toLowerCase().endsWith('.glb')) {
        const assetDataUrl = await validateAndEncodeGlb(file);
        execute({ type: 'import_glb', name: file.name.replace(/\.glb$/i, ''), assetDataUrl });
      } else {
        replaceDocument(await readJsonProject(file));
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The selected file could not be imported.');
    }
  };

  return (
    <>
      <input ref={fileInput} className="sr-only" type="file" accept=".json,.model-room.json,.glb,application/json,model/gltf-binary" onChange={onImport} />
      <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}><Upload /> Import</Button>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="sm" />}>
          <Download /> Export <ChevronDown />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={() => downloadJson(doc)}><FileJson /> Editable project JSON</DropdownMenuItem>
          <DropdownMenuItem onClick={() => void exportSceneGlb().catch((error) => setError(error instanceof Error ? error.message : 'GLB export failed.'))}><Box /> Rendered scene GLB</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

function PrimitivePalette() {
  const execute = useStudioStore((state) => state.execute);
  return (
    <div className="panel-section">
      <p className="eyebrow">ADD PRIMITIVE</p>
      <div className="primitive-grid">
        {primitives.map(({ type, icon: Icon }) => (
          <button key={type} type="button" onClick={() => execute({ type: 'add_primitive', primitiveType: type })}>
            <Icon /><span>{PRIMITIVE_LABELS[type]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ObjectGlyph({ object }: { object: StudioObject }) {
  if (object.type === 'group') return <Group />;
  if (object.type === 'glb') return <Box />;
  return <span>{object.type.slice(0, 1).toUpperCase()}</span>;
}

function OutlinerRow({ object, depth }: { object: StudioObject; depth: number }) {
  const objects = useStudioStore((state) => state.doc.objects);
  const selection = useStudioStore((state) => state.selection);
  const select = useStudioStore((state) => state.select);
  const children = objects.filter((item) => item.parentId === object.id);
  const selected = selection.includes(object.id);
  return (
    <>
      <button
        type="button"
        className={selected ? 'selected' : ''}
        style={{ paddingLeft: 7 + depth * 14 }}
        onClick={(event) => select(event.shiftKey ? selected ? selection.filter((id) => id !== object.id) : [...selection, object.id] : [object.id])}
      >
        <span className="object-glyph"><ObjectGlyph object={object} /></span>
        <span className="object-row-name">{object.name}</span>
        <span className="object-type">{object.type}</span>
      </button>
      {children.map((child) => <OutlinerRow key={child.id} object={child} depth={depth + 1} />)}
    </>
  );
}

function SceneOutliner() {
  const objects = useStudioStore((state) => state.doc.objects);
  const selection = useStudioStore((state) => state.selection);
  const execute = useStudioStore((state) => state.execute);
  const selectedObject = objects.find((item) => item.id === selection[0]);
  return (
    <div className="panel-section outliner-section">
      <div className="section-heading"><p className="eyebrow">SCENE</p><span>{objects.length} objects</span></div>
      <div className="outliner-list">
        {objects.filter((object) => !object.parentId).map((object) => <OutlinerRow key={object.id} object={object} depth={0} />)}
        {!objects.length && <p className="empty-state">Add a primitive to start shaping your scene.</p>}
      </div>
      <div className="outliner-actions">
        <Button variant="ghost" size="xs" disabled={selection.length < 2} onClick={() => execute({ type: 'group', objectIds: selection })}><Group /> Group</Button>
        <Button variant="ghost" size="xs" disabled={!selectedObject || selectedObject.type !== 'group'} onClick={() => selectedObject && execute({ type: 'ungroup', groupId: selectedObject.id })}><Ungroup /> Ungroup</Button>
      </div>
    </div>
  );
}

function LeftPanel({ drawer = false }: { drawer?: boolean }) {
  return (
    <aside className={`${drawer ? 'drawer-panel' : 'left-panel panel-surface'}`}>
      <PrimitivePalette />
      <SceneOutliner />
      <div className="agent-note"><Sparkles /><div><strong>Build with an agent</strong><span>Ask Codex to add or refine any object in this live scene.</span></div></div>
    </aside>
  );
}

function VectorEditor({ label, field, value, objectId }: { label: string; field: 'position' | 'rotation' | 'scale'; value: Vec3; objectId: string }) {
  const execute = useStudioStore((state) => state.execute);
  const commit = (axis: number, raw: string) => {
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) return;
    const next = [...value] as Vec3;
    next[axis] = numeric;
    execute({ type: 'set_transform', objectId, [field]: next });
  };
  return (
    <div className="vector-row">
      <label>{label}</label>
      {(['X', 'Y', 'Z'] as const).map((axis, index) => (
        <span key={`${objectId}-${field}-${axis}-${value[index]}`}><b>{axis}</b><input type="number" step={field === 'rotation' ? 1 : 0.1} defaultValue={Number(value[index].toFixed(3))} onBlur={(event) => commit(index, event.currentTarget.value)} aria-label={`${label} ${axis}`} /></span>
      ))}
    </div>
  );
}

function MaterialSlider({ label, value, onCommit }: { label: string; value: number; onCommit: (value: number) => void }) {
  const [local, setLocal] = useState(value);
  return (
    <div className="real-slider-line">
      <span>{label}</span>
      <Slider min={0} max={1} step={0.01} value={[local]} onValueChange={(values) => setLocal(Array.isArray(values) ? values[0] : values)} onValueCommitted={(values) => onCommit(Array.isArray(values) ? values[0] : values)} />
      <b>{local.toFixed(2)}</b>
    </div>
  );
}

function ObjectInspector({ object }: { object: StudioObject }) {
  const execute = useStudioStore((state) => state.execute);
  const selection = useStudioStore((state) => state.selection);
  const focus = useStudioStore((state) => state.focus);
  return (
    <>
      <div className="inspector-heading">
        <div>
          <p className="eyebrow">INSPECTOR</p>
          <Input className="object-name-input" defaultValue={object.name} key={`${object.id}-${object.name}`} onBlur={(event) => event.currentTarget.value.trim() !== object.name && execute({ type: 'rename', objectId: object.id, name: event.currentTarget.value })} aria-label="Object name" />
        </div>
        <span className="object-chip">{object.type.toUpperCase()}</span>
      </div>
      <div className="inspector-block">
        <p className="eyebrow">TRANSFORM</p>
        <VectorEditor label="Position" field="position" value={object.position} objectId={object.id} />
        <VectorEditor label="Rotation" field="rotation" value={object.rotation} objectId={object.id} />
        <VectorEditor label="Scale" field="scale" value={object.scale} objectId={object.id} />
      </div>
      {object.type !== 'group' && object.type !== 'glb' && (
        <div className="inspector-block">
          <div className="section-heading"><p className="eyebrow">MATERIAL</p><span>Standard</span></div>
          <label className="material-color">
            <input type="color" value={object.material.color} onChange={(event) => execute({ type: 'set_material', objectId: object.id, material: { color: event.target.value } })} />
            <span>Base color</span><code>{object.material.color.toUpperCase()}</code>
          </label>
          <MaterialSlider key={`${object.id}-roughness-${object.material.roughness}`} label="Roughness" value={object.material.roughness} onCommit={(roughness) => execute({ type: 'set_material', objectId: object.id, material: { roughness } })} />
          <MaterialSlider key={`${object.id}-metalness-${object.material.metalness}`} label="Metalness" value={object.material.metalness} onCommit={(metalness) => execute({ type: 'set_material', objectId: object.id, material: { metalness } })} />
        </div>
      )}
      <div className="inspector-actions">
        <Button variant="outline" size="sm" onClick={() => execute({ type: 'duplicate', objectId: object.id })}><Copy /> Duplicate</Button>
        <Button variant="outline" size="sm" onClick={() => focus(selection)}><Focus /> Frame</Button>
        <Button variant="destructive" size="sm" onClick={() => execute({ type: 'delete', objectId: object.id })}><Trash2 /> Delete</Button>
      </div>
    </>
  );
}

function ActivityFeed() {
  const activity = useStudioStore((state) => state.activity);
  const now = Date.now();
  return (
    <div className="activity-feed">
      {activity.map((item) => {
        const age = Math.max(0, now - item.timestamp);
        const time = age < 15_000 ? 'now' : age < 60_000 ? `${Math.floor(age / 1000)}s` : `${Math.floor(age / 60_000)}m`;
        return <div className={`activity-item ${item.actor === 'agent' ? 'agent' : ''}`} key={item.id}><span>{item.actor === 'agent' ? 'A' : 'Y'}</span><div><strong>{item.actor === 'agent' ? 'Agent' : 'You'}</strong><p>{item.label}</p></div><time>{time}</time></div>;
      })}
    </div>
  );
}

function RightPanel({ drawer = false }: { drawer?: boolean }) {
  const objects = useStudioStore((state) => state.doc.objects);
  const selection = useStudioStore((state) => state.selection);
  const object = objects.find((item) => item.id === selection[0]);
  return (
    <aside className={`${drawer ? 'drawer-panel' : 'right-panel panel-surface'}`}>
      <Tabs defaultValue="object" className="inspector-tabs">
        <TabsList variant="line" className="inspector-tabs-list"><TabsTrigger value="object"><SlidersHorizontal /> Object</TabsTrigger><TabsTrigger value="activity"><Sparkles /> Activity</TabsTrigger></TabsList>
        <TabsContent value="object">{object ? <ObjectInspector object={object} /> : <div className="inspector-empty"><MousePointer2 /><strong>Select an object</strong><span>Choose a shape in the canvas or scene list to inspect it.</span></div>}</TabsContent>
        <TabsContent value="activity"><div className="activity-block"><div className="section-heading"><p className="eyebrow">ACTIVITY</p><span>Live</span></div><ActivityFeed /></div></TabsContent>
      </Tabs>
    </aside>
  );
}

function Header({ openLeft, openRight }: { openLeft: () => void; openRight: () => void }) {
  const doc = useStudioStore((state) => state.doc);
  const saveState = useStudioStore((state) => state.saveState);
  const history = useStudioStore((state) => state.history);
  const future = useStudioStore((state) => state.future);
  const undo = useStudioStore((state) => state.undo);
  const redo = useStudioStore((state) => state.redo);
  const statusText = saveState === 'saved' ? 'Autosaved' : saveState === 'saving' ? 'Saving…' : 'Save issue';
  return (
    <header className="studio-header">
      <div className="brand-lockup">
        <span className="brand-mark" aria-hidden="true"><Circle /></span>
        <div><p className="brand-name">MODEL ROOM</p><p className="project-name">{doc.title} <span>·</span> {statusText}</p></div>
      </div>
      <div className="header-actions">
        <Button className="compact-panel-button left" variant="ghost" size="icon-sm" onClick={openLeft} aria-label="Open scene panel"><PanelLeft /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Undo" disabled={!history.length} onClick={() => undo()}><Undo2 /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Redo" disabled={!future.length} onClick={() => redo()}><Redo2 /></Button>
        <div className="header-divider" />
        <FileActions />
        <WebMcpBadge />
        <Button className="compact-panel-button right" variant="ghost" size="icon-sm" onClick={openRight} aria-label="Open inspector"><SlidersHorizontal /></Button>
      </div>
    </header>
  );
}

function Viewport() {
  const toolMode = useStudioStore((state) => state.toolMode);
  const setToolMode = useStudioStore((state) => state.setToolMode);
  const snap = useStudioStore((state) => state.doc.settings.snapEnabled);
  const setSnap = useStudioStore((state) => state.setSnapEnabled);
  const setCameraPreset = useStudioStore((state) => state.setCameraPreset);
  const webmcpStatus = useStudioStore((state) => state.webmcpStatus);
  return (
    <div className="viewport-wrap">
      <StudioCanvas />
      <div className="view-label"><span className="live-dot" /> PERSPECTIVE <span>·</span> GRID 0.5 M</div>
      <div className="viewport-toolbar" aria-label="Transform tools">
        <button className={toolMode === 'translate' ? 'active' : ''} type="button" onClick={() => setToolMode('translate')} aria-label="Move tool"><Focus /><kbd>W</kbd></button>
        <button className={toolMode === 'rotate' ? 'active' : ''} type="button" onClick={() => setToolMode('rotate')} aria-label="Rotate tool"><Rotate3D /><kbd>E</kbd></button>
        <button className={toolMode === 'scale' ? 'active' : ''} type="button" onClick={() => setToolMode('scale')} aria-label="Scale tool"><Scale3D /><kbd>R</kbd></button>
        <span className="toolbar-rule" />
        <button className={snap ? 'active-subtle' : ''} type="button" onClick={() => setSnap(!snap)} aria-label="Toggle grid snapping"><Grid3X3 /><kbd>SNAP</kbd></button>
      </div>
      <div className="camera-presets"><button onClick={() => setCameraPreset('top')}>TOP</button><button onClick={() => setCameraPreset('front')}>FRONT</button><button onClick={() => setCameraPreset('iso')}>ISO</button></div>
      <div className="agent-pulse"><Sparkles /><span><strong>{webmcpStatus === 'ready' ? 'Agent ready' : 'Shared scene'}</strong> · Select a shape or ask for a change</span></div>
    </div>
  );
}

export function ModelRoomPreview() {
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const doc = useStudioStore((state) => state.doc);
  const error = useStudioStore((state) => state.error);
  const setError = useStudioStore((state) => state.setError);
  const webmcpStatus = useStudioStore((state) => state.webmcpStatus);
  return (
    <main className="studio-shell">
      <Header openLeft={() => setLeftOpen(true)} openRight={() => setRightOpen(true)} />
      <section className="studio-grid"><LeftPanel /><Viewport /><RightPanel /></section>
      <footer className="studio-status"><span>{doc.objects.length} OBJECTS</span><span>REVISION {doc.revision}</span><span>LOCAL PROJECT</span><span className="status-right">WEBMCP <b>{webmcpStatus.toUpperCase()}</b></span></footer>
      {error && <div className="error-banner" role="alert"><AlertCircle /><span>{error}</span><button onClick={() => setError(null)} aria-label="Dismiss error"><X /></button></div>}
      <Sheet open={leftOpen} onOpenChange={setLeftOpen}><SheetContent side="left" className="mobile-sheet"><SheetHeader className="sr-only"><SheetTitle>Scene tools</SheetTitle><SheetDescription>Add and organize objects.</SheetDescription></SheetHeader><LeftPanel drawer /></SheetContent></Sheet>
      <Sheet open={rightOpen} onOpenChange={setRightOpen}><SheetContent side="right" className="mobile-sheet"><SheetHeader className="sr-only"><SheetTitle>Inspector</SheetTitle><SheetDescription>Edit the selected object.</SheetDescription></SheetHeader><RightPanel drawer /></SheetContent></Sheet>
    </main>
  );
}
