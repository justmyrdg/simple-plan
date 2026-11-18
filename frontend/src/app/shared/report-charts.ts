import { Component, DestroyRef, ElementRef, afterNextRender, computed, inject, input, signal } from '@angular/core';
import { CollectionStatus, Report } from '../core/api.service';
import { COLLECTION_STATUS } from './collection-list';
import { toDate } from './format';

const DAY = 86_400_000;
/** Bottom-to-top order of the stacked bars; colors are the --viz-* tokens in styles.css. */
const STACK: { key: Exclude<CollectionStatus, 'pending'>; fill: string; hatch?: boolean }[] = [
  { key: 'collected', fill: 'var(--viz-collected)' },
  { key: 'missed', fill: 'var(--viz-missed)', hatch: true },
  { key: 'no_waste', fill: 'var(--viz-nowaste)' },
  { key: 'no_data', fill: 'var(--viz-nodata)' },
];
const TARGET = 0.8; // same "good enough" line the KPI tile uses

interface Bucket { start: Date; end: Date; counts: Record<string, number>; total: number }

function startOfDay(d: Date) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function addDays(d: Date, n: number) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function short(d: Date) { return d.toLocaleDateString([], { month: 'short', day: 'numeric' }); }
/** Rect with only the end away from the baseline rounded (4px data-end). */
function bar(x: number, y: number, w: number, h: number, r: number, side: 'top' | 'right') {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (side === 'top')
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}
function niceStep(max: number) {
  for (const s of [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000]) if (max / s <= 4) return s;
  return Math.ceil(max / 4);
}

/** The Reports page graphs: pickup results over time (stacked bars) and collection rate per area (bars). */
@Component({
  selector: 'app-report-charts',
  template: `
    <div class="chart-grid">
      <!-- 1. pickups over time -->
      <section class="card chart-card">
        <div class="chart-head">
          <h3>Pickup results {{ buckets().size === 1 ? 'per day' : buckets().size === 7 ? 'per week' : 'per month' }}</h3>
          <ul class="chart-legend">
            @for (s of stack; track s.key) {
              <li>
                <svg class="chart-swatch" viewBox="0 0 12 12" aria-hidden="true">
                  <rect width="12" height="12" rx="3" [attr.fill]="s.fill" />
                  @if (s.hatch) { <rect width="12" height="12" rx="3" fill="url(#rc-hatch)" /> }
                </svg>
                <svg class="icon icon-sm" aria-hidden="true"><use [attr.href]="labels[s.key].icon" /></svg>
                {{ labels[s.key].label }}
              </li>
            }
          </ul>
        </div>
        @if (buckets().pickups === 0) {
          <p class="empty">No scheduled pickups were judged in this period.</p>
        } @else {
          <div class="chart-box">
            <svg [attr.viewBox]="'0 0 ' + w() + ' ' + H" class="chart-svg" role="img"
                 [attr.aria-label]="'Stacked bar chart of pickup results, ' + buckets().pickups + ' pickups. The table below has the same numbers.'">
              <defs>
                <pattern id="rc-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <line x1="0" y1="0" x2="0" y2="5" stroke="var(--viz-missed-ink)" stroke-width="1.6" />
                </pattern>
              </defs>
              @for (t of timeChart().ticks; track t.v) {
                <line [attr.x1]="PAD_L" [attr.x2]="w() - PAD_R" [attr.y1]="t.y" [attr.y2]="t.y"
                      [attr.stroke]="t.v === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'" stroke-width="1" />
                <text class="chart-tick" [attr.x]="PAD_L - 6" [attr.y]="t.y + 4" text-anchor="end">{{ t.v }}</text>
              }
              @for (b of timeChart().bars; track b.i) {
                @for (s of b.segs; track s.key) {
                  <path [attr.d]="s.d" [attr.fill]="s.fill" />
                  @if (s.hatch) { <path [attr.d]="s.d" fill="url(#rc-hatch)" /> }
                }
                @if (b.label) {
                  <text class="chart-tick" [attr.x]="b.cx" [attr.y]="H - 6" text-anchor="middle">{{ b.label }}</text>
                }
                <!-- hit target: the whole column, wider than the bar -->
                <rect class="chart-hit" [attr.x]="b.cx - b.slot / 2" [attr.y]="PAD_T" [attr.width]="b.slot"
                      [attr.height]="plotH" (mouseenter)="hoverTime.set(b.i)" (mouseleave)="hoverTime.set(null)" />
              }
              @if (hoverTime() !== null) {
                <rect class="chart-hover" [attr.x]="timeChart().bars[hoverTime()!].cx - timeChart().bars[hoverTime()!].slot / 2"
                      [attr.y]="PAD_T" [attr.width]="timeChart().bars[hoverTime()!].slot" [attr.height]="plotH" />
              }
            </svg>
            @if (hoverTime() !== null) {
              @let b = buckets().list[hoverTime()!];
              <div class="chart-tip" [style.left.px]="tipLeft(timeChart().bars[hoverTime()!].cx)">
                <strong>{{ bucketTitle(b) }}</strong>
                @for (s of stack; track s.key) {
                  <div class="chart-tip-row">
                    <span class="chart-tip-dot" [style.background]="s.fill"></span>{{ labels[s.key].label }}
                    <b>{{ b.counts[s.key] }}</b>
                  </div>
                }
                <div class="chart-tip-row chart-tip-total">Total <b>{{ b.total }}</b></div>
              </div>
            }
          </div>
        }
      </section>

      <!-- 2. collection rate per area -->
      <section class="card chart-card">
        <div class="chart-head">
          <h3>Collection rate by area</h3>
          <span class="muted small">Dashed line: {{ TARGET * 100 }}% target · lowest first</span>
        </div>
        @if (!report().areas.length) {
          <p class="empty">No areas yet.</p>
        } @else {
          <div class="chart-box">
            <svg [attr.viewBox]="'0 0 ' + w() + ' ' + rateChart().height" class="chart-svg" role="img"
                 aria-label="Bar chart of the collection rate per area. The By area table below has the same numbers.">
              @for (g of rateChart().grid; track g.p) {
                <line [attr.x1]="g.x" [attr.x2]="g.x" [attr.y1]="0" [attr.y2]="rateChart().height - 20"
                      [attr.stroke]="g.p === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'" stroke-width="1" />
                <text class="chart-tick" [attr.x]="g.x" [attr.y]="rateChart().height - 5" text-anchor="middle">{{ g.p }}%</text>
              }
              <line class="chart-target" [attr.x1]="rateChart().targetX" [attr.x2]="rateChart().targetX"
                    [attr.y1]="0" [attr.y2]="rateChart().height - 20" />
              @for (r of rateChart().rows; track r.id) {
                <text class="chart-label" [attr.x]="rateChart().labelW - 10" [attr.y]="r.y + 4" text-anchor="end">{{ r.name }}</text>
                @if (r.d) {
                  <path [attr.d]="r.d" fill="var(--viz-series)" />
                  <text class="chart-value" [attr.x]="r.endX + 6" [attr.y]="r.y + 4">{{ r.text }}</text>
                } @else {
                  <text class="chart-tick" [attr.x]="rateChart().labelW + 4" [attr.y]="r.y + 4">{{ r.text }}</text>
                }
                <rect class="chart-hit" x="0" [attr.y]="r.y - ROW / 2" [attr.width]="w()" [attr.height]="ROW"
                      (mouseenter)="hoverArea.set(r.i)" (mouseleave)="hoverArea.set(null)" />
              }
              @if (hoverArea() !== null) {
                <rect class="chart-hover" x="0" [attr.y]="rateChart().rows[hoverArea()!].y - ROW / 2" [attr.width]="w()" [attr.height]="ROW" />
              }
            </svg>
            @if (hoverArea() !== null) {
              @let r = rateChart().rows[hoverArea()!];
              <div class="chart-tip" [style.left.px]="tipLeft(rateChart().labelW + 80)" [style.top.px]="r.y + ROW / 2 + 4">
                <strong>{{ r.name }}</strong>
                <div class="chart-tip-row">Collection rate <b>{{ r.d ? r.text : '–' }}</b></div>
                <div class="chart-tip-row">Collected <b>{{ r.a.collected }}</b></div>
                <div class="chart-tip-row">Not collected <b>{{ r.a.missed }}</b></div>
                <div class="chart-tip-row">Pickups judged <b>{{ r.a.pickups }}</b></div>
              </div>
            }
          </div>
        }
      </section>
    </div>
  `,
})
export class ReportCharts {
  readonly report = input.required<Report>();

  protected readonly H = 230;
  protected readonly PAD_L = 34;
  protected readonly PAD_R = 8;
  protected readonly PAD_T = 10;
  protected readonly PAD_B = 26;
  protected readonly ROW = 32;
  protected readonly TARGET = TARGET;
  protected readonly plotH = this.H - this.PAD_T - this.PAD_B;
  protected readonly stack = STACK;
  protected readonly labels = COLLECTION_STATUS;

  /** Drawing width = the card's width, so text stays at its real size. */
  protected readonly w = signal(560);
  protected readonly hoverTime = signal<number | null>(null);
  protected readonly hoverArea = signal<number | null>(null);

  constructor() {
    const host = inject(ElementRef).nativeElement as HTMLElement;
    const destroy = inject(DestroyRef);
    afterNextRender(() => {
      // both cards share one width (they sit side by side, or stacked on narrow screens);
      // the observer also fires once layout is done, so an early 0-width read gets corrected
      const card = host.querySelector('.chart-card') as HTMLElement;
      const measure = () => {
        if (card.clientWidth > 0) this.w.set(Math.max(260, Math.round(card.clientWidth - 32)));
      };
      measure();
      const ro = new ResizeObserver(measure);
      ro.observe(card);
      destroy.onDestroy(() => ro.disconnect());
    });
  }

  /** Pickups grouped per day (≤ 31 days), per week (≤ 120 days) or per 30 days. */
  protected readonly buckets = computed(() => {
    const r = this.report();
    const since = startOfDay(toDate(r.since));
    const until = toDate(r.until);
    const days = Math.max(1, Math.ceil((until.getTime() - since.getTime()) / DAY));
    const size = days <= 31 ? 1 : days <= 120 ? 7 : 30;
    const n = Math.ceil(days / size);
    const list: Bucket[] = Array.from({ length: n }, (_, i) => ({
      start: addDays(since, i * size),
      end: addDays(since, Math.min((i + 1) * size, days) - 1),
      counts: { collected: 0, missed: 0, no_waste: 0, no_data: 0 },
      total: 0,
    }));
    let pickups = 0;
    for (const c of r.collections) {
      if (c.status === 'pending') continue;
      const day = Math.round((startOfDay(toDate(c.scheduled_for)).getTime() - since.getTime()) / DAY);
      const b = list[Math.floor(day / size)];
      if (!b) continue;
      b.counts[c.status]++;
      b.total++;
      pickups++;
    }
    return { size, list, pickups };
  });

  protected readonly timeChart = computed(() => {
    const { list, size } = this.buckets();
    const w = this.w();
    const plotW = w - this.PAD_L - this.PAD_R;
    const max = Math.max(1, ...list.map((b) => b.total));
    const step = niceStep(max);
    const top = Math.ceil(max / step) * step;
    const y = (v: number) => this.PAD_T + this.plotH - (v / top) * this.plotH;
    const ticks = [];
    for (let v = 0; v <= top; v += step) ticks.push({ v, y: y(v) });

    const slot = plotW / list.length;
    const bw = Math.max(3, Math.min(28, slot * 0.66));
    const every = Math.ceil(list.length / Math.max(2, Math.floor(plotW / 56)));
    const bars = list.map((b, i) => {
      const cx = this.PAD_L + slot * (i + 0.5);
      const shown = STACK.filter((s) => b.counts[s.key] > 0);
      let cum = 0;
      const segs = shown.map((s, j) => {
        const h = (b.counts[s.key] / top) * this.plotH;
        const last = j === shown.length - 1;
        const y0 = y(cum) - h;
        cum += b.counts[s.key];
        // 2px surface gap between stacked segments
        const hh = last ? h : Math.max(1, h - 2);
        return { key: s.key, fill: s.fill, hatch: !!s.hatch, d: bar(cx - bw / 2, y0 + (h - hh), bw, hh, last ? 4 : 0, 'top') };
      });
      const label = i % every === 0 ? (size === 30 ? b.start.toLocaleDateString([], { month: 'short' }) : short(b.start)) : '';
      return { i, cx, slot, segs, label };
    });
    return { ticks, bars };
  });

  protected readonly rateChart = computed(() => {
    const w = this.w();
    const labelW = Math.round(Math.min(170, Math.max(90, w * 0.32)));
    const plotW = Math.max(60, w - labelW - 52);
    const x = (p: number) => labelW + p * plotW;
    const areas = [...this.report().areas].sort(
      (a, b) => (a.collection_rate ?? 2) - (b.collection_rate ?? 2) || a.area.localeCompare(b.area),
    );
    const rows = areas.map((a, i) => {
      const y = this.ROW / 2 + 4 + i * this.ROW;
      const rate = a.collection_rate;
      // ~6.5px per character at 12px; the full name is in the tooltip and the table
      const fit = Math.max(6, Math.floor((labelW - 12) / 6.5));
      const name = a.area.length > fit ? a.area.slice(0, fit - 1) + '…' : a.area;
      if (rate === null) return { i, id: a.area_id, a, y, name, d: '', endX: 0, text: 'No data yet' };
      const end = x(rate);
      return {
        i, id: a.area_id, a, y, name, endX: end,
        d: bar(labelW, y - 7, Math.max(2, end - labelW), 14, 4, 'right'),
        text: `${Math.round(rate * 100)}%`,
      };
    });
    const height = rows.length * this.ROW + 8 + 20;
    const grid = [0, 25, 50, 75, 100].map((p) => ({ p, x: x(p / 100) }));
    return { rows, height, grid, labelW, targetX: x(TARGET) };
  });

  protected bucketTitle(b: Bucket) {
    const opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' };
    return b.start.getTime() === b.end.getTime()
      ? b.start.toLocaleDateString([], opts)
      : `${short(b.start)} – ${short(b.end)}, ${b.end.getFullYear()}`;
  }

  /** Keep the tooltip (≈190px wide) inside the card. */
  protected tipLeft(x: number) {
    return Math.max(4, Math.min(x - 95, this.w() - 194));
  }
}
