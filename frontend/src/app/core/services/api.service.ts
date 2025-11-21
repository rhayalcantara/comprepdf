import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

export interface CompressionJob {
  jobId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  originalFilename?: string;
  originalSize?: number;
  compressedSize?: number;
  compressionRatio?: number;
  downloadUrl?: string;
  expiresAt?: string;
  createdAt?: string;
  completedAt?: string;
  errorMessage?: string;
}

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

@Injectable({
  providedIn: 'root'
})
export class ApiService {
  private readonly baseUrl = environment.apiUrl;

  constructor(private http: HttpClient) {}

  compressPdf(file: File, compressionLevel: string): Observable<ApiResponse<CompressionJob>> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('compressionLevel', compressionLevel);

    return this.http.post<ApiResponse<CompressionJob>>(`${this.baseUrl}/compress`, formData);
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
