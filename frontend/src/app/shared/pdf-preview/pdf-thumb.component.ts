import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  ViewChild,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { PdfDocHandle } from './pdf-preview.service';

/**
 * Miniatura de UNA página de PDF. Renderiza lazy: solo cuando entra al
 * viewport (IntersectionObserver). La rotación es un transform CSS — preview
 * instantáneo sin re-render de pdf.js.
 */
@Component({
  selector: 'app-pdf-thumb',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="thumb-frame"
         [class.selected]="selected()"
         [class.selectable]="selectable()"
         (click)="onClick()"
         [attr.role]="selectable() ? 'checkbox' : null"
         [attr.aria-checked]="selectable() ? selected() : null"
         [attr.tabindex]="selectable() ? 0 : null"
         (keydown.enter)="onClick()"
         (keydown.space)="onClick(); $event.preventDefault()">
      <canvas #canvas
              [style.transform]="'rotate(' + rotation() + 'deg)'"
              [style.visibility]="state() === 'rendered' ? 'visible' : 'hidden'"></canvas>
      @if (state() !== 'rendered') {
        <span class="thumb-ph mono">{{ state() === 'failed' ? '!' : page() }}</span>
      }
      @if (selected()) {
        <span class="thumb-check material-icons">check_circle</span>
      }
    </div>
    @if (showLabel()) {
      <p class="thumb-label mono">{{ page() }}</p>
    }
  `,
  styles: [`
    :host {
      display: block;
      width: 100%;
    }

    .thumb-frame {
      position: relative;
      aspect-ratio: 3 / 4;
      display: grid;
      place-items: center;
      overflow: hidden;
      background: var(--mist);
      border: 1px solid var(--line);
      border-radius: 8px;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }

    .thumb-frame.selectable {
      cursor: pointer;
    }

    .thumb-frame.selectable:hover {
      border-color: var(--cobalt);
    }

    .thumb-frame.selectable:focus-visible {
      outline: 2px solid var(--cobalt);
      outline-offset: 2px;
    }

    .thumb-frame.selected {
      border-color: var(--cobalt);
      box-shadow: inset 0 0 0 1px var(--cobalt);
      background: var(--cobalt-soft);
    }

    canvas {
      max-width: 100%;
      max-height: 100%;
      box-shadow: 0 1px 3px rgba(18, 35, 63, 0.15);
      transition: transform 0.25s ease;
    }

    .thumb-ph {
      position: absolute;
      font-size: 1.1rem;
      color: #9aa7ba;
    }

    .thumb-check {
      position: absolute;
      top: 4px;
      right: 4px;
      font-size: 20px;
      color: var(--cobalt);
      background: #fff;
      border-radius: 50%;
      line-height: 1;
    }

    .thumb-label {
      margin: 0.35rem 0 0;
      text-align: center;
      font-size: 0.75rem;
      color: var(--ink-soft);
    }
  `],
})
export class PdfThumbComponent implements OnDestroy {
  doc = input.required<PdfDocHandle>();
  /** Página 1-based. */
  page = input.required<number>();
  /** Ancho de render en px CSS (el canvas escala al frame). */
  width = input(140);
  /** 0 | 90 | 180 | 270 — solo CSS, no re-renderiza. */
  rotation = input(0);
  selected = input(false);
  selectable = input(false);
  showLabel = input(true);
  toggled = output<number>();

  state = signal<'pending' | 'rendered' | 'failed'>('pending');

  @ViewChild('canvas', { static: true }) private canvasRef!: ElementRef<HTMLCanvasElement>;

  private observer: IntersectionObserver | null = null;

  constructor(private host: ElementRef<HTMLElement>, private zone: NgZone) {
    // Nuevo documento o página → volver a estado pendiente y re-observar.
    effect(() => {
      this.doc();
      this.page();
      this.state.set('pending');
      this.observe();
    }, { allowSignalWrites: true });
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }

  private observe(): void {
    this.observer?.disconnect();
    this.zone.runOutsideAngular(() => {
      this.observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            this.observer?.disconnect();
            void this.renderNow();
          }
        },
        { rootMargin: '200px' },
      );
      this.observer.observe(this.host.nativeElement);
    });
  }

  private async renderNow(): Promise<void> {
    try {
      await this.doc().render(this.page(), this.canvasRef.nativeElement, this.width());
      this.zone.run(() => this.state.set('rendered'));
    } catch {
      this.zone.run(() => this.state.set('failed'));
    }
  }

  onClick(): void {
    if (this.selectable()) {
      this.toggled.emit(this.page());
    }
  }
}
