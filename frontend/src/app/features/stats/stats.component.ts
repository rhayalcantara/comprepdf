import { Component, OnInit, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import {
  ApiService,
  StatsOverview,
  DailyStat,
  RecentJob,
  OperationStat,
  OperationCount,
  CompressionLevelStat,
} from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { TOOL_CATALOG } from '../../core/tool-catalog';

/** Metadatos visuales de una operación (etiqueta ES, ícono y matiz). */
interface OperationMeta {
  label: string;
  icon: string;
  hue: string;
  hueSoft: string;
}

/**
 * Catálogo de operaciones para el panel: reutiliza `TOOL_CATALOG` (mismos
 * íconos/colores/títulos que el resto de la app) y añade `certificate`
 * (emisión de admin), que no vive en el catálogo de herramientas de usuario.
 */
const OPERATION_META: Record<string, OperationMeta> = {
  ...Object.fromEntries(
    TOOL_CATALOG.map((t) => [
      t.id,
      { label: t.title, icon: t.icon, hue: t.hue, hueSoft: t.hueSoft } as OperationMeta,
    ]),
  ),
  certificate: { label: 'Certificado', icon: 'workspace_premium', hue: '#0f766e', hueSoft: '#e3f4f1' },
};

const FALLBACK_META: OperationMeta = {
  label: 'Otra',
  icon: 'description',
  hue: '#51617d',
  hueSoft: '#eef2f7',
};

/** Segmento de una barra apilada de la tendencia. */
interface TrendSegment {
  operation: string;
  count: number;
  color: string;
  /** Alto del segmento en % del alto total del gráfico. */
  heightPct: number;
}

/** Una columna (día) del gráfico de tendencia. */
interface TrendDay {
  date: string;
  label: string;
  total: number;
  segments: TrendSegment[];
}

/** Fila del desglose "uso por herramienta". */
interface OperationBar {
  operation: string;
  meta: OperationMeta;
  total: number;
  completed: number;
  failed: number;
  /** Ancho de la barra en % (relativo al máximo). */
  widthPct: number;
}

/** Segmento del donut de distribución por operación. */
interface DonutSegment {
  operation: string;
  meta: OperationMeta;
  count: number;
  pct: number;
  dash: number;
  offset: number;
}

const DONUT_RADIUS = 54;
const DONUT_CIRC = 2 * Math.PI * DONUT_RADIUS;

@Component({
  selector: 'app-stats',
  standalone: true,
  imports: [CommonModule, RouterLink, MatProgressSpinnerModule, MatIconModule],
  templateUrl: './stats.component.html',
  styleUrls: ['./stats.component.scss'],
})
export class StatsComponent implements OnInit {
  overview = signal<StatsOverview | null>(null);
  operations = signal<OperationStat[]>([]);
  dailyStats = signal<DailyStat[]>([]);
  recentJobs = signal<RecentJob[]>([]);

  loading = signal(true);
  trendLoading = signal(false);
  error = signal<string | null>(null);
  range = signal<7 | 30>(7);

  readonly donutRadius = DONUT_RADIUS;
  readonly donutCirc = DONUT_CIRC;

  isAdmin = computed(() => this.auth.isAdmin());

  /** Título del panel según el rol. */
  heading = computed(() => (this.isAdmin() ? 'Panel de administración' : 'Mi actividad'));
  subheading = computed(() =>
    this.isAdmin()
      ? 'Actividad global del servicio, usuarios y salud operativa.'
      : 'Un resumen de tus trabajos y del uso de las herramientas.',
  );

  /** El panel está vacío cuando no hay ningún trabajo en el alcance. */
  isEmpty = computed(() => (this.overview()?.totalJobs ?? 0) === 0);

  // --- Uso por herramienta (barras horizontales) ---
  operationBars = computed<OperationBar[]>(() => {
    const rows = [...(this.overview()?.byOperation ?? [])]
      .filter((r) => r.total > 0)
      .sort((a, b) => b.total - a.total);
    const max = rows.reduce((m, r) => Math.max(m, r.total), 0) || 1;
    return rows.map((r) => ({
      operation: r.operation,
      meta: this.metaFor(r.operation),
      total: r.total,
      completed: r.completed,
      failed: r.failed,
      widthPct: Math.round((r.total / max) * 100),
    }));
  });

  // --- Donut de distribución por operación ---
  donutSegments = computed<DonutSegment[]>(() => {
    const rows = [...(this.overview()?.byOperation ?? [])]
      .filter((r) => r.total > 0)
      .sort((a, b) => b.total - a.total);
    const total = rows.reduce((s, r) => s + r.total, 0);
    if (total === 0) return [];
    let acc = 0;
    return rows.map((r) => {
      const pct = r.total / total;
      const dash = pct * DONUT_CIRC;
      const seg: DonutSegment = {
        operation: r.operation,
        meta: this.metaFor(r.operation),
        count: r.total,
        pct: Math.round(pct * 100),
        dash,
        offset: -acc * DONUT_CIRC,
      };
      acc += pct;
      return seg;
    });
  });

  donutTotal = computed(() =>
    (this.overview()?.byOperation ?? []).reduce((s, r) => s + r.total, 0),
  );

  // --- Tarjeta de compresión ---
  hasCompression = computed(() => (this.overview()?.compression.totalCompressions ?? 0) > 0);

  compressionLevels = computed<CompressionLevelStat[]>(() => {
    const compress = this.operations().find((o) => o.operation === 'compress');
    return compress?.compressionLevels ?? [];
  });

  // --- Tendencia (barras apiladas) ---
  trendDays = computed<TrendDay[]>(() => {
    // El backend debería enviar `date` como "YYYY-MM-DD" ordenado asc, pero en el
    // entorno MySQL real llega como Date string y ordenado por texto: reordenamos
    // cronológicamente de forma defensiva.
    const days = [...this.dailyStats()].sort(
      (a, b) => this.parseDay(a.date).getTime() - this.parseDay(b.date).getTime(),
    );
    const max = days.reduce((m, d) => Math.max(m, d.total), 0) || 1;
    return days.map((d) => {
      const ops = Object.entries(d.byOperation)
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1]);
      const colHeight = (d.total / max) * 100;
      const segments: TrendSegment[] = ops.map(([operation, count]) => ({
        operation,
        count,
        color: this.metaFor(operation).hue,
        heightPct: (count / d.total) * colHeight,
      }));
      return { date: d.date, label: this.shortDay(d.date), total: d.total, segments };
    });
  });

  /** Operaciones presentes en la tendencia, para la leyenda. */
  trendLegend = computed<{ operation: string; meta: OperationMeta }[]>(() => {
    const seen = new Set<string>();
    for (const d of this.dailyStats()) {
      for (const op of Object.keys(d.byOperation)) {
        if (d.byOperation[op] > 0) seen.add(op);
      }
    }
    return [...seen].map((operation) => ({ operation, meta: this.metaFor(operation) }));
  });

  constructor(private api: ApiService, private auth: AuthService) {}

  ngOnInit(): void {
    this.loadAll();
  }

  loadAll(): void {
    this.loading.set(true);
    this.error.set(null);

    Promise.all([
      this.api.getOverview().toPromise(),
      this.api.getOperations().toPromise(),
      this.api.getDailyStats(this.range()).toPromise(),
      this.api.getRecentJobs(10).toPromise(),
    ])
      .then(([overview, operations, daily, recent]) => {
        if (overview?.success && overview.data) this.overview.set(overview.data);
        if (operations?.success && operations.data) this.operations.set(operations.data);
        if (daily?.success && daily.data) this.dailyStats.set(daily.data);
        if (recent?.success && recent.data) this.recentJobs.set(recent.data);
        this.loading.set(false);
      })
      .catch((err) => {
        this.error.set('No se pudo cargar el panel. Inténtalo de nuevo.');
        this.loading.set(false);
        console.error('Error loading dashboard:', err);
      });
  }

  /** Cambia el rango de la tendencia y recarga solo esa serie. */
  setRange(days: 7 | 30): void {
    if (this.range() === days) return;
    this.range.set(days);
    this.trendLoading.set(true);
    this.api.getDailyStats(days).subscribe({
      next: (res) => {
        if (res.success && res.data) this.dailyStats.set(res.data);
        this.trendLoading.set(false);
      },
      error: () => this.trendLoading.set(false),
    });
  }

  metaFor(operation: string): OperationMeta {
    return OPERATION_META[operation] ?? { ...FALLBACK_META, label: operation || 'Otra' };
  }

  formatBytes(bytes: number): string {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }

  formatMs(ms: number): string {
    if (!ms) return '0 ms';
    if (ms < 1000) return `${ms} ms`;
    return `${(ms / 1000).toFixed(1)} s`;
  }

  getStatusIcon(status: string): string {
    switch (status) {
      case 'completed': return 'check_circle';
      case 'failed': return 'error';
      case 'processing': return 'hourglass_empty';
      default: return 'schedule';
    }
  }

  statusLabel(status: string): string {
    switch (status) {
      case 'completed': return 'Completado';
      case 'failed': return 'Fallido';
      case 'processing': return 'Procesando';
      case 'pending': return 'Pendiente';
      default: return status;
    }
  }

  levelLabel(level: string | null): string {
    const labels: Record<string, string> = {
      low: 'Baja (72 DPI)',
      medium: 'Media (150 DPI)',
      high: 'Alta (300 DPI)',
      custom: 'Personalizada',
    };
    return (level && labels[level]) || level || 'Sin nivel';
  }

  /**
   * Parseo robusto de la fecha del día. Acepta "YYYY-MM-DD" (lo del contrato) y
   * también el Date string completo que devuelve el driver MySQL en este entorno.
   */
  private parseDay(date: string): Date {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return new Date(`${date}T00:00:00`);
    return new Date(date);
  }

  /** "14 jul" a partir de la fecha del día (cualquier formato soportado). */
  private shortDay(date: string): string {
    const d = this.parseDay(date);
    if (isNaN(d.getTime())) return date;
    return d.toLocaleDateString('es', { day: 'numeric', month: 'short' });
  }

  trackByDate = (_: number, d: TrendDay) => d.date;
  trackByOp = (_: number, o: { operation: string }) => o.operation;
}
