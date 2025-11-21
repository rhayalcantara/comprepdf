import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatRadioModule } from '@angular/material/radio';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { ApiService, CompressionJob } from '../../core/services/api.service';
import { interval, switchMap, takeWhile } from 'rxjs';

@Component({
  selector: 'app-compress',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatCardModule,
    MatButtonModule,
    MatRadioModule,
    MatProgressBarModule,
    MatIconModule,
    MatSnackBarModule
  ],
  template: `
    <div class="max-w-4xl mx-auto">
      <mat-card class="mb-6">
        <mat-card-header>
          <mat-card-title>Comprimir PDF</mat-card-title>
          <mat-card-subtitle>Sube tu archivo PDF y selecciona el nivel de compresión</mat-card-subtitle>
        </mat-card-header>
        <mat-card-content class="pt-4">
          <!-- Upload Zone -->
          <div
            class="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center cursor-pointer hover:border-primary transition-colors"
            [class.border-primary]="isDragging()"
            (dragover)="onDragOver($event)"
            (dragleave)="onDragLeave($event)"
            (drop)="onDrop($event)"
            (click)="fileInput.click()">
            <mat-icon class="text-6xl text-gray-400">cloud_upload</mat-icon>
            <p class="mt-2 text-gray-600">Arrastra tu PDF aquí o haz clic para seleccionar</p>
            <p class="text-sm text-gray-400">Máximo 50MB</p>
            <input
              #fileInput
              type="file"
              accept=".pdf"
              hidden
              (change)="onFileSelected($event)">
          </div>

          @if (selectedFile()) {
            <div class="mt-4 p-4 bg-gray-100 rounded flex items-center justify-between">
              <div class="flex items-center gap-2">
                <mat-icon>description</mat-icon>
                <span>{{ selectedFile()?.name }}</span>
                <span class="text-gray-500">({{ formatSize(selectedFile()?.size || 0) }})</span>
              </div>
              <button mat-icon-button (click)="clearFile()">
                <mat-icon>close</mat-icon>
              </button>
            </div>
          }

          <!-- Compression Level -->
          <div class="mt-6">
            <label class="block text-sm font-medium text-gray-700 mb-2">Nivel de compresión</label>
            <mat-radio-group [(ngModel)]="compressionLevel" class="flex flex-col gap-2">
              <mat-radio-button value="low">Baja (72 DPI) - Máxima compresión</mat-radio-button>
              <mat-radio-button value="medium">Media (150 DPI) - Balance recomendado</mat-radio-button>
              <mat-radio-button value="high">Alta (300 DPI) - Mejor calidad</mat-radio-button>
            </mat-radio-group>
          </div>
        </mat-card-content>
        <mat-card-actions align="end">
          <button
            mat-raised-button
            color="primary"
            [disabled]="!selectedFile() || isProcessing()"
            (click)="compress()">
            @if (isProcessing()) {
              Procesando...
            } @else {
              Comprimir PDF
            }
          </button>
        </mat-card-actions>
      </mat-card>

      <!-- Result -->
      @if (currentJob()) {
        <mat-card>
          <mat-card-header>
            <mat-card-title>Resultado</mat-card-title>
          </mat-card-header>
          <mat-card-content class="pt-4">
            @if (currentJob()?.status === 'processing') {
              <mat-progress-bar mode="indeterminate"></mat-progress-bar>
              <p class="mt-2 text-center text-gray-600">Comprimiendo archivo...</p>
            }

            @if (currentJob()?.status === 'completed') {
              <div class="grid grid-cols-2 gap-4 text-center">
                <div class="p-4 bg-gray-100 rounded">
                  <p class="text-sm text-gray-500">Tamaño original</p>
                  <p class="text-2xl font-bold">{{ formatSize(currentJob()?.originalSize || 0) }}</p>
                </div>
                <div class="p-4 bg-green-100 rounded">
                  <p class="text-sm text-gray-500">Tamaño comprimido</p>
                  <p class="text-2xl font-bold text-green-600">{{ formatSize(currentJob()?.compressedSize || 0) }}</p>
                </div>
              </div>
              <div class="mt-4 text-center">
                <p class="text-3xl font-bold text-primary">{{ currentJob()?.compressionRatio }}% reducción</p>
              </div>
              <div class="mt-4 flex justify-center">
                <button mat-raised-button color="accent" (click)="download()">
                  <mat-icon>download</mat-icon>
                  Descargar PDF comprimido
                </button>
              </div>
            }

            @if (currentJob()?.status === 'failed') {
              <div class="p-4 bg-red-100 text-red-700 rounded">
                <p>Error: {{ currentJob()?.errorMessage }}</p>
              </div>
            }
          </mat-card-content>
        </mat-card>
      }
    </div>
  `
})
export class CompressComponent {
  selectedFile = signal<File | null>(null);
  isDragging = signal(false);
  isProcessing = signal(false);
  currentJob = signal<CompressionJob | null>(null);
  compressionLevel = 'medium';

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

    this.apiService.compressPdf(file, this.compressionLevel).subscribe({
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
        a.download = `compressed_${job.originalFilename}`;
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
