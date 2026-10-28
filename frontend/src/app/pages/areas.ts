import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { ApiService, Area, errorMessage } from '../core/api.service';
import { AreaMap, MapMarker } from '../shared/area-map';
import { AreaForm } from '../shared/area-form';
import { fmtAgo, fmtDateTime } from '../shared/format';

@Component({
  selector: 'app-areas',
  imports: [RouterLink, AreaMap, AreaForm],
  template: `
    <header class="page-head">
      <div>
        <h1>Areas &amp; contacts</h1>
        <p class="page-sub">Places with cameras, their residents' phone numbers, and pickup schedules.</p>
      </div>
      <div class="page-head-actions">
        <button class="btn btn-primary" (click)="formOpen.set(true)"><svg class="icon"><use href="#i-plus" /></svg> Add area</button>
      </div>
    </header>

    <div class="page">
      @if (error()) { <div class="error">{{ error() }}</div> }

      <div class="areas-grid">
        <div class="card card-flush">
          <div class="card-head">
            <div class="search">
              <svg class="icon"><use href="#i-search" /></svg>
              <input class="input" placeholder="Search areas" [value]="q()" (input)="q.set($any($event.target).value)" />
            </div>
          </div>
          <div class="table-wrap">
            <table class="table table-click">
              <thead>
                <tr><th>Area</th><th>Status</th><th class="num">Contacts</th><th>Next pickup</th></tr>
              </thead>
              <tbody>
                @for (a of filtered(); track a.id) {
                  <tr (click)="open(a.id)" (mouseenter)="hoverId.set(a.id)" (mouseleave)="hoverId.set(null)" [class.row-active]="hoverId() === a.id">
                    <td>
                      <a [routerLink]="['/admin/areas', a.id]" class="cell-title" (click)="$event.stopPropagation()">{{ a.name }}</a>
                      <span class="cell-sub">
                        @if (a.camera_enabled) { <svg class="icon icon-sm"><use href="#i-camera" /></svg> {{ a.camera_label || 'Camera' }} · }
                        {{ a.address || 'No address' }}
                      </span>
                    </td>
                    <td>
                      <span class="tag" [attr.data-kind]="a.last_status ?? 'idle'">
                        {{ a.last_status === 'trash' ? 'Trash' : a.last_status === 'clean' ? 'Clean' : 'No data' }}
                      </span>
                      <span class="cell-sub">{{ ago(a.last_checked_at) }}</span>
                    </td>
                    <td class="num">{{ a.contact_count }}</td>
                    <td>{{ a.next_pickup ? dateTime(a.next_pickup) : '—' }}</td>
                  </tr>
                } @empty {
                  <tr><td colspan="4" class="empty-cell">{{ q() ? 'No areas match your search.' : 'No areas yet. Click "Add area".' }}</td></tr>
                }
              </tbody>
            </table>
          </div>
        </div>

        <div class="card card-flush">
          <app-area-map class="map-tall" [markers]="markers()" [selectedId]="hoverId()" (markerClick)="open($event)" />
        </div>
      </div>
    </div>

    @if (formOpen()) {
      <app-area-form (closed)="formOpen.set(false)" (saved)="onSaved($event)" />
    }
  `,
})
export class AreasPage implements OnInit {
  private api = inject(ApiService);
  private router = inject(Router);

  protected areas = signal<Area[]>([]);
  protected q = signal('');
  protected hoverId = signal<number | null>(null);
  protected formOpen = signal(false);
  protected error = signal<string | null>(null);

  protected filtered = computed(() => {
    const q = this.q().trim().toLowerCase();
    return q ? this.areas().filter((a) => `${a.name} ${a.address} ${a.camera_label}`.toLowerCase().includes(q)) : this.areas();
  });

  protected markers = computed<MapMarker[]>(() =>
    this.filtered().map((a) => ({ id: a.id, lat: a.lat, lng: a.lng, title: a.name, subtitle: a.address, tone: a.last_status ?? 'idle' })),
  );

  ngOnInit() {
    this.load();
  }

  protected load() {
    this.api.areas().subscribe({
      next: (a) => this.areas.set(a),
      error: (e: HttpErrorResponse) => this.error.set(errorMessage(e)),
    });
  }

  protected open(id: number) {
    this.router.navigate(['/admin/areas', id]);
  }

  protected onSaved(a: Area) {
    this.formOpen.set(false);
    this.router.navigate(['/admin/areas', a.id]);
  }

  protected ago = fmtAgo;
  protected dateTime = fmtDateTime;
}
