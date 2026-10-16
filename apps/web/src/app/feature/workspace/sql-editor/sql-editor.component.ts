import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  ViewChild,
  input,
  output,
} from '@angular/core';
import { basicSetup } from 'codemirror';
import { PostgreSQL, sql } from '@codemirror/lang-sql';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

const querydockSqlHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--sql-color-keyword)' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--sql-color-type)' },
  { tag: [tags.string, tags.character], color: 'var(--sql-color-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--sql-color-number)' },
  { tag: tags.operator, color: 'var(--sql-color-operator)' },
  { tag: tags.comment, color: 'var(--sql-color-comment)', fontStyle: 'italic' },
]);

const querydockTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: 'var(--color-surface-solid)',
      color: 'var(--color-foreground)',
      fontSize: '1em',
      height: '100%',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-content': {
      caretColor: 'var(--color-accent)',
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      minHeight: '100%',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-accent)' },
    '.cm-activeLine': { backgroundColor: 'rgb(255 255 255 / 3%)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--color-hover)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      backgroundColor: 'rgb(102 239 189 / 22%)',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--color-surface-solid)',
      borderRight: '1px solid var(--color-border)',
      color: 'var(--color-muted)',
    },
    '.cm-tooltip': {
      backgroundColor: 'var(--color-background-raised)',
      border: '1px solid var(--color-border-strong)',
      color: 'var(--color-foreground)',
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
      backgroundColor: 'var(--color-selected)',
      color: 'var(--color-foreground)',
    },
  },
  { dark: true },
);

@Component({
  selector: 'qd-sql-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './sql-editor.component.html',
  styleUrl: './sql-editor.component.css',
})
export class SqlEditorComponent implements AfterViewInit, OnChanges, OnDestroy {
  readonly value = input('');
  readonly readOnly = input(false);
  readonly ariaLabel = input('SQL editor');
  readonly valueChange = output<string>();
  @ViewChild('editorMount', { static: true }) private editorMount!: ElementRef<HTMLDivElement>;

  private editor?: EditorView;

  /** Creates CodeMirror after the editor host exists in the rendered view. */
  ngAfterViewInit(): void {
    this.editor = new EditorView({
      state: EditorState.create({
        doc: this.value(),
        extensions: [
          basicSetup,
          syntaxHighlighting(querydockSqlHighlight),
          sql({ dialect: PostgreSQL }),
          EditorState.readOnly.of(this.readOnly()),
          EditorView.editable.of(!this.readOnly()),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            'aria-label': this.ariaLabel(),
            'aria-readonly': String(this.readOnly()),
            spellcheck: 'false',
            tabindex: '0',
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) this.valueChange.emit(update.state.doc.toString());
          }),
          querydockTheme,
        ],
      }),
      parent: this.editorMount.nativeElement,
    });
  }

  /** Synchronizes external SQL changes and editor options into CodeMirror state. */
  ngOnChanges(changes: SimpleChanges): void {
    if (!this.editor) return;

    if (changes['value'] && this.editor.state.doc.toString() !== this.value()) {
      this.editor.dispatch({
        changes: {
          from: 0,
          to: this.editor.state.doc.length,
          insert: this.value(),
        },
      });
    }
  }

  /** Destroys the CodeMirror view and releases editor event handlers. */
  ngOnDestroy(): void {
    this.editor?.destroy();
  }
}
