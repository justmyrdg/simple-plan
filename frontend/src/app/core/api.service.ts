import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';

export interface Area {
  id: number;
  name: string;
  address: string;
  lat: number;
  lng: number;
  camera_enabled: boolean;
  camera_label: string;
  camera_url: string;
  last_status: 'trash' | 'clean' | null;
  last_score: number | null;
  last_checked_at: string | null;
  last_collected_at: string | null;
  contact_count: number;
  schedule_count: number;
  next_pickup: string | null;
}
export type AreaInput = Pick<Area, 'name' | 'address' | 'lat' | 'lng' | 'camera_enabled' | 'camera_label' | 'camera_url'>;

export interface Contact {
  id: number;
  area_id: number;
  name: string;
  phone: string;
  active: boolean;
  language: SmsLanguage;
  consent_at: string | null; // when the resident agreed to receive SMS (Data Privacy Act)
  opted_out_at: string | null;
  created_at: string;
}
export type SmsLanguage = 'en' | 'fil';
export type ContactInput = Pick<Contact, 'name' | 'phone' | 'active' | 'language'> & { consent?: boolean };
export const LANGUAGE_LABEL: Record<SmsLanguage, string> = { en: 'English', fil: 'Filipino' };

export type CollectionStatus = 'pending' | 'collected' | 'missed' | 'no_waste' | 'no_data';

/** What happened at one scheduled pickup, judged from the camera history. */
export interface Collection {
  id: number;
  area_id: number;
  area: string;
  status: CollectionStatus;
  scheduled_for: string;
  full_since: string | null;
  collected_at: string | null;
  minutes_from_schedule: number | null; // negative = before the scheduled time
  on_time: boolean;
  hours_full: number | null;
  before_photo: number | null; // detection ids with a saved photo
  after_photo: number | null;
}

export interface ReportStats {
  pickups: number;
  collected: number;
  missed: number;
  no_waste: number;
  no_data: number;
  collection_rate: number | null;
  on_time_rate: number | null;
  avg_minutes_late: number | null;
  avg_hours_full: number | null;
  time_full: number | null;
  hours_observed: number;
  times_filled: number;
  reminders_sent: number;
  reminders_failed: number;
}
export interface Report {
  days: number;
  since: string;
  until: string;
  totals: ReportStats;
  areas: (ReportStats & { area_id: number; area: string })[];
  collections: Collection[];
}

export interface Schedule {
  id: number;
  area_id: number;
  kind: 'weekly' | 'once';
  weekday: number | null;
  date: string | null;
  time: string;
  truck: string;
  notes: string;
  notify_minutes_before: number;
  active: boolean;
  description: string;
}
export type ScheduleInput = Omit<Schedule, 'id' | 'area_id' | 'description'>;

export interface SmsEntry {
  id: number;
  time: string;
  area: string | null;
  phone: string;
  message: string;
  status: 'sent' | 'simulated' | 'failed';
  error: string;
  kind: 'reminder' | 'manual' | 'alert';
}

export interface Dashboard {
  sms_provider: 'semaphore' | 'smsgate' | 'simulated';
  totals: {
    areas: number;
    cameras: number;
    cameras_online: number;
    areas_trash: number;
    contacts: number;
    pickups_today: number;
    sms_today: Partial<Record<'sent' | 'simulated' | 'failed', number>>;
    collections_today: Record<CollectionStatus, number>;
  };
  recent_collections: Collection[];
  areas: { id: number; name: string; lat: number; lng: number; camera_enabled: boolean;
           status: 'trash' | 'clean' | null; score: number | null; checked_at: string | null; online: boolean }[];
  upcoming_pickups: { time: string; area_id: number; area: string; truck: string; contacts: number }[];
  activity: { hour: string; checks: number; trash: number }[];
  recent_detections: { time: string; area: string; status: 'trash' | 'clean'; score: number }[];
}

export interface PublicArea {
  id: number;
  name: string;
  address: string;
  lat: number;
  lng: number;
  status: 'trash' | 'clean' | null;
  status_checked_at: string | null;
  last_collected_at: string | null;
  next_pickup: string | null;
  next_pickup_truck: string | null;
}
export interface PublicAreaDetail extends PublicArea {
  regular_schedule: { description: string; truck: string; notes: string }[];
  upcoming: { time: string; truck: string; notes: string; one_time: boolean }[];
}

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Pulls a readable message out of a FastAPI error response. */
export function errorMessage(e: HttpErrorResponse): string {
  if (e.status === 0 || e.status === 502 || e.status === 504) return 'Cannot reach the server. Is the backend running?';
  const d = e.error?.detail;
  if (typeof d === 'string') return d;
  if (Array.isArray(d) && d.length) return d.map((x) => String(x.msg).replace(/^Value error, /, '')).join('; ');
  return `Request failed (${e.status})`;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);

  // areas
  areas() { return this.http.get<Area[]>('/api/areas'); }
  area(id: number) { return this.http.get<Area>(`/api/areas/${id}`); }
  createArea(body: AreaInput) { return this.http.post<Area>('/api/areas', body); }
  updateArea(id: number, body: AreaInput) { return this.http.put<Area>(`/api/areas/${id}`, body); }
  deleteArea(id: number) { return this.http.delete(`/api/areas/${id}`); }

  // contacts
  contacts(areaId: number) { return this.http.get<Contact[]>(`/api/areas/${areaId}/contacts`); }
  createContact(areaId: number, body: ContactInput) { return this.http.post<Contact>(`/api/areas/${areaId}/contacts`, body); }
  updateContact(id: number, body: ContactInput) { return this.http.put<Contact>(`/api/contacts/${id}`, body); }
  deleteContact(id: number) { return this.http.delete(`/api/contacts/${id}`); }
  testContact(id: number) { return this.http.post<{ status: string; error: string }>(`/api/contacts/${id}/test`, {}); }
  notifyArea(areaId: number, message: string) {
    return this.http.post<Record<'sent' | 'simulated' | 'failed', number>>(`/api/areas/${areaId}/notify`, { message });
  }

  // schedules
  schedules(areaId: number) { return this.http.get<Schedule[]>(`/api/areas/${areaId}/schedules`); }
  createSchedule(areaId: number, body: ScheduleInput) { return this.http.post<Schedule>(`/api/areas/${areaId}/schedules`, body); }
  updateSchedule(id: number, body: ScheduleInput) { return this.http.put<Schedule>(`/api/schedules/${id}`, body); }
  deleteSchedule(id: number) { return this.http.delete(`/api/schedules/${id}`); }

  // collections & reports
  collections(areaId?: number, days = 30) {
    return this.http.get<Collection[]>('/api/collections', { params: areaId ? { area_id: areaId, days } : { days } });
  }
  report(days: number) { return this.http.get<Report>('/api/reports/summary', { params: { days } }); }
  reportCsv(days: number) { return this.http.get('/api/reports/collections.csv', { params: { days }, responseType: 'blob' }); }

  // dashboard & logs
  dashboard() { return this.http.get<Dashboard>('/api/dashboard'); }
  smsLog(areaId?: number) {
    return this.http.get<SmsEntry[]>('/api/sms-log', { params: areaId ? { area_id: areaId } : {} });
  }

  // public
  publicAreas() { return this.http.get<PublicArea[]>('/api/public/areas'); }
  publicArea(id: number) { return this.http.get<PublicAreaDetail>(`/api/public/areas/${id}`); }
  publicInfo() {
    return this.http.get<{ organization: string; privacy_contact: string; photo_retention_days: number }>('/api/public/info');
  }
  optOut(phone: string) { return this.http.post<{ message: string }>('/api/public/opt-out', { phone }); }
}
