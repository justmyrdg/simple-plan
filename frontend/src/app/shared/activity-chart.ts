import { Component, computed, input, signal } from '@angular/core';
import { fmtTime } from './format';

export interface ActivityBucket {
  hour: string;
  checks: number;
  trash: number;
}

/** Stacked bars of clean vs trash camera checks per hour, with per-bar hover tooltip. */
@Component({
  selector: 'app-activity-chart',
  template: `
    <div class="activity" (mouseleave)="hover.set(null)">
      <div class="activity-plot">
        @for (b of bars(); track b.hour; let i = $index) {
          <div class="activity-col" (mouseenter)="hover.set(i)" [class.dim]="hover() !== null && hover() !== i">
            <div class="activity-stack" [style.height.%]="b.total ? (b.total / max()) * 100 : 0">
              @if (b.trash) { <div class="seg seg-trash" [style.flex-grow]="b.trash"></div> }
              @if (b.clean) { <div class="seg seg-clean" [style.flex-grow]="b.clean"></div> }
            </div>
          </div>
        }
        @if (!hasData()) {
          <div class="activity-empty">No camera checks in the last 24 hours</div>
        }
      </div>
      <div class="activity-axis">
        <span>{{ label(0) }}</span><span>{{ label(12) }}</span><span>now</span>
      </div>
      @if (hover() !== null && bars()[hover()!]; as b) {
        <div class="activity-tip" [style.left.%]="((hover()! + 0.5) / bars().length) * 100">
          <strong>{{ label(hover()!) }}</strong>
          <span><i class="sw sw-trash"></i>Trash {{ b.trash }}</span>
          <span><i class="sw sw-clean"></i>Clean {{ b.clean }}</span>
        </div>
      }
    </div>
  `,
})
export class ActivityChart {
  readonly data = input<ActivityBucket[]>([]);
  protected readonly hover = signal<number | null>(null);

  protected readonly bars = computed(() =>
    this.data().map((b) => ({ hour: b.hour, total: b.checks, trash: b.trash, clean: b.checks - b.trash })),
  );
  protected readonly max = computed(() => Math.max(1, ...this.bars().map((b) => b.total)));
  protected readonly hasData = computed(() => this.bars().some((b) => b.total > 0));

  protected label(i: number) {
    const b = this.data()[i];
    return b ? fmtTime(b.hour) : '';
  }
}
