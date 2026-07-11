// Shared outbound-mail helpers (Resend HTTP API). Used by the public form
// routes and the Stripe webhook handler, so both send from one place.

// All outbound mail is sent from the Hive domain (verified in Resend).
const MAIL_FROM = process.env.MAIL_FROM || 'Hive <vineet.dutta@hiveny.com>';
// Master recipient for submitted inquiry/application details.
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'vineet.dutta@hiveny.com';

// Low-level mail send via the Resend HTTP API. Throws on failure so callers can
// log it; callers wrap this so a failed send never blocks saving the inquiry.
async function sendMail({ to, subject, html, replyTo }) {
  if (!to) return;
  if (!process.env.RESEND_API_KEY) {
    console.warn(`[mail] RESEND_API_KEY missing — "${subject}" to ${to} not sent.`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: [to],
      subject,
      html,
      reply_to: replyTo || undefined
    })
  });
  if (!res.ok) {
    throw new Error(`Resend ${res.status}: ${await res.text()}`);
  }
  console.log(`[mail] Sent "${subject}" to ${to}`);
}

// Branded wrapper for confirmation emails sent to the person who submitted a form.
function confirmationHtml(heading, bodyLines) {
  return `
    <div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a18;">
      <h2 style="color: #1a1a18;">${heading}</h2>
      ${bodyLines.map(l => `<p style="line-height: 1.6; color: #444;">${l}</p>`).join('')}
      <p style="line-height: 1.6; color: #444;">Warm regards,<br>Vineet Dutta<br>Hive · <a href="https://hiveny.com" style="color: #d4920b;">hiveny.com</a></p>
      <p style="margin-top: 20px; color: #888; font-size: 12px;">This is an automated confirmation from Hive. You can reply directly to this email to reach us.</p>
    </div>`;
}

module.exports = { sendMail, confirmationHtml, MAIL_FROM, NOTIFY_EMAIL };
