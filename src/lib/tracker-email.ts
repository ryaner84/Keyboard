import "server-only";

interface EmailMessage {
  to: string;
  subject: string;
  html: string;
}

export class TrackerEmailDeliveryError extends Error {
  constructor(
    message: string,
    readonly definitive: boolean
  ) {
    super(message);
    this.name = "TrackerEmailDeliveryError";
  }
}

export function isDefinitiveTrackerEmailFailure(error: unknown): boolean {
  return error instanceof TrackerEmailDeliveryError && error.definitive;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[
        char
      ] ?? char
  );
}

export async function sendTrackerEmail(message: EmailMessage): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.TRACKER_EMAIL_FROM;
  if (!apiKey || !from) {
    if (process.env.NODE_ENV === "development") {
      console.info(`[tracker-email] ${message.subject} -> ${message.to}`);
      return;
    }
    throw new TrackerEmailDeliveryError(
      "Tracker email delivery is not configured",
      true
    );
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [message.to],
      reply_to: process.env.TRACKER_EMAIL_REPLY_TO || undefined,
      subject: message.subject,
      html: message.html,
    }),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new TrackerEmailDeliveryError(
      `Email provider rejected the message (${response.status}): ${details}`,
      true
    );
  }
}

export async function sendTrackerLoginEmail({
  email,
  magicUrl,
  otp,
}: {
  email: string;
  magicUrl: string;
  otp: string;
}) {
  const safeUrl = escapeHtml(magicUrl);
  const safeOtp = escapeHtml(otp);
  await sendTrackerEmail({
    to: email,
    subject: "Save your GMK Tracker",
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#111827">
        <h1 style="font-size:22px;margin-bottom:12px">Save your tracker</h1>
        <p style="line-height:1.6;color:#4b5563">
          Use the button below to verify your email and sync your tracked keyboards and keycap sets.
        </p>
        <p style="margin:24px 0">
          <a href="${safeUrl}" style="display:inline-block;background:#4f46e5;color:white;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600">
            Verify and open my tracker
          </a>
        </p>
        <p style="color:#4b5563">Or enter this 6-digit code:</p>
        <p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:12px 0">${safeOtp}</p>
        <p style="font-size:13px;color:#9ca3af">This link and code expire in 10 minutes.</p>
      </div>
    `,
  });
}
