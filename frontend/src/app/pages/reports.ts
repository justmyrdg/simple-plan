import { Component, OnInit, inject, signal } from '@angular/core';
import { DecimalPipe, PercentPipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ApiService, Collection, Report, ReportPeriod, errorMessage } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { COLLECTION_STATUS, CollectionList } from '../shared/collection-list';
import { fmtDate, fmtTime } from '../shared/format';

/** YYYY-MM-DD in local time (what `<input type="date">` and the API expect). */
function isoDay(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

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
            <button [class.active]="!custom() && days() === d" (click)="load(d)">{{ d }} days</button>
          }
          <button [class.active]="custom()" (click)="custom.set(true)">Custom dates</button>
        </nav>
        <button class="btn" (click)="downloadCsv()"><svg class="icon"><use href="#i-download" /></svg> Download CSV</button>
        <button class="btn btn-primary" (click)="print()" [disabled]="!r()"><svg class="icon"><use href="#i-printer" /></svg> Print</button>
      </div>
    </header>

    <div class="page">
      @if (custom()) {
        <form class="card date-range no-print" (submit)="applyRange($event)">
          <label class="field">
            <span>From</span>
            <input class="input" type="date" [value]="start()" [max]="today" (input)="start.set($any($event.target).value)" required />
          </label>
          <label class="field">
            <span>To</span>
            <input class="input" type="date" [value]="end()" [max]="today" (input)="end.set($any($event.target).value)" required />
          </label>
          <button class="btn btn-primary" type="submit">Show records</button>
        </form>
      }

      @if (error()) { <div class="error">{{ error() }}</div> }

      @if (r(); as r) {
        <!-- printed page header (hidden on screen) -->
        <div class="print-head print-only">
          <img src="bsu-logo.png" alt="Batangas State University logo" />
          <div>
            <div class="print-school">Batangas State University</div>
            <div class="print-school-sub">The National Engineering University</div>
            <div class="print-title">TrashWatch · Garbage Collection Report</div>
            <div class="print-meta">
              Period: {{ date(r.since) }} – {{ date(r.until) }} ·
              Printed {{ date(now) }} {{ time(now) }}{{ printedBy() ? ' by ' + printedBy() : '' }}
            </div>
          </div>
        </div>

        <p class="muted small no-print">{{ date(r.since) }} – {{ date(r.until) }} · {{ r.totals.pickups }} scheduled pickups judged</p>

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

        <!-- on screen: the list with before/after photos -->
        <section class="card no-print">
          <div class="section-head"><h3>Pickups in this period</h3></div>
          <app-collection-list [items]="r.collections" empty="No scheduled pickups were judged in this period." />
        </section>

        <!-- on paper: one row per pickup record, with dates -->
        <section class="card card-flush print-only print-records">
          <div class="card-head"><h3>Pickup records ({{ r.collections.length }})</h3></div>
          <table class="table">
            <thead>
              <tr>
                <th class="num">#</th><th>Area</th><th>Scheduled pickup</th><th>Result</th>
                <th>Full since</th><th>Clean at</th><th>Timing</th><th class="num">Full for</th>
              </tr>
            </thead>
            <tbody>
              @for (c of r.collections; track c.id; let i = $index) {
                <tr>
                  <td class="num">{{ i + 1 }}</td>
                  <td>{{ c.area }}</td>
                  <td>{{ dateTime(c.scheduled_for) }}</td>
                  <td>{{ status[c.status].label }}</td>
                  <td>{{ c.full_since ? dateTime(c.full_since) : '–' }}</td>
                  <td>{{ c.collected_at ? dateTime(c.collected_at) : '–' }}</td>
                  <td>{{ c.collected_at ? timing(c) : '–' }}</td>
                  <td class="num">{{ c.hours_full === null ? '–' : (c.hours_full | number: '1.0-1') + ' h' }}</td>
                </tr>
              } @empty {
                <tr><td colspan="8" class="empty-cell">No scheduled pickups were judged in this period.</td></tr>
              }
            </tbody>
          </table>
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

        <div class="print-sign print-only">
          <div><span class="print-line"></span>Prepared by</div>
          <div><span class="print-line"></span>Noted by</div>
        </div>
      } @else if (!error()) {
        <div class="loading-block"><span class="spinner spinner-dark"></span> Loading report…</div>
      }
    </div>
  `,
})
export class ReportsPage implements OnInit {
  private api = inject(ApiService);
  private auth = inject(AuthService);

  protected periods = [7, 30, 90];
  protected days = signal(30);
  protected custom = signal(false);
  protected today = isoDay(new Date());
  protected start = signal(isoDay(new Date(new Date().getFullYear(), new Date().getMonth(), 1)));
  protected end = signal(this.today);
  protected r = signal<Report | null>(null);
  protected error = signal<string | null>(null);
  protected now = new Date();
  protected status = COLLECTION_STATUS;

  ngOnInit() {
    this.load(30);
  }

  /** The period currently shown (what Print and CSV use). */
  private period(): ReportPeriod {
    return this.custom() ? { start: this.start(), end: this.end() } : { days: this.days() };
  }

  protected load(days: number) {
    this.custom.set(false);
    this.days.set(days);
    this.fetch();
  }

  protected applyRange(e: Event) {
    e.preventDefault();
    if (this.end() < this.start()) {
      this.error.set('The "To" date is before the "From" date.');
      return;
    }
    this.fetch();
  }

  private fetch() {
    this.api.report(this.period()).subscribe({
      next: (r) => {
        this.r.set(r);
        this.error.set(null);
      },
      error: (e: HttpErrorResponse) => this.error.set(errorMessage(e)),
    });
  }

  protected print() {
    this.now = new Date();
    // let the "Printed …" time render before the print dialog opens
    setTimeout(() => window.print());
  }

  protected printedBy() {
    const u = this.auth.user();
    return u?.full_name || u?.username || '';
  }

  protected downloadCsv() {
    const p = this.period();
    this.api.reportCsv(p).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'start' in p ? `trashwatch-collections-${p.start}_to_${p.end}.csv` : `trashwatch-collections-${p.days}d.csv`;
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
  protected timing(c: Collection) {
    const m = c.minutes_from_schedule ?? 0;
    if (c.on_time && m >= -15) return 'On time';
    const abs = Math.abs(m);
    const text = abs >= 60 ? `${Math.floor(abs / 60)}h ${abs % 60}m` : `${abs} min`;
    return m < 0 ? `${text} early` : `${text} late`;
  }
  protected date = fmtDate;
  protected time = fmtTime;
  protected dateTime(v: string) {
    return `${fmtDate(v)} ${fmtTime(v)}`;
  }
}
