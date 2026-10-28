import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { PercentPipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  ApiService, Area, Collection, Contact, LANGUAGE_LABEL, Schedule, ScheduleInput, SmsEntry, SmsLanguage, WEEKDAYS, errorMessage,
} from '../core/api.service';
import { AreaForm } from '../shared/area-form';
import { CollectionList } from '../shared/collection-list';
import { AreaMap, MapMarker } from '../shared/area-map';
import { fmtAgo, fmtDate, fmtDateTime } from '../shared/format';

type Tab = 'contacts' | 'schedule' | 'collections' | 'messages';

const EMPTY_SCHEDULE: ScheduleInput = {
  kind: 'weekly', weekday: 0, date: null, time: '07:00', truck: '', notes: '', notify_minutes_before: 60, notify_at_pickup: true, active: true,
};

@Component({
  selector: 'app-area-detail',
  imports: [RouterLink, PercentPipe, AreaForm, AreaMap, CollectionList],
  template: `
    <header class="page-head">
      <div>
        <a routerLink="/admin/areas" class="back"><svg class="icon"><use href="#i-arrow-left" /></svg> All areas</a>
        <h1>{{ area()?.name ?? 'Area' }}</h1>
        @if (area(); as a) {
          <p class="page-sub">
            {{ a.address || 'No address' }}
            @if (a.camera_enabled) { · <svg class="icon icon-sm"><use href="#i-camera" /></svg> {{ a.camera_label || 'Camera' }} }
          </p>
        }
      </div>
      @if (area()) {
        <div class="page-head-actions">
          <button class="btn" (click)="editOpen.set(true)"><svg class="icon"><use href="#i-edit" /></svg> Edit area</button>
          <button class="btn btn-danger" (click)="deleteArea()"><svg class="icon"><use href="#i-delete" /></svg> Delete</button>
        </div>
      }
    </header>

    <div class="page">
      @if (error()) { <div class="error">{{ error() }}</div> }

      @if (area(); as a) {
        <section class="detail-top">
          <div class="card status-mini" [attr.data-status]="a.last_status ?? 'idle'">
            <svg class="icon icon-lg"><use [attr.href]="a.last_status === 'trash' ? '#i-alert' : a.last_status === 'clean' ? '#i-check' : '#i-idle'" /></svg>
            <div>
              <div class="status-mini-label">{{ a.last_status === 'trash' ? 'Full of trash' : a.last_status === 'clean' ? 'Clean' : 'No camera data' }}</div>
              <div class="muted small">
                @if (a.last_score !== null) { Score {{ a.last_score | percent: '1.0-0' }} · }
                last checked {{ ago(a.last_checked_at) }}
              </div>
            </div>
          </div>
          <div class="card mini-stat"><span class="kpi-value">{{ contacts().length }}</span><span class="kpi-label">Contacts ({{ activeContacts() }} active)</span></div>
          <div class="card mini-stat"><span class="kpi-value small-value">{{ a.next_pickup ? dateTime(a.next_pickup) : 'None' }}</span><span class="kpi-label">Next pickup</span>
            <span class="kpi-label">Last collected: {{ a.last_collected_at ? dateTime(a.last_collected_at) : 'not yet' }}</span></div>
          <div class="card card-flush mini-map"><app-area-map class="map-sm" [markers]="marker()" /></div>
        </section>

        <nav class="tabs-line">
          <button [class.active]="tab() === 'contacts'" (click)="tab.set('contacts')"><svg class="icon"><use href="#i-users" /></svg> Contacts</button>
          <button [class.active]="tab() === 'schedule'" (click)="tab.set('schedule')"><svg class="icon"><use href="#i-calendar" /></svg> Pickup schedule</button>
          <button [class.active]="tab() === 'collections'" (click)="tab.set('collections'); loadCollections()"><svg class="icon"><use href="#i-truck" /></svg> Collections</button>
          <button [class.active]="tab() === 'messages'" (click)="tab.set('messages'); loadSms()"><svg class="icon"><use href="#i-message" /></svg> Messages</button>
        </nav>

        <!-- ===== Contacts ===== -->
        @if (tab() === 'contacts') {
          <section class="card">
            <form class="inline-form" (submit)="addContact($event)">
              <label class="field"><span>Name</span><input class="input" name="name" required maxlength="120" placeholder="Juan Dela Cruz" /></label>
              <label class="field"><span>Mobile number</span><input class="input" name="phone" required inputmode="tel" placeholder="09171234567" /></label>
              <label class="field field-narrow"><span>SMS language</span>
                <select class="input" name="language">
                  <option value="en">English</option>
                  <option value="fil">Filipino</option>
                </select></label>
              <button class="btn btn-primary" [disabled]="busy()"><svg class="icon"><use href="#i-plus" /></svg> Add contact</button>
              <label class="toggle consent">
                <input type="checkbox" name="consent" required />
                <span>The resident agreed to receive SMS pickup reminders and to have their name and number stored for this purpose.</span>
              </label>
            </form>
            @if (contactError()) { <div class="error">{{ contactError() }}</div> }
            @if (flash()) { <div class="success">{{ flash() }}</div> }

            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Name</th><th>Mobile</th><th>Language</th><th>Reminders</th><th class="actions-col"></th></tr></thead>
                <tbody>
                  @for (c of contacts(); track c.id) {
                    @if (editingId() === c.id) {
                      <tr class="row-edit">
                        <td><input class="input" [value]="c.name" #en /></td>
                        <td><input class="input" [value]="c.phone" #ep inputmode="tel" /></td>
                        <td><select class="input" #el [value]="c.language">
                          <option value="en">English</option><option value="fil">Filipino</option></select></td>
                        <td><label class="toggle"><input type="checkbox" [checked]="c.active" #ea /><span>On</span></label></td>
                        <td class="actions">
                          <button class="btn btn-primary btn-sm" (click)="saveContact(c, en.value, ep.value, ea.checked, $any(el.value))">Save</button>
                          <button class="btn btn-sm" (click)="editingId.set(null)">Cancel</button>
                        </td>
                      </tr>
                    } @else {
                      <tr [class.row-muted]="!c.active">
                        <td>
                          <span class="cell-title">{{ c.name }}</span>
                          <span class="cell-sub">{{ c.consent_at ? 'Consent ' + date(c.consent_at) : 'No consent recorded' }}</span>
                        </td>
                        <td class="mono">{{ c.phone }}</td>
                        <td>{{ languageLabel[c.language] }}</td>
                        <td>
                          @if (c.opted_out_at && !c.active) {
                            <button class="tag tag-btn" data-kind="opted_out" (click)="toggleContact(c)"
                                    [title]="'Opted out ' + date(c.opted_out_at) + '. Click if they asked to receive SMS again.'">Opted out</button>
                          } @else {
                            <button class="switch" [class.on]="c.active" (click)="toggleContact(c)" [attr.aria-pressed]="c.active"
                                    [attr.aria-label]="'SMS reminders for ' + c.name">
                              <span></span>
                            </button>
                          }
                        </td>
                        <td class="actions">
                          <button class="icon-btn" title="Send test SMS" (click)="testContact(c)"><svg class="icon"><use href="#i-send" /></svg></button>
                          <button class="icon-btn" title="Edit" (click)="editingId.set(c.id)"><svg class="icon"><use href="#i-edit" /></svg></button>
                          <button class="icon-btn icon-btn-danger" title="Delete" (click)="deleteContact(c)"><svg class="icon"><use href="#i-delete" /></svg></button>
                        </td>
                      </tr>
                    }
                  } @empty {
                    <tr><td colspan="5" class="empty-cell">No contacts yet. Residents added here get an SMS before each pickup.</td></tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }

        <!-- ===== Schedule ===== -->
        @if (tab() === 'schedule') {
          <section class="card">
            <div class="section-head">
              <h3>Pickup schedule</h3>
              <button class="btn btn-primary" (click)="openSchedule(null)"><svg class="icon"><use href="#i-plus" /></svg> Add pickup</button>
            </div>
            <ul class="schedule-list">
              @for (s of schedules(); track s.id) {
                <li [class.row-muted]="!s.active">
                  <span class="sched-ico"><svg class="icon"><use [attr.href]="s.kind === 'weekly' ? '#i-refresh' : '#i-calendar'" /></svg></span>
                  <div class="sched-main">
                    <strong>{{ s.description }}</strong>
                    <span class="muted small">
                      {{ s.truck || 'Garbage truck' }} · SMS {{ reminderLabel(s.notify_minutes_before) }}{{ s.notify_at_pickup ? ' + at pickup time' : '' }}
                      @if (!s.active) { · <em>paused</em> }
                    </span>
                    @if (s.notes) { <span class="small">{{ s.notes }}</span> }
                  </div>
                  <div class="actions">
                    <button class="icon-btn" title="Edit" (click)="openSchedule(s)"><svg class="icon"><use href="#i-edit" /></svg></button>
                    <button class="icon-btn icon-btn-danger" title="Delete" (click)="deleteSchedule(s)"><svg class="icon"><use href="#i-delete" /></svg></button>
                  </div>
                </li>
              } @empty {
                <li class="empty">No pickups yet. Add a weekly pickup day or a one-time pickup.</li>
              }
            </ul>
          </section>
        }

        <!-- ===== Collections ===== -->
        @if (tab() === 'collections') {
          <section class="card">
            <div class="section-head">
              <h3>Collections · last 30 days</h3>
              <button class="btn" (click)="loadCollections()"><svg class="icon"><use href="#i-refresh" /></svg> Refresh</button>
            </div>
            <p class="muted small">For each scheduled pickup the camera checks whether the area went from full to clean
              between 2 hours before and 4 hours after the scheduled time. Photos are taken when the status changes.</p>
            <app-collection-list [items]="collections()" [showArea]="false"
                                 empty="No pickups judged yet. Add a pickup schedule; each pickup is checked once its time window starts." />
          </section>
        }

        <!-- ===== Messages ===== -->
        @if (tab() === 'messages') {
          <section class="card">
            <form class="notify-form" (submit)="notify($event)">
              <label class="field"><span>Send a message now to all {{ activeContacts() }} active contacts</span>
                <textarea class="input" name="message" rows="3" maxlength="480" required
                          placeholder="e.g. Garbage collection is delayed to 9:00 AM today."></textarea></label>
              <button class="btn btn-primary" [disabled]="busy() || !activeContacts()"><svg class="icon"><use href="#i-send" /></svg> Send SMS</button>
            </form>
            @if (flash()) { <div class="success">{{ flash() }}</div> }
            <h3 class="sub-head">Message history</h3>
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Time</th><th>To</th><th>Message</th><th>Status</th></tr></thead>
                <tbody>
                  @for (m of sms(); track m.id) {
                    <tr>
                      <td class="nowrap">{{ dateTime(m.time) }}</td>
                      <td class="mono">{{ m.phone }}</td>
                      <td class="msg">{{ m.message }} @if (m.error) { <span class="cell-sub err">{{ m.error }}</span> }</td>
                      <td><span class="tag" [attr.data-kind]="m.status">{{ m.status }}</span></td>
                    </tr>
                  } @empty {
                    <tr><td colspan="4" class="empty-cell">No messages sent for this area yet.</td></tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }
      } @else if (!error()) {
        <div class="loading-block"><span class="spinner spinner-dark"></span> Loading…</div>
      }
    </div>

    @if (editOpen() && area()) {
      <app-area-form [area]="area()" (closed)="editOpen.set(false)" (saved)="area.set($event); editOpen.set(false)" />
    }

    @if (schedOpen()) {
      <div class="modal-backdrop" (click)="schedOpen.set(false)">
        <form class="modal" (click)="$event.stopPropagation()" (submit)="saveSchedule($event)">
          <div class="modal-head">
            <h2>{{ schedEditing() ? 'Edit pickup' : 'Add pickup' }}</h2>
            <button type="button" class="icon-btn" (click)="schedOpen.set(false)" aria-label="Close"><svg class="icon"><use href="#i-x" /></svg></button>
          </div>
          <div class="segmented segmented-full">
            <button type="button" [class.active]="sf().kind === 'weekly'" (click)="setS('kind', 'weekly')">Every week</button>
            <button type="button" [class.active]="sf().kind === 'once'" (click)="setS('kind', 'once')">One time</button>
          </div>
          <div class="coords">
            @if (sf().kind === 'weekly') {
              <label class="field"><span>Day</span>
                <select class="input" [value]="sf().weekday ?? 0" (change)="setS('weekday', +$any($event.target).value)">
                  @for (d of weekdays; track $index) { <option [value]="$index">{{ d }}</option> }
                </select></label>
            } @else {
              <label class="field"><span>Date</span>
                <input class="input" type="date" [value]="sf().date ?? ''" (input)="setS('date', $any($event.target).value)" required /></label>
            }
            <label class="field"><span>Time</span>
              <input class="input" type="time" [value]="sf().time" (input)="setS('time', $any($event.target).value)" required /></label>
          </div>
          <label class="field"><span>Truck / collector</span>
            <input class="input" [value]="sf().truck" (input)="setS('truck', $any($event.target).value)" placeholder="e.g. Truck 3 (CENRO)" /></label>
          <label class="field"><span>Send SMS reminder</span>
            <select class="input" [value]="sf().notify_minutes_before" (change)="setS('notify_minutes_before', +$any($event.target).value)">
              <option value="15">15 minutes before</option>
              <option value="30">30 minutes before</option>
              <option value="60">1 hour before</option>
              <option value="120">2 hours before</option>
              <option value="720">12 hours before</option>
              <option value="1440">1 day before</option>
            </select></label>
          <label class="toggle"><input type="checkbox" [checked]="sf().notify_at_pickup" (change)="setS('notify_at_pickup', $any($event.target).checked)" />
            <span>Also text residents at the pickup time</span></label>
          <label class="field"><span>Notes (shown to residents)</span>
            <input class="input" [value]="sf().notes" (input)="setS('notes', $any($event.target).value)" placeholder="e.g. Biodegradable only" /></label>
          <label class="toggle"><input type="checkbox" [checked]="sf().active" (change)="setS('active', $any($event.target).checked)" /><span>Active</span></label>
          @if (schedError()) { <div class="error">{{ schedError() }}</div> }
          <div class="modal-actions">
            <button type="button" class="btn" (click)="schedOpen.set(false)">Cancel</button>
            <button class="btn btn-primary" [disabled]="busy()">Save pickup</button>
          </div>
        </form>
      </div>
    }
  `,
})
export class AreaDetail implements OnInit {
  private api = inject(ApiService);
  private router = inject(Router);

  readonly id = input.required<string>(); // route param

  protected area = signal<Area | null>(null);
  protected contacts = signal<Contact[]>([]);
  protected schedules = signal<Schedule[]>([]);
  protected sms = signal<SmsEntry[]>([]);
  protected collections = signal<Collection[]>([]);
  protected tab = signal<Tab>('contacts');
  protected error = signal<string | null>(null);
  protected contactError = signal<string | null>(null);
  protected flash = signal<string | null>(null);
  protected busy = signal(false);
  protected editingId = signal<number | null>(null);
  protected editOpen = signal(false);

  protected schedOpen = signal(false);
  protected schedEditing = signal<Schedule | null>(null);
  protected sf = signal<ScheduleInput>({ ...EMPTY_SCHEDULE });
  protected schedError = signal<string | null>(null);

  protected weekdays = WEEKDAYS;
  protected activeContacts = computed(() => this.contacts().filter((c) => c.active).length);
  protected marker = computed<MapMarker[]>(() => {
    const a = this.area();
    return a ? [{ id: a.id, lat: a.lat, lng: a.lng, title: a.name, tone: a.last_status ?? 'idle' }] : [];
  });

  private get areaId() {
    return Number(this.id());
  }

  ngOnInit() {
    this.api.area(this.areaId).subscribe({
      next: (a) => this.area.set(a),
      error: (e: HttpErrorResponse) => this.error.set(errorMessage(e)),
    });
    this.loadContacts();
    this.loadSchedules();
  }

  private refreshArea() {
    this.api.area(this.areaId).subscribe((a) => this.area.set(a));
  }

  private showFlash(msg: string) {
    this.flash.set(msg);
    setTimeout(() => this.flash() === msg && this.flash.set(null), 4000);
  }

  // ---- contacts ----

  private loadContacts() {
    this.api.contacts(this.areaId).subscribe((c) => this.contacts.set(c));
  }

  protected addContact(e: Event) {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const data = new FormData(form);
    this.busy.set(true);
    this.contactError.set(null);
    const contact = {
      name: String(data.get('name')), phone: String(data.get('phone')), active: true,
      language: (data.get('language') as SmsLanguage) ?? 'en', consent: data.get('consent') === 'on',
    };
    this.api.createContact(this.areaId, contact).subscribe({
      next: (c) => {
        this.busy.set(false);
        form.reset();
        this.contacts.update((list) => [...list, c].sort((a, b) => a.name.localeCompare(b.name)));
        this.showFlash(`${c.name} added.`);
      },
      error: (err: HttpErrorResponse) => {
        this.busy.set(false);
        this.contactError.set(errorMessage(err));
      },
    });
  }

  protected saveContact(c: Contact, name: string, phone: string, active: boolean, language = c.language, consent = false) {
    this.contactError.set(null);
    this.api.updateContact(c.id, { name, phone, active, language, consent }).subscribe({
      next: (u) => {
        this.contacts.update((list) => list.map((x) => (x.id === u.id ? u : x)));
        this.editingId.set(null);
      },
      error: (err: HttpErrorResponse) => this.contactError.set(errorMessage(err)),
    });
  }

  protected toggleContact(c: Contact) {
    // an opted-out resident may only be turned back on if they asked again (new consent)
    if (!c.active && c.opted_out_at) {
      if (!confirm(`${c.name} opted out of SMS. Turn reminders back on only if they asked to receive them again.\n\nDid they agree again?`)) return;
      this.saveContact(c, c.name, c.phone, true, c.language, true);
      return;
    }
    this.saveContact(c, c.name, c.phone, !c.active);
  }

  protected deleteContact(c: Contact) {
    if (!confirm(`Remove ${c.name} (${c.phone}) from this area?`)) return;
    this.api.deleteContact(c.id).subscribe({
      next: () => this.contacts.update((list) => list.filter((x) => x.id !== c.id)),
      error: (err: HttpErrorResponse) => this.contactError.set(errorMessage(err)),
    });
  }

  protected testContact(c: Contact) {
    this.api.testContact(c.id).subscribe({
      next: (r) =>
        r.status === 'failed'
          ? this.contactError.set(`Test SMS to ${c.phone} failed: ${r.error}`)
          : this.showFlash(r.status === 'sent' ? `Test SMS sent to ${c.phone}.` : `Test SMS to ${c.phone} logged (simulation mode).`),
      error: (err: HttpErrorResponse) => this.contactError.set(errorMessage(err)),
    });
  }

  // ---- schedules ----

  private loadSchedules() {
    this.api.schedules(this.areaId).subscribe((s) => this.schedules.set(s));
  }

  protected openSchedule(s: Schedule | null) {
    this.schedEditing.set(s);
    this.schedError.set(null);
    if (s) {
      const { id, area_id, description, ...rest } = s;
      this.sf.set(rest);
    } else {
      const d = new Date();
      const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      this.sf.set({ ...EMPTY_SCHEDULE, date: today });
    }
    this.schedOpen.set(true);
  }

  protected setS<K extends keyof ScheduleInput>(k: K, v: ScheduleInput[K]) {
    this.sf.update((x) => ({ ...x, [k]: v }));
  }

  protected saveSchedule(e: Event) {
    e.preventDefault();
    const s = this.schedEditing();
    const body = { ...this.sf() };
    if (body.kind === 'weekly') body.date = null;
    else body.weekday = null;
    this.busy.set(true);
    const req = s ? this.api.updateSchedule(s.id, body) : this.api.createSchedule(this.areaId, body);
    req.subscribe({
      next: () => {
        this.busy.set(false);
        this.schedOpen.set(false);
        this.loadSchedules();
        this.refreshArea();
      },
      error: (err: HttpErrorResponse) => {
        this.busy.set(false);
        this.schedError.set(errorMessage(err));
      },
    });
  }

  protected deleteSchedule(s: Schedule) {
    if (!confirm(`Delete the pickup "${s.description}"?`)) return;
    this.api.deleteSchedule(s.id).subscribe(() => {
      this.loadSchedules();
      this.refreshArea();
    });
  }

  protected reminderLabel(min: number) {
    if (min >= 1440) return `${min / 1440} day${min > 1440 ? 's' : ''} before`;
    if (min >= 60) return `${min / 60} hour${min > 60 ? 's' : ''} before`;
    return `${min} min before`;
  }

  // ---- collections ----

  protected loadCollections() {
    this.api.collections(this.areaId).subscribe((c) => this.collections.set(c));
  }

  // ---- messages ----

  protected loadSms() {
    this.api.smsLog(this.areaId).subscribe((s) => this.sms.set(s));
  }

  protected notify(e: Event) {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const message = String(new FormData(form).get('message')).trim();
    if (!message || !confirm(`Send this SMS to ${this.activeContacts()} contacts?\n\n${message}`)) return;
    this.busy.set(true);
    this.api.notifyArea(this.areaId, message).subscribe({
      next: (r) => {
        this.busy.set(false);
        form.reset();
        const ok = (r.sent ?? 0) + (r.simulated ?? 0);
        this.showFlash(`${ok} message${ok === 1 ? '' : 's'} ${r.simulated ? 'logged (simulation mode)' : 'sent'}${r.failed ? `, ${r.failed} failed` : ''}.`);
        this.loadSms();
      },
      error: (err: HttpErrorResponse) => {
        this.busy.set(false);
        this.error.set(errorMessage(err));
      },
    });
  }

  // ---- area ----

  protected deleteArea() {
    const a = this.area();
    if (!a || !confirm(`Delete "${a.name}" with all its contacts, schedules and history? This cannot be undone.`)) return;
    this.api.deleteArea(a.id).subscribe({
      next: () => this.router.navigate(['/admin/areas']),
      error: (err: HttpErrorResponse) => this.error.set(errorMessage(err)),
    });
  }

  protected ago = fmtAgo;
  protected dateTime = fmtDateTime;
  protected date = fmtDate;
  protected languageLabel = LANGUAGE_LABEL;
}
