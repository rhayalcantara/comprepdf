import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { PdfDocHandle } from './pdf-preview.service';
import { PdfThumbComponent } from './pdf-thumb.component';

/**
 * Grid de todas las páginas de un documento. Los thumbs renderizan lazy, así
 * que documentos grandes solo pintan lo visible.
 */
@Component({
  selector: 'app-pdf-page-grid',
  standalone: true,
  imports: [PdfThumbComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="thumb-grid">
      @for (p of pages(); track p) {
        <app-pdf-thumb
          [doc]="doc()"
          [page]="p"
          [width]="thumbWidth()"
          [selectable]="selectable()"
          [selected]="selected().has(p)"
          [rotation]="rotationFor(p)"
          (toggled)="pageToggle.emit($event)" />
      }
    </div>
  `,
  styles: [`
    .thumb-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
      gap: 12px;
    }
  `],
})
export class PdfPageGridComponent {
  doc = input.required<PdfDocHandle>();
  selected = input<ReadonlySet<number>>(new Set<number>());
  selectable = input(true);
  /** Grados a aplicar (preview CSS) según rotateScope. */
  rotation = input(0);
  rotateScope = input<'all' | 'selected' | 'none'>('none');
  thumbWidth = input(140);
  pageToggle = output<number>();

  pages = computed(() => Array.from({ length: this.doc().pageCount }, (_, i) => i + 1));

  rotationFor(page: number): number {
    const scope = this.rotateScope();
    if (scope === 'all') return this.rotation();
    if (scope === 'selected' && this.selected().has(page)) return this.rotation();
    return 0;
  }
}
