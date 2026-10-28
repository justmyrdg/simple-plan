import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService } from '../core/api.service';

/**
 * Public privacy notice (Data Privacy Act of 2012, RA 10173). The organization name, privacy
 * contact and photo retention period come from backend/.env (ORG_NAME, PRIVACY_CONTACT,
 * PHOTO_RETENTION_DAYS).
 */
@Component({
  selector: 'app-privacy',
  imports: [RouterLink],
  template: `
    <div class="public-top">
      <header class="public-bar">
        <a routerLink="/" class="brand brand-link">
          <div class="brand-mark"><svg class="icon"><use href="#i-trash" /></svg></div>
          <div>
            <div class="brand-name">TrashWatch</div>
            <div class="brand-sub">Garbage pickup schedule</div>
          </div>
        </a>
      </header>
      <section class="hero">
        <h1>Privacy notice</h1>
        <p>How TrashWatch handles your information</p>
      </section>
    </div>

    <main class="public-page">
      <article class="card prose">
        <h2>Who we are</h2>
        <p>TrashWatch is operated by <strong>{{ org() || 'the office managing garbage collection in your area' }}</strong>
          to monitor garbage collection points and remind residents of pickup schedules.</p>

        <h2>What we collect</h2>
        <ul>
          <li><strong>Your name and mobile number</strong>, and the collection area you belong to, only if you agreed to receive SMS reminders.</li>
          <li><strong>The SMS messages sent to you</strong> and whether they were delivered to the SMS provider.</li>
          <li><strong>Camera images of garbage collection points.</strong> Cameras face the collection area, not homes. They are used to tell whether the area is full or clean.</li>
        </ul>

        <h2>Why we collect it</h2>
        <ul>
          <li>To text you before each garbage pickup in your area.</li>
          <li>To check whether collection points were collected, and to improve pickup schedules.</li>
        </ul>

        <h2>How long we keep it</h2>
        <ul>
          <li>Camera photos are deleted automatically after <strong>{{ retention() }} days</strong>.</li>
          <li>Your name and number are kept until you stop the reminders or ask to be removed.</li>
        </ul>

        <h2>Who we share it with</h2>
        <p>Your number and the message text are passed to the SMS provider only to deliver the reminders. We don't sell or share your information for any other purpose.</p>

        <h2>Your rights</h2>
        <p>Under the Data Privacy Act of 2012 you can ask to see, correct or delete your information, and you can withdraw your consent at any time.</p>
        <p><a routerLink="/stop" class="btn btn-primary"><svg class="icon"><use href="#i-x" /></svg> Stop my SMS reminders</a></p>
        @if (contact()) {
          <p>For other requests or questions, contact <strong>{{ contact() }}</strong>.</p>
        } @else {
          <p>For other requests or questions, contact your barangay office.</p>
        }
      </article>
    </main>
  `,
})
export class Privacy implements OnInit {
  private api = inject(ApiService);
  protected org = signal('');
  protected contact = signal('');
  protected retention = signal(30);

  ngOnInit() {
    this.api.publicInfo().subscribe((i) => {
      this.org.set(i.organization);
      this.contact.set(i.privacy_contact);
      this.retention.set(i.photo_retention_days);
    });
  }
}
