import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { interval, switchMap, takeWhile } from 'rxjs';
import {
  ApiService,
  CertificateRecord,
  IssueCertificatePayload,
  JobResponse,
} from '../../core/services/api.service';

const ADMIN_KEY_STORAGE = 'cert_admin_key';

@Component({
  selector: 'app-certificates',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, MatProgressBarModule, MatSnackBarModule],
  template: `
    <div class="max-w-4xl mx-auto pt-8 pb-16">

      <a routerLink="/" class="back-link">
        <span class="material-icons">arrow_back</span>
        Todas las herramientas
      </a>

      <header class="flex items-center gap-4 mt-4 mb-6">
        <span class="tool-chip" style="background:#e6f4ec">
          <span class="material-icons" style="color:#0f7b4a">badge</span>
        </span>
        <div>
          <h1 class="font-display text-2xl md:text-3xl font-bold m-0">Certificados</h1>
          <p class="text-ink-soft m-0 mt-1">Emite certificados digitales internos firmados por la CA de la cooperativa. Solo TI.</p>
        </div>
      </header>

      <!-- Clave de administrador -->
      @if (!adminKey()) {
        <div class="sheet p-6 md:p-8">
          <p class="field-label mb-1">Clave de administrador</p>
          <p class="text-sm text-ink-soft mt-0 mb-3">
            Este módulo está restringido. Introduce la clave de administrador (CERT_ADMIN_KEY) para continuar.
          </p>
          <div class="flex gap-2">
            <input class="input flex-1" type="password" [(ngModel)]="keyInput"
                   placeholder="Clave de administrador" (keyup.enter)="saveKey()">
            <button class="btn-cta" [disabled]="!keyInput.trim()" (click)="saveKey()">Continuar</button>
          </div>
        </div>
      } @else {
        <div class="flex items-center gap-2 text-sm text-ink-soft mb-4">
          <span class="material-icons" style="font-size:18px;color:#0f7b4a">lock</span>
          <span>Sesión de administrador activa.</span>
          <button class="link-btn" (click)="forgetKey()">Cambiar clave</button>
        </div>

        <!-- Formulario de emisión -->
        <div class="sheet p-6 md:p-8">
          <h2 class="font-display text-lg font-bold m-0 mb-4">Emitir certificado</h2>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label class="field">
              <span class="field-label">Nombre del empleado *</span>
              <input class="input" [(ngModel)]="form.nombre" maxlength="120" placeholder="p. ej. Juan Pérez">
            </label>
            <label class="field">
              <span class="field-label">Departamento</span>
              <input class="input" [(ngModel)]="form.departamento" maxlength="120" placeholder="p. ej. Contabilidad">
            </label>
            <label class="field">
              <span class="field-label">Cédula</span>
              <input class="input" [(ngModel)]="form.cedula" maxlength="40" placeholder="000-0000000-0">
            </label>
            <label class="field">
              <span class="field-label">Correo</span>
              <input class="input" type="email" [(ngModel)]="form.email" maxlength="255" placeholder="empleado@coopaspire.com.do">
            </label>
            <label class="field">
              <span class="field-label">Contraseña del .pfx *</span>
              <input class="input" type="password" [(ngModel)]="form.pfxPassword" maxlength="200"
                     placeholder="Protege el archivo del empleado">
            </label>
            <label class="field">
              <span class="field-label">Vigencia</span>
              <select class="input" [(ngModel)]="form.validityYears">
                <option [ngValue]="1">1 año</option>
                <option [ngValue]="2">2 años</option>
                <option [ngValue]="3">3 años</option>
                <option [ngValue]="4">4 años</option>
                <option [ngValue]="5">5 años</option>
              </select>
            </label>
          </div>

          <p class="text-sm text-ink-soft mt-3 mb-0">
            Indica al menos cédula o correo como identificador del empleado. La contraseña se entrega al empleado junto con su archivo.
          </p>

          <div class="mt-6 flex justify-end">
            <button class="btn-cta" [disabled]="!canSubmit() || isProcessing()" (click)="issue()">
              @if (isProcessing()) { Emitiendo… } @else { Emitir certificado }
            </button>
          </div>

          @if (currentJob(); as job) {
            <div class="mt-5" role="status">
              @if (job.status === 'pending' || job.status === 'processing') {
                <mat-progress-bar mode="indeterminate"></mat-progress-bar>
                <p class="mt-2 text-center text-ink-soft m-0">Generando el certificado…</p>
              }
              @if (job.status === 'completed') {
                <div class="ok-box">
                  <span class="material-icons">check_circle</span>
                  <div class="flex-1">
                    <p class="font-medium m-0">Certificado emitido y descargado.</p>
                    <p class="text-sm m-0 mt-1">Si la descarga no inició, </p>
                  </div>
                  <button class="btn-secondary" (click)="download(job)">Descargar .pfx</button>
                </div>
              }
              @if (job.status === 'failed') {
                <div class="error-box">
                  <span class="material-icons">error_outline</span>
                  <div>
                    <p class="font-medium m-0">No se pudo emitir el certificado</p>
                    <p class="text-sm m-0 mt-1">{{ job.errorMessage }}</p>
                  </div>
                </div>
              }
            </div>
          }
        </div>

        <!-- Listado -->
        <div class="sheet p-6 md:p-8 mt-6">
          <div class="flex items-center justify-between mb-4">
            <h2 class="font-display text-lg font-bold m-0">Certificados emitidos</h2>
            <button class="link-btn" (click)="loadList()">
              <span class="material-icons" style="font-size:18px">refresh</span> Actualizar
            </button>
          </div>

          @if (certificates().length === 0) {
            <p class="text-ink-soft m-0">Aún no hay certificados emitidos.</p>
          } @else {
            <div class="table-wrap">
              <table class="cert-table">
                <thead>
                  <tr>
                    <th>Empleado</th>
                    <th>Departamento</th>
                    <th>Vence</th>
                    <th>Estado</th>
                    <th>Serial</th>
                  </tr>
                </thead>
                <tbody>
                  @for (c of certificates(); track c.serial) {
                    <tr>
                      <td>
                        <span class="font-medium">{{ c.nombre }}</span>
                        @if (c.email) { <span class="block text-sm text-ink-soft">{{ c.email }}</span> }
                      </td>
                      <td>{{ c.departamento || '—' }}</td>
                      <td class="mono">{{ c.notAfter ? (c.notAfter | date:'dd/MM/yyyy') : '—' }}</td>
                      <td>
                        <span class="badge" [class.badge-ok]="c.estado === 'activo'" [class.badge-off]="c.estado !== 'activo'">
                          {{ c.estado }}
                        </span>
                      </td>
                      <td class="mono text-sm text-ink-soft" [title]="c.serial">{{ shortSerial(c.serial) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .back-link { display:inline-flex; align-items:center; gap:0.35rem; color:var(--ink-soft); font-size:0.9rem; font-weight:500; text-decoration:none; }
    .back-link .material-icons { font-size:18px; }
    .back-link:hover { color:var(--cobalt); }
    .field { display:block; }
    .field-label { display:block; font-size:0.85rem; font-weight:600; color:var(--ink); margin-bottom:0.35rem; }
    .link-btn { display:inline-flex; align-items:center; gap:0.25rem; background:none; border:none; color:var(--cobalt); font-weight:500; font-size:0.9rem; cursor:pointer; padding:0; font-family:inherit; }
    .link-btn:hover { text-decoration:underline; }
    .btn-secondary { border:1px solid var(--line); background:var(--paper); color:var(--ink); border-radius:8px; padding:0.5rem 0.9rem; font-weight:600; cursor:pointer; font-family:inherit; white-space:nowrap; }
    .btn-secondary:hover { border-color:var(--cobalt); color:var(--cobalt); }
    .ok-box { display:flex; align-items:center; gap:0.75rem; padding:1rem; border-radius:10px; background:var(--ok-soft); }
    .ok-box .material-icons { color:#0f7b4a; }
    .error-box { display:flex; gap:0.75rem; padding:1rem; border-radius:10px; background:var(--danger-soft); color:var(--danger); }
    .error-box .material-icons { font-size:22px; }
    .table-wrap { overflow-x:auto; }
    .cert-table { width:100%; border-collapse:collapse; }
    .cert-table th { text-align:left; font-size:0.8rem; text-transform:uppercase; letter-spacing:0.03em; color:var(--ink-soft); padding:0.5rem 0.75rem; border-bottom:1px solid var(--line); }
    .cert-table td { padding:0.7rem 0.75rem; border-bottom:1px solid var(--line); vertical-align:top; }
    .badge { display:inline-block; padding:0.15rem 0.6rem; border-radius:999px; font-size:0.8rem; font-weight:600; text-transform:capitalize; }
    .badge-ok { background:var(--ok-soft); color:#0f7b4a; }
    .badge-off { background:var(--mist); color:var(--ink-soft); }
  `]
})
export class CertificatesComponent implements OnInit {
  adminKey = signal<string | null>(null);
  keyInput = '';

  form: IssueCertificatePayload = {
    nombre: '',
    cedula: '',
    email: '',
    departamento: '',
    pfxPassword: '',
    validityYears: 2,
  };

  isProcessing = signal(false);
  currentJob = signal<JobResponse | null>(null);
  certificates = signal<CertificateRecord[]>([]);

  constructor(private api: ApiService, private snackBar: MatSnackBar) {}

  ngOnInit(): void {
    const stored = sessionStorage.getItem(ADMIN_KEY_STORAGE);
    if (stored) {
      this.adminKey.set(stored);
      this.loadList();
    }
  }

  saveKey(): void {
    const key = this.keyInput.trim();
    if (!key) return;
    sessionStorage.setItem(ADMIN_KEY_STORAGE, key);
    this.adminKey.set(key);
    this.keyInput = '';
    this.loadList();
  }

  forgetKey(): void {
    sessionStorage.removeItem(ADMIN_KEY_STORAGE);
    this.adminKey.set(null);
    this.certificates.set([]);
    this.currentJob.set(null);
  }

  canSubmit(): boolean {
    const f = this.form;
    return !!f.nombre.trim() && !!f.pfxPassword && (!!f.cedula?.trim() || !!f.email?.trim());
  }

  issue(): void {
    const key = this.adminKey();
    if (!key || !this.canSubmit()) return;

    // Solo enviar campos con valor (el backend exige cédula O correo).
    const payload: IssueCertificatePayload = {
      nombre: this.form.nombre.trim(),
      pfxPassword: this.form.pfxPassword,
      validityYears: this.form.validityYears,
    };
    if (this.form.cedula?.trim()) payload.cedula = this.form.cedula.trim();
    if (this.form.email?.trim()) payload.email = this.form.email.trim();
    if (this.form.departamento?.trim()) payload.departamento = this.form.departamento.trim();

    this.isProcessing.set(true);
    this.currentJob.set(null);

    this.api.issueCertificate(payload, key).subscribe({
      next: (res) => {
        if (res.success && res.data) {
          this.currentJob.set(res.data);
          this.pollJob(res.data.jobId);
        } else {
          this.isProcessing.set(false);
          this.snackBar.open(res.error?.message || 'No se pudo emitir', 'Cerrar', { duration: 4000 });
        }
      },
      error: (err) => {
        this.isProcessing.set(false);
        this.handleError(err, 'Error al emitir el certificado');
      },
    });
  }

  private pollJob(jobId: string): void {
    interval(2000).pipe(
      switchMap(() => this.api.getJobStatus(jobId)),
      takeWhile((res) => {
        const s = res.data?.status;
        return s === 'pending' || s === 'processing';
      }, true),
    ).subscribe({
      next: (res) => {
        if (!res.data) return;
        this.currentJob.set(res.data);
        if (res.data.status === 'completed') {
          this.isProcessing.set(false);
          this.download(res.data);           // descarga automática del .pfx
          this.resetForm();
          this.loadList();
        } else if (res.data.status === 'failed') {
          this.isProcessing.set(false);
        }
      },
      error: () => {
        this.isProcessing.set(false);
        this.snackBar.open('Error al consultar el estado', 'Cerrar', { duration: 3000 });
      },
    });
  }

  download(job: JobResponse): void {
    this.api.downloadFile(job.jobId).subscribe({
      next: (blob) => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = job.outputFilename || 'certificado.pfx';
        a.click();
        window.URL.revokeObjectURL(url);
      },
      error: () => this.snackBar.open('Error al descargar el .pfx', 'Cerrar', { duration: 3000 }),
    });
  }

  loadList(): void {
    const key = this.adminKey();
    if (!key) return;
    this.api.listCertificates(key).subscribe({
      next: (res) => {
        if (res.success && res.data) this.certificates.set(res.data);
      },
      error: (err) => this.handleError(err, 'Error al cargar los certificados'),
    });
  }

  shortSerial(serial: string): string {
    return serial.length > 12 ? serial.slice(0, 12) + '…' : serial;
  }

  private resetForm(): void {
    this.form = { nombre: '', cedula: '', email: '', departamento: '', pfxPassword: '', validityYears: 2 };
  }

  private handleError(err: unknown, fallback: string): void {
    const status = (err as { status?: number })?.status;
    if (status === 401 || status === 503) {
      this.snackBar.open('Clave de administrador inválida o módulo no configurado.', 'Cerrar', { duration: 4000 });
      this.forgetKey();
    } else {
      this.snackBar.open(fallback, 'Cerrar', { duration: 3000 });
    }
  }
}
