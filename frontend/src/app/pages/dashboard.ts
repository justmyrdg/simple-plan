import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { PercentPipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ApiService, Dashboard, errorMessage } from '../core/api.service';
import { AreaMap, MapMarker } from '../shared/area-map';
import { ActivityChart } from '../shared/activity-chart';
import { CollectionList } from '../shared/collection-list';
import { fmtAgo, fmtDateTime, fmtTime, fmtUntil } from '../shared/format';

const REFRESH_MS = 15000;

@Component({
  selector: 'app-dashboard',
  imports: [RouterLink, PercentPipe, AreaMap, ActivityChart, CollectionList],
  template: `
    <header class="page-head">
      <div>
        <h1>Dashboard</h1>
        <p class="page-sub">Overview of all monitored areas · updates every 15 seconds</p>
      </div>
      <div class="page-head-actions">
        <button class="btn" (click)="load()"><svg class="icon"><use href="#i-refresh" /></svg> Refresh</button>
        <a class="btn btn-primary" routerLink="/admin/monitor"><svg class="icon"><use href="#i-camera" /></svg> Open monitor</a>
      </div>
    </header>

    <div class="page">
      @if (error()) { <div class="error">{{ error() }}</div> }
      @if (d()?.sms_provider === 'simulated') {
        <div class="notice">
          <svg class="icon"><use href="#i-message" /></svg>
          SMS is in <strong>simulation mode</strong>: messages are logged but not sent. Set up the free Android SMS gateway
          (<code>SMSGATE_USERNAME</code> / <code>SMSGATE_PASSWORD</code>) or <code>SEMAPHORE_API_KEY</code> in <code>backend/.env</code> to send real texts.
        </div>
      }

      @if (d(); as d) {
        <section class="kpi-row">
          <div class="kpi-tile">
            <span class="kpi-icon"><svg class="icon"><use href="#i-pin" /></svg></span>
            <span class="kpi-value">{{ d.totals.areas }}</span><span class="kpi-label">Areas</span>
          </div>
          <div class="kpi-tile">
            <span class="kpi-icon"><svg class="icon"><use href="#i-camera" /></svg></span>
            <span class="kpi-value">{{ d.totals.cameras_online }}<small> / {{ d.totals.cameras }}</small></span>
            <span class="kpi-label">Cameras online</span>
          </div>
          <div class="kpi-tile" [class.kpi-bad]="d.totals.areas_trash > 0">
            <span class="kpi-icon"><svg class="icon"><use href="#i-alert" /></svg></span>
            <span class="kpi-value">{{ d.totals.areas_trash }}</span><span class="kpi-label">Areas with trash</span>
          </div>
          <div class="kpi-tile">
            <span class="kpi-icon"><svg class="icon"><use href="#i-users" /></svg></span>
            <span class="kpi-value">{{ d.totals.contacts }}</span><span class="kpi-label">Registered contacts</span>
          </div>
          <div class="kpi-tile">
            <span class="kpi-icon"><svg class="icon"><use href="#i-truck" /></svg></span>
            <span class="kpi-value">{{ d.totals.pickups_today }}</span><span class="kpi-label">Pickups today</span>
          </div>
          <div class="kpi-tile" [class.kpi-bad]="d.totals.collections_today.missed > 0">
            <span class="kpi-icon"><svg class="icon"><use href="#i-check" /></svg></span>
            <span class="kpi-value">{{ d.totals.collections_today.collected }}</span>
            <span class="kpi-label">Collected today{{ d.totals.collections_today.missed ? ' · ' + d.totals.collections_today.missed + ' missed' : '' }}</span>
          </div>
          <div class="kpi-tile">
            <span class="kpi-icon"><svg class="icon"><use href="#i-message" /></svg></span>
            <span class="kpi-value">{{ smsToday() }}</span>
            <span class="kpi-label">SMS today{{ d.totals.sms_today.failed ? ' · ' + d.totals.sms_today.failed + ' failed' : '' }}</span>
          </div>
        </section>

        <section class="dash-grid">
          <div class="card card-flush dash-map">
            <div class="card-head">
              <h3>Area map</h3>
              <span class="legend">
                <span class="legend-item"><i class="pin-dot pin-dot-trash"></i>Trash</span>
                <span class="legend-item"><i class="pin-dot pin-dot-clean"></i>Clean</span>
                <span class="legend-item"><i class="pin-dot pin-dot-idle"></i>No data</span>
              </span>
            </div>
            <app-area-map class="map-lg" [markers]="markers()" (markerClick)="openArea($event)" />
          </div>

          <div class="card">
            <div class="section-head"><h3>Area status</h3><a class="link" routerLink="/admin/areas">Manage</a></div>
            <ul class="status-list">
              @for (a of d.areas; track a.id) {
                <li>
                  <a [routerLink]="['/admin/areas', a.id]" class="status-row">
                    <span class="status-ico" [attr.data-tone]="a.status ?? 'idle'">
                      <svg class="icon"><use [attr.href]="a.status === 'trash' ? '#i-alert' : a.status === 'clean' ? '#i-check' : '#i-idle'" /></svg>
                    </span>
                    <span class="status-main">
                      <span class="status-name">{{ a.name }}</span>
                      <span class="status-meta">
                        @if (a.camera_enabled) {
                          <span class="online" [class.on]="a.online"></span>{{ a.online ? 'Online' : 'Offline' }} · checked {{ ago(a.checked_at) }}
                        } @else { No camera }
                      </span>
                    </span>
                    <span class="tag" [attr.data-kind]="a.status ?? 'idle'">
                      {{ a.status === 'trash' ? 'Trash' : a.status === 'clean' ? 'Clean' : 'No data' }}
                      @if (a.score !== null) { {{ a.score | percent: '1.0-0' }} }
                    </span>
                  </a>
                </li>
              } @empty {
                <li class="empty">No areas yet. <a routerLink="/admin/areas">Add one</a>.</li>
              }
            </ul>
          </div>

          <div class="card">
            <div class="section-head">
              <h3>Camera checks · last 24 hours</h3>
              <span class="legend">
                <span class="legend-item"><i class="sw sw-trash"></i>Trash</span>
                <span class="legend-item"><i class="sw sw-clean"></i>Clean</span>
              </span>
            </div>
            <app-activity-chart [data]="d.activity" />
          </div>

          <div class="card">
            <div class="section-head"><h3>Upcoming pickups</h3><span class="muted small">next 7 days</span></div>
            <ul class="pickup-list">
              @for (p of d.upcoming_pickups; track p.time + p.area_id) {
                <li>
                  <div class="pickup-date"><span>{{ day(p.time) }}</span><strong>{{ time(p.time) }}</strong></div>
                  <div class="pickup-main">
                    <a [routerLink]="['/admin/areas', p.area_id]" class="pickup-area">{{ p.area }}</a>
                    <span class="muted small">{{ p.truck || 'Garbage truck' }} · {{ p.contacts }} contact{{ p.contacts === 1 ? '' : 's' }} notified</span>
                  </div>
                  <span class="pickup-until">{{ until(p.time) }}</span>
                </li>
              } @empty {
                <li class="empty">No pickups scheduled. Add a schedule from an area's page.</li>
              }
            </ul>
          </div>

          <div class="card dash-wide">
            <div class="section-head"><h3>Recent collections · last 7 days</h3><a class="link" routerLink="/admin/reports">Full report</a></div>
            <app-collection-list [items]="d.recent_collections"
                                 empty="No pickups judged yet. Each scheduled pickup is checked against the camera once its time window starts." />
          </div>

          <div class="card dash-wide">
            <div class="section-head"><h3>Recent status changes</h3></div>
            @if (d.recent_detections.length) {
              <div class="table-wrap">
                <table class="table">
                  <thead><tr><th>Time</th><th>Area</th><th>Status</th><th class="num">Score</th></tr></thead>
                  <tbody>
                    @for (r of d.recent_detections; track $index) {
                      <tr>
                        <td>{{ dateTime(r.time) }}</td>
                        <td>{{ r.area }}</td>
                        <td><span class="tag" [attr.data-kind]="r.status">{{ r.status === 'trash' ? 'Trash' : 'Clean' }}</span></td>
                        <td class="num">{{ r.score | percent: '1.0-0' }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            } @else {
              <p class="empty">Start the camera on the Monitor page to record detections.</p>
            }
          </div>
        </section>
      } @else if (!error()) {
        <div class="loading-block"><span class="spinner spinner-dark"></span> Loading dashboard…</div>
      }
    </div>
  `,
})
export class DashboardPage implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private router = inject(Router);
  private timer?: ReturnType<typeof setInterval>;

  protected d = signal<Dashboard | null>(null);
  protected error = signal<string | null>(null);

  protected markers = computed<MapMarker[]>(() =>
    (this.d()?.areas ?? []).map((a) => ({
      id: a.id, lat: a.lat, lng: a.lng, title: a.name,
      subtitle: a.status ? `${a.status === 'trash' ? 'Trash' : 'Clean'} · ${fmtAgo(a.checked_at)}` : 'No data yet',
      tone: a.status ?? 'idle',
    })),
  );

  protected smsToday = computed(() => {
    const s = this.d()?.totals.sms_today ?? {};
    return (s.sent ?? 0) + (s.simulated ?? 0);
  });

  ngOnInit() {
    this.load();
    this.timer = setInterval(() => this.load(), REFRESH_MS);
  }

  ngOnDestroy() {
    clearInterval(this.timer);
  }

  protected load() {
    this.api.dashboard().subscribe({
      next: (d) => {
        this.d.set(d);
        this.error.set(null);
      },
      error: (e: HttpErrorResponse) => this.error.set(errorMessage(e)),
    });
  }

  protected openArea(id: number) {
    this.router.navigate(['/admin/areas', id]);
  }

  protected ago = fmtAgo;
  protected until = fmtUntil;
  protected time = fmtTime;
  protected dateTime = fmtDateTime;
  protected day(v: string) {
    return new Date(v).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }
}
