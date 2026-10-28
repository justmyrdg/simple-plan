import { Component, OnInit, inject, signal } from '@angular/core';
import { DecimalPipe, PercentPipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ApiService, Report, errorMessage } from '../core/api.service';
import { CollectionList } from '../shared/collection-list';
import { fmtDate } from '../shared/format';

/** Collection performance over a period: the numbers that show whether waste management is improving. */
@Component({
  selector: 'app-reports',
  imports: [DecimalPipe, CollectionList],
  template: `
    <header class="page-head">
      <div>
        <h1>Reports</h1>
        <p class="page-sub">How well scheduled pickups were collected, judged from the cameras.</p>
      </div>
      <div class="page-head-actions">
        <nav class="segmented" aria-label="Period">
          @for (d of periods; track d) {
            <button [class.active]="days() === d" (click)="load(d)">{{ d }} days</button>
          }
        </nav>
        <button class="btn" (click)="downloadCsv()"><svg class="icon"><use href="#i-download" /></svg> Download CSV</button>
      </div>
    </header>

    <div class="page">
      @if (error()) { <div class="error">{{ error() }}</div> }

      @if (r(); as r) {
        <p class="muted small">{{ date(r.since) }} – {{ date(r.until) }} · {{ r.totals.pickups }} scheduled pickups judged</p>

        <section class="kpi-row">
          <div class="kpi-tile" [class.kpi-bad]="(r.totals.collection_rate ?? 1) < 0.8">
            <span class="kpi-icon"><svg class="icon"><use href="#i-check" /></svg></span>
            <span class="kpi-value">{{ pct(r.totals.collection_rate) }}</span><span class="kpi-label">Collection rate</span>
          </div>
          <div class="kpi-tile">
            <span class="kpi-icon"><svg class="icon"><use href="#i-clock" /></svg></span>
            <span class="kpi-value">{{ pct(r.totals.on_time_rate) }}</span><span class="kpi-label">Collected on time</span>
          </div>
          <div class="kpi-tile">
            <span class="kpi-icon"><svg class="icon"><use href="#i-truck" /></svg></span>
            <span class="kpi-value">{{ minutes(r.totals.avg_minutes_late) }}</span><span class="kpi-label">Average delay</span>
          </div>
          <div class="kpi-tile">
            <span class="kpi-icon"><svg class="icon"><use href="#i-trash" /></svg></span>
            <span class="kpi-value">{{ r.totals.avg_hours_full === null ? '–' : (r.totals.avg_hours_full | number: '1.0-1') + ' h' }}</span>
            <span class="kpi-label">Full before pickup (avg)</span>
          </div>
          <div class="kpi-tile">
            <span class="kpi-icon"><svg class="icon"><use href="#i-alert" /></svg></span>
            <span class="kpi-value">{{ pct(r.totals.time_full) }}</span><span class="kpi-label">Time areas were full</span>
          </div>
          <div class="kpi-tile" [class.kpi-bad]="r.totals.reminders_failed > 0">
            <span class="kpi-icon"><svg class="icon"><use href="#i-message" /></svg></span>
            <span class="kpi-value">{{ r.totals.reminders_sent }}</span>
            <span class="kpi-label">Reminders sent{{ r.totals.reminders_failed ? ' · ' + r.totals.reminders_failed + ' failed' : '' }}</span>
          </div>
        </section>

        <section class="card card-flush">
          <div class="card-head"><h3>By area</h3></div>
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Area</th><th class="num">Pickups</th><th class="num">Collected</th><th class="num">Missed</th>
                  <th class="num">Nothing to collect</th><th class="num">No data</th><th class="num">Collection rate</th>
                  <th class="num">On time</th><th class="num">Avg delay</th><th class="num">Full before pickup</th>
                  <th class="num">Time full</th><th class="num">Times filled</th><th class="num">Reminders</th>
                </tr>
              </thead>
              <tbody>
                @for (a of r.areas; track a.area_id) {
                  <tr>
                    <td class="cell-title">{{ a.area }}</td>
                    <td class="num">{{ a.pickups }}</td>
                    <td class="num">{{ a.collected }}</td>
                    <td class="num" [class.err]="a.missed > 0">{{ a.missed }}</td>
                    <td class="num">{{ a.no_waste }}</td>
                    <td class="num">{{ a.no_data }}</td>
                    <td class="num">{{ pct(a.collection_rate) }}</td>
                    <td class="num">{{ pct(a.on_time_rate) }}</td>
                    <td class="num">{{ minutes(a.avg_minutes_late) }}</td>
                    <td class="num">{{ a.avg_hours_full === null ? '–' : (a.avg_hours_full | number: '1.0-1') + ' h' }}</td>
                    <td class="num">{{ pct(a.time_full) }}</td>
                    <td class="num">{{ a.times_filled }}</td>
                    <td class="num">{{ a.reminders_sent }}{{ a.reminders_failed ? ' (' + a.reminders_failed + ' failed)' : '' }}</td>
                  </tr>
                } @empty {
                  <tr><td colspan="13" class="empty-cell">No areas yet.</td></tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        <section class="card">
          <div class="section-head"><h3>Pickups in this period</h3></div>
          <app-collection-list [items]="r.collections" empty="No scheduled pickups were judged in this period." />
        </section>

        <section class="card how">
          <div class="section-head"><h3>How these numbers are measured</h3></div>
          <ul>
            <li><strong>Collected</strong>: in the window from 2 hours before to 4 hours after a scheduled pickup, the camera saw the area go from full to clean, and it stayed clean for 3 minutes.</li>
            <li><strong>Missed</strong>: the area was still full when that window ended. Admins get an SMS.</li>
            <li><strong>Nothing to collect</strong>: the area was never full in the window. <strong>No data</strong>: the camera wasn't reporting, so the pickup isn't judged.</li>
            <li><strong>Collection rate</strong> = collected ÷ (collected + missed). <strong>On time</strong> = clean within 30 minutes after the scheduled time (or earlier).</li>
            <li><strong>Full before pickup</strong>: from when the area became full until it turned clean. <strong>Time full</strong>: share of camera-observed time the area looked full.</li>
          </ul>
        </section>
      } @else if (!error()) {
        <div class="loading-block"><span class="spinner spinner-dark"></span> Loading report…</div>
      }
    </div>
  `,
})
export class ReportsPage implements OnInit {
  private api = inject(ApiService);

  protected periods = [7, 30, 90];
  protected days = signal(30);
  protected r = signal<Report | null>(null);
  protected error = signal<string | null>(null);

  ngOnInit() {
    this.load(30);
  }

  protected load(days: number) {
    this.days.set(days);
    this.api.report(days).subscribe({
      next: (r) => {
        this.r.set(r);
        this.error.set(null);
      },
      error: (e: HttpErrorResponse) => this.error.set(errorMessage(e)),
    });
  }

  protected downloadCsv() {
    this.api.reportCsv(this.days()).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `trashwatch-collections-${this.days()}d.csv`;
        a.click();
        URL.revokeObjectURL(url);
      },
      error: (e: HttpErrorResponse) => this.error.set(errorMessage(e)),
    });
  }

  private percent = new PercentPipe('en-US');
  protected pct(v: number | null) {
    return v === null ? '–' : this.percent.transform(v, '1.0-0');
  }
  protected minutes(v: number | null) {
    if (v === null) return '–';
    const m = Math.round(v);
    return m < 0 ? `${-m} min early` : `${m} min`;
  }
  protected date = fmtDate;
}
