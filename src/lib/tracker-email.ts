import "server-only";

interface EmailMessage {
  to: string;
  subject: string;
  html: string;
}

export type TrackerEmailDeliveryCode =
  | "configuration_missing"
  | "api_key_invalid"
  | "sender_not_verified"
  | "sandbox_recipient_restricted"
  | "provider_rate_limited"
  | "provider_rejected"
  | "provider_unavailable";

export class TrackerEmailDeliveryError extends Error {
  constructor(
    message: string,
    readonly definitive: boolean,
    readonly code: TrackerEmailDeliveryCode
  ) {
    super(message);
    this.name = "TrackerEmailDeliveryError";
  }
}

export function isDefinitiveTrackerEmailFailure(error: unknown): boolean {
  return error instanceof TrackerEmailDeliveryError && error.definitive;
}

export function trackerEmailFailureCode(
  error: unknown
): TrackerEmailDeliveryCode {
  return error instanceof TrackerEmailDeliveryError
    ? error.code
    : "provider_unavailable";
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

const RESEND_EMAIL_URL = "https://api.resend.com/emails";
const RESEND_SANDBOX_FROM = "GMK Tracker <onboarding@resend.dev>";

function configuredSender(): string {
  const value = process.env.TRACKER_EMAIL_FROM?.trim();
  if (!value || /your-domain\.com/i.test(value)) return RESEND_SANDBOX_FROM;
  return value;
}

function deliveryError(status: number, details: string): TrackerEmailDeliveryError {
  const normalized = details.toLowerCase();
  let code: TrackerEmailDeliveryCode = "provider_rejected";

  if (status === 401 || normalized.includes("invalid_api_key")) {
    code = "api_key_invalid";
  } else if (
    normalized.includes("testing emails") ||
    normalized.includes("only send") && normalized.includes("own email")
  ) {
    code = "sandbox_recipient_restricted";
  } else if (
    normalized.includes("domain") &&
    (normalized.includes("not verified") || normalized.includes("verify"))
  ) {
    code = "sender_not_verified";
  } else if (status === 429) {
    code = "provider_rate_limited";
  }

  return new TrackerEmailDeliveryError(
    `Email provider rejected the message (${status}): ${details}`,
    true,
    code
  );
}

async function sendWithResend({
  apiKey,
  from,
  message,
}: {
  apiKey: string;
  from: string;
  message: EmailMessage;
}): Promise<void> {
  let response: Response;
  try {
    response = await fetch(RESEND_EMAIL_URL, {
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
  } catch (error) {
    throw new TrackerEmailDeliveryError(
      `Email provider could not be reached: ${
        error instanceof Error ? error.message : String(error)
      }`,
      false,
      "provider_unavailable"
    );
  }

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw deliveryError(response.status, details);
  }
}

export async function sendTrackerEmail(message: EmailMessage): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    if (process.env.NODE_ENV === "development") {
      console.info(`[tracker-email] ${message.subject} -> ${message.to}`);
      return;
    }
    throw new TrackerEmailDeliveryError(
      "Tracker email delivery is not configured: RESEND_API_KEY is missing",
      true,
      "configuration_missing"
    );
  }

  const from = configuredSender();
  try {
    await sendWithResend({ apiKey, from, message });
  } catch (error) {
    // A stale or unverified custom sender in Vercel should not prevent the
    // Resend account owner from using passwordless login during setup.
    if (
      from !== RESEND_SANDBOX_FROM &&
      error instanceof TrackerEmailDeliveryError &&
      error.code === "sender_not_verified"
    ) {
      await sendWithResend({ apiKey, from: RESEND_SANDBOX_FROM, message });
      return;
    }
    throw error;
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
