<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/fe4299db-44b1-48d7-966f-8f144d0a2bda

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Notifications

The app can send vaccination reminders by email and SMS.

### Email reminders

Set these environment variables:

- `SMTP_USER`
- `SMTP_PASS`

### SMS reminders

Set `SMS_PROVIDER` to one of these values:

- `httpsms`: Sends SMS through the official httpSMS API using your Android phone number.
- `textbelt`: Sends SMS through Textbelt. You can start with the free `textbelt` key, then switch to your own key for more volume.
- `fast2sms`: Uses the Fast2SMS API.
- `webhook`: Sends reminder data to your own SMS gateway webhook.
- `none`: Disables SMS reminders.

### Textbelt setup

Use Textbelt if you want the fastest path to working SMS reminders without setting up Fast2SMS or your own Android gateway.

- Docs: [Textbelt documentation](https://docs.textbelt.com/)
- Country support FAQ: [Textbelt supported countries](https://docs.textbelt.com/faq/sending-and-receiving-messages)

Set these environment variables:

- `SMS_PROVIDER=textbelt`
- `TEXTBELT_API_KEY=textbelt` for 1 free SMS per day, or your own Textbelt API key for higher limits
- `TEXTBELT_SENDER` optional, defaults to `ImmuniBaby`

The app sends Textbelt requests like this:

```json
{
  "phone": "+919876543210",
  "message": "ImmuniBaby reminder: Baby's DPT vaccination is due on 2026-04-10. Reply STOP to opt out.",
  "key": "textbelt",
  "sender": "ImmuniBaby"
}
```

### httpSMS setup

Use the official httpSMS Android app and API:

- Docs: [httpSMS documentation](https://docs.httpsms.com/)
- Send API example: [Scheduling SMS Messages](https://docs.httpsms.com/features/scheduling-sms-messages)

Set these environment variables:

- `SMS_PROVIDER=httpsms`
- `HTTPSMS_API_KEY`
- `HTTPSMS_FROM_NUMBER`
- `HTTPSMS_API_BASE_URL` optional, defaults to `https://api.httpsms.com`

The app sends SMS with this request shape:

```json
{
  "from": "+919876543210",
  "to": "+919876543210",
  "content": "ImmuniBaby reminder: Baby's DPT vaccination is due on 2026-04-10."
}
```

When `SMS_PROVIDER=webhook`, the app sends a `POST` request with JSON like this:

```json
{
  "phoneNumber": "+919876543210",
  "message": "ImmuniBaby reminder: Baby's DPT vaccination is due on 2026-04-10.",
  "babyName": "Baby",
  "vaccine": "DPT",
  "dueDate": "2026-04-10"
}
```

This is useful when you do not want to pay for an SMS API and instead want to route reminders through your own Android phone/SIM, self-hosted automation, or another gateway you control.
