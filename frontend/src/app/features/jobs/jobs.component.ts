import { Component, OnInit, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { ApiService, JobSummary, Pagination } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';

/** Etiquetas legibles de cada operación para la tabla. */
const OPERATION_LABELS: Record<string, string> = {
  compress: 'Comprimir',
  split: 'Dividir',
  merge: 'Unir',
  sign: 'Firmar',
  extract: 'Extraer',
  rotate: 'Rotar',
  protect: 'Proteger',
  unlock: 'Desbloquear',
  certificate: 'Certificado',
  form_generate: 'Formulario',
  pdf_edit: 'Editar',
  organize: 'Ordenar páginas',
  convert: 'Convertir',
  pdf_to_word: 'PDF a Word',
  pdf_to_excel: 'PDF a Excel',
  translate: 'Traducir',
};

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pendiente',
  processing: 'Procesando',
  completed: 'Completado',
  failed: 'Fallido',
};

@Component({
  selector: 'app-jobs',
  standalone: true,
  imports: [CommonModule, MatSnackBarModule],
  template: `
    <div class="max-w-5xl mx-auto pt-8 pb-16">
      <header class="flex flex-wrap items-center gap-4 mb-6">
        <div class="flex-1">
          <h1 class="font-display text-2xl md:text-3xl font-bold m-0">Mis trabajos</h1>
          <p class="text-ink-soft m-0 mt-1">
            Historial de operaciones. Los archivos se eliminan a las 24 horas.
          </p>
        </div>
        @if (isAdmin()) {
          <label class="all-toggle">
            <input type="checkbox" [checked]="showAll()" (change)="toggleAll($event)">
            <span>Ver todos los usuarios</span>
          </label>
        }
      </header>

      <div class="sheet p-0 overflow-hidden">
        @if (loading()) {
          <p class="text-ink-soft text-center py-10 m-0">Cargando…</p>
        } @else if (jobs().length === 0) {
          <p class="text-ink-soft text-center py-10 m-0">Aún no hay trabajos que mostrar.</p>
        } @else {
          <div class="table-wrap">
            <table class="jobs-table">
              <thead>
                <tr>
                  <th>Operación</th>
                  <th>Archivo</th>
                  @if (showAll()) { <th>Usuario</th> }
                  <th>Estado</th>
                  <th>Fecha</th>
                  <th class="text-right">Acciones</th>
                </tr>
              </thead>
              <tbody>
                @for (job of jobs(); track job.jobId) {
                  <tr>
                    <td>{{ operationLabel(job.operationType) }}</td>
                    <td class="filename" [title]="job.outputFilename || job.originalFilename || ''">
                      {{ job.outputFilename || job.originalFilename || '—' }}
                    </td>
                    @if (showAll()) {
                      <td>{{ job.username || '(huérfano)' }}</td>
                    }
                    <td>
                      <span class="badge"
                            [class.badge-ok]="job.status === 'completed'"
                            [class.badge-fail]="job.status === 'failed'"
                            [class.badge-wait]="job.status === 'pending' || job.status === 'processing'">
                        {{ statusLabel(job.status) }}
                      </span>
                    </td>
                    <td class="mono text-sm text-ink-soft">{{ job.createdAt | date:'dd/MM/yyyy HH:mm' }}</td>
                    <td class="text-right actions">
                      @if (job.status === 'completed' && job.downloadUrl) {
                        @if (isExpired(job)) {
                          <span class="expired" title="El archivo expiró (24 h) y ya no está disponible">Expirado</span>
                        } @else {
                          <button class="icon-btn" (click)="download(job)" title="Descargar" aria-label="Descargar">
                            <span class="material-icons">download</span>
                          </button>
                        }
                      }
                      <button class="icon-btn danger" (click)="remove(job)" title="Borrar" aria-label="Borrar">
                        <span class="material-icons">delete_outline</span>
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>

          <!-- Paginación -->
          @if (pagination(); as p) {
            <div class="pager">
              <span class="text-sm text-ink-soft">
                {{ p.total }} trabajo(s) · página {{ p.page }} de {{ p.totalPages || 1 }}
              </span>
              <div class="flex gap-2">
                <button class="btn-ghost btn-sm" [disabled]="p.page <= 1 || loading()" (click)="goto(p.page - 1)">
                  Anterior
                </button>
                <button class="btn-ghost btn-sm" [disabled]="p.page >= p.totalPages || loading()" (click)="goto(p.page + 1)">
                  Siguiente
                </button>
              </div>
            </div>
          }
        }
      </div>
    </div>
  `,
  styles: [`
    .all-toggle { display:inline-flex; align-items:center; gap:0.5rem; font-size:0.9rem; color:var(--ink); cursor:pointer; user-select:none; }
    .all-toggle input { accent-color:var(--cobalt); width:16px; height:16px; cursor:pointer; }
    .table-wrap { overflow-x:auto; }
    .jobs-table { width:100%; border-collapse:collapse; }
    .jobs-table th { text-align:left; font-size:0.78rem; text-transform:uppercase; letter-spacing:0.03em; color:var(--ink-soft); padding:0.75rem 1rem; border-bottom:1px solid var(--line); white-space:nowrap; }
    .jobs-table td { padding:0.75rem 1rem; border-bottom:1px solid var(--line); vertical-align:middle; }
    .jobs-table tbody tr:last-child td { border-bottom:none; }
    .filename { max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .badge { display:inline-block; padding:0.15rem 0.6rem; border-radius:999px; font-size:0.78rem; font-weight:600; background:var(--mist); color:var(--ink-soft); }
    .badge-ok { background:var(--ok-soft); color:#0f7b4a; }
    .badge-fail { background:var(--danger-soft); color:var(--danger); }
    .badge-wait { background:var(--cobalt-soft); color:var(--cobalt-deep); }
    .actions { white-space:nowrap; }
    .actions .icon-btn { display:inline-flex; }
    .icon-btn.danger:hover { background:var(--danger-soft); color:var(--danger); }
    .expired { font-size:0.8rem; color:var(--ink-soft); font-style:italic; margin-right:0.35rem; }
    .pager { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:0.85rem 1rem; border-top:1px solid var(--line); flex-wrap:wrap; }
    .btn-sm { padding:0.45rem 1rem; font-size:0.9rem; }
  `]
})
export class JobsComponent implements OnInit {
  jobs = signal<JobSummary[]>([]);
  pagination = signal<Pagination | null>(null);
  loading = signal(false);
  showAll = signal(false);
  private page = signal(1);

  isAdmin = computed(() => this.auth.isAdmin());

  constructor(
    private api: ApiService,
    private auth: AuthService,
    private snackBar: MatSnackBar,
  ) {}

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.api.listJobs(this.page(), 20, this.showAll()).subscribe({
      next: (res) => {
        this.loading.set(false);
        if (res.success && res.data) {
          this.jobs.set(res.data.items);
          this.pagination.set(res.data.pagination);
        }
      },
      error: () => {
        this.loading.set(false);
        this.snackBar.open('No se pudo cargar el historial.', 'Cerrar', { duration: 3000 });
      },
    });
  }

  toggleAll(event: Event): void {
    this.showAll.set((event.target as HTMLInputElement).checked);
    this.page.set(1);
    this.load();
  }

  goto(page: number): void {
    if (page < 1) return;
    this.page.set(page);
    this.load();
  }

  isExpired(job: JobSummary): boolean {
    return !!job.expiresAt && new Date(job.expiresAt).getTime() <= Date.now();
  }

  operationLabel(op: string): string {
    return OPERATION_LABELS[op] || op;
  }

  statusLabel(status: string): string {
    return STATUS_LABELS[status] || status;
  }

  download(job: JobSummary): void {
    this.api.downloadFile(job.jobId).subscribe({
      next: (blob) => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = job.outputFilename || job.originalFilename || 'archivo';
        a.click();
        window.URL.revokeObjectURL(url);
      },
      error: () => this.snackBar.open('No se pudo descargar el archivo.', 'Cerrar', { duration: 3000 }),
    });
  }

  remove(job: JobSummary): void {
    if (!confirm('¿Borrar este trabajo y su archivo? Esta acción no se puede deshacer.')) return;
    this.api.deleteJob(job.jobId).subscribe({
      next: () => {
        this.snackBar.open('Trabajo borrado.', 'Cerrar', { duration: 2500 });
        this.load();
      },
      error: () => this.snackBar.open('No se pudo borrar el trabajo.', 'Cerrar', { duration: 3000 }),
    });
  }
}
