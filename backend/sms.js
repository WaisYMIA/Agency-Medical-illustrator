// ============================================================
// Medical Premium Illustrator — SMS Delivery
// ============================================================
//
// This is a thin, provider-agnostic wrapper. As shipped, it does NOT
// send real SMS — it logs the OTP to the SERVER's console only. That
// is deliberate: without a real SMS account, there is no way to
// actually deliver a text message, and returning the OTP to the
// browser instead would defeat the entire point of OTP verification.
//
// To go live, sign up with an SMS provider and fill in sendSmsLive()
// below. Africa's Talking (africastalking.com) is a common choice for
// Kenyan numbers and has a free sandbox for testing. Twilio is another
// option if you need broader country coverage.
//
// Once sendSmsLive() is implemented, set SMS_PROVIDER_CONFIGURED=true
// as an environment variable on your host (e.g. in Render's
// Environment tab) to switch it on. Until then, this module stays in
// safe dev mode automatically — nothing will silently "half-work" in
// production.

const DEV_MODE = process.env.SMS_PROVIDER_CONFIGURED !== 'true';

async function sendOtpSms(phone, otp) {
  const message = `Your Medical Premium Illustrator verification code is ${otp}. It expires in 5 minutes. Do not share this code.`;

  if (DEV_MODE) {
    // eslint-disable-next-line no-console
    console.log(`\n[DEV MODE — no SMS provider configured]`);
    console.log(`  Would send to ${phone}: "${message}"`);
    console.log(`  (Set SMS_PROVIDER_CONFIGURED=true and implement sendSmsLive() to send real SMS.)\n`);
    return { sent: false, devMode: true };
  }

  await sendSmsLive(phone, message);
  return { sent: true, devMode: false };
}

async function sendSmsLive(phone, message) {
  // ---- Example using Africa's Talking (uncomment and fill in once you
  //      have an account, then set SMS_PROVIDER_CONFIGURED=true):
  //
  // const AfricasTalking = require('africastalking')({
  //   apiKey: process.env.AT_API_KEY,
  //   username: process.env.AT_USERNAME,
  // });
  // const sms = AfricasTalking.SMS;
  // await sms.send({ to: [phone], message, from: process.env.AT_SENDER_ID });

  throw new Error(
    'SMS_PROVIDER_CONFIGURED is true, but sendSmsLive() has not been implemented yet. ' +
    'Fill in a real SMS provider integration in backend/sms.js.'
  );
}

module.exports = { sendOtpSms };
