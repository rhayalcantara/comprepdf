import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subscription, finalize, interval, switchMap, takeWhile } from 'rxjs';

import { ApiService, FormSummary } from '../../core/services/api.service';

@Component({
  selector: 'app-form-list',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './form-list.component.html',
  styleUrl: './form-list.component.scss',
})
export class FormListComponent implements OnInit, OnDestroy {
  forms: FormSummary[] = [];
  search = '';
  loading = true;
  actionId = '';
  errorMessage = '';

  private pollSub?: Subscription;

  constructor(private readonly api: ApiService) {}

  get filteredForms(): FormSummary[] {
    const term = this.search.trim().toLocaleLowerCase();
    return term
      ? this.forms.filter((form) => form.name.toLocaleLowerCase().includes(term))
      : this.forms;
  }

  ngOnInit(): void {
    this.loadForms();
  }

  ngOnDestroy(): void {
    this.pollSub?.unsubscribe();
  }

  loadForms(): void {
    this.loading = true;
    this.errorMessage = '';
    this.api
      .listForms()
      .pipe(finalize(() => (this.loading = false)))
      .subscribe({
        next: (res) => {
          this.forms = res.success && res.data ? res.data : [];
          if (!res.success) this.errorMessage = res.error?.message ?? 'No fue posible cargar los formularios.';
        },
        error: () => (this.errorMessage = 'No fue posible cargar los formularios guardados.'),
      });
  }

  deleteForm(form: FormSummary): void {
    const confirmed = window.confirm(`¿Eliminar “${form.name}”? Esta acción no se puede deshacer.`);
    if (!confirmed) return;

    this.actionId = form.id;
    this.api
      .deleteForm(form.id)
      .pipe(finalize(() => (this.actionId = '')))
      .subscribe({
        next: () => (this.forms = this.forms.filter((item) => item.id !== form.id)),
        error: () => (this.errorMessage = 'No fue posible eliminar el formulario.'),
      });
  }

  /** Genera el PDF (job form_generate) y lo descarga al completarse. */
  downloadForm(form: FormSummary): void {
    this.actionId = form.id;
    this.errorMessage = '';
    this.api.generateForm(form.id).subscribe({
      next: (res) => {
        if (res.success && res.data?.jobId) {
          this.pollAndDownload(res.data.jobId, form.name);
        } else {
          this.actionId = '';
          this.errorMessage = res.error?.message ?? 'No fue posible generar el PDF.';
        }
      },
      error: () => {
        this.actionId = '';
        this.errorMessage = 'No fue posible generar el PDF.';
      },
    });
  }

  formatDate(value: string): string {
    return new Intl.DateTimeFormat('es-DO', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  }

  private pollAndDownload(jobId: string, name: string): void {
    this.pollSub?.unsubscribe();
    this.pollSub = interval(1500)
      .pipe(
        switchMap(() => this.api.getJobStatus(jobId)),
        takeWhile((r) => {
          const s = r.data?.status;
          return s === 'pending' || s === 'processing';
        }, true),
      )
      .subscribe({
        next: (r) => {
          const status = r.data?.status;
          if (status === 'completed') {
            this.fetchAndSave(jobId, name);
          } else if (status === 'failed') {
            this.actionId = '';
            this.errorMessage = r.data?.errorMessage ?? 'La generación del PDF falló.';
          }
        },
        error: () => {
          this.actionId = '';
          this.errorMessage = 'Error al consultar el estado del PDF.';
        },
      });
  }

  private fetchAndSave(jobId: string, name: string): void {
    this.api.downloadFile(jobId).subscribe({
      next: (blob) => {
        this.actionId = '';
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${this.safeFileName(name)}.pdf`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
      error: () => {
        this.actionId = '';
        this.errorMessage = 'No fue posible descargar el PDF generado.';
      },
    });
  }

  private safeFileName(name: string): string {
    return (
      name
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'formulario'
    );
  }
}
