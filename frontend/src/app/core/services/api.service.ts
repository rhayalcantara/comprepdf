import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { SafeUser } from './auth.service';

export interface CompressionJob {
  jobId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  operationType?: string;
  originalFilename?: string;
  originalSize?: number;
  outputFilename?: string;
  compressedSize?: number;
  compressionRatio?: number;
  downloadUrl?: string;
  expiresAt?: string;
  createdAt?: string;
  completedAt?: string;
  errorMessage?: string;
}

// Alias genérico: la misma forma sirve para cualquier operación PDF
export type JobResponse = CompressionJob;

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { message: string };
}

/** Operaciones conocidas (incluye `certificate`, emisión de admin). */
export type OperationType =
  | 'compress' | 'split' | 'merge' | 'sign'
  | 'extract' | 'rotate' | 'protect' | 'unlock' | 'certificate';

/** Conteo agnóstico por operación (bloque `byOperation` del overview). */
export interface OperationCount {
  operation: OperationType;
  total: number;
  completed: number;
  failed: number;
}

/** Métricas propias de compresión (bloque `compression` del overview). */
export interface CompressionSummary {
  avgCompressionRatio: string;
  avgProcessingTimeMs: number;
  totalOriginalBytes: number;
  totalCompressedBytes: number;
  totalSpaceSaved: number;
  totalCompressions: number;
}

/** Resumen de usuarios (solo admin). */
export interface UsersSummary {
  total: number;
  activos: number;
  inactivos: number;
  pendientes: number;
}

/** Fila de "top usuarios" (solo admin). */
export interface TopUser {
  userId: string;
  username: string | null;
  jobs: number;
}

/**
 * Respuesta de `GET /stats/overview`. Los bloques `users`/`topUsers` solo llegan
 * en modo admin (detecta con `'users' in data`). Los campos legacy de compresión
 * a nivel superior existen en el backend pero NO se tipan aquí: usa `compression`.
 */
export interface StatsOverview {
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  pendingJobs: number;
  processingJobs: number;
  successRate: number;
  byOperation: OperationCount[];
  compression: CompressionSummary;
  storage: { outputBytes: number };
  // Solo admin:
  users?: UsersSummary;
  topUsers?: TopUser[];
}

/**
 * Punto de la tendencia diaria (`GET /stats/daily`). `total` y `byOperation`
 * alimentan el apilado; los campos legacy de compresión se ignoran en el front.
 */
export interface DailyStat {
  date: string;
  total: number;
  byOperation: Record<string, number>;
}

/** Desglose por nivel DPI, anidado en la operación `compress`. */
export interface CompressionLevelStat {
  level: string;
  count: number;
}

/** Item de `GET /stats/operations`: conteo por operación (+ niveles en compress). */
export interface OperationStat {
  operation: OperationType;
  count: number;
  compressionLevels?: CompressionLevelStat[];
}

/** Item de `GET /stats/recent`. `username` solo en modo admin. */
export interface RecentJob {
  jobId: string;
  status: string;
  operationType: string;
  compressionLevel: string | null;
  originalFilename: string | null;
  originalSize: number | null;
  compressedSize: number | null;
  compressionRatio: number | null;
  createdAt: string;
  completedAt: string | null;
  username?: string | null;
}

export type SignMode = 'certificate' | 'drawn' | 'combined';

/** Colocación normalizada 0-1 (x,y = esquina inferior-izquierda, convención PDF). */
export interface SignPlacement {
  x: number;
  y: number;
  w: number;
}

export interface SignOptions {
  mode?: SignMode;
  /** Certificado .pfx/.p12 (certificate y combined). */
  cert?: File;
  /** Contraseña del certificado (certificate y combined). */
  password?: string;
  fieldName?: string;
  reason?: string;
  location?: string;
  /** Imagen PNG/JPEG de la firma dibujada o subida (drawn y combined). */
  signature?: Blob;
  signatureFilename?: string;
  placement?: SignPlacement;
  /** 'all' o lista tipo "1,3-5" (drawn y combined). */
  pages?: string;
  outputName?: string;
}

// --- Módulo de certificados (CA interna) ---

export interface IssueCertificatePayload {
  nombre: string;
  cedula?: string;
  email?: string;
  departamento?: string;
  /** Contraseña que protegerá el .pfx del empleado. */
  pfxPassword: string;
  /** Vigencia en años (1–5). Por defecto 2 en el servidor. */
  validityYears?: number;
}

export interface CertificateRecord {
  serial: string;
  nombre: string;
  cedula?: string | null;
  email?: string | null;
  departamento?: string | null;
  notBefore?: string | null;
  notAfter?: string | null;
  estado: 'activo' | 'revocado';
  emitidoPor?: string | null;
  createdAt: string;
}

// --- "Mis trabajos" (historial paginado) ---

/** Resumen de un job para el listado. `username` solo llega en modo admin (?all=true). */
export interface JobSummary {
  jobId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  operationType: string;
  compressionLevel: string | null;
  originalFilename: string | null;
  originalSize: number | null;
  outputFilename: string | null;
  outputSize: number | null;
  downloadUrl: string | null;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  /** Solo presente cuando el admin lista con ?all=true (huérfano → null). */
  username?: string | null;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface JobsPage {
  items: JobSummary[];
  pagination: Pagination;
}

// --- Gestión de usuarios (solo admin) ---

export interface CreateUserPayload {
  username: string;
  nombre: string;
  rol?: 'admin' | 'user';
  email?: string;
  password?: string;
}

export interface CreateUserResult {
  user: SafeUser;
  /** Solo viene si no se envió password: mostrar UNA vez. */
  temporaryPassword?: string;
}

export interface UpdateUserPayload {
  rol?: 'admin' | 'user';
  estado?: 'activo' | 'inactivo' | 'pendiente';
  nombre?: string;
  email?: string;
  newPassword?: string;
}

@Injectable({
  providedIn: 'root'
})
export class ApiService {
  private readonly baseUrl = environment.apiUrl;

  constructor(private http: HttpClient) {}

  // --- Certificados (solo admin; el token JWT lo adjunta el interceptor) ---

  /** Emite un certificado personal. Crea un job; el .pfx se descarga por /jobs. */
  issueCertificate(payload: IssueCertificatePayload): Observable<ApiResponse<JobResponse>> {
    return this.http.post<ApiResponse<JobResponse>>(
      `${this.baseUrl}/certificates`,
      payload,
    );
  }

  /** Lista los certificados emitidos (opcionalmente filtrando por estado). */
  listCertificates(estado?: 'activo' | 'revocado'): Observable<ApiResponse<CertificateRecord[]>> {
    const query = estado ? `?estado=${estado}` : '';
    return this.http.get<ApiResponse<CertificateRecord[]>>(
      `${this.baseUrl}/certificates${query}`,
    );
  }

  compressPdf(file: File, compressionLevel: string, outputName?: string): Observable<ApiResponse<CompressionJob>> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('compressionLevel', compressionLevel);
    this.appendOutputName(formData, outputName);
    return this.http.post<ApiResponse<CompressionJob>>(`${this.baseUrl}/compress`, formData);
  }

  // --- Operaciones PDF ---

  /** Nombre de salida opcional elegido por el usuario (todas las operaciones). */
  private appendOutputName(formData: FormData, outputName?: string): void {
    const name = outputName?.trim();
    if (name) formData.append('outputName', name);
  }

  splitPdf(file: File, mode: 'individual' | 'ranges', ranges?: string, outputName?: string): Observable<ApiResponse<JobResponse>> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('mode', mode);
    if (mode === 'ranges' && ranges) {
      formData.append('ranges', ranges);
    }
    this.appendOutputName(formData, outputName);
    return this.http.post<ApiResponse<JobResponse>>(`${this.baseUrl}/pdf/split`, formData);
  }

  /**
   * Une varios PDFs en el orden dado. `pageRanges` es opcional y, si se pasa,
   * debe ser paralelo a `files`: cada entrada "all" o una lista tipo "1-3,5"
   * con las páginas de ese PDF a incluir.
   */
  mergePdfs(files: File[], outputName?: string, pageRanges?: string[]): Observable<ApiResponse<JobResponse>> {
    const formData = new FormData();
    files.forEach((f) => formData.append('files', f));
    if (pageRanges && pageRanges.length) {
      formData.append('pageRanges', JSON.stringify(pageRanges));
    }
    this.appendOutputName(formData, outputName);
    return this.http.post<ApiResponse<JobResponse>>(`${this.baseUrl}/pdf/merge`, formData);
  }

  extractPages(file: File, pages: string, outputName?: string): Observable<ApiResponse<JobResponse>> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('pages', pages);
    this.appendOutputName(formData, outputName);
    return this.http.post<ApiResponse<JobResponse>>(`${this.baseUrl}/pdf/extract`, formData);
  }

  rotatePages(file: File, degrees: number, pages: string = 'all', outputName?: string): Observable<ApiResponse<JobResponse>> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('degrees', String(degrees));
    formData.append('pages', pages);
    this.appendOutputName(formData, outputName);
    return this.http.post<ApiResponse<JobResponse>>(`${this.baseUrl}/pdf/rotate`, formData);
  }

  protectPdf(file: File, password: string, ownerPassword?: string, outputName?: string): Observable<ApiResponse<JobResponse>> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('password', password);
    if (ownerPassword) formData.append('ownerPassword', ownerPassword);
    this.appendOutputName(formData, outputName);
    return this.http.post<ApiResponse<JobResponse>>(`${this.baseUrl}/pdf/protect`, formData);
  }

  unlockPdf(file: File, password: string, outputName?: string): Observable<ApiResponse<JobResponse>> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('password', password);
    this.appendOutputName(formData, outputName);
    return this.http.post<ApiResponse<JobResponse>>(`${this.baseUrl}/pdf/unlock`, formData);
  }

  /**
   * Firma un PDF. Según `mode`:
   * - 'certificate' (default): requiere `cert` + `password`.
   * - 'drawn': requiere `signature` + `placement` (+ `pages`).
   * - 'combined': todo lo anterior.
   * Los campos que el backend ignora en un modo NO se envían.
   */
  signPdf(file: File, opts: SignOptions): Observable<ApiResponse<JobResponse>> {
    const mode: SignMode = opts.mode ?? 'certificate';
    const formData = new FormData();
    formData.append('file', file);
    formData.append('mode', mode);
    if (mode !== 'certificate' && opts.signature) {
      formData.append('signature', opts.signature, opts.signatureFilename ?? 'firma.png');
      if (opts.placement) {
        // Normalizadas 0-1, esquina inferior-izquierda (convención PDF).
        formData.append('x', opts.placement.x.toFixed(4));
        formData.append('y', opts.placement.y.toFixed(4));
        formData.append('w', opts.placement.w.toFixed(4));
      }
      formData.append('pages', opts.pages || 'all');
    }
    if (mode !== 'drawn') {
      if (opts.cert) formData.append('cert', opts.cert);
      if (opts.password) formData.append('password', opts.password);
      if (opts.fieldName) formData.append('fieldName', opts.fieldName);
      if (opts.reason) formData.append('reason', opts.reason);
      if (opts.location) formData.append('location', opts.location);
    }
    this.appendOutputName(formData, opts.outputName);
    return this.http.post<ApiResponse<JobResponse>>(`${this.baseUrl}/pdf/sign`, formData);
  }

  getJobStatus(jobId: string): Observable<ApiResponse<CompressionJob>> {
    return this.http.get<ApiResponse<CompressionJob>>(`${this.baseUrl}/jobs/${jobId}`);
  }

  downloadFile(jobId: string): Observable<Blob> {
    return this.http.get(`${this.baseUrl}/jobs/${jobId}/download`, {
      responseType: 'blob'
    });
  }

  deleteJob(jobId: string): Observable<ApiResponse<void>> {
    return this.http.delete<ApiResponse<void>>(`${this.baseUrl}/jobs/${jobId}`);
  }

  // --- Panel (estadísticas operation-aware y rol-aware) ---

  /** Resumen del panel. El backend filtra por dueño salvo admin (global). */
  getOverview(): Observable<ApiResponse<StatsOverview>> {
    return this.http.get<ApiResponse<StatsOverview>>(`${this.baseUrl}/stats/overview`);
  }

  /** Tendencia diaria (solo días con actividad). `days` = 7 o 30. */
  getDailyStats(days: number = 7): Observable<ApiResponse<DailyStat[]>> {
    return this.http.get<ApiResponse<DailyStat[]>>(`${this.baseUrl}/stats/daily?days=${days}`);
  }

  /** Conteo por operación; `compress` incluye el desglose por nivel DPI. */
  getOperations(): Observable<ApiResponse<OperationStat[]>> {
    return this.http.get<ApiResponse<OperationStat[]>>(`${this.baseUrl}/stats/operations`);
  }

  /** Últimos N jobs de cualquier operación (con `username` en modo admin). */
  getRecentJobs(limit: number = 10): Observable<ApiResponse<RecentJob[]>> {
    return this.http.get<ApiResponse<RecentJob[]>>(`${this.baseUrl}/stats/recent?limit=${limit}`);
  }

  // --- Mis trabajos ---

  /**
   * Historial paginado. El usuario ve los suyos; el admin con `all=true` ve todos
   * (con `username` por item). El token lo adjunta el interceptor.
   */
  listJobs(page = 1, limit = 20, all = false): Observable<ApiResponse<JobsPage>> {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (all) params.set('all', 'true');
    return this.http.get<ApiResponse<JobsPage>>(`${this.baseUrl}/jobs?${params.toString()}`);
  }

  // --- Gestión de usuarios (solo admin) ---

  getUsers(): Observable<ApiResponse<{ users: SafeUser[] }>> {
    return this.http.get<ApiResponse<{ users: SafeUser[] }>>(`${this.baseUrl}/users`);
  }

  createUser(payload: CreateUserPayload): Observable<ApiResponse<CreateUserResult>> {
    return this.http.post<ApiResponse<CreateUserResult>>(`${this.baseUrl}/users`, payload);
  }

  updateUser(id: string, payload: UpdateUserPayload): Observable<ApiResponse<{ user: SafeUser }>> {
    return this.http.patch<ApiResponse<{ user: SafeUser }>>(`${this.baseUrl}/users/${id}`, payload);
  }
}
