// Cafe use cases — domain types for a cafe landing page
import { registerType } from '@treenx/core/comp';

/** Mail delivery settings */
class CafeMailService {
  /** @title SMTP host */
  host = 'smtp.example.com';
  /** @title Port */
  port = 587;
  /** @title Sender address @format email */
  from = '';
}
registerType('cafe.mail', CafeMailService);

/** Contact form use case — receives form submissions, logs them */
class CafeContact {
  /** @title Recipient @format email */
  recipient = '';
  /** @title Mail service */
  mailService?: CafeMailService;
  /** @title Last submission */
  lastSubmission = '';

  /** @description Submit contact form — validates and logs submission */
  submit(data: { name: string; email: string; message: string }) {
    if (!data.name || !data.email) throw new Error('Name and email required');
    // For now: store last submission on the node. Later: create child node, send notification.
    this.lastSubmission = JSON.stringify({ ...data, at: new Date().toISOString() });
    console.log(`[cafe:contact] → ${this.recipient}: ${data.name} <${data.email}> "${data.message}"`);
  }
}
registerType('cafe.contact', CafeContact);
