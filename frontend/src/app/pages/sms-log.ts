import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ApiService, SmsEntry, errorMessage } from '../core/api.service';
import { fmtDateTime } from '../shared/format';

type Filter = 'all' | 'reminder' | 'manual' | 'alert' | 'failed';

@Component({
  selector: 'app-sms-log',
  template: `
    <header class="page-head">
      <div>
        <h1>SMS log</h1>
        <p class="page-sub">Every pickup reminder, manual message and admin alert, newest first.</p>
      </div>
      <div class="page-head-actions">
        <nav class="segmented">
          @for (f of filters; track f.id) {
            <button [class.active]="filter() === f.id" (click)="filter.set(f.id)">{{ f.label }}</button>
          }
        </nav>
        <button class="btn" (click)="load()"><svg class="icon"><use href="#i-refresh" /></svg> Refresh</button>
      </div>
    </header>
    <div class="page">
      @if (error()) { <div class="error">{{ error() }}</div> }
      <div class="card card-flush">
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Time</th><th>Area</th><th>To</th><th>Type</th><th>Message</th><th>Status</th></tr></thead>
            <tbody>
              @for (m of shown(); track m.id) {
                <tr>
                  <td class="nowrap">{{ dateTime(m.time) }}</td>
                  <td>{{ m.area ?? '—' }}</td>
                  <td class="mono">{{ m.phone }}</td>
                  <td>{{ kindLabel[m.kind] }}</td>
                  <td class="msg">{{ m.message }} @if (m.error) { <span class="cell-sub err">{{ m.error }}</span> }</td>
                  <td><span class="tag" [attr.data-kind]="m.status">{{ m.status }}</span></td>
                </tr>
              } @empty {
                <tr><td colspan="6" class="empty-cell">No messages yet.</td></tr>
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `,
})
export class SmsLogPage implements OnInit {
  private api = inject(ApiService);
  protected rows = signal<SmsEntry[]>([]);
  protected filter = signal<Filter>('all');
  protected error = signal<string | null>(null);
  protected filters: { id: Filter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'reminder', label: 'Reminders' },
    { id: 'manual', label: 'Manual' },
    { id: 'alert', label: 'Admin alerts' },
    { id: 'failed', label: 'Failed' },
  ];
  protected kindLabel: Record<SmsEntry['kind'], string> = {
    reminder: 'Reminder', at_pickup: 'At pickup time', manual: 'Manual', alert: 'Admin alert',
  };

  protected shown = computed(() => {
    const f = this.filter();
    return this.rows().filter(
      (m) => f === 'all' || (f === 'failed' ? m.status === 'failed' : f === 'reminder' ? m.kind === 'reminder' || m.kind === 'at_pickup' : m.kind === f),
    );
  });

  ngOnInit() {
    this.load();
  }

  protected load() {
    this.api.smsLog().subscribe({
      next: (r) => this.rows.set(r),
      error: (e: HttpErrorResponse) => this.error.set(errorMessage(e)),
    });
  }

  protected dateTime = fmtDateTime;
}
