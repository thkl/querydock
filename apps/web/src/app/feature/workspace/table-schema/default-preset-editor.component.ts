import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { AGRID_EDITOR_CONTEXT, type AgridEditorContext } from '@thkl/agrid';

interface DefaultPreset {
  value: string;
  label: string;
}

interface DefaultPresetEditorRow extends Record<string, unknown> {
  defaultPresetOptions?: DefaultPreset[];
}

@Component({
  selector: 'qd-default-preset-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './default-preset-editor.component.html',
  styleUrl: './default-preset-editor.component.css',
})
export class DefaultPresetEditorComponent {
  readonly editor = inject(AGRID_EDITOR_CONTEXT) as AgridEditorContext<string>;
  readonly options = computed(() =>
    (this.editor.row() as DefaultPresetEditorRow | null)?.defaultPresetOptions ?? [],
  );

  /** Commits the selected adapter-provided expression through the grid editor API. */
  selectPreset(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.editor.setDraft(value);
    this.editor.commit();
  }
}
