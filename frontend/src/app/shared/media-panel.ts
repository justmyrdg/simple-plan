import { Component, OnDestroy, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ApiService, RecordingItem, RecordingResultItem, SnapshotItem, errorMessage } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { fmtDateTime } from './format';

/**
 * Photos and videos an admin saves by hand from an area's network camera: record / stop, save a
 * snapshot, and play, download or delete what was saved. Used on the Monitor page and the area page.
 */
@Component({
  selector: 'app-media-panel',
  template: `
    <div class="mp">
      @if (error()) { <div class="error" role="alert"><svg class="icon"><use href="#i-alert" /></svg> {{ error() }}</div> }

      <div class="mp-actions">
        <div class="mp-group">
          @if (active()) {
            <span class="live-badge"><span class="live-dot"></span> REC {{ clock(elapsed()) }} / {{ clock(maxSeconds()) }}</span>
            <button class="btn btn-danger" (click)="stop()" [disabled]="busy()">{{ busy() ? 'Saving…' : 'Stop recording' }}</button>
          } @else {
            <button class="btn" (click)="start()" [disabled]="busy() || !canCapture()">
              <svg class="icon"><use href="#i-camera" /></svg> Record video
            </button>
          }
        </div>
        <div class="mp-group">
          <input class="input mp-note" placeholder="Note (optional)" maxlength="200" aria-label="Note for the photo"
                 [value]="note()" (input)="note.set(noteValue($event))" />
          <button class="btn btn-primary" (click)="snap()" [disabled]="busy() || !canCapture()">
            <svg class="icon"><use href="#i-snap" /></svg> Save photo
          </button>
        </div>
      </div>
      @if (!canCapture()) {
        <p class="muted small">Add a network camera address to this area (Areas page) to save photos and videos.</p>
      }
      <p class="muted small">
        Videos have no sound and stop by themselves after {{ clock(maxSeconds()) }}.
        {{ cloud() ? 'Files are kept in cloud storage.' : 'Files are kept on the server.' }}
        Anyone with an admin login can see and delete them.
      </p>

      <h3 class="sub-head">Videos <span class="count">{{ recordings().length }}</span></h3>
      <ul class="mp-list">
        @for (r of recordings(); track r.id) {
          <li class="mp-row">
            <div class="mp-main">
              <div class="mp-title">
                <span class="tag" [attr.data-kind]="r.status === 'done' ? 'clean' : r.status === 'failed' ? 'trash' : 'pending'">
                  {{ r.status === 'done' ? 'Saved' : r.status === 'failed' ? 'Failed' : 'Recording' }}
                </span>
                <strong>{{ dateTime(r.started_at) }}</strong>
              </div>
              <div class="muted small">
                {{ r.status === 'recording' ? 'In progress' : clock(r.seconds) }}
                @if (r.size) { · {{ megabytes(r.size) }} }
                · by {{ r.started_by }}
              </div>
              @if (r.error) { <div class="small mp-err">{{ r.error }}</div> }
            </div>
            <div class="mp-buttons">
              @if (r.status === 'done') {
                <button class="btn" (click)="playing.set(playing() === r.id ? null : r.id)">{{ playing() === r.id ? 'Close' : 'Play' }}</button>
                <a class="btn" [href]="fileUrl('recordings', r.id, true)" title="Download"><svg class="icon"><use href="#i-download" /></svg></a>
              }
              @if (r.status !== 'recording') {
                <button class="btn btn-danger" (click)="deleteRecording(r)" title="Delete" aria-label="Delete video">
                  <svg class="icon"><use href="#i-delete" /></svg>
                </button>
              }
            </div>
            @if (playing() === r.id) {
              <div class="mp-player">
                <div class="mp-stage">
                  <video #vid class="mp-video" controls autoplay playsinline [src]="fileUrl('recordings', r.id)"
                         (timeupdate)="videoTime.set(vid.currentTime)"></video>
                  @if (nowResult(); as res) {
                    @if (showRegions() && res.cells; as c) {
                      <div class="regions" [style.grid-template-columns]="'repeat(' + c.length + ', 1fr)'">
                        @for (row of c; track $index) {
                          @for (s of row; track $index) {
                            <div class="region" [style.background]="cellColor(s, res.threshold)" [class.region-hot]="s >= res.threshold">
                              <span>{{ percentNumber(s) }}</span>
                            </div>
                          }
                        }
                      </div>
                    }
                    <span class="mp-verdict" [attr.data-kind]="res.status">
                      {{ res.status === 'trash' ? 'FULL OF TRASH' : 'CLEAN' }} · {{ percent(res.score) }}
                    </span>
                  }
                </div>
                @if (segments(r.seconds).length) {
                  <div class="mp-timeline" title="Detector result along the video. Click to jump." (click)="seek($event, vid, r.seconds)">
                    @for (s of segments(r.seconds); track s.left) {
                      <span class="mp-seg" [attr.data-kind]="s.status" [style.left.%]="s.left" [style.width.%]="s.width"></span>
                    }
                    <span class="mp-playhead" [style.left.%]="playhead(r.seconds)"></span>
                  </div>
                  <div class="muted small mp-legend">
                    <span class="tag" data-kind="trash">Full of trash {{ trashShare() }}%</span>
                    <span class="tag" data-kind="clean">Clean {{ 100 - trashShare() }}%</span>
                    of the video
                    <label class="toggle">
                      <input type="checkbox" [checked]="showRegions()" (change)="showRegions.set(!showRegions())" />
                      <span>Show region overlay</span>
                    </label>
                  </div>
                } @else {
                  <p class="muted small">No detector results were noted for this video.</p>
                }
              </div>
              <p class="muted small">The label and regions are drawn over the player; the saved and downloaded video file is unchanged.</p>
            }
          </li>
        } @empty {
          <li class="empty">No videos yet.</li>
        }
      </ul>

      <h3 class="sub-head">Photos <span class="count">{{ snapshots().length }}</span></h3>
      <ul class="mp-grid">
        @for (s of snapshots(); track s.id) {
          <li class="mp-photo">
            <a [href]="fileUrl('snapshots', s.id)" target="_blank" rel="noopener">
              <img [src]="fileUrl('snapshots', s.id)" [alt]="'Photo taken ' + dateTime(s.created_at)" loading="lazy" />
            </a>
            <div class="mp-photo-meta">
              <span class="small">{{ dateTime(s.created_at) }}</span>
              <span class="muted small">by {{ s.taken_by }}{{ s.note ? ' · ' + s.note : '' }}</span>
            </div>
            <div class="mp-buttons">
              <a class="btn btn-ghost" [href]="fileUrl('snapshots', s.id, true)" title="Download" aria-label="Download photo"><svg class="icon"><use href="#i-download" /></svg></a>
              <button class="btn btn-ghost" (click)="deleteSnapshot(s)" title="Delete" aria-label="Delete photo"><svg class="icon"><use href="#i-delete" /></svg></button>
            </div>
          </li>
        } @empty {
          <li class="empty">No photos yet.</li>
        }
      </ul>
    </div>
  `,
})
export class MediaPanel implements OnDestroy {
  private api = inject(ApiService);
  private auth = inject(AuthService);

  readonly areaId = input.required<number>();
  /** False when the area has no network camera: saved files are still listed, but nothing new can be captured. */
  readonly canCapture = input(true);

  protected snapshots = signal<SnapshotItem[]>([]);
  protected recordings = signal<RecordingItem[]>([]);
  protected maxSeconds = signal(600);
  protected cloud = signal(false);
  protected busy = signal(false);
  protected error = signal<string | null>(null);
  protected playing = signal<number | null>(null);
  protected note = signal('');
  // detector verdicts along the video being played, and where the player is now
  protected results = signal<RecordingResultItem[]>([]);
  protected videoTime = signal(0);
  protected showRegions = signal(true);
  protected nowResult = computed(() => {
    const t = this.videoTime();
    const list = this.results();
    let current: RecordingResultItem | null = null;
    for (const r of list) {
      if (r.t > t) break;
      current = r;
    }
    return current ?? list[0] ?? null;
  });
  protected trashShare = computed(() => {
    const list = this.results();
    return list.length ? Math.round((100 * list.filter((r) => r.status === 'trash').length) / list.length) : 0;
  });

  protected active = computed(() => this.recordings().find((r) => r.status === 'recording') ?? null);
  // the server's clock may be in another time zone, so count up from the seconds it reported
  private loadedAt = signal(Date.now());
  private tick = signal(Date.now());
  protected elapsed = computed(() => {
    const r = this.active();
    return r ? r.seconds + Math.max(0, Math.round((this.tick() - this.loadedAt()) / 1000)) : 0;
  });

  private timer = setInterval(() => {
    this.tick.set(Date.now());
    if (this.active() && !this.busy() && Math.round(this.tick() / 1000) % 5 === 0) this.loadRecordings();
  }, 1000);

  constructor() {
    effect(() => {
      const id = this.areaId();
      untracked(() => {
        this.playing.set(null);
        this.error.set(null);
        this.loadSnapshots(id);
        this.loadRecordings(id);
      });
    });
    effect(() => {
      const id = this.playing();
      untracked(() => {
        this.results.set([]);
        this.videoTime.set(0);
        if (id !== null) {
          this.api.recordingResults(id).subscribe((list) => {
            if (this.playing() === id) this.results.set(list);
          });
        }
      });
    });
  }

  /** Coloured stretches of the timeline: each verdict holds until the next one is noted. */
  protected segments(videoSeconds: number) {
    const list = this.results();
    const total = Math.max(videoSeconds, list.length ? list[list.length - 1].t + 1 : 0, 1);
    return list.map((r, i) => {
      const end = i + 1 < list.length ? list[i + 1].t : total;
      return { status: r.status, left: (100 * r.t) / total, width: (100 * Math.max(end - r.t, 0.5)) / total };
    });
  }

  protected playhead(videoSeconds: number) {
    const list = this.results();
    const total = Math.max(videoSeconds, list.length ? list[list.length - 1].t + 1 : 0, 1);
    return Math.min(100, (100 * this.videoTime()) / total);
  }

  protected seek(e: MouseEvent, video: HTMLVideoElement, videoSeconds: number) {
    const bar = e.currentTarget as HTMLElement;
    const list = this.results();
    const total = Math.max(videoSeconds, list.length ? list[list.length - 1].t + 1 : 0, 1);
    video.currentTime = (total * (e.clientX - bar.getBoundingClientRect().left)) / bar.clientWidth;
  }

  // same shading as the live Monitor view: only regions past the threshold, stronger the more confident
  protected cellColor(score: number, threshold: number) {
    if (score < threshold) return 'transparent';
    const a = 0.18 + 0.32 * ((score - threshold) / Math.max(1 - threshold, 0.01));
    return `rgba(225, 45, 35, ${a.toFixed(2)})`;
  }

  protected percent(score: number) {
    return `${this.percentNumber(score)}%`;
  }

  protected percentNumber(score: number) {
    return Math.round(score * 100);
  }

  ngOnDestroy() {
    clearInterval(this.timer);
  }

  private loadSnapshots(id = this.areaId()) {
    this.api.snapshots(id).subscribe((s) => this.snapshots.set(s));
  }

  private loadRecordings(id = this.areaId()) {
    this.api.recordings(id).subscribe((r) => {
      if (id !== this.areaId()) return;
      this.recordings.set(r.items);
      this.maxSeconds.set(r.max_seconds);
      this.cloud.set(r.cloud);
      this.loadedAt.set(Date.now());
    });
  }

  private fail(e: HttpErrorResponse) {
    this.busy.set(false);
    this.error.set(errorMessage(e));
  }

  protected snap() {
    this.busy.set(true);
    this.error.set(null);
    this.api.saveSnapshot(this.areaId(), this.note().trim()).subscribe({
      next: (s) => {
        this.busy.set(false);
        this.note.set('');
        this.snapshots.update((list) => [s, ...list]);
      },
      error: (e: HttpErrorResponse) => this.fail(e),
    });
  }

  protected start() {
    this.busy.set(true);
    this.error.set(null);
    this.api.startRecording(this.areaId()).subscribe({
      next: () => {
        this.busy.set(false);
        this.loadRecordings();
      },
      error: (e: HttpErrorResponse) => this.fail(e),
    });
  }

  protected stop() {
    this.busy.set(true);
    this.api.stopRecording(this.areaId()).subscribe({
      next: () => {
        this.busy.set(false);
        this.loadRecordings();
      },
      error: (e: HttpErrorResponse) => {
        this.fail(e);
        this.loadRecordings(); // it may have ended on its own
      },
    });
  }

  protected deleteRecording(r: RecordingItem) {
    if (!confirm(`Delete the video from ${this.dateTime(r.started_at)}? This cannot be undone.`)) return;
    this.api.deleteRecording(r.id).subscribe({
      next: () => this.recordings.update((list) => list.filter((x) => x.id !== r.id)),
      error: (e: HttpErrorResponse) => this.fail(e),
    });
  }

  protected deleteSnapshot(s: SnapshotItem) {
    if (!confirm(`Delete the photo from ${this.dateTime(s.created_at)}? This cannot be undone.`)) return;
    this.api.deleteSnapshot(s.id).subscribe({
      next: () => this.snapshots.update((list) => list.filter((x) => x.id !== s.id)),
      error: (e: HttpErrorResponse) => this.fail(e),
    });
  }

  // <img>, <video> and downloads can't send the auth header, so the token goes in the URL (like the camera stream)
  protected fileUrl(kind: 'snapshots' | 'recordings', id: number, download = false) {
    return `/api/${kind}/${id}/file?token=${encodeURIComponent(this.auth.token() ?? '')}${download ? '&download=true' : ''}`;
  }

  protected noteValue(e: Event) {
    return (e.target as HTMLInputElement).value;
  }

  protected clock(totalSeconds: number) {
    const s = Math.max(0, Math.round(totalSeconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  protected megabytes(bytes: number) {
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }

  protected dateTime = fmtDateTime;
}
