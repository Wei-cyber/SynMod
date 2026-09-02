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

async function expectOpaqueTopmostMenu(page: Page, itemName: string) {
  const menu = page.locator('[data-slot="dropdown-menu-content"]');
  const item = menu.getByRole('menuitem', { name: itemName, exact: true });
  await expect(menu).toBeVisible();
  await expect(item).toBeVisible();
  const surface = await menu.evaluate((element) => {
    const background = getComputedStyle(element).backgroundColor;
    const zIndex = Number(getComputedStyle(element.parentElement!).zIndex);
    const rect = element.getBoundingClientRect();
    const topElement = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 12);
    return {
      background,
      zIndex,
      ownsTopElement: Boolean(topElement && element.contains(topElement)),
    };
  });
  expect(surface.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(surface.background).not.toBe('transparent');
  expect(surface.zIndex).toBeGreaterThanOrEqual(100);
  expect(surface.ownsTopElement).toBe(true);
}

test('shows the primitive palette and all five Lamp Study outliner rows', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByText('SynMod', { exact: true })).toBeVisible();

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

test('keeps Export and Boolean menus opaque and above the editor while all outliner actions stay in bounds', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expectOpaqueTopmostMenu(page, 'Editable project JSON');
  await page.keyboard.press('Escape');

  const actionRow = page.getByTestId('outliner-actions');
  const ungroup = actionRow.getByRole('button', { name: 'Ungroup', exact: true });
  await expect(actionRow).toBeVisible();
  await expect(ungroup).toBeVisible();
  const bounds = await Promise.all([actionRow.boundingBox(), ungroup.boundingBox()]);
  expect(bounds[0]).not.toBeNull();
  expect(bounds[1]).not.toBeNull();
  expect(bounds[1]!.x + bounds[1]!.width).toBeLessThanOrEqual(bounds[0]!.x + bounds[0]!.width + 0.5);

  const rows = page.getByTestId('scene-outliner').getByTestId('outliner-row');
  await rows.filter({ hasText: 'Base' }).click();
  await rows.filter({ hasText: 'Lower arm' }).click({ modifiers: ['Shift'] });
  const booleanButton = actionRow.getByRole('button', { name: 'Boolean', exact: true });
  await expect(booleanButton).toBeEnabled();
  await booleanButton.click();
  await expectOpaqueTopmostMenu(page, 'Union');
  await expect(page.getByRole('menuitem', { name: 'Subtract second', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Intersect', exact: true })).toBeVisible();
});

test('registers the draft WebMCP contract and executes read, mutation, validation, and cancellation paths in a browser', async ({ page }) => {
  await installWebMcpHarness(page);
  await page.goto('/');

  await expect.poll(() => page.evaluate(() => (window as typeof window & { __modelRoomTools: Map<string, WebMcpToolDefinition> }).__modelRoomTools.size)).toBe(31);

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
    const hostCompatibleSummary = await (tools.get('get_scene_summary')!.execute as unknown as (input: object) => Promise<{ structuredContent: { revision: number } }>)({});
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
      hostCompatibleRevision: hostCompatibleSummary.structuredContent.revision,
      startCount: summary.structuredContent.objectCount,
      objectId,
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
  expect(browserResult.hostCompatibleRevision).toBe(browserResult.startRevision);
  expect(browserResult.addRevision).toBe(browserResult.startRevision + 1);
  expect(browserResult.materialRevision).toBe(browserResult.addRevision + 1);
  expect(browserResult.finalRevision).toBe(browserResult.materialRevision);
  expect(browserResult.finalCount).toBe(6);
  await expect(page.getByTestId('outliner-row')).toHaveCount(6);
  await expect(page.getByTestId('outliner-row').filter({ hasText: 'Browser sphere' })).toBeVisible();

  const deleteAttempt = page.evaluate(async ({ objectId, expectedRevision }) => {
    const tools = (window as typeof window & { __modelRoomTools: Map<string, WebMcpToolDefinition> }).__modelRoomTools;
    try {
      await tools.get('delete_object')!.execute({ object_id: objectId, expected_revision: expectedRevision }, { signal: new AbortController().signal });
      return '';
    } catch (error) {
      return error instanceof Error ? error.name : String(error);
    }
  }, { objectId: browserResult.objectId, expectedRevision: browserResult.finalRevision });
  const confirmation = await page.waitForEvent('dialog');
  expect(confirmation.message()).toContain('delete this object');
  await confirmation.dismiss();
  await expect(deleteAttempt).resolves.toBe('NotAllowedError');
  await expect(page.getByTestId('outliner-row')).toHaveCount(6);
});

test('completes relative placement and temporary-reference modeling in one call each', async ({ page }) => {
  await installWebMcpHarness(page);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __modelRoomTools: Map<string, WebMcpToolDefinition> }).__modelRoomTools.size)).toBe(31);

  const result = await page.evaluate(async () => {
    const tools = (window as typeof window & { __modelRoomTools: Map<string, WebMcpToolDefinition> }).__modelRoomTools;
    const signal = new AbortController().signal;
    const cylinder = await tools.get('add_primitive')!.execute({ primitive_type: 'cylinder', name: 'Cylinder_L', position: [5.5, 2, -7], geometry: { height: 2 } }, { signal }) as { structuredContent: { revision: number } };
    const cone = await tools.get('add_primitive')!.execute({ primitive_type: 'cone', name: 'Cone on Cylinder L', relative_to: { target: { name: 'Cylinder L' }, placement: 'top', inherit_material: true } }, { signal }) as { structuredContent: { revision: number; objects: Array<{ position: number[] }> } };
    const transaction = await tools.get('execute_scene_transaction')!.execute({
      expected_revision: cone.structuredContent.revision,
      label: 'One-call Boolean',
      operations: [
        { action: 'add_primitive', primitive_type: 'box', name: 'Transaction base', result_ref: 'base' },
        { action: 'add_primitive', primitive_type: 'cylinder', name: 'Transaction cutter', result_ref: 'cutter' },
        { action: 'boolean', operation: 'subtract', operands: [{ temp_ref: 'base' }, { temp_ref: 'cutter' }], name: 'Transaction result', result_ref: 'result' },
      ],
      focus_after: [{ temp_ref: 'result' }],
    }, { signal }) as { structuredContent: { revision: number; resolvedRefs: Record<string, string> } };
    await new Promise(requestAnimationFrame);
    return {
      cylinderRevision: cylinder.structuredContent.revision,
      coneRevision: cone.structuredContent.revision,
      conePosition: cone.structuredContent.objects[0].position,
      transactionRevision: transaction.structuredContent.revision,
      resultId: transaction.structuredContent.resolvedRefs.result,
      indicatorText: document.querySelector('[data-testid="agent-task-indicator"]')?.textContent ?? '',
    };
  });

  expect(result.coneRevision).toBe(result.cylinderRevision + 1);
  expect(result.conePosition).toEqual([5.5, 3.5, -7]);
  expect(result.transactionRevision).toBe(result.coneRevision + 1);
  expect(result.resultId).toBeTruthy();
  expect(result.indicatorText).toContain('Execute Scene Transaction');
  expect(result.indicatorText).toContain('3 objects');
});

declare global {
  interface Window {
    __modelRoomTools: Map<string, WebMcpToolDefinition>;
    __modelRoomRegistrationSignals: Map<string, AbortSignal | undefined>;
  }
}
