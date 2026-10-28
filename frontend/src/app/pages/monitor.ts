import { Component, ElementRef, OnDestroy, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { DecimalPipe, PercentPipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { DetectResult, DetectorService } from '../core/detector.service';
import { ApiService, Area } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { ScoreGauge } from '../shared/score-gauge';
import { TrendChart, TrendPoint } from '../shared/trend-chart';

const AREA_KEY = 'tw_monitor_area';

type Mode = 'live' | 'upload';
// 'device' = a camera on this computer/phone; 'network' = the area's IP camera, read by the server
type Feed = 'device' | 'network';

export interface LogEntry {
  id: number;
  time: number;
  source: 'live' | 'upload';
  kind: 'trash' | 'clean' | 'snapshot';
  title: string;
  score: number;
  thumb: string;
  // uploads keep the full image so they can be reopened in the viewer
  image?: string;
  result?: DetectResult;
}

const MAX_TREND_POINTS = 120;
const THUMB_WIDTH = 160;

@Component({
  selector: 'app-monitor',
  imports: [DecimalPipe, PercentPipe, ScoreGauge, TrendChart],
  templateUrl: './monitor.html',
})
export class Monitor implements OnInit, OnDestroy {
  private api = inject(DetectorService);
  private areasApi = inject(ApiService);
  private auth = inject(AuthService);

  // which area the live camera is watching; live results are recorded against it
  protected readonly cameraAreas = signal<Area[]>([]);
  protected readonly areaId = signal<number | null>(null);
  protected readonly area = computed(() => this.cameraAreas().find((a) => a.id === this.areaId()) ?? null);
  protected readonly areaName = computed(() => this.area()?.name ?? null);
  protected readonly hasNetworkCam = computed(() => !!this.area()?.camera_url);
  protected readonly feed = signal<Feed>('device');
  // MJPEG preview of the network camera, shown in an <img>
  protected readonly streamUrl = signal<string | null>(null);

  // ---- global state ----
  protected readonly mode = signal<Mode>('live');
  protected readonly threshold = signal(0.5);
  protected readonly grid = signal(3);
  protected readonly showRegions = signal(true);
  protected readonly modelType = signal<string | null>(null);
  protected readonly backendOnline = signal<boolean | null>(null);
  protected readonly error = signal<string | null>(null);

  protected readonly result = signal<DetectResult | null>(null);
  protected readonly log = signal<LogEntry[]>([]);
  private nextId = 1;

  // ---- live monitor ----
  protected readonly cameraOn = signal(false);
  protected readonly cameras = signal<MediaDeviceInfo[]>([]);
  protected readonly cameraId = signal<string>('');
  protected readonly intervalMs = signal(1000);
  protected readonly alertAfter = signal(3); // consecutive trash checks before alerting
  protected readonly soundOn = signal(false);
  protected readonly trend = signal<TrendPoint[]>([]);
  protected readonly latency = signal<number | null>(null);
  protected readonly checks = signal(0);
  protected readonly alertActive = signal(false);
  protected readonly alertSince = signal<number | null>(null);
  protected readonly now = signal(Date.now());
  private trashStreak = 0;
  private cleanStreak = 0;

  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');
  private readonly feedImg = viewChild<ElementRef<HTMLImageElement>>('feedImg');
  private stream: MediaStream | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private clock: ReturnType<typeof setInterval> | null = null;

  // ---- upload ----
  protected readonly uploadImage = signal<string | null>(null);
  protected readonly uploading = signal(0);
  protected readonly dragging = signal(false);
  protected readonly selectedId = signal<number | null>(null);

  // ---- derived ----
  protected readonly status = computed<'trash' | 'clean' | 'idle'>(() => {
    const r = this.result();
    if (!r) return 'idle';
    return r.score >= this.threshold() ? 'trash' : 'clean';
  });

  protected readonly cells = computed(() => this.result()?.cells ?? null);

  protected readonly trashyRegions = computed(() => {
    const c = this.cells();
    if (!c) return null;
    const flat = c.flat();
    return flat.filter((s) => s >= this.threshold()).length / flat.length;
  });

  protected readonly stats = computed(() => {
    const pts = this.trend();
    if (!pts.length) return null;
    const scores = pts.map((p) => p.score);
    return {
      avg: scores.reduce((a, b) => a + b, 0) / scores.length,
      peak: Math.max(...scores),
      trashTime: scores.filter((s) => s >= this.threshold()).length / scores.length,
    };
  });

  protected readonly alertDuration = computed(() => {
    const since = this.alertSince();
    if (!since) return '';
    const s = Math.max(0, Math.round((this.now() - since) / 1000));
    return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  });

  protected readonly visibleLog = computed(() =>
    this.log().filter((e) => (this.mode() === 'live' ? e.source === 'live' : e.source === 'upload')),
  );

  ngOnInit() {
    this.checkBackend();
    this.areasApi.areas().subscribe((list) => {
      const cams = list.filter((a) => a.camera_enabled);
      this.cameraAreas.set(cams);
      let saved: number | null = null;
      try {
        saved = Number(localStorage.getItem(AREA_KEY)) || null;
      } catch {
        /* storage unavailable */
      }
      this.areaId.set(cams.find((a) => a.id === saved)?.id ?? cams[0]?.id ?? null);
      this.feed.set(this.hasNetworkCam() ? 'network' : 'device');
    });
    this.clock = setInterval(() => this.now.set(Date.now()), 1000);
  }

  ngOnDestroy() {
    this.stopCamera();
    if (this.clock) clearInterval(this.clock);
  }

  protected checkBackend() {
    this.api.health().subscribe({
      next: (h) => {
        this.modelType.set(h.model);
        this.backendOnline.set(true);
      },
      error: () => this.backendOnline.set(false),
    });
  }

  protected setMode(m: Mode) {
    if (m === this.mode()) return;
    this.stopCamera();
    this.error.set(null);
    this.result.set(null);
    this.uploadImage.set(null);
    this.selectedId.set(null);
    this.mode.set(m);
  }

  // ---- settings ----

  protected onArea(e: Event) {
    const id = Number((e.target as HTMLSelectElement).value) || null;
    this.stopCamera();
    this.areaId.set(id);
    this.feed.set(this.hasNetworkCam() ? 'network' : 'device');
    try {
      localStorage.setItem(AREA_KEY, String(id ?? ''));
    } catch {
      /* storage unavailable */
    }
  }

  protected onFeed(e: Event) {
    this.stopCamera();
    this.feed.set((e.target as HTMLSelectElement).value as Feed);
  }

  protected onThreshold(e: Event) {
    this.threshold.set(+(e.target as HTMLInputElement).value);
  }

  protected onGrid(e: Event) {
    this.grid.set(+(e.target as HTMLSelectElement).value);
  }

  protected onInterval(e: Event) {
    this.intervalMs.set(+(e.target as HTMLSelectElement).value);
  }

  protected onAlertAfter(e: Event) {
    this.alertAfter.set(+(e.target as HTMLSelectElement).value);
  }

  protected cellColor(score: number) {
    // only shade cells past the threshold, stronger the more confident
    if (score < this.threshold()) return 'transparent';
    const a = 0.18 + 0.32 * ((score - this.threshold()) / Math.max(1 - this.threshold(), 0.01));
    return `rgba(225, 45, 35, ${a.toFixed(2)})`;
  }

  // ---- live camera ----

  private resetSession() {
    this.trend.set([]);
    this.checks.set(0);
    this.trashStreak = this.cleanStreak = 0;
    this.alertActive.set(false);
    this.alertSince.set(null);
  }

  protected async startCamera() {
    this.error.set(null);
    if (this.feed() === 'network') {
      this.startNetworkCamera();
      return;
    }
    try {
      const video: MediaTrackConstraints = this.cameraId()
        ? { deviceId: { exact: this.cameraId() }, width: 1280, height: 720 }
        : { width: 1280, height: 720 };
      this.stream = await navigator.mediaDevices.getUserMedia({ video });
      // device labels are only available after permission is granted
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.cameras.set(devices.filter((d) => d.kind === 'videoinput'));
      const track = this.stream.getVideoTracks()[0];
      this.cameraId.set(track.getSettings().deviceId ?? '');

      this.cameraOn.set(true);
      this.resetSession();
      setTimeout(() => {
        const v = this.video()?.nativeElement;
        if (!v) return;
        v.srcObject = this.stream;
        v.play();
        this.captureLoop();
      });
    } catch {
      this.error.set('Could not open the camera. Allow camera access in your browser and try again.');
    }
  }

  protected stopCamera() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.streamUrl.set(null);
    this.cameraOn.set(false);
    this.alertActive.set(false);
    this.alertSince.set(null);
  }

  protected async switchCamera(e: Event) {
    this.cameraId.set((e.target as HTMLSelectElement).value);
    if (this.cameraOn()) {
      this.stopCamera();
      await this.startCamera();
    }
  }

  private grabFrame(maxWidth?: number): HTMLCanvasElement | null {
    const v = this.video()?.nativeElement;
    const img = this.feedImg()?.nativeElement;
    let src: CanvasImageSource, w: number, h: number;
    if (v?.videoWidth) [src, w, h] = [v, v.videoWidth, v.videoHeight];
    else if (img?.naturalWidth) [src, w, h] = [img, img.naturalWidth, img.naturalHeight];
    else return null;
    const scale = maxWidth ? Math.min(1, maxWidth / w) : 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvas.getContext('2d')!.drawImage(src, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  // ---- network camera: the server grabs and analyzes frames, the browser only shows them ----

  private startNetworkCamera() {
    const id = this.areaId();
    if (id === null) return;
    this.streamUrl.set(`/api/cameras/${id}/stream?token=${encodeURIComponent(this.auth.token() ?? '')}`);
    this.cameraOn.set(true);
    this.resetSession();
    this.networkLoop(id);
  }

  protected onFeedError() {
    if (this.cameraOn()) {
      this.error.set('Cannot show the network camera. Check its address on the Areas page and that the server can reach it.');
    }
  }

  private async networkLoop(id: number) {
    if (!this.cameraOn() || this.areaId() !== id) return;
    const started = performance.now();
    try {
      const r = await firstValueFrom(this.api.detectCamera(id, this.threshold(), this.grid()));
      if (!this.cameraOn()) return;
      this.onLiveResult(r, started);
    } catch (e) {
      this.error.set(this.describeError(e as HttpErrorResponse));
    }
    if (this.cameraOn()) this.timer = setTimeout(() => this.networkLoop(id), this.intervalMs());
  }

  private onLiveResult(r: DetectResult, started: number) {
    this.latency.set(Math.round(performance.now() - started));
    this.backendOnline.set(true);
    this.error.set(null);
    this.result.set(r);
    this.checks.update((n) => n + 1);
    this.trend.update((t) => [...t, { time: Date.now(), score: r.score }].slice(-MAX_TREND_POINTS));
    this.updateAlert(r);
  }

  private captureLoop() {
    if (!this.cameraOn()) return;
    const canvas = this.grabFrame(960);
    if (!canvas) {
      this.timer = setTimeout(() => this.captureLoop(), 300);
      return;
    }
    canvas.toBlob(async (blob) => {
      if (!blob || !this.cameraOn()) return;
      const started = performance.now();
      try {
        const r = await firstValueFrom(this.api.detect(blob, this.threshold(), this.grid(), 'frame.jpg', this.areaId(), 'live'));
        if (!this.cameraOn()) return;
        this.onLiveResult(r, started);
      } catch (e) {
        this.error.set(this.describeError(e as HttpErrorResponse));
      }
      // wait for each answer before sending the next frame, so slow CPUs don't pile up requests
      if (this.cameraOn()) this.timer = setTimeout(() => this.captureLoop(), this.intervalMs());
    }, 'image/jpeg', 0.85);
  }

  private updateAlert(r: DetectResult) {
    const isTrash = r.score >= this.threshold();
    if (isTrash) {
      this.trashStreak++;
      this.cleanStreak = 0;
    } else {
      this.cleanStreak++;
      this.trashStreak = 0;
    }

    if (!this.alertActive() && this.trashStreak >= this.alertAfter()) {
      this.alertActive.set(true);
      this.alertSince.set(Date.now());
      this.addLiveEntry('trash', 'Trash detected', r.score);
      if (this.soundOn()) this.beep();
    } else if (this.alertActive() && this.cleanStreak >= this.alertAfter()) {
      this.alertActive.set(false);
      this.alertSince.set(null);
      this.addLiveEntry('clean', 'Area cleared', r.score);
    }
  }

  protected takeSnapshot() {
    const r = this.result();
    this.addLiveEntry('snapshot', 'Manual snapshot', r?.score ?? 0);
  }

  private addLiveEntry(kind: LogEntry['kind'], title: string, score: number) {
    const thumb = this.grabFrame(THUMB_WIDTH)?.toDataURL('image/jpeg', 0.7) ?? '';
    this.pushLog({ id: this.nextId++, time: Date.now(), source: 'live', kind, title, score, thumb });
  }

  private beep() {
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.15;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
    } catch {
      /* audio not available */
    }
  }

  // ---- upload ----

  protected onFileInput(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files?.length) this.handleFiles(Array.from(input.files));
    input.value = '';
  }

  protected onDrop(e: DragEvent) {
    e.preventDefault();
    this.dragging.set(false);
    if (e.dataTransfer?.files.length) this.handleFiles(Array.from(e.dataTransfer.files));
  }

  protected onDragOver(e: DragEvent) {
    e.preventDefault();
    this.dragging.set(true);
  }

  private async handleFiles(files: File[]) {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (!images.length) {
      this.error.set('Please choose image files (JPG, PNG, BMP or WEBP).');
      return;
    }
    this.error.set(null);
    this.uploading.set(images.length);
    for (const file of images) {
      const url = URL.createObjectURL(file);
      try {
        const r = await firstValueFrom(this.api.detect(file, this.threshold(), this.grid(), file.name, null, 'upload'));
        this.backendOnline.set(true);
        const entry: LogEntry = {
          id: this.nextId++,
          time: Date.now(),
          source: 'upload',
          kind: r.is_trash ? 'trash' : 'clean',
          title: file.name,
          score: r.score,
          thumb: url,
          image: url,
          result: r,
        };
        this.pushLog(entry);
        this.openEntry(entry);
      } catch (e) {
        this.error.set(`${file.name}: ${this.describeError(e as HttpErrorResponse)}`);
      }
      this.uploading.update((n) => n - 1);
    }
  }

  protected openEntry(entry: LogEntry) {
    if (entry.source !== 'upload' || !entry.result) return;
    this.selectedId.set(entry.id);
    this.uploadImage.set(entry.image ?? null);
    this.result.set(entry.result);
  }

  // re-run the selected upload with the current grid setting
  protected async reanalyze() {
    const entry = this.log().find((e) => e.id === this.selectedId());
    if (!entry?.image) return;
    const blob = await (await fetch(entry.image)).blob();
    try {
      const r = await firstValueFrom(this.api.detect(blob, this.threshold(), this.grid(), entry.title));
      entry.result = r;
      entry.score = r.score;
      entry.kind = r.is_trash ? 'trash' : 'clean';
      this.log.update((l) => [...l]);
      this.result.set(r);
    } catch (e) {
      this.error.set(this.describeError(e as HttpErrorResponse));
    }
  }

  // ---- log ----

  private pushLog(entry: LogEntry) {
    this.log.update((l) => [entry, ...l].slice(0, 100));
  }

  protected clearLog() {
    const source = this.mode();
    this.log.update((l) => l.filter((e) => e.source !== source));
    if (source === 'upload') {
      this.selectedId.set(null);
      this.uploadImage.set(null);
      this.result.set(null);
    }
  }

  protected time(t: number) {
    return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  private describeError(e: HttpErrorResponse): string {
    if (e.status === 0 || e.status === 502 || e.status === 504) {
      this.backendOnline.set(false);
      return 'Cannot reach the detection server. Start it with: python backend/main.py';
    }
    if (e.status === 401) {
      return 'Your session ended. Please log in again.';
    }
    return e.error?.detail ?? `Request failed (${e.status})`;
  }
}
