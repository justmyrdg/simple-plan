import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface DetectResult {
  filename: string;
  is_trash: boolean;
  label: string;
  score: number;
  threshold: number;
  trash_cell_ratio: number | null;
  cells: number[][] | null;
  annotated_image: string;
  model: 'trained' | 'zero-shot';
}

@Injectable({ providedIn: 'root' })
export class DetectorService {
  private http = inject(HttpClient);

  health(): Observable<{ status: string; model: string }> {
    return this.http.get<{ status: string; model: string }>('/api/health');
  }

  detect(
    image: Blob,
    threshold: number,
    grid: number,
    filename = 'image.jpg',
    areaId: number | null = null,
    source: 'live' | 'upload' = 'live',
  ): Observable<DetectResult> {
    const form = new FormData();
    form.append('file', image, filename);
    form.append('threshold', String(threshold));
    form.append('grid', String(grid));
    form.append('source', source);
    // with an area, the backend records the result as that area's current status
    if (areaId !== null) form.append('area_id', String(areaId));
    return this.http.post<DetectResult>('/api/detect', form);
  }

  /** Analyze the newest frame of an area's network camera; the backend records it as the area's status. */
  detectCamera(areaId: number, threshold: number, grid: number): Observable<DetectResult> {
    const form = new FormData();
    form.append('threshold', String(threshold));
    form.append('grid', String(grid));
    return this.http.post<DetectResult>(`/api/cameras/${areaId}/detect`, form);
  }
}
