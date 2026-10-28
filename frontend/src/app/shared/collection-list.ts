import { Component, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Collection, CollectionStatus } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { fmtDateTime, fmtTime } from './format';

export const COLLECTION_STATUS: Record<CollectionStatus, { label: string; icon: string }> = {
  collected: { label: 'Collected', icon: '#i-check' },
  missed: { label: 'Not collected', icon: '#i-alert' },
  pending: { label: 'Waiting', icon: '#i-clock' },
  no_waste: { label: 'Nothing to collect', icon: '#i-idle' },
  no_data: { label: 'No camera data', icon: '#i-camera' },
};

/** Scheduled pickups and whether the camera saw the area get collected, with before / after photos. */
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
          @if (c.before_photo || c.after_photo) {
            <div class="cl-photos">
              @if (c.before_photo) {
                <a [href]="photoUrl(c.before_photo)" target="_blank" rel="noopener" title="Before (full)">
                  <img [src]="photoUrl(c.before_photo)" alt="Before: area full" loading="lazy" /><span>Before</span>
                </a>
              }
              @if (c.after_photo) {
                <a [href]="photoUrl(c.after_photo)" target="_blank" rel="noopener" title="After (clean)">
                  <img [src]="photoUrl(c.after_photo)" alt="After: area clean" loading="lazy" /><span>After</span>
                </a>
              }
            </div>
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

  readonly items = input.required<Collection[]>();
  readonly showArea = input(true);
  readonly empty = input('No pickups judged yet.');

  protected status = COLLECTION_STATUS;
  protected time = fmtTime;
  protected dateTime = fmtDateTime;

  // <img> can't send the auth header, so the token goes in the URL (same as the camera stream)
  protected photoUrl(detectionId: number) {
    return `/api/detections/${detectionId}/photo?token=${encodeURIComponent(this.auth.token() ?? '')}`;
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
