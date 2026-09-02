'use client';

import { useEffect, type ReactNode } from 'react';

import { loadLocalScene, saveLocalScene } from '@/lib/persistence';
import { readSharedDocumentFromHash } from '@/lib/share-links';
import { useStudioStore } from '@/lib/studio-store';
import { registerWebMcpTools } from '@/lib/webmcp';

function isEditableTarget(target: EventTarget | null) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable);
}

export function StudioProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    let active = true;
    void (async () => {
      const shared = await readSharedDocumentFromHash(window.location.hash);
      if (shared) return { doc: shared, readOnly: true };
      return { doc: await loadLocalScene(), readOnly: false };
    })()
      .then(({ doc, readOnly }) => active && useStudioStore.getState().hydrate(doc, readOnly))
      .catch(() => {
        if (!active) return;
        useStudioStore.getState().hydrate(null);
        useStudioStore.getState().setError(window.location.hash.startsWith('#share=') ? 'The shared project link is corrupt, so Rover Study was reopened.' : 'The local project could not be restored, so Rover Study was reopened.');
      });

    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = useStudioStore.subscribe((state, previous) => {
      if (!state.hydrated || state.readOnly || state.doc === previous.doc) return;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        state.setSaveState('saving');
        void saveLocalScene(useStudioStore.getState().doc)
          .then(() => useStudioStore.getState().setSaveState('saved'))
          .catch(() => {
            useStudioStore.getState().setSaveState('error');
            useStudioStore.getState().setError('Autosave failed. Export a project file to keep this version.');
          });
      }, 450);
    });

    let unregisterTools: () => void = () => undefined;
    void registerWebMcpTools()
      .then((cleanup) => { unregisterTools = cleanup; })
      .catch(() => useStudioStore.getState().setError('Site tools could not be registered in this browser. Human editing still works.'));

    return () => {
      active = false;
      clearTimeout(saveTimer);
      unsubscribe();
      unregisterTools();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const state = useStudioStore.getState();
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (state.readOnly && (modifier || event.key === 'Delete' || event.key === 'Backspace')) return;
      if (modifier && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) state.redo();
        else state.undo();
      } else if (modifier && key === 'y') {
        event.preventDefault(); state.redo();
      } else if (modifier && key === 'd' && state.selection.length === 1) {
        event.preventDefault(); state.execute({ type: 'duplicate', objectId: state.selection[0] });
      } else if (modifier && key === 'g' && state.selection.length > 1) {
        event.preventDefault(); state.execute({ type: 'group', objectIds: state.selection });
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && state.selection.length === 1) {
        event.preventDefault(); state.execute({ type: 'delete', objectId: state.selection[0] });
      } else if (key === 'w') state.setToolMode('translate');
      else if (key === 'e') state.setToolMode('rotate');
      else if (key === 'r') state.setToolMode('scale');
      else if (key === 'f' && state.selection.length) state.focus(state.selection);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return children;
}
