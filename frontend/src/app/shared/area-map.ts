import { Component, ElementRef, OnDestroy, afterNextRender, effect, input, output, viewChild } from '@angular/core';
import * as L from 'leaflet';

export interface MapMarker {
  id: number;
  lat: number;
  lng: number;
  title: string;
  subtitle?: string;
  tone: 'trash' | 'clean' | 'idle';
}

// Batangas City, used when there is nothing to show yet
const DEFAULT_CENTER: L.LatLngExpression = [13.7565, 121.0583];

/**
 * Leaflet + OpenStreetMap map. Shows status-colored area pins; in pick mode a click
 * (or dragging the pick pin) emits a location.
 */
@Component({
  selector: 'app-area-map',
  template: `<div #host class="map-host"></div>`,
})
export class AreaMap implements OnDestroy {
  readonly markers = input<MapMarker[]>([]);
  readonly selectedId = input<number | null>(null);
  readonly pickMode = input(false);
  readonly pickPosition = input<{ lat: number; lng: number } | null>(null);

  readonly markerClick = output<number>();
  readonly pick = output<{ lat: number; lng: number }>();

  private host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private map?: L.Map;
  private layer = L.layerGroup();
  private pickPin?: L.Marker;
  private fitted = false;
  private resize?: ResizeObserver;

  constructor() {
    afterNextRender(() => {
      this.map = L.map(this.host().nativeElement, { zoomControl: true }).setView(DEFAULT_CENTER, 14);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors',
      }).addTo(this.map);
      this.layer.addTo(this.map);
      this.map.on('click', (e: L.LeafletMouseEvent) => {
        if (this.pickMode()) this.pick.emit({ lat: round(e.latlng.lat), lng: round(e.latlng.lng) });
      });
      // the map needs a nudge when its container changes size (tabs, sidebars, mobile)
      this.resize = new ResizeObserver(() => this.map?.invalidateSize());
      this.resize.observe(this.host().nativeElement);
      this.drawMarkers();
      this.drawPickPin();
    });

    effect(() => {
      this.markers();
      this.selectedId();
      this.drawMarkers();
    });
    effect(() => {
      this.pickPosition();
      this.pickMode();
      this.drawPickPin();
    });
  }

  ngOnDestroy() {
    this.resize?.disconnect();
    this.map?.remove();
  }

  /** Pan to a marker, e.g. when it's chosen from a list. */
  focus(lat: number, lng: number, zoom = 16) {
    this.map?.setView([lat, lng], zoom);
  }

  private drawMarkers() {
    if (!this.map) return;
    this.layer.clearLayers();
    const ms = this.markers();
    for (const m of ms) {
      const selected = m.id === this.selectedId();
      const icon = L.divIcon({
        className: '',
        html: `<div class="pin pin-${m.tone}${selected ? ' pin-selected' : ''}"><span></span></div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 28],
        popupAnchor: [0, -26],
      });
      const marker = L.marker([m.lat, m.lng], { icon, title: m.title, keyboard: true })
        .bindTooltip(`<strong>${escapeHtml(m.title)}</strong>${m.subtitle ? `<br>${escapeHtml(m.subtitle)}` : ''}`, {
          direction: 'top',
          offset: [0, -26],
        })
        .on('click', () => this.markerClick.emit(m.id));
      marker.addTo(this.layer);
    }
    if (!this.fitted && ms.length && !this.pickMode()) {
      this.fitted = true;
      if (ms.length === 1) this.map.setView([ms[0].lat, ms[0].lng], 15);
      else this.map.fitBounds(L.latLngBounds(ms.map((m) => [m.lat, m.lng] as L.LatLngTuple)), { padding: [40, 40] });
    }
  }

  private drawPickPin() {
    if (!this.map) return;
    const pos = this.pickPosition();
    if (!this.pickMode() || !pos) {
      this.pickPin?.remove();
      this.pickPin = undefined;
      return;
    }
    if (!this.pickPin) {
      const icon = L.divIcon({ className: '', html: '<div class="pin pin-pick"><span></span></div>', iconSize: [28, 28], iconAnchor: [14, 28] });
      this.pickPin = L.marker([pos.lat, pos.lng], { icon, draggable: true }).addTo(this.map);
      this.pickPin.on('dragend', () => {
        const p = this.pickPin!.getLatLng();
        this.pick.emit({ lat: round(p.lat), lng: round(p.lng) });
      });
      this.map.setView([pos.lat, pos.lng], Math.max(this.map.getZoom(), 15));
    } else {
      this.pickPin.setLatLng([pos.lat, pos.lng]);
    }
  }
}

function round(n: number) {
  return Math.round(n * 1e6) / 1e6;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
