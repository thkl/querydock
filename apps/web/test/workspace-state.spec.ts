import { describe, expect, it } from 'vitest';
import { ConfirmationDialogService } from '../src/app/feature/workspace/confirmation/confirmation-dialog.service';
import { RelationshipDiagramStateService } from '../src/app/feature/workspace/relationship-diagram/relationship-diagram-state.service';

describe('ConfirmationDialogService', () => {
  it('resolves the active request when the user confirms or cancels', async () => {
    const service = new ConfirmationDialogService();
    const confirmed = service.confirm({ title: 'Apply changes', message: 'Apply reviewed SQL?', confirmLabel: 'Apply' });
    expect(service.request()).toMatchObject({ title: 'Apply changes', confirmLabel: 'Apply' });
    service.resolve(true);
    await expect(confirmed).resolves.toBe(true);
    expect(service.request()).toBeNull();

    const cancelled = service.confirm({
      title: 'Drop table', message: 'This removes table data.', confirmLabel: 'Drop', intent: 'danger',
    });
    service.resolve(false);
    await expect(cancelled).resolves.toBe(false);
    expect(service.request()).toBeNull();
  });

  it('settles a superseded dialog as cancelled before opening the next request', async () => {
    const service = new ConfirmationDialogService();
    const first = service.confirm({ title: 'First', message: 'First prompt', confirmLabel: 'Continue' });
    const second = service.confirm({ title: 'Second', message: 'Second prompt', confirmLabel: 'Continue' });

    await expect(first).resolves.toBe(false);
    expect(service.request()?.title).toBe('Second');
    service.resolve(true);
    await expect(second).resolves.toBe(true);
  });
});

describe('RelationshipDiagramStateService', () => {
  it('stores view data per connection and returns independent position maps', () => {
    const service = new RelationshipDiagramStateService();
    service.saveSnapshots('connection-a', [], 2);
    service.saveTablePositions('connection-a', { 'public.people': { x: 20, y: 40 } });
    service.saveViewport('connection-a', 150, 250);
    service.saveViewport('connection-b', 5, 10);

    const view = service.viewFor('connection-a');
    expect(view).toMatchObject({
      snapshots: [], partialLoadCount: 2,
      tablePositions: { 'public.people': { x: 20, y: 40 } },
      scrollLeft: 150, scrollTop: 250,
    });
    view.tablePositions['public.people']!.x = 999;
    expect(service.viewFor('connection-a').tablePositions['public.people']?.x).toBe(20);
    expect(service.viewFor('connection-b')).toMatchObject({ snapshots: null, scrollLeft: 5, scrollTop: 10 });
  });
});

