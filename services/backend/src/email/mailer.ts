/**
 * Sending email (NOTIF-02): SES in AWS, the console locally, a list in tests. Messages go to one
 * recipient each, so no address is ever shown to anyone else (NFR-06).
 */
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** e.g. List-Unsubscribe and List-Unsubscribe-Post. */
  headers: Record<string, string>;
}

export interface Mailer {
  send(email: Email): Promise<void>;
}

export function sesMailer(
  config: { from: string; configurationSet: string },
  client = new SESv2Client(),
): Mailer {
  return {
    async send(email) {
      await client.send(
        new SendEmailCommand({
          FromEmailAddress: `Torn Signpost <${config.from}>`,
          Destination: { ToAddresses: [email.to] },
          ConfigurationSetName: config.configurationSet,
          Content: {
            Simple: {
              Subject: { Data: email.subject, Charset: 'UTF-8' },
              Body: {
                Text: { Data: email.text, Charset: 'UTF-8' },
                Html: { Data: email.html, Charset: 'UTF-8' },
              },
              Headers: Object.entries(email.headers).map(([Name, Value]) => ({ Name, Value })),
            },
          },
        }),
      );
    },
  };
}

/** Local development: print instead of sending. */
export const consoleMailer: Mailer = {
  async send(email) {
    console.log(
      `\n— email to ${email.to} —\nSubject: ${email.subject}\n${Object.entries(email.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')}\n\n${email.text}\n— end —\n`,
    );
  },
};
