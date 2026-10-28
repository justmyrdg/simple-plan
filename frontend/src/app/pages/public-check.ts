import { Component, OnInit, computed, inject, input, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { ApiService, PublicArea, PublicAreaDetail, errorMessage } from '../core/api.service';
import { AreaMap, MapMarker } from '../shared/area-map';
import { fmtAgo, fmtDay, fmtTime, fmtUntil } from '../shared/format';

/** Public page: residents find their area and see when the garbage truck comes. No login. */
@Component({
  selector: 'app-public-check',
  imports: [RouterLink, AreaMap],
  template: `
    <div class="public-top">
      <header class="public-bar">
        <div class="brand">
          <div class="brand-mark"><svg class="icon"><use href="#i-trash" /></svg></div>
          <div>
            <div class="brand-name">TrashWatch</div>
            <div class="brand-sub">Garbage pickup schedule</div>
          </div>
        </div>
        <a routerLink="/login" class="btn btn-ghost"><svg class="icon"><use href="#i-key" /></svg> Admin login</a>
      </header>

      <section class="hero">
        <h1>{{ greeting }}</h1>
        <p>Let's check when the garbage truck comes to your area.</p>
        <div class="search search-lg">
          <svg class="icon"><use href="#i-search" /></svg>
          <input class="input" placeholder="Search your street, purok or barangay" [value]="q()" (input)="q.set($any($event.target).value)"
                 aria-label="Search areas" />
        </div>
      </section>
    </div>

    <main class="public-page">

      @if (error()) { <div class="error">{{ error() }}</div> }

      <div class="public-grid">
        <div class="public-list">
          @for (a of filtered(); track a.id) {
            <button class="area-card" [class.selected]="a.id === selected()?.id" (click)="select(a.id)">
              <div class="area-card-top">
                <span class="area-card-name">{{ a.name }}</span>
                @if (a.status) {
                  <span class="tag" [attr.data-kind]="a.status">{{ a.status === 'trash' ? 'Needs pickup' : 'Clean' }}</span>
                }
              </div>
              @if (a.address) { <span class="muted small">{{ a.address }}</span> }
              <span class="area-card-next">
                <svg class="icon icon-sm"><use href="#i-truck" /></svg>
                @if (a.next_pickup) {
                  Next: <strong>{{ day(a.next_pickup) }} {{ time(a.next_pickup) }}</strong> <span class="muted">({{ until(a.next_pickup) }})</span>
                } @else { <span class="muted">No pickup scheduled</span> }
              </span>
            </button>
          } @empty {
            <p class="empty">{{ loading() ? 'Loading areas…' : q() ? 'No area matches "' + q() + '".' : 'No areas have been set up yet.' }}</p>
          }
        </div>

        <div class="public-side">
          <div class="card card-flush">
            <app-area-map class="map-public" [markers]="markers()" [selectedId]="selected()?.id ?? null" (markerClick)="select($event)" />
          </div>

          @if (selected(); as s) {
            <section class="card pickup-card">
              <h2>{{ s.name }}</h2>
              @if (s.address) { <p class="muted">{{ s.address }}</p> }

              @if (s.upcoming.length) {
                <div class="next-pickup">
                  <svg class="icon icon-lg"><use href="#i-truck" /></svg>
                  <div>
                    <span class="next-label">Next pickup</span>
                    <strong class="next-when">{{ day(s.upcoming[0].time) }}, {{ time(s.upcoming[0].time) }}</strong>
                    <span class="next-until">{{ until(s.upcoming[0].time) }}{{ s.upcoming[0].truck ? ' · ' + s.upcoming[0].truck : '' }}</span>
                    @if (s.upcoming[0].notes) { <span class="small">{{ s.upcoming[0].notes }}</span> }
                  </div>
                </div>
              } @else {
                <div class="notice">No pickup is scheduled in the next two weeks.</div>
              }

              @if (s.regular_schedule.length) {
                <h3 class="sub-head">Regular collection</h3>
                <ul class="plain-list">
                  @for (r of s.regular_schedule; track $index) {
                    <li><svg class="icon icon-sm"><use href="#i-refresh" /></svg> {{ r.description }}{{ r.truck ? ' · ' + r.truck : '' }}
                      @if (r.notes) { <span class="muted small"> · {{ r.notes }}</span> }</li>
                  }
                </ul>
              }

              @if (s.upcoming.length > 1) {
                <h3 class="sub-head">Next 2 weeks</h3>
                <ul class="plain-list">
                  @for (u of s.upcoming.slice(1, 8); track u.time) {
                    <li><svg class="icon icon-sm"><use href="#i-calendar" /></svg> {{ day(u.time) }} · {{ time(u.time) }}
                      @if (u.one_time) { <span class="tag tag-info">Special</span> }</li>
                  }
                </ul>
              }

              @if (s.status) {
                <p class="cam-status" [attr.data-kind]="s.status">
                  <svg class="icon icon-sm"><use href="#i-camera" /></svg>
                  Camera: {{ s.status === 'trash' ? 'trash is piling up' : 'area is clean' }} · {{ ago(s.status_checked_at) }}
                </p>
              }
              @if (s.last_collected_at) {
                <p class="cam-status" data-kind="clean">
                  <svg class="icon icon-sm"><use href="#i-truck" /></svg>
                  Last collected: {{ day(s.last_collected_at) }} · {{ time(s.last_collected_at) }}
                </p>
              }
            </section>
          } @else if (areas().length) {
            <p class="empty">Select an area from the list or the map.</p>
          }
        </div>
      </div>
    </main>

    <footer class="public-foot">
      <a routerLink="/privacy"><svg class="icon icon-sm"><use href="#i-shield" /></svg> Privacy notice</a>
      <a routerLink="/stop"><svg class="icon icon-sm"><use href="#i-x" /></svg> Stop SMS reminders</a>
    </footer>
  `,
})
export class PublicCheck implements OnInit {
  private api = inject(ApiService);
  private router = inject(Router);
  private map = viewChild(AreaMap);

  readonly area = input<string>(); // ?area=ID so a link can be shared

  protected readonly greeting = (() => {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning!' : h < 18 ? 'Good afternoon!' : 'Good evening!';
  })();

  protected areas = signal<PublicArea[]>([]);
  protected selected = signal<PublicAreaDetail | null>(null);
  protected q = signal('');
  protected loading = signal(true);
  protected error = signal<string | null>(null);

  protected filtered = computed(() => {
    const q = this.q().trim().toLowerCase();
    return q ? this.areas().filter((a) => `${a.name} ${a.address}`.toLowerCase().includes(q)) : this.areas();
  });

  protected markers = computed<MapMarker[]>(() =>
    this.filtered().map((a) => ({
      id: a.id, lat: a.lat, lng: a.lng, title: a.name,
      subtitle: a.next_pickup ? `Next pickup: ${fmtDay(a.next_pickup)} ${fmtTime(a.next_pickup)}` : 'No pickup scheduled',
      tone: a.status ?? 'idle',
    })),
  );

  ngOnInit() {
    this.api.publicAreas().subscribe({
      next: (a) => {
        this.areas.set(a);
        this.loading.set(false);
        const wanted = Number(this.area());
        const first = a.find((x) => x.id === wanted) ?? (a.length === 1 ? a[0] : null);
        if (first) this.select(first.id, false);
      },
      error: (e: HttpErrorResponse) => {
        this.loading.set(false);
        this.error.set(errorMessage(e));
      },
    });
  }

  protected select(id: number, updateUrl = true) {
    this.api.publicArea(id).subscribe({
      next: (d) => {
        this.selected.set(d);
        this.map()?.focus(d.lat, d.lng);
        if (updateUrl) {
          this.router.navigate([], { queryParams: { area: id }, replaceUrl: true });
          // on phones the details sit below the list, so bring them into view
          if (window.innerWidth <= 860) {
            setTimeout(() => document.querySelector('.pickup-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
          }
        }
      },
      error: (e: HttpErrorResponse) => this.error.set(errorMessage(e)),
    });
  }

  protected day = fmtDay;
  protected time = fmtTime;
  protected until = fmtUntil;
  protected ago = fmtAgo;
}
