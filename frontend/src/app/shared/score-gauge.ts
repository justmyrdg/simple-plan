import { Component, computed, input } from '@angular/core';

/** Half-ring gauge showing the trash score (0-1) with a threshold tick. */
@Component({
  selector: 'app-score-gauge',
  template: `
    <svg viewBox="0 0 200 116" class="gauge" role="img"
         [attr.aria-label]="'Trash score ' + pct() + ' percent, threshold ' + thresholdPct() + ' percent'">
      <path [attr.d]="track" class="gauge-track" />
      @if (score() !== null) {
        <path [attr.d]="track" class="gauge-fill" [class.is-trash]="isTrash()"
              pathLength="100" [attr.stroke-dasharray]="pct() + ' 100'" />
      }
      <line [attr.x1]="tick().x1" [attr.y1]="tick().y1" [attr.x2]="tick().x2" [attr.y2]="tick().y2" class="gauge-tick" />
      <text x="100" y="92" class="gauge-value">{{ score() === null ? '–' : pct() + '%' }}</text>
      <text x="100" y="112" class="gauge-caption">trash score</text>
    </svg>
  `,
})
export class ScoreGauge {
  readonly score = input<number | null>(null);
  readonly threshold = input(0.5);

  // semicircle from left (180°) to right (0°), radius 80, centered at (100, 100)
  protected readonly track = 'M 20 100 A 80 80 0 0 1 180 100';

  protected readonly pct = computed(() => Math.round((this.score() ?? 0) * 100));
  protected readonly thresholdPct = computed(() => Math.round(this.threshold() * 100));
  protected readonly isTrash = computed(() => (this.score() ?? 0) >= this.threshold());
  protected readonly tick = computed(() => {
    const a = Math.PI * (1 - this.threshold());
    const c = Math.cos(a), s = Math.sin(a);
    return { x1: 100 + 68 * c, y1: 100 - 68 * s, x2: 100 + 92 * c, y2: 100 - 92 * s };
  });
}
