import { Component, OnInit, inject, input, output, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ApiService, Area, AreaInput, errorMessage } from '../core/api.service';
import { AreaMap } from './area-map';

/** Modal to create or edit an area; location is picked by clicking the map. */
@Component({
  selector: 'app-area-form',
  imports: [AreaMap],
  template: `
    <div class="modal-backdrop" (click)="closed.emit()">
      <form class="modal modal-wide" (click)="$event.stopPropagation()" (submit)="save($event)">
        <div class="modal-head">
          <h2>{{ area() ? 'Edit area' : 'Add area' }}</h2>
          <button type="button" class="icon-btn" (click)="closed.emit()" aria-label="Close"><svg class="icon"><use href="#i-x" /></svg></button>
        </div>

        <div class="form-grid">
          <div class="form-col">
            <label class="field"><span>Area name *</span>
              <input class="input" [value]="v().name" (input)="set('name', $any($event.target).value)" required maxlength="120"
                     placeholder="e.g. Purok 3 collection point" /></label>
            <label class="field"><span>Address / landmark</span>
              <input class="input" [value]="v().address" (input)="set('address', $any($event.target).value)"
                     placeholder="e.g. beside the barangay hall" /></label>
            <label class="toggle">
              <input type="checkbox" [checked]="v().camera_enabled" (change)="set('camera_enabled', $any($event.target).checked)" />
              <span>Camera installed at this area</span>
            </label>
            @if (v().camera_enabled) {
              <label class="field"><span>Camera name</span>
                <input class="input" [value]="v().camera_label" (input)="set('camera_label', $any($event.target).value)" placeholder="e.g. Camera 1" /></label>
              <label class="field"><span>Network camera address</span>
                <input class="input" [value]="v().camera_url" (input)="set('camera_url', $any($event.target).value)" maxlength="500"
                       placeholder="rtsp://admin:password@192.168.1.64:554/Streaming/Channels/102" />
                <span class="field-hint">Optional. With an address the server watches the camera itself; leave empty to use a browser's camera on the Monitor page.</span></label>
            }
            <div class="coords">
              <label class="field"><span>Latitude</span>
                <input class="input" type="number" step="any" [value]="v().lat" (input)="set('lat', +$any($event.target).value)" required /></label>
              <label class="field"><span>Longitude</span>
                <input class="input" type="number" step="any" [value]="v().lng" (input)="set('lng', +$any($event.target).value)" required /></label>
            </div>
          </div>
          <div class="form-col">
            <span class="field-label">Location: click the map or drag the pin</span>
            <app-area-map class="map-picker" [pickMode]="true" [pickPosition]="{ lat: v().lat, lng: v().lng }" (pick)="onPick($event)" />
          </div>
        </div>

        @if (error()) { <div class="error">{{ error() }}</div> }
        <div class="modal-actions">
          <button type="button" class="btn" (click)="closed.emit()">Cancel</button>
          <button class="btn btn-primary" [disabled]="saving()">{{ saving() ? 'Saving…' : 'Save area' }}</button>
        </div>
      </form>
    </div>
  `,
})
export class AreaForm implements OnInit {
  private api = inject(ApiService);
  readonly area = input<Area | null>(null);
  readonly saved = output<Area>();
  readonly closed = output<void>();

  protected v = signal<AreaInput>({ name: '', address: '', lat: 13.7565, lng: 121.0583, camera_enabled: true, camera_label: '', camera_url: '' });
  protected saving = signal(false);
  protected error = signal<string | null>(null);

  ngOnInit() {
    const a = this.area();
    if (a) this.v.set({ name: a.name, address: a.address, lat: a.lat, lng: a.lng, camera_enabled: a.camera_enabled, camera_label: a.camera_label, camera_url: a.camera_url });
  }

  protected set<K extends keyof AreaInput>(k: K, value: AreaInput[K]) {
    this.v.update((x) => ({ ...x, [k]: value }));
  }

  protected onPick(p: { lat: number; lng: number }) {
    this.v.update((x) => ({ ...x, ...p }));
  }

  protected save(e: Event) {
    e.preventDefault();
    this.saving.set(true);
    this.error.set(null);
    const a = this.area();
    const req = a ? this.api.updateArea(a.id, this.v()) : this.api.createArea(this.v());
    req.subscribe({
      next: (r) => this.saved.emit(r),
      error: (err: HttpErrorResponse) => {
        this.saving.set(false);
        this.error.set(errorMessage(err));
      },
    });
  }
}
