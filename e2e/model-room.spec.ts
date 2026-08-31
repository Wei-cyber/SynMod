import { expect, test, type Page } from '@playwright/test';

async function installWebMcpHarness(page: Page) {
  await page.addInitScript(() => {
    const tools = new Map<string, WebMcpToolDefinition>();
    const registrationSignals = new Map<string, AbortSignal | undefined>();
    Object.defineProperty(window, '__modelRoomTools', { configurable: true, value: tools });
    Object.defineProperty(window, '__modelRoomRegistrationSignals', { configurable: true, value: registrationSignals });
    Object.defineProperty(document, 'modelContext', {
      configurable: true,
      value: {
        registerTool: async (definition: WebMcpToolDefinition, options?: { signal?: AbortSignal }) => {
          tools.set(definition.name, definition);
          registrationSignals.set(definition.name, options?.signal);
        },
      },
    });
  });
}

test('shows the primitive palette and all five Lamp Study outliner rows', async ({ page }) => {
  await page.goto('/');

  const palette = page.getByTestId('primitive-palette');
  await expect(palette).toBeVisible();
  await expect(palette.getByText('ADD PRIMITIVE')).toBeVisible();
  for (const primitive of ['Box', 'Sphere', 'Cylinder', 'Cone', 'Torus']) {
    await expect(palette.getByRole('button', { name: primitive, exact: true })).toBeVisible();
  }

  const outlinerRows = page.getByTestId('scene-outliner').getByTestId('outliner-row');
  await expect(outlinerRows).toHaveCount(5);
  for (const name of ['Base', 'Lower arm', 'Joint', 'Upper arm', 'Shade']) {
    await expect(outlinerRows.filter({ hasText: name })).toBeVisible();
  }
});

test('registers the draft WebMCP contract and executes read, mutation, validation, and cancellation paths in a browser', async ({ page }) => {
  await installWebMcpHarness(page);
  await page.goto('/');

  await expect.poll(() => page.evaluate(() => (window as typeof window & { __modelRoomTools: Map<string, WebMcpToolDefinition> }).__modelRoomTools.size)).toBe(29);

  const contracts = await page.evaluate(() => {
    const browserWindow = window as typeof window & {
      __modelRoomTools: Map<string, WebMcpToolDefinition>;
      __modelRoomRegistrationSignals: Map<string, AbortSignal | undefined>;
    };
    return [...browserWindow.__modelRoomTools.values()].map((tool) => ({
      name: tool.name,
      title: tool.title,
      annotations: tool.annotations,
      annotationKeys: Object.keys(tool.annotations ?? {}).sort(),
      registrationCancelled: browserWindow.__modelRoomRegistrationSignals.get(tool.name)?.aborted,
    }));
  });
  expect(contracts.every((tool) => Boolean(tool.title))).toBe(true);
  expect(contracts.every((tool) => tool.annotationKeys.join(',') === 'readOnlyHint,untrustedContentHint')).toBe(true);
  expect(contracts.every((tool) => tool.annotations?.untrustedContentHint === true)).toBe(true);
  expect(contracts.every((tool) => tool.registrationCancelled === false)).toBe(true);
  expect(contracts.find((tool) => tool.name === 'get_scene_summary')).toMatchObject({
    title: 'Get Scene Summary',
    annotations: { readOnlyHint: true, untrustedContentHint: true },
  });

  const browserResult = await page.evaluate(async () => {
    const tools = (window as typeof window & { __modelRoomTools: Map<string, WebMcpToolDefinition> }).__modelRoomTools;
    const signal = new AbortController().signal;
    const summary = await tools.get('get_scene_summary')!.execute({}, { signal }) as { structuredContent: { revision: number; objectCount: number } };
    const added = await tools.get('add_primitive')!.execute({ primitive_type: 'sphere', name: 'Browser sphere', position: [-2, 0.5, 0] }, { signal }) as { structuredContent: { revision: number; affectedObjectIds: string[] } };
    const objectId = added.structuredContent.affectedObjectIds[0];
    const material = await tools.get('set_object_material')!.execute({ object_id: objectId, color: '#f15722' }, { signal }) as { structuredContent: { revision: number; objects: Array<{ material: { color: string } }> } };

    let invalidIdError = '';
    try {
      await tools.get('select_objects')!.execute({ object_ids: ['missing-object'] }, { signal });
    } catch (error) {
      invalidIdError = error instanceof Error ? error.message : String(error);
    }

    const cancelled = new AbortController();
    cancelled.abort(new DOMException('Cancelled in browser test', 'AbortError'));
    let cancellationName = '';
    try {
      await tools.get('add_primitive')!.execute({ primitive_type: 'box' }, { signal: cancelled.signal });
    } catch (error) {
      cancellationName = error instanceof Error ? error.name : String(error);
    }
    const after = await tools.get('get_scene_summary')!.execute({}, { signal }) as { structuredContent: { revision: number; objectCount: number } };
    return {
      startRevision: summary.structuredContent.revision,
      startCount: summary.structuredContent.objectCount,
      addRevision: added.structuredContent.revision,
      materialRevision: material.structuredContent.revision,
      color: material.structuredContent.objects[0].material.color,
      invalidIdError,
      cancellationName,
      finalRevision: after.structuredContent.revision,
      finalCount: after.structuredContent.objectCount,
    };
  });

  expect(browserResult).toMatchObject({
    startCount: 5,
    color: '#f15722',
    cancellationName: 'AbortError',
  });
  expect(browserResult.invalidIdError).toContain('not found');
  expect(browserResult.addRevision).toBe(browserResult.startRevision + 1);
  expect(browserResult.materialRevision).toBe(browserResult.addRevision + 1);
  expect(browserResult.finalRevision).toBe(browserResult.materialRevision);
  expect(browserResult.finalCount).toBe(6);
  await expect(page.getByTestId('outliner-row')).toHaveCount(6);
  await expect(page.getByTestId('outliner-row').filter({ hasText: 'Browser sphere' })).toBeVisible();
});

declare global {
  interface Window {
    __modelRoomTools: Map<string, WebMcpToolDefinition>;
    __modelRoomRegistrationSignals: Map<string, AbortSignal | undefined>;
  }
}
