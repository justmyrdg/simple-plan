import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpInterceptorFn } from '@angular/common/http';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, tap, throwError } from 'rxjs';

export interface User {
  id: number;
  username: string;
  full_name: string;
}

const TOKEN_KEY = 'tw_token';
const USER_KEY = 'tw_user';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: session lasts until reload */
  }
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  private router = inject(Router);

  readonly token = signal<string | null>(read(TOKEN_KEY));
  readonly user = signal<User | null>(JSON.parse(read(USER_KEY) ?? 'null'));
  readonly loggedIn = computed(() => !!this.token());

  login(username: string, password: string) {
    return this.http.post<{ token: string; user: User }>('/api/auth/login', { username, password }).pipe(
      tap((r) => {
        this.token.set(r.token);
        this.user.set(r.user);
        write(TOKEN_KEY, r.token);
        write(USER_KEY, JSON.stringify(r.user));
      }),
    );
  }

  changePassword(current_password: string, new_password: string) {
    return this.http.post('/api/auth/password', { current_password, new_password });
  }

  logout(redirect = true) {
    this.token.set(null);
    this.user.set(null);
    write(TOKEN_KEY, null);
    write(USER_KEY, null);
    if (redirect) this.router.navigate(['/login']);
  }
}

/** Adds the bearer token; on 401 from a protected call, logs out and returns to the login page. */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const token = auth.token();
  const authed = token && !req.url.startsWith('/api/public') ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;
  return next(authed).pipe(
    catchError((err) => {
      if (err.status === 401 && token && !req.url.includes('/api/auth/')) {
        auth.logout(false);
        router.navigate(['/login'], { queryParams: { expired: 1, next: router.url } });
      }
      return throwError(() => err);
    }),
  );
};

export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  if (auth.loggedIn()) return true;
  return inject(Router).createUrlTree(['/login'], { queryParams: { next: state.url } });
};
