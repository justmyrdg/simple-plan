import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { ApiService, errorMessage } from '../core/api.service';

/** Public page where residents stop SMS reminders to their number (withdraw consent). No login. */
@Component({
  selector: 'app-stop-sms',
  imports: [RouterLink],
  template: `
    <main class="auth-page">
      <section class="auth-hero">
        <h1>Stop SMS<br />reminders</h1>
        <p>Enter your mobile number and TrashWatch will stop sending you pickup reminders.</p>
      </section>
      <form class="auth-card card" (submit)="submit($event)">
        @if (done(); as msg) {
          <div class="success">{{ msg }}</div>
          <p class="muted small">Changed your mind? Ask your barangay or the admin to add your number again.</p>
        } @else {
          <label class="field"><span>Mobile number</span>
            <input class="input" name="phone" required inputmode="tel" placeholder="09171234567" autocomplete="tel" /></label>
          @if (error()) { <div class="error" role="alert">{{ error() }}</div> }
          <button class="btn btn-primary btn-block" [disabled]="busy()">{{ busy() ? 'Stopping…' : 'Stop my SMS reminders' }}</button>
        }
        <a routerLink="/" class="auth-alt"><svg class="icon"><use href="#i-calendar" /></svg> Back to the pickup schedule</a>
        <a routerLink="/privacy" class="auth-alt"><svg class="icon"><use href="#i-shield" /></svg> Privacy notice</a>
      </form>
    </main>
  `,
})
export class StopSms {
  private api = inject(ApiService);
  protected busy = signal(false);
  protected error = signal<string | null>(null);
  protected done = signal<string | null>(null);

  protected submit(e: Event) {
    e.preventDefault();
    const phone = String(new FormData(e.target as HTMLFormElement).get('phone'));
    this.busy.set(true);
    this.error.set(null);
    this.api.optOut(phone).subscribe({
      next: (r) => this.done.set(r.message),
      error: (err: HttpErrorResponse) => {
        this.busy.set(false);
        this.error.set(errorMessage(err));
      },
    });
  }
}
