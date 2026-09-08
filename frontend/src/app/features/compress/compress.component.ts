import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { ApiService, CompressionJob } from '../../core/services/api.service';
import { interval, switchMap, takeWhile } from 'rxjs';
import { findTool } from '../../core/tool-catalog';

interface LevelOption {
  value: string;
  label: string;
  dpi: string;
  detail: string;
}

@Component({
  selector: 'app-compress',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    MatProgressBarModule,
    MatSnackBarModule
  ],
  template: `
    <div class="max-w-2xl mx-auto pt-8 pb-16">

      <a routerLink="/" class="back-link">
        <span class="material-icons">arrow_back</span>
        Todas las herramientas
      </a>

      <header class="flex items-center gap-4 mt-4 mb-6">
        <span class="tool-chip" [style.background]="tool?.hueSoft">
          <span class="material-icons" [style.color]="tool?.hue">compress</span>
        </span>
        <div>
          <h1 class="font-display text-2xl md:text-3xl font-bold m-0">Comprimir</h1>
          <p class="text-ink-soft m-0 mt-1">Reduce el tamaño de un PDF eligiendo el nivel de calidad.</p>
        </div>
      </header>

      <div class="sheet p-6 md:p-8">
        <!-- Zona de archivo -->
        @if (!selectedFile()) {
          <label class="dropzone" [class.dragging]="isDragging()"
                 (dragover)="onDragOver($event)" (dragleave)="onDragLeave($event)" (drop)="onDrop($event)">
            <span class="material-icons">upload_file</span>
            <p class="mt-2 mb-1 font-medium">Arrastra tu PDF aquí o haz clic para seleccionar</p>
            <p class="text-sm text-ink-soft m-0">Máximo 50 MB</p>
            <input type="file" accept=".pdf" hidden (change)="onFileSelected($event)">
          </label>
        } @else {
          <div class="file-row">
            <span class="material-icons">description</span>
            <span class="flex-1 truncate">{{ selectedFile()?.name }}</span>
            <span class="size">{{ formatSize(selectedFile()?.size || 0) }}</span>
            <button type="button" class="icon-btn" (click)="clearFile()" aria-label="Quitar archivo">
              <span class="material-icons">close</span>
            </button>
          </div>
        }

        <!-- Nivel de compresión: tres opciones comparables lado a lado -->
        <p class="field-label mt-6 mb-2">Nivel de compresión</p>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3" role="radiogroup" aria-label="Nivel de compresión">
          @for (level of levels; track level.value) {
            <button type="button" class="level-card" role="radio"
                    [attr.aria-checked]="compressionLevel === level.value"
                    [class.selected]="compressionLevel === level.value"
                    (click)="compressionLevel = level.value">
              <span class="font-semibold">{{ level.label }}</span>
              <span class="mono dpi">{{ level.dpi }}</span>
              <span class="text-sm text-ink-soft">{{ level.detail }}</span>
            </button>
          }
        </div>

        <label class="field mt-6">
          <span class="field-label">Nombre del resultado (opcional)</span>
          <input class="input" [(ngModel)]="outputName" maxlength="100" placeholder="p. ej. contrato_final">
        </label>

        <div class="mt-6 flex justify-end">
          <button class="btn-cta" [disabled]="!selectedFile() || isProcessing()" (click)="compress()">
            @if (isProcessing()) {
              Procesando…
            } @else {
              Comprimir PDF
            }
          </button>
        </div>
      </div>

      <!-- Resultado -->
      @if (currentJob(); as job) {
        <div class="sheet p-6 mt-6" role="status">
          @if (job.status === 'pending' || job.status === 'processing') {
            <mat-progress-bar mode="indeterminate"></mat-progress-bar>
            <p class="mt-3 text-center text-ink-soft m-0">Comprimiendo tu documento…</p>
          }

          @if (job.status === 'completed') {
            <div class="grid grid-cols-2 gap-3 text-center">
              <div class="stat">
                <p class="text-sm text-ink-soft m-0">Tamaño original</p>
                <p class="mono text-xl font-semibold m-0 mt-1">{{ formatSize(job.originalSize || 0) }}</p>
              </div>
              <div class="stat stat-ok">
                <p class="text-sm text-ink-soft m-0">Tamaño comprimido</p>
                <p class="mono text-xl font-semibold m-0 mt-1">{{ formatSize(job.compressedSize || 0) }}</p>
              </div>
            </div>
            <p class="font-display text-center text-3xl font-bold text-cobalt mt-5 mb-4">
              −{{ job.compressionRatio }}%
            </p>
            <div class="flex justify-center">
              <button class="btn-cta" (click)="download()">
                <span class="material-icons">download</span>
                Descargar PDF comprimido
              </button>
            </div>
          }

          @if (job.status === 'failed') {
            <div class="error-box">
              <span class="material-icons">error_outline</span>
              <div>
                <p class="font-medium m-0">No se pudo comprimir el archivo</p>
                <p class="text-sm m-0 mt-1">{{ job.errorMessage }}</p>
              </div>
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .back-link {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      color: var(--ink-soft);
      font-size: 0.9rem;
      font-weight: 500;
      text-decoration: none;
    }

    .back-link .material-icons {
      font-size: 18px;
    }

    .back-link:hover {
      color: var(--cobalt);
    }

    .field-label {
      display: block;
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--ink);
    }

    .level-card {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 0.25rem;
      padding: 0.9rem 1rem;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--paper);
      text-align: left;
      cursor: pointer;
      font-family: inherit;
      color: var(--ink);
      transition: border-color 0.15s ease, background 0.15s ease;
    }

    .level-card:hover {
      border-color: var(--cobalt);
    }

    .level-card.selected {
      border-color: var(--cobalt);
      background: var(--cobalt-soft);
      box-shadow: inset 0 0 0 1px var(--cobalt);
    }

    .level-card .dpi {
      font-size: 0.8rem;
      color: var(--cobalt);
    }

    .stat {
      padding: 1rem;
      border-radius: 10px;
      background: var(--mist);
      border: 1px solid var(--line);
    }

    .stat-ok {
      background: var(--ok-soft);
      border-color: transparent;
    }

    .error-box {
      display: flex;
      gap: 0.75rem;
      padding: 1rem;
      border-radius: 10px;
      background: var(--danger-soft);
      color: var(--danger);
    }

    .error-box .material-icons {
      font-size: 22px;
    }
  `]
})
export class CompressComponent {
  selectedFile = signal<File | null>(null);
  isDragging = signal(false);
  isProcessing = signal(false);
  currentJob = signal<CompressionJob | null>(null);
  compressionLevel = 'medium';
  /** Nombre opcional del archivo resultante (sin extensión). */
  outputName = '';
  tool = findTool('compress');

  levels: LevelOption[] = [
    { value: 'low', label: 'Baja', dpi: '72 DPI', detail: 'Máxima compresión, para pantalla' },
    { value: 'medium', label: 'Media', dpi: '150 DPI', detail: 'Balance recomendado' },
    { value: 'high', label: 'Alta', dpi: '300 DPI', detail: 'Mejor calidad, para imprimir' },
  ];

  constructor(
    private apiService: ApiService,
    private snackBar: MatSnackBar
  ) {}

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
    const file = event.dataTransfer?.files[0];
    if (file && file.type === 'application/pdf') {
      this.selectedFile.set(file);
    } else {
      this.snackBar.open('Solo se permiten archivos PDF', 'Cerrar', { duration: 3000 });
    }
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      this.selectedFile.set(file);
    }
  }

  clearFile(): void {
    this.selectedFile.set(null);
    this.currentJob.set(null);
  }

  compress(): void {
    const file = this.selectedFile();
    if (!file) return;

    this.isProcessing.set(true);
    this.currentJob.set(null);

    this.apiService.compressPdf(file, this.compressionLevel, this.outputName.trim() || undefined).subscribe({
      next: (response) => {
        if (response.success && response.data) {
          this.currentJob.set(response.data);
          this.pollJobStatus(response.data.jobId);
        }
      },
      error: (error) => {
        this.isProcessing.set(false);
        this.snackBar.open('Error al subir el archivo', 'Cerrar', { duration: 3000 });
        console.error(error);
      }
    });
  }

  private pollJobStatus(jobId: string): void {
    interval(2000).pipe(
      switchMap(() => this.apiService.getJobStatus(jobId)),
      takeWhile((response) => {
        const status = response.data?.status;
        return status === 'pending' || status === 'processing';
      }, true)
    ).subscribe({
      next: (response) => {
        if (response.data) {
          this.currentJob.set(response.data);
          if (response.data.status === 'completed' || response.data.status === 'failed') {
            this.isProcessing.set(false);
          }
        }
      },
      error: () => {
        this.isProcessing.set(false);
        this.snackBar.open('Error al obtener el estado', 'Cerrar', { duration: 3000 });
      }
    });
  }

  download(): void {
    const job = this.currentJob();
    if (!job) return;

    this.apiService.downloadFile(job.jobId).subscribe({
      next: (blob) => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = job.outputFilename || `compressed_${job.originalFilename}`;
        a.click();
        window.URL.revokeObjectURL(url);
      },
      error: () => {
        this.snackBar.open('Error al descargar el archivo', 'Cerrar', { duration: 3000 });
      }
    });
  }

  formatSize(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}
