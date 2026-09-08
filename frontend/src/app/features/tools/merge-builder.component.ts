import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  inject,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { PdfDocHandle, PdfPreviewService } from '../../shared/pdf-preview/pdf-preview.service';
import { PdfThumbComponent } from '../../shared/pdf-preview/pdf-thumb.component';

/** Un archivo de la lista de unión, con su vista previa y páginas a incluir. */
interface MergeItem {
  /** Clave estable para @for/track y para localizar el item tras async. */
  key: number;
  file: File;
  doc: PdfDocHandle | null;
  pageCount: number;
  status: 'loading' | 'ready' | 'password' | 'error';
  /** Spec de páginas a incluir; vacío = todas. */
  pages: string;
}

/** Entrada expuesta al componente padre: archivo + selección de páginas. */
export interface MergeEntry {
  file: File;
  /** '' = todas; o una lista tipo "1-3,5". */
  pages: string;
  pageCount: number;
  ready: boolean;
}

/**
 * Constructor visual de la unión de PDFs: miniatura de cada archivo, arrastrar
 * para reordenar y selección de páginas por documento. Gestiona su propia lista
 * y emite el orden + rangos al padre en cada cambio.
 */
@Component({
  selector: 'app-merge-builder',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, DragDropModule, PdfThumbComponent],
  template: `
    <label class="dropzone" [class.dragging]="isDragging()"
           (dragover)="onDragOver($event)" (dragleave)="onDragLeave($event)" (drop)="onDrop($event)">
      <span class="material-icons">upload_file</span>
      <p class="mt-2 mb-1 font-medium">Arrastra tus PDFs aquí o haz clic para seleccionar</p>
      <p class="text-sm text-ink-soft m-0">Se unirán en el orden mostrado — arrastra para reordenar</p>
      <input type="file" accept=".pdf" multiple hidden (change)="onPick($event)">
    </label>

    @if (items().length) {
      <div cdkDropList class="merge-list mt-4" (cdkDropListDropped)="drop($event)">
        @for (it of items(); track it.key; let i = $index) {
          <div class="merge-card" cdkDrag cdkDragLockAxis="y">
            <button type="button" class="drag-handle" cdkDragHandle aria-label="Reordenar">
              <span class="material-icons">drag_indicator</span>
            </button>
            <span class="order mono">{{ i + 1 }}</span>

            <div class="merge-thumb">
              @switch (it.status) {
                @case ('ready') {
                  @if (it.doc) {
                    <app-pdf-thumb [doc]="it.doc" [page]="1" [width]="80" [showLabel]="false" />
                  }
                }
                @case ('loading') {
                  <span class="material-icons spin">progress_activity</span>
                }
                @default {
                  <span class="material-icons ph">description</span>
                }
              }
            </div>

            <div class="merge-meta">
              <span class="merge-name truncate">{{ it.file.name }}</span>
              <span class="merge-sub mono">
                {{ formatSize(it.file.size) }}
                @switch (it.status) {
                  @case ('ready') { · {{ it.pageCount }} pág. }
                  @case ('password') { · protegido }
                  @case ('error') { · sin vista previa }
                }
              </span>
            </div>

            @if (it.status === 'ready') {
              <label class="pages-field">
                <span class="pages-label">Páginas</span>
                <input class="input mono pages-input" [ngModel]="it.pages"
                       (ngModelChange)="setPages(it.key, $event)"
                       [placeholder]="'Todas'" [attr.aria-label]="'Páginas de ' + it.file.name">
              </label>
            }

            <button type="button" class="icon-btn" (click)="remove(it.key)" aria-label="Quitar archivo">
              <span class="material-icons">close</span>
            </button>
          </div>
        }
      </div>
      <p class="text-sm text-ink-soft mt-2 mb-0">
        Deja <strong>Páginas</strong> vacío para incluir el documento completo, o indica un rango (ej: 1-3,5).
      </p>
    }
  `,
  styles: [`
    :host { display: block; }

    .merge-list {
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
    }

    .merge-card {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      padding: 0.6rem 0.75rem;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--paper);
    }

    .merge-card.cdk-drag-preview {
      box-shadow: 0 8px 24px rgba(18, 35, 63, 0.18);
      border-color: var(--cobalt);
    }

    .merge-card.cdk-drag-placeholder { opacity: 0.35; }

    .cdk-drag-animating { transition: transform 0.2s cubic-bezier(0, 0, 0.2, 1); }
    .merge-list.cdk-drop-list-dragging .merge-card:not(.cdk-drag-placeholder) {
      transition: transform 0.2s cubic-bezier(0, 0, 0.2, 1);
    }

    .drag-handle {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border: none;
      background: none;
      color: #9aa7ba;
      cursor: grab;
      flex-shrink: 0;
    }
    .drag-handle:active { cursor: grabbing; }
    .drag-handle .material-icons { font-size: 20px; }

    .order {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border-radius: 6px;
      background: var(--cobalt-soft);
      color: var(--cobalt);
      font-size: 0.75rem;
      font-weight: 500;
      flex-shrink: 0;
    }

    .merge-thumb {
      width: 44px;
      height: 58px;
      flex-shrink: 0;
      display: grid;
      place-items: center;
      color: #9aa7ba;
    }
    .merge-thumb .ph { font-size: 26px; }
    .merge-thumb .spin { animation: spin 1s linear infinite; font-size: 22px; }

    @keyframes spin { to { transform: rotate(360deg); } }

    .merge-meta {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
      flex: 1;
    }
    .merge-name { font-weight: 500; }
    .merge-sub { font-size: 0.75rem; color: var(--ink-soft); }

    .pages-field {
      display: flex;
      flex-direction: column;
      gap: 2px;
      flex-shrink: 0;
    }
    .pages-label {
      font-size: 0.7rem;
      font-weight: 600;
      color: var(--ink-soft);
    }
    .pages-input {
      width: 6.5rem;
      padding: 0.3rem 0.5rem;
      font-size: 0.85rem;
    }

    @media (max-width: 520px) {
      .pages-input { width: 4.5rem; }
    }
  `],
})
export class MergeBuilderComponent implements OnDestroy {
  private pdfPreview = inject(PdfPreviewService);

  items = signal<MergeItem[]>([]);
  isDragging = signal(false);

  /** Orden y selección de páginas actuales (paralelos entre sí). */
  entriesChange = output<MergeEntry[]>();

  private nextKey = 1;

  ngOnDestroy(): void {
    for (const it of this.items()) void it.doc?.destroy();
  }

  // --- Alta de archivos ---
  onPick(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.addFiles(Array.from(input.files ?? []));
    input.value = '';
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.isDragging.set(true);
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.isDragging.set(false);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.isDragging.set(false);
    const files = Array.from(event.dataTransfer?.files ?? [])
      .filter((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    this.addFiles(files);
  }

  private addFiles(files: File[]): void {
    if (!files.length) return;
    const added: MergeItem[] = files.map((file) => ({
      key: this.nextKey++,
      file,
      doc: null,
      pageCount: 0,
      status: 'loading',
      pages: '',
    }));
    this.items.update((list) => [...list, ...added]);
    this.emit();
    for (const it of added) void this.load(it);
  }

  /** Abre el PDF con pdf.js para la miniatura y el conteo de páginas. */
  private async load(item: MergeItem): Promise<void> {
    try {
      const doc = await this.pdfPreview.open(item.file);
      // Si el item se quitó mientras cargaba, liberar el documento.
      if (!this.items().some((it) => it.key === item.key)) {
        void doc.destroy();
        return;
      }
      this.patch(item.key, { doc, pageCount: doc.pageCount, status: 'ready' });
    } catch (e) {
      this.patch(item.key, { status: e === 'password' ? 'password' : 'error' });
    }
  }

  // --- Mutaciones ---
  drop(event: CdkDragDrop<MergeItem[]>): void {
    if (event.previousIndex === event.currentIndex) return;
    this.items.update((list) => {
      const next = [...list];
      moveItemInArray(next, event.previousIndex, event.currentIndex);
      return next;
    });
    this.emit();
  }

  setPages(key: number, value: string): void {
    this.patch(key, { pages: value });
  }

  remove(key: number): void {
    const target = this.items().find((it) => it.key === key);
    void target?.doc?.destroy();
    this.items.update((list) => list.filter((it) => it.key !== key));
    this.emit();
  }

  private patch(key: number, changes: Partial<MergeItem>): void {
    this.items.update((list) => list.map((it) => (it.key === key ? { ...it, ...changes } : it)));
    this.emit();
  }

  private emit(): void {
    this.entriesChange.emit(
      this.items().map((it) => ({
        file: it.file,
        pages: it.pages,
        pageCount: it.pageCount,
        ready: it.status === 'ready',
      })),
    );
  }

  formatSize(bytes: number): string {
    if (!bytes) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}
