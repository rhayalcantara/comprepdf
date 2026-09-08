import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { PdfDocHandle } from '../../shared/pdf-preview/pdf-preview.service';
import { PdfThumbComponent } from '../../shared/pdf-preview/pdf-thumb.component';
import { PageItem } from './workspace.service';

/**
 * Panel de páginas del Estudio: navegador y editor de estructura a la vez.
 *
 * Arrastrar reordena, ⟳ gira y × elimina — todo instantáneo sobre la miniatura
 * (la rotación es un transform CSS, ver PdfThumbComponent). Nada de esto toca el
 * servidor hasta el flush; aquí solo se emiten intenciones.
 */
@Component({
  selector: 'app-pages-panel',
  standalone: true,
  imports: [CommonModule, PdfThumbComponent],
  template: `
    <div class="panel-head">
      <p class="eyebrow">Páginas</p>
      <span class="count mono">{{ pages.length }}</span>
    </div>

    <ol class="page-list">
      @for (page of pages; track page.source; let i = $index) {
        <li class="page-item"
            [class.current]="i + 1 === currentPage"
            [class.dragging]="dragIndex === i"
            [class.drop-target]="dragOverIndex === i && dragIndex !== i"
            draggable="true"
            (dragstart)="dragIndex = i"
            (dragover)="onDragOver($event, i)"
            (drop)="onDrop($event, i)"
            (dragend)="endDrag()">
          <button class="thumb-button" type="button" (click)="pageSelected.emit(i + 1)">
            @if (doc) {
              <app-pdf-thumb [doc]="doc" [page]="page.source" [rotation]="page.rotate"
                             [width]="120" [showLabel]="false" />
            }
            <span class="position mono">{{ i + 1 }}</span>
          </button>
          <div class="page-actions">
            <button type="button" title="Girar 90°" (click)="rotate.emit(i)">⟳</button>
            <button type="button" class="danger" title="Eliminar página"
                    (click)="remove.emit(i)" [disabled]="pages.length <= 1">×</button>
          </div>
        </li>
      }
    </ol>
    <p class="panel-hint">Arrastra una miniatura para reordenar.</p>
  `,
  styles: [`
    :host { display: block; }
    .panel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.6rem; }
    .eyebrow { text-transform: uppercase; letter-spacing: 0.1em; font-size: 0.68rem; color: var(--ink-soft); margin: 0; }
    .count { font-size: 0.8rem; color: var(--ink-soft); }
    .mono { font-variant-numeric: tabular-nums; }

    .page-list {
      list-style: none; margin: 0; padding: 0;
      display: grid; gap: 0.5rem;
      /* Igual que el lienzo: descuenta la cinta y la barra fija del pie. */
      max-height: calc(100vh - 380px); overflow-y: auto;
    }
    .page-item {
      display: grid; grid-template-columns: 1fr auto; gap: 0.35rem; align-items: center;
      border: 1px solid transparent; border-radius: 10px; padding: 0.3rem;
      cursor: grab;
      &.current { border-color: var(--cobalt); background: var(--cobalt-soft); }
      &.dragging { opacity: 0.45; }
      &.drop-target { border-color: var(--cobalt); border-style: dashed; }
    }
    .thumb-button {
      position: relative; border: none; background: none; padding: 0; cursor: pointer;
      display: block; width: 100%; min-width: 0;
    }
    .position {
      position: absolute; left: 4px; bottom: 4px;
      background: rgba(20, 33, 61, 0.78); color: #fff;
      font-size: 0.68rem; padding: 0 5px; border-radius: 4px;
    }
    .page-actions { display: grid; gap: 0.25rem; }
    .page-actions button {
      width: 26px; height: 26px; border: 1px solid var(--line); border-radius: 6px;
      background: #fff; cursor: pointer; font-size: 0.85rem; line-height: 1;
      &:disabled { opacity: 0.4; cursor: not-allowed; }
      &.danger:hover:not(:disabled) { color: #b42318; border-color: #f1b3ac; }
    }
    .panel-hint { font-size: 0.75rem; color: var(--ink-soft); margin: 0.6rem 0 0; }
  `],
})
export class PagesPanelComponent {
  @Input() doc: PdfDocHandle | null = null;
  @Input() pages: PageItem[] = [];
  @Input() currentPage = 1;

  @Output() pageSelected = new EventEmitter<number>();
  @Output() reorder = new EventEmitter<{ from: number; to: number }>();
  @Output() rotate = new EventEmitter<number>();
  @Output() remove = new EventEmitter<number>();

  dragIndex: number | null = null;
  dragOverIndex: number | null = null;

  onDragOver(event: DragEvent, index: number): void {
    event.preventDefault();
    this.dragOverIndex = index;
  }

  onDrop(event: DragEvent, index: number): void {
    event.preventDefault();
    if (this.dragIndex !== null && this.dragIndex !== index) {
      this.reorder.emit({ from: this.dragIndex, to: index });
    }
    this.endDrag();
  }

  endDrag(): void {
    this.dragIndex = null;
    this.dragOverIndex = null;
  }
}
