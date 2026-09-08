import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TOOL_CATALOG } from '../../core/tool-catalog';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <!-- Hero: la tesis es la privacidad — los archivos no salen de la red -->
    <section class="pt-14 pb-8 text-center">
      <p class="eyebrow mb-4">Herramientas PDF internas</p>
      <h1 class="font-display text-4xl md:text-5xl font-bold leading-tight max-w-3xl mx-auto">
        Trabaja tus PDF sin que<br class="hidden md:block">
        salgan de tu red
      </h1>
      <p class="mt-5 text-lg text-ink-soft max-w-2xl mx-auto">
        Comprime, divide, une, firma y protege documentos en segundos.
        Todo se procesa en el servidor interno y los archivos se eliminan a las 24 horas.
      </p>
    </section>

    <!-- Entrada principal: el documento primero, la función después -->
    <section class="pb-10">
      <a class="studio-cta no-underline text-inherit" routerLink="/estudio">
        <span class="tool-chip" style="background:#eaefff">
          <span class="material-icons" style="color:#2e5bff">auto_awesome_motion</span>
        </span>
        <span class="studio-cta-body">
          <strong class="font-display text-lg">Abrir el Estudio</strong>
          <span class="text-sm text-ink-soft">
            Reordena, marca, firma y comprime el mismo documento sin descargar nada
            en medio. Una sola descarga, al final.
          </span>
        </span>
        <span class="material-icons studio-cta-arrow">arrow_forward</span>
      </a>
    </section>

    <!-- Acciones rápidas: para quien ya sabe exactamente qué quiere -->
    <section class="pb-16">
      <p class="section-label">Acciones rápidas</p>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        @for (tool of tools; track tool.id) {
          <a class="sheet block p-6 no-underline text-inherit" [routerLink]="tool.route">
            <span class="tool-chip" [style.background]="tool.hueSoft">
              <span class="material-icons" [style.color]="tool.hue">{{ tool.icon }}</span>
            </span>
            <h2 class="font-display text-lg font-semibold mt-4 mb-1">{{ tool.title }}</h2>
            <p class="text-sm text-ink-soft leading-relaxed m-0">{{ tool.description }}</p>
          </a>
        }
      </div>
    </section>

    <!-- Señales de confianza -->
    <section class="border-t border-line py-10 mb-4">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-8 text-center">
        <div>
          <span class="material-icons text-cobalt">dns</span>
          <h3 class="font-display font-semibold mt-2 mb-1">Procesado en tu red</h3>
          <p class="text-sm text-ink-soft m-0">Los documentos nunca se envían a servicios externos.</p>
        </div>
        <div>
          <span class="material-icons text-cobalt">auto_delete</span>
          <h3 class="font-display font-semibold mt-2 mb-1">Borrado automático</h3>
          <p class="text-sm text-ink-soft m-0">Cada archivo se elimina del servidor a las 24 horas.</p>
        </div>
        <div>
          <span class="material-icons text-cobalt">verified_user</span>
          <h3 class="font-display font-semibold mt-2 mb-1">Firma con tu certificado</h3>
          <p class="text-sm text-ink-soft m-0">El certificado se usa una sola vez y se descarta al firmar.</p>
        </div>
      </div>
    </section>
  `,
  styles: [`
    .section-label {
      font-size: 0.78rem; font-weight: 700; letter-spacing: 0.04em;
      text-transform: uppercase; color: var(--ink-soft); margin: 0 0 1rem;
    }
    .studio-cta {
      display: flex; align-items: center; gap: 1.1rem;
      border: 1px solid var(--cobalt); border-radius: 14px;
      background: linear-gradient(180deg, #fff, #f7f9ff);
      padding: 1.35rem 1.5rem;
      box-shadow: 0 8px 30px rgba(46, 91, 255, 0.08);
      transition: box-shadow 0.15s ease, transform 0.15s ease;
    }
    .studio-cta:hover { box-shadow: 0 12px 36px rgba(46, 91, 255, 0.16); transform: translateY(-1px); }
    .studio-cta-body { display: grid; gap: 0.25rem; }
    .studio-cta-arrow { margin-left: auto; color: var(--cobalt); }
  `],
})
export class HomeComponent {
  tools = TOOL_CATALOG;
}
