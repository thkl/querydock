import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { AGRID_RENDERER_CONTEXT } from '@thkl/agrid';

@Component({
  selector: 'qd-schema-badge-cell',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (label()) {
      <span class="schema-grid-badge" [class.schema-grid-badge--draft]="draft()"
        [class.schema-grid-badge--required]="required()">{{ label() }}</span>
    } @else {
      <span aria-hidden="true">—</span>
    }
  `,
  styles: [`
    :host { display: inline-flex; align-items: center; min-width: 0; }
    .schema-grid-badge {
      display: inline-flex;
      align-items: center;
      max-width: 100%;
      padding: 3px 7px;
      overflow: hidden;
      border: 1px solid var(--color-border);
      border-radius: 5px;
      background: var(--color-chip);
      color: var(--color-accent-strong);
      font-size: .76em;
      font-weight: 700;
      letter-spacing: .025em;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .schema-grid-badge--draft {
      border-color: var(--color-draft-border);
      background: var(--color-draft-subtle);
      color: var(--color-draft);
    }
    .schema-grid-badge--required { color: var(--color-warning); }
  `],
})
export class SchemaBadgeCellComponent {
  private readonly context = inject(AGRID_RENDERER_CONTEXT);
  readonly label = computed(() => {
    const value = this.context.value();
    if (value === true) return 'UNCOMMITTED';
    if (value === false || value === null || value === undefined || value === '') return '';
    return String(value).replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim().toUpperCase();
  });
  readonly draft = computed(() => this.label() === 'UNCOMMITTED');
  readonly required = computed(() => this.label() === 'NO');
}
