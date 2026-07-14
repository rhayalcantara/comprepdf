import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

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

export interface GlobalStats {
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  pendingJobs: number;
  successRate: number;
  avgCompressionRatio: string;
  avgProcessingTimeMs: number;
  totalOriginalBytes: number;
  totalCompressedBytes: number;
  totalSpaceSaved: number;
  totalCompressions: number;
}

export interface DailyStat {
  date: string;
  compressions: number;
  avgCompressionRatio: string;
  avgProcessingTimeMs: number;
  totalOriginalBytes: number;
  totalCompressedBytes: number;
  spaceSaved: number;
}

export interface RecentJob {
  jobId: string;
  status: string;
  compressionLevel: string;
  originalFilename?: string;
  originalSize: number | null;
  compressedSize: number | null;
  compressionRatio: number | null;
  createdAt: string;
  completedAt?: string;
}

export interface CompressionLevelStat {
  level: string;
  count: number;
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

@Injectable({
  providedIn: 'root'
})
export class ApiService {
  private readonly baseUrl = environment.apiUrl;

  constructor(private http: HttpClient) {}

  // --- Certificados (protegidos con clave de administrador, solo TI) ---

  /** Header de autorización del módulo de certificados. */
  private adminHeaders(adminKey: string): HttpHeaders {
    return new HttpHeaders({ 'X-Admin-Key': adminKey });
  }

  /** Emite un certificado personal. Crea un job; el .pfx se descarga por /jobs. */
  issueCertificate(payload: IssueCertificatePayload, adminKey: string): Observable<ApiResponse<JobResponse>> {
    return this.http.post<ApiResponse<JobResponse>>(
      `${this.baseUrl}/certificates`,
      payload,
      { headers: this.adminHeaders(adminKey) },
    );
  }

  /** Lista los certificados emitidos (opcionalmente filtrando por estado). */
  listCertificates(adminKey: string, estado?: 'activo' | 'revocado'): Observable<ApiResponse<CertificateRecord[]>> {
    const query = estado ? `?estado=${estado}` : '';
    return this.http.get<ApiResponse<CertificateRecord[]>>(
      `${this.baseUrl}/certificates${query}`,
      { headers: this.adminHeaders(adminKey) },
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

  mergePdfs(files: File[], outputName?: string): Observable<ApiResponse<JobResponse>> {
    const formData = new FormData();
    files.forEach((f) => formData.append('files', f));
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

  getGlobalStats(): Observable<ApiResponse<GlobalStats>> {
    return this.http.get<ApiResponse<GlobalStats>>(`${this.baseUrl}/stats`);
  }

  getDailyStats(days: number = 7): Observable<ApiResponse<DailyStat[]>> {
    return this.http.get<ApiResponse<DailyStat[]>>(`${this.baseUrl}/stats/daily?days=${days}`);
  }

  getRecentJobs(limit: number = 10): Observable<ApiResponse<RecentJob[]>> {
    return this.http.get<ApiResponse<RecentJob[]>>(`${this.baseUrl}/stats/recent?limit=${limit}`);
  }

  getCompressionLevelStats(): Observable<ApiResponse<CompressionLevelStat[]>> {
    return this.http.get<ApiResponse<CompressionLevelStat[]>>(`${this.baseUrl}/stats/levels`);
  }
}
