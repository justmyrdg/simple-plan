import { Component, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { AuthService } from '../core/auth.service';
import { errorMessage } from '../core/api.service';

@Component({
  selector: 'app-login',
  imports: [RouterLink],
  template: `
    <main class="auth-page">
      <section class="auth-hero">
        <h1>Keep every<br />area clean</h1>
        <p>Cameras watch the collection points. You see what needs pickup.</p>
      </section>
      <form class="auth-card card" (submit)="submit($event)">
        <div class="brand brand-center">
          <div class="brand-mark"><svg class="icon"><use href="#i-trash" /></svg></div>
          <div>
            <div class="brand-name">TrashWatch</div>
            <div class="brand-sub">Admin login</div>
          </div>
        </div>

        @if (expired()) { <div class="notice">Your session ended. Please log in again.</div> }

        <label class="field"><span>Username</span>
          <input class="input" name="username" autocomplete="username" required autofocus /></label>
        <label class="field"><span>Password</span>
          <input class="input" name="password" type="password" autocomplete="current-password" required /></label>

        @if (error()) { <div class="error" role="alert">{{ error() }}</div> }

        <button class="btn btn-primary btn-block" [disabled]="loading()">
          {{ loading() ? 'Logging in…' : 'Log in' }}
        </button>
        <a routerLink="/" class="auth-alt"><svg class="icon"><use href="#i-calendar" /></svg> Resident? Check the pickup schedule</a>
      </form>
    </main>
  `,
})
export class Login {
  private auth = inject(AuthService);
  private router = inject(Router);

  // query params, bound by withComponentInputBinding
  readonly next = input<string>();
  readonly expired = input<string>();

  protected loading = signal(false);
  protected error = signal<string | null>(null);

  constructor() {
    if (this.auth.loggedIn()) this.router.navigateByUrl('/admin');
  }

  protected submit(e: Event) {
    e.preventDefault();
    const data = new FormData(e.target as HTMLFormElement);
    this.loading.set(true);
    this.error.set(null);
    this.auth.login(String(data.get('username')), String(data.get('password'))).subscribe({
      next: () => {
        const next = this.next();
        this.router.navigateByUrl(next?.startsWith('/admin') ? next : '/admin');
      },
      error: (err: HttpErrorResponse) => {
        this.loading.set(false);
        this.error.set(errorMessage(err));
      },
    });
  }
}
