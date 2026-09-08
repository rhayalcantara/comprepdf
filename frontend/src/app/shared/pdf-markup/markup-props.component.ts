import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MarkupElement, isShape, typeLabel } from './markup-element';

/**
 * Panel de propiedades del elemento seleccionado. Compartido por `/editor` y el
 * Estudio: edita el objeto EN SITIO (los inputs escriben sobre `element`), así
 * que el contenedor no necesita re-sincronizar nada.
 */
@Component({
  selector: 'app-markup-props',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    @if (element; as el) {
      <div class="props-heading">
        <div><p class="eyebrow">Elemento</p><h2>{{ label(el) }}</h2></div>
        <button class="icon-button danger" type="button" title="Eliminar"
                (click)="remove.emit(el)">×</button>
      </div>

      @if (shape(el)) {
        <label class="field">
          <span>Color</span>
          <input type="color" [(ngModel)]="el.color" />
        </label>
        @if (el.type !== 'highlight') {
          <label class="field">
            <span>Grosor del trazo ({{ el.strokeWidth }} pt)</span>
            <input type="range" min="0.5" max="12" step="0.5"
                   [ngModel]="el.strokeWidth" (ngModelChange)="el.strokeWidth = +$event" />
          </label>
        }
        @if (el.type === 'line' || el.type === 'arrow') {
          <label class="field">
            <span>Dirección</span>
            <select [(ngModel)]="el.dir">
              <option value="up">↗ Ascendente</option>
              <option value="down">↘ Descendente</option>
            </select>
          </label>
        }
        @if (el.type === 'mark') {
          <label class="field">
            <span>Tipo de marca</span>
            <select [(ngModel)]="el.mark">
              <option value="check">✓ Verificación</option>
              <option value="cross">✗ Cruz</option>
              <option value="dot">● Punto</option>
            </select>
          </label>
        }
        @if (el.type === 'callout') {
          <label class="field">
            <span>Texto</span>
            <textarea rows="2" [(ngModel)]="el.text"></textarea>
          </label>
          <label class="field">
            <span>Tamaño de letra</span>
            <input type="number" min="4" max="96" [(ngModel)]="el.fontSize" />
          </label>
          <p class="panel-hint">Arrastra el punto rojo para apuntar la flecha.</p>
        }
        @if (el.type === 'stamp') {
          <label class="field">
            <span>Texto del sello</span>
            <input maxlength="60" [(ngModel)]="el.text" />
          </label>
          <label class="check-field">
            <input type="checkbox" [(ngModel)]="el.showDatetime" />
            <span>Incluir fecha y hora (la pone el servidor al aplicar)</span>
          </label>
        }
        <p class="panel-hint">Arrastra el recuadro para mover y la esquina para cambiar el tamaño.</p>
      } @else if (el.type !== 'image') {
        <label class="field">
          <span>{{ el.type === 'whiteout' ? 'Texto encima (opcional)' : 'Texto' }}</span>
          <textarea rows="3" [(ngModel)]="el.text"></textarea>
        </label>
        <label class="field">
          <span>Tamaño de letra</span>
          <input type="number" min="4" max="96" [(ngModel)]="el.fontSize" />
        </label>
        <label class="field">
          <span>Color del texto</span>
          <input type="color" [(ngModel)]="el.type === 'whiteout' ? el.textColor : el.color" />
        </label>
        @if (el.type === 'whiteout') {
          <label class="field">
            <span>Color del recuadro</span>
            <input type="color" [(ngModel)]="el.color" />
          </label>
        }
      } @else {
        <p class="panel-hint">Arrastra el recuadro para mover la imagen y la esquina para cambiar su tamaño. Mantiene su proporción.</p>
      }
    } @else {
      <div class="empty-props">
        <strong>Nada seleccionado</strong>
        <span>Añade un elemento o selecciónalo en la página para editarlo.</span>
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .props-heading { display: flex; align-items: flex-start; justify-content: space-between; }
    .props-heading h2 { font-size: 1.05rem; margin: 0.2rem 0 0.75rem; color: #14213d; }
    .eyebrow { text-transform: uppercase; letter-spacing: 0.1em; font-size: 0.68rem; color: var(--ink-soft); margin: 0; }
    .icon-button { border: none; background: none; font-size: 1.2rem; cursor: pointer; color: var(--ink-soft); }
    .icon-button.danger:hover { color: #b42318; }
    .panel-hint { font-size: 0.78rem; color: var(--ink-soft); margin: 0.5rem 0 0; }
    .field { display: grid; gap: 0.3rem; margin-bottom: 0.75rem; }
    .field span { font-size: 0.8rem; color: var(--ink-soft); }
    .field input, .field textarea, .field select {
      border: 1px solid var(--line); border-radius: 8px; padding: 0.45rem 0.55rem; font: inherit; width: 100%;
    }
    .field input[type="range"] { border: none; padding: 0; }
    .field input[type="color"] { height: 38px; padding: 2px; }
    .check-field {
      display: flex; align-items: flex-start; gap: 0.45rem; margin-bottom: 0.75rem;
      font-size: 0.8rem; color: var(--ink-soft); cursor: pointer;
      input { width: auto; margin-top: 2px; }
    }
    .empty-props { display: grid; gap: 0.3rem; color: var(--ink-soft); font-size: 0.85rem; }
    .empty-props strong { color: var(--ink); }
  `],
})
export class MarkupPropsComponent {
  @Input() element?: MarkupElement;
  @Output() remove = new EventEmitter<MarkupElement>();

  shape = isShape;
  label = typeLabel;
}
