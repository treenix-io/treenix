import { declareClientType } from '@treenx/core/comp/client-declaration';
import { declareOpenModule } from '@treenx/core/kernel/module-declaration';
// Cafe use cases — domain types for a cafe landing page

/** Mail delivery settings */
export class CafeMailService {
  /** @title SMTP host */
  host = 'smtp.example.com';
  /** @title Port */
  port = 587;
  /** @title Sender address @format email */
  from = '';
}
const declaredCafeMail = declareClientType('cafe.mail', CafeMailService);

/** Contact form use case — receives form submissions, logs them */
export class CafeContact {
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
    console.log(
      `[cafe:contact] → ${this.recipient}: ${data.name} <${data.email}> "${data.message}"`,
    );
  }
}
const declaredCafeContact = declareClientType('cafe.contact', CafeContact);

export const clientModules = [
  declareOpenModule('@treenx/mods/cafe/types', [], [declaredCafeMail, declaredCafeContact]),
];
