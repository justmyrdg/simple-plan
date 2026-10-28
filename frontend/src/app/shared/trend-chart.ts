import { Component, computed, input, signal } from '@angular/core';

export interface TrendPoint {
  time: number; // epoch ms
  score: number; // 0-1
}

const W = 600;
const H = 160;
const PAD = { top: 10, right: 12, bottom: 22, left: 34 };

/** Line chart of trash score over time, with threshold line and hover crosshair. */
@Component({
  selector: 'app-trend-chart',
  template: `
    <div class="trend" (mouseleave)="hover.set(null)">
      <svg [attr.viewBox]="'0 0 ' + W + ' ' + H" preserveAspectRatio="none" class="trend-svg"
           (mousemove)="onMove($event)" role="img" aria-label="Trash score over time">
        @for (g of gridLines; track g) {
          <line [attr.x1]="PAD.left" [attr.x2]="W - PAD.right" [attr.y1]="y(g)" [attr.y2]="y(g)" class="trend-grid" />
        }
        @if (points().length > 1) {
          <line [attr.x1]="PAD.left" [attr.x2]="W - PAD.right" [attr.y1]="y(threshold())" [attr.y2]="y(threshold())"
                class="trend-threshold" />
          <path [attr.d]="area()" class="trend-area" />
          <path [attr.d]="line()" class="trend-line" />
        }
        @if (hoverPoint(); as h) {
          <line [attr.x1]="h.x" [attr.x2]="h.x" [attr.y1]="PAD.top" [attr.y2]="H - PAD.bottom" class="trend-cross" />
        }
      </svg>
      <!-- labels and the hover dot live in HTML so they don't stretch with the SVG -->
      @for (g of gridLines; track g) {
        <span class="trend-axis trend-axis-y" [style.top.%]="(y(g) / H) * 100">{{ g * 100 }}%</span>
      }
      <span class="trend-axis trend-axis-x" [style.left.%]="(PAD.left / W) * 100">{{ startLabel() }}</span>
      <span class="trend-axis trend-axis-x trend-axis-end" [style.right.%]="(PAD.right / W) * 100">now</span>
      @if (hoverPoint(); as h) {
        <span class="trend-dot" [class.is-trash]="h.p.score >= threshold()"
              [style.left.%]="(h.x / W) * 100" [style.top.%]="(h.y / H) * 100"></span>
        <div class="trend-tip" [style.left.%]="(h.x / W) * 100">
          <strong>{{ (h.p.score * 100).toFixed(0) }}%</strong>
          <span>{{ h.p.score >= threshold() ? 'Trash' : 'Clean' }} · {{ clock(h.p.time) }}</span>
        </div>
      }
      @if (points().length < 2) {
        <div class="trend-empty">Start the camera to see the score over time</div>
      }
    </div>
  `,
})
export class TrendChart {
  readonly points = input<TrendPoint[]>([]);
  readonly threshold = input(0.5);

  protected readonly W = W;
  protected readonly H = H;
  protected readonly PAD = PAD;
  protected readonly gridLines = [0, 0.5, 1];
  protected readonly hover = signal<number | null>(null);

  private readonly xs = computed(() => {
    const pts = this.points();
    if (pts.length < 2) return [];
    const t0 = pts[0].time, t1 = pts[pts.length - 1].time;
    const span = Math.max(t1 - t0, 1);
    return pts.map((p) => PAD.left + ((p.time - t0) / span) * (W - PAD.left - PAD.right));
  });

  protected readonly line = computed(() =>
    this.points().map((p, i) => `${i ? 'L' : 'M'}${this.xs()[i].toFixed(1)},${this.y(p.score).toFixed(1)}`).join(' '),
  );

  protected readonly area = computed(() => {
    const xs = this.xs();
    if (!xs.length) return '';
    const base = this.y(0);
    return `${this.line()} L${xs[xs.length - 1].toFixed(1)},${base} L${xs[0].toFixed(1)},${base} Z`;
  });

  protected readonly hoverPoint = computed(() => {
    const i = this.hover();
    const pts = this.points();
    if (i === null || !pts[i]) return null;
    return { p: pts[i], x: this.xs()[i], y: this.y(pts[i].score) };
  });

  protected readonly startLabel = computed(() => {
    const pts = this.points();
    if (pts.length < 2) return '';
    const secs = Math.round((pts[pts.length - 1].time - pts[0].time) / 1000);
    return secs >= 60 ? `-${Math.floor(secs / 60)}m ${secs % 60}s` : `-${secs}s`;
  });

  protected y(score: number) {
    return PAD.top + (1 - score) * (H - PAD.top - PAD.bottom);
  }

  protected onMove(e: MouseEvent) {
    const xs = this.xs();
    if (!xs.length) return;
    const svg = e.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - x) < Math.abs(xs[best] - x)) best = i;
    this.hover.set(best);
  }

  protected clock(t: number) {
    return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
}
