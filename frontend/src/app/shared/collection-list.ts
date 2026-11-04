import { Component, inject, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService, Collection, CollectionStatus } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { fmtDateTime, fmtTime } from './format';

export const COLLECTION_STATUS: Record<CollectionStatus, { label: string; icon: string }> = {
  collected: { label: 'Collected', icon: '#i-check' },
  missed: { label: 'Not collected', icon: '#i-alert' },
  pending: { label: 'Waiting', icon: '#i-clock' },
  no_waste: { label: 'Nothing to collect', icon: '#i-idle' },
  no_data: { label: 'No camera data', icon: '#i-camera' },
};

/** Scheduled pickups and whether the camera saw the area get collected, with before / after photos (each can be deleted). */
@Component({
  selector: 'app-collection-list',
  imports: [RouterLink],
  template: `
    <ul class="cl-list">
      @for (c of items(); track c.id) {
        <li class="cl-row" [attr.data-status]="c.status">
          <span class="cl-ico"><svg class="icon"><use [attr.href]="status[c.status].icon" /></svg></span>
          <div class="cl-main">
            <div class="cl-title">
              <span class="tag" [attr.data-kind]="c.status">{{ status[c.status].label }}</span>
              @if (showArea()) { <a class="cl-area" [routerLink]="['/admin/areas', c.area_id]">{{ c.area }}</a> }
              <span class="muted small">Pickup {{ dateTime(c.scheduled_for) }}</span>
            </div>
            <div class="cl-meta small">
              @if (c.full_since) { <span>Full since {{ time(c.full_since) }}</span> }
              @if (c.collected_at) {
                <span>Clean at {{ time(c.collected_at) }}</span>
                <span [class.cl-late]="!c.on_time">{{ timing(c) }}</span>
              }
              @if (c.hours_full !== null) { <span>Full for {{ duration(c.hours_full) }}</span> }
            </div>
          </div>
          @if (photos(c); as list) {
            @if (list.length) {
              <div class="cl-photos">
                @for (p of list; track p.id) {
                  <div class="cl-photo">
                    <a [href]="photoUrl(p.id)" target="_blank" rel="noopener" [title]="p.title">
                      <img [src]="photoUrl(p.id)" [alt]="p.title" loading="lazy" /><span>{{ p.label }}</span>
                    </a>
                    <button type="button" class="cl-photo-del" (click)="deletePhoto(p.id)"
                            title="Delete this photo" aria-label="Delete this photo">
                      <svg class="icon icon-sm"><use href="#i-delete" /></svg>
                    </button>
                  </div>
                }
              </div>
            }
          }
        </li>
      } @empty {
        <li class="empty">{{ empty() }}</li>
      }
    </ul>
  `,
})
export class CollectionList {
  private auth = inject(AuthService);
  private api = inject(ApiService);

  readonly items = input.required<Collection[]>();
  readonly showArea = input(true);
  readonly empty = input('No pickups judged yet.');
  readonly photoDeleted = output<number>();

  private readonly deleted = signal<number[]>([]);

  protected status = COLLECTION_STATUS;
  protected time = fmtTime;
  protected dateTime = fmtDateTime;

  // <img> can't send the auth header, so the token goes in the URL (same as the camera stream)
  protected photoUrl(detectionId: number) {
    return `/api/detections/${detectionId}/photo?token=${encodeURIComponent(this.auth.token() ?? '')}`;
  }

  protected photos(c: Collection) {
    const all = [
      { id: c.before_photo, label: 'Before', title: 'Before (area full)' },
      { id: c.after_photo, label: 'After', title: 'After (area clean)' },
    ];
    return all.filter((p): p is { id: number; label: string; title: string } => p.id !== null && !this.deleted().includes(p.id));
  }

  protected deletePhoto(detectionId: number) {
    if (!confirm('Delete this photo? This cannot be undone.')) return;
    this.api.deletePhoto(detectionId).subscribe({
      next: () => {
        this.deleted.update((d) => [...d, detectionId]);
        this.photoDeleted.emit(detectionId);
      },
      error: () => alert('Could not delete the photo. Try again.'),
    });
  }

  protected timing(c: Collection) {
    const m = c.minutes_from_schedule ?? 0;
    if (c.on_time && m >= -15) return 'on time';
    const abs = Math.abs(m);
    const text = abs >= 60 ? `${Math.floor(abs / 60)}h ${abs % 60}m` : `${abs} min`;
    return m < 0 ? `${text} early` : `${text} late`;
  }

  protected duration(hours: number) {
    return hours >= 1 ? `${hours.toFixed(1)} h` : `${Math.round(hours * 60)} min`;
  }
}
