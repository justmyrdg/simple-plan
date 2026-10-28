import { Component, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { filter } from 'rxjs';
import { AuthService } from '../core/auth.service';
import { errorMessage } from '../core/api.service';

@Component({
  selector: 'app-admin-layout',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <div class="shell" [class.nav-open]="navOpen()">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark"><svg class="icon"><use href="#i-trash" /></svg></div>
          <div>
            <div class="brand-name">TrashWatch</div>
            <div class="brand-sub">Admin</div>
          </div>
          <button class="icon-btn nav-close" (click)="navOpen.set(false)" aria-label="Close menu">
            <svg class="icon"><use href="#i-x" /></svg>
          </button>
        </div>

        <nav class="nav">
          <a routerLink="/admin/dashboard" routerLinkActive="active"><svg class="icon"><use href="#i-grid" /></svg> Dashboard</a>
          <a routerLink="/admin/monitor" routerLinkActive="active"><svg class="icon"><use href="#i-camera" /></svg> Monitor</a>
          <a routerLink="/admin/areas" routerLinkActive="active"><svg class="icon"><use href="#i-pin" /></svg> Areas &amp; contacts</a>
          <a routerLink="/admin/sms" routerLinkActive="active"><svg class="icon"><use href="#i-message" /></svg> SMS log</a>
          <a routerLink="/" class="nav-secondary"><svg class="icon"><use href="#i-calendar" /></svg> Public schedule page</a>
        </nav>

        <div class="sidebar-foot">
          <div class="user">
            <div class="avatar">{{ initials() }}</div>
            <div class="user-text">
              <div class="user-name">{{ auth.user()?.full_name || auth.user()?.username }}</div>
              <div class="user-sub">{{ auth.user()?.username }}</div>
            </div>
          </div>
          <div class="foot-actions">
            <button class="btn btn-ghost" (click)="openPassword()"><svg class="icon"><use href="#i-key" /></svg> Password</button>
            <button class="btn btn-ghost" (click)="auth.logout()"><svg class="icon"><use href="#i-logout" /></svg> Log out</button>
          </div>
        </div>
      </aside>
      <div class="scrim" (click)="navOpen.set(false)"></div>

      <div class="content">
        <header class="mobile-bar">
          <button class="icon-btn" (click)="navOpen.set(true)" aria-label="Open menu"><svg class="icon"><use href="#i-menu" /></svg></button>
          <span class="brand-name">TrashWatch</span>
        </header>
        <router-outlet />
      </div>
    </div>

    @if (pwOpen()) {
      <div class="modal-backdrop" (click)="pwOpen.set(false)">
        <form class="modal" (click)="$event.stopPropagation()" (submit)="savePassword($event)">
          <div class="modal-head">
            <h2>Change password</h2>
            <button type="button" class="icon-btn" (click)="pwOpen.set(false)" aria-label="Close"><svg class="icon"><use href="#i-x" /></svg></button>
          </div>
          <label class="field"><span>Current password</span>
            <input class="input" type="password" name="cur" autocomplete="current-password" required /></label>
          <label class="field"><span>New password (at least 8 characters)</span>
            <input class="input" type="password" name="new" autocomplete="new-password" minlength="8" required /></label>
          @if (pwError()) { <div class="error">{{ pwError() }}</div> }
          @if (pwDone()) { <div class="success">Password changed.</div> }
          <div class="modal-actions">
            <button type="button" class="btn" (click)="pwOpen.set(false)">Close</button>
            <button class="btn btn-primary" [disabled]="pwSaving()">Save</button>
          </div>
        </form>
      </div>
    }
  `,
})
export class AdminLayout {
  protected auth = inject(AuthService);
  protected navOpen = signal(false);
  protected pwOpen = signal(false);
  protected pwSaving = signal(false);
  protected pwError = signal<string | null>(null);
  protected pwDone = signal(false);

  constructor() {
    // close the mobile menu after navigating
    inject(Router).events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe(() => this.navOpen.set(false));
  }

  protected initials() {
    const u = this.auth.user();
    const name = u?.full_name || u?.username || '?';
    return name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  }

  protected openPassword() {
    this.pwError.set(null);
    this.pwDone.set(false);
    this.pwOpen.set(true);
  }

  protected savePassword(e: Event) {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const data = new FormData(form);
    this.pwSaving.set(true);
    this.pwError.set(null);
    this.auth.changePassword(String(data.get('cur')), String(data.get('new'))).subscribe({
      next: () => {
        this.pwSaving.set(false);
        this.pwDone.set(true);
        form.reset();
      },
      error: (err: HttpErrorResponse) => {
        this.pwSaving.set(false);
        this.pwError.set(errorMessage(err));
      },
    });
  }
}
