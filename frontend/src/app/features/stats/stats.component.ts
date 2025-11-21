import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTableModule } from '@angular/material/table';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { ApiService, GlobalStats, DailyStat, RecentJob, CompressionLevelStat } from '../../core/services/api.service';

@Component({
  selector: 'app-stats',
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatProgressSpinnerModule,
    MatTableModule,
    MatIconModule,
    MatButtonModule
  ],
  templateUrl: './stats.component.html',
  styleUrls: ['./stats.component.scss']
})
export class StatsComponent implements OnInit {
  globalStats = signal<GlobalStats | null>(null);
  dailyStats = signal<DailyStat[]>([]);
  recentJobs = signal<RecentJob[]>([]);
  levelStats = signal<CompressionLevelStat[]>([]);
  loading = signal(true);
  error = signal<string | null>(null);

  recentJobsColumns: string[] = ['filename', 'status', 'level', 'ratio', 'date'];

  constructor(private apiService: ApiService) {}

  ngOnInit(): void {
    this.loadAllStats();
  }

  loadAllStats(): void {
    this.loading.set(true);
    this.error.set(null);

    // Load all stats in parallel
    Promise.all([
      this.apiService.getGlobalStats().toPromise(),
      this.apiService.getDailyStats(7).toPromise(),
      this.apiService.getRecentJobs(10).toPromise(),
      this.apiService.getCompressionLevelStats().toPromise()
    ])
      .then(([global, daily, recent, levels]) => {
        if (global?.success && global.data) {
          this.globalStats.set(global.data);
        }
        if (daily?.success && daily.data) {
          this.dailyStats.set(daily.data);
        }
        if (recent?.success && recent.data) {
          this.recentJobs.set(recent.data);
        }
        if (levels?.success && levels.data) {
          this.levelStats.set(levels.data);
        }
        this.loading.set(false);
      })
      .catch(err => {
        this.error.set('Error al cargar las estadísticas');
        this.loading.set(false);
        console.error('Error loading stats:', err);
      });
  }

  formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  }

  getStatusIcon(status: string): string {
    switch (status) {
      case 'completed': return 'check_circle';
      case 'failed': return 'error';
      case 'processing': return 'hourglass_empty';
      default: return 'schedule';
    }
  }

  getStatusColor(status: string): string {
    switch (status) {
      case 'completed': return 'text-green-600';
      case 'failed': return 'text-red-600';
      case 'processing': return 'text-blue-600';
      default: return 'text-gray-600';
    }
  }

  getLevelLabel(level: string): string {
    const labels: Record<string, string> = {
      'low': 'Baja (72 DPI)',
      'medium': 'Media (150 DPI)',
      'high': 'Alta (300 DPI)',
      'custom': 'Personalizada'
    };
    return labels[level] || level;
  }
}
