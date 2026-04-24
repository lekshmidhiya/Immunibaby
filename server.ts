// server.ts
import 'dotenv/config';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import cron from 'node-cron';

console.log('Starting server initialization...');

declare global {
  namespace Express {
    interface Request {
      user: { id: number; name: string; email: string; phone_number?: string | null };
    }
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ------------------- DATABASE -------------------
const db = new Database('immunibaby.db');
console.log('Database connected successfully');

const sleepSync = (ms: number) => {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
};

const withDbRetry = <T,>(label: string, fn: () => T) => {
  const maxRetries = 5;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return fn();
    } catch (err: any) {
      if (err?.code === 'SQLITE_BUSY') {
        if (attempt === maxRetries) {
          console.error(`${label} failed: database is locked. Close any SQLite viewers or other apps using immunibaby.db and try again.`);
          throw err;
        }
        sleepSync(250 * attempt);
        continue;
      }
      throw err;
    }
  }
  return fn();
};

withDbRetry('Database pragmas', () => {
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
});

withDbRetry('Database migrations', () => db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  phone_number TEXT
);

CREATE TABLE IF NOT EXISTS babies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  dob TEXT NOT NULL,
  sex TEXT,
  parent_id INTEGER NOT NULL,
  notes TEXT,
  photo_url TEXT,
  FOREIGN KEY (parent_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS vaccinations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  baby_id INTEGER NOT NULL,
  vaccine_name TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT DEFAULT 'Pending',
  completed_date TEXT,
  FOREIGN KEY (baby_id) REFERENCES babies(id)
);

CREATE TABLE IF NOT EXISTS growth_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  baby_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  weight REAL,
  height REAL,
  head_circumference REAL,
  FOREIGN KEY (baby_id) REFERENCES babies(id)
);

CREATE TABLE IF NOT EXISTS milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  baby_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  date TEXT,
  category TEXT,
  achieved BOOLEAN DEFAULT 0,
  FOREIGN KEY (baby_id) REFERENCES babies(id)
);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  baby_id INTEGER NOT NULL,
  doctor_name TEXT NOT NULL,
  date TEXT NOT NULL,
  purpose TEXT,
  status TEXT DEFAULT 'Scheduled',
  FOREIGN KEY (baby_id) REFERENCES babies(id)
);
`));

const ensureBabyPhotoColumn = () => {
  withDbRetry('Ensure baby photo column', () => {
    const columns = db.prepare('PRAGMA table_info(babies)').all();
    const hasPhoto = columns.some((column: any) => column.name === 'photo_url');
    if (!hasPhoto) {
      db.prepare('ALTER TABLE babies ADD COLUMN photo_url TEXT').run();
    }
  });
};

ensureBabyPhotoColumn();

const ensureBabySexColumn = () => {
  withDbRetry('Ensure baby sex column', () => {
    const columns = db.prepare('PRAGMA table_info(babies)').all();
    const hasSex = columns.some((column: any) => column.name === 'sex');
    if (!hasSex) {
      db.prepare('ALTER TABLE babies ADD COLUMN sex TEXT').run();
    }
  });
};

ensureBabySexColumn();

const ensureUserPhoneNumberColumn = () => {
  withDbRetry('Ensure user phone_number column', () => {
    const columns = db.prepare('PRAGMA table_info(users)').all();
    const hasPhoneNumber = columns.some((column: any) => column.name === 'phone_number');
    if (!hasPhoneNumber) {
      db.prepare('ALTER TABLE users ADD COLUMN phone_number TEXT').run();
    }
  });
};

ensureUserPhoneNumberColumn();

const ensureVaccinationCompletedDateColumn = () => {
  withDbRetry('Ensure vaccination completed_date column', () => {
    const columns = db.prepare('PRAGMA table_info(vaccinations)').all();
    const hasCompletedDate = columns.some((column: any) => column.name === 'completed_date');
    if (!hasCompletedDate) {
      db.prepare('ALTER TABLE vaccinations ADD COLUMN completed_date TEXT').run();
    }
  });
};

const backfillVaccinationCompletedDates = () => {
  withDbRetry('Vaccination completed_date backfill', () => {
    db.prepare(`
      UPDATE vaccinations
      SET completed_date = due_date
      WHERE status = 'Completed' AND completed_date IS NULL
    `).run();
  });
};

ensureVaccinationCompletedDateColumn();
backfillVaccinationCompletedDates();

// ------------------- JWT SECRET -------------------
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

const normalizePhoneNumber = (value: unknown) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const normalized = trimmed.replace(/[\s()-]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : undefined;
};

const padDateUnit = (value: number) => String(value).padStart(2, '0');

const formatCalendarDate = (date: Date) => {
  const year = date.getFullYear();
  const month = padDateUnit(date.getMonth() + 1);
  const day = padDateUnit(date.getDate());
  return `${year}-${month}-${day}`;
};

const formatCalendarDateInTimeZone = (date: Date, timeZone: string) => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find(part => part.type === 'year')?.value;
  const month = parts.find(part => part.type === 'month')?.value;
  const day = parts.find(part => part.type === 'day')?.value;

  if (!year || !month || !day) {
    return formatCalendarDate(date);
  }

  return `${year}-${month}-${day}`;
};

// ------------------- NODMAILER -------------------
const SMTP_USER = process.env.SMTP_USER?.trim();
const SMTP_PASS = process.env.SMTP_PASS?.trim();
const FAST2SMS_API_KEY = process.env.FAST2SMS_API_KEY?.trim();
const FAST2SMS_LANGUAGE = process.env.FAST2SMS_LANGUAGE?.trim() || 'english';
const HTTPSMS_API_KEY = process.env.HTTPSMS_API_KEY?.trim();
const HTTPSMS_FROM_NUMBER = process.env.HTTPSMS_FROM_NUMBER?.trim();
const HTTPSMS_API_BASE_URL = process.env.HTTPSMS_API_BASE_URL?.trim() || 'https://api.httpsms.com';
const SMS_WEBHOOK_URL = process.env.SMS_WEBHOOK_URL?.trim();
const SMS_WEBHOOK_SECRET = process.env.SMS_WEBHOOK_SECRET?.trim();
const SMS_WEBHOOK_TIMEOUT_MS = Number.parseInt(process.env.SMS_WEBHOOK_TIMEOUT_MS?.trim() || '10000', 10);
const TEXTBELT_API_KEY = process.env.TEXTBELT_API_KEY?.trim() || (process.env.SMS_PROVIDER?.trim().toLowerCase() === 'textbelt' ? 'textbelt' : undefined);
const TEXTBELT_SENDER = process.env.TEXTBELT_SENDER?.trim() || 'ImmuniBaby';
const REMINDER_CRON = process.env.REMINDER_CRON?.trim() || '0 8 * * *';
const REMINDER_TIMEZONE = process.env.REMINDER_TIMEZONE?.trim() || 'Asia/Kolkata';
const getTodayDateString = () => formatCalendarDateInTimeZone(new Date(), REMINDER_TIMEZONE);

type SmsProvider = 'fast2sms' | 'httpsms' | 'webhook' | 'textbelt' | 'none';

const isLikelyPlaceholderValue = (value: string | undefined | null) => {
  if (!value) return false;

  const normalized = value.trim().toLowerCase();
  return (
    normalized.includes('your-')
    || normalized.includes('your_')
    || normalized.includes('your ')
    || normalized.includes('placeholder')
    || normalized.includes('replace')
    || normalized.includes('change-me')
    || normalized.includes('changeme')
    || normalized.includes('example.com')
  );
};

const parseSmsProvider = (value: string | undefined | null): SmsProvider | null => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'fast2sms' || normalized === 'httpsms' || normalized === 'webhook' || normalized === 'textbelt' || normalized === 'none') {
    return normalized;
  }
  return null;
};

const hasUsableFast2SmsConfig = Boolean(FAST2SMS_API_KEY) && !isLikelyPlaceholderValue(FAST2SMS_API_KEY);
const hasUsableHttpSmsConfig = Boolean(HTTPSMS_API_KEY && HTTPSMS_FROM_NUMBER) && !isLikelyPlaceholderValue(HTTPSMS_API_KEY);
const hasUsableSmsWebhookConfig = Boolean(SMS_WEBHOOK_URL) && !isLikelyPlaceholderValue(SMS_WEBHOOK_URL);
const hasUsableTextbeltConfig = Boolean(TEXTBELT_API_KEY) && !isLikelyPlaceholderValue(TEXTBELT_API_KEY);

const configuredSmsProvider = parseSmsProvider(process.env.SMS_PROVIDER);
const SMS_PROVIDER: SmsProvider =
  configuredSmsProvider
  ?? (hasUsableFast2SmsConfig ? 'fast2sms' : hasUsableHttpSmsConfig ? 'httpsms' : hasUsableSmsWebhookConfig ? 'webhook' : hasUsableTextbeltConfig ? 'textbelt' : 'none');
const hasConfiguredFast2SmsKey = hasUsableFast2SmsConfig;
const hasConfiguredHttpSms = hasUsableHttpSmsConfig;
const hasConfiguredSmsWebhook = hasUsableSmsWebhookConfig;
const hasConfiguredTextbelt = hasUsableTextbeltConfig;

const transporter = SMTP_USER && SMTP_PASS
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS
      }
    })
  : null;

if (transporter) {
  transporter.verify(error => {
    if (error) {
      console.error('SMTP Connection Error:', error);
    } else {
      console.log('SMTP server is ready to take messages');
    }
  });
} else {
  console.log('SMTP reminders are disabled. Add SMTP_USER and SMTP_PASS to enable email notifications.');
}

if (SMS_PROVIDER === 'fast2sms') {
  if (!FAST2SMS_API_KEY) {
    console.log('SMS reminders are disabled. Set FAST2SMS_API_KEY or switch SMS_PROVIDER to httpsms, textbelt, or webhook.');
  } else if (!hasConfiguredFast2SmsKey) {
    console.log('SMS reminders are disabled. FAST2SMS_API_KEY still looks like placeholder text, so replace it with your real Fast2SMS authorization key.');
  } else {
    console.log('SMS reminders are enabled through Fast2SMS.');
  }
} else if (SMS_PROVIDER === 'httpsms') {
  if (!HTTPSMS_API_KEY || !HTTPSMS_FROM_NUMBER) {
    console.log('SMS reminders are disabled. Set HTTPSMS_API_KEY and HTTPSMS_FROM_NUMBER to enable httpSMS notifications.');
  } else if (!hasConfiguredHttpSms) {
    console.log('SMS reminders are disabled. HTTPSMS_API_KEY still looks like placeholder text, so replace it with your real httpSMS API key.');
  } else {
    console.log('SMS reminders are enabled through httpSMS.');
  }
} else if (SMS_PROVIDER === 'webhook') {
  if (!SMS_WEBHOOK_URL) {
    console.log('SMS reminders are disabled. Set SMS_WEBHOOK_URL or switch SMS_PROVIDER to httpsms, textbelt, or fast2sms.');
  } else if (!hasConfiguredSmsWebhook) {
    console.log('SMS reminders are disabled. SMS_WEBHOOK_URL still looks like placeholder text, so replace it with your real gateway URL.');
  } else {
    console.log('SMS reminders are enabled through a custom SMS webhook.');
  }
} else if (SMS_PROVIDER === 'textbelt') {
  if (!TEXTBELT_API_KEY) {
    console.log('SMS reminders are disabled. Set TEXTBELT_API_KEY or use the free "textbelt" key while SMS_PROVIDER=textbelt is selected.');
  } else if (!hasConfiguredTextbelt) {
    console.log('SMS reminders are disabled. TEXTBELT_API_KEY still looks like placeholder text, so replace it with your real Textbelt key or use the free "textbelt" key.');
  } else {
    console.log('SMS reminders are enabled through Textbelt.');
  }
} else {
  console.log('SMS reminders are disabled. Set SMS_PROVIDER=httpsms, SMS_PROVIDER=textbelt, SMS_PROVIDER=fast2sms, or SMS_PROVIDER=webhook to enable SMS notifications.');
}

const buildVaccinationReminderMessage = (babyName: string, vaccine: string, date: string) =>
  `ImmuniBaby reminder: ${babyName}'s ${vaccine} vaccination is due on ${date}.`;

const buildTextbeltMessageContent = (message: string, metadata: Record<string, string> = {}) => {
  if (metadata.kind === 'vaccination-reminder' && !/reply stop to opt out\.?$/i.test(message)) {
    return `${message} Reply STOP to opt out.`;
  }
  return message;
};

let smsRuntimeFailureMessage: string | null = null;

const getSmsRuntimeFailureMessage = () => smsRuntimeFailureMessage;

const setSmsRuntimeFailureMessage = (message: string) => {
  if (smsRuntimeFailureMessage === message) return;
  smsRuntimeFailureMessage = message;
  console.error(`SMS provider temporarily disabled: ${message}`);
};

const isSmsProviderConfigured = () => {
  if (SMS_PROVIDER === 'fast2sms') return hasConfiguredFast2SmsKey;
  if (SMS_PROVIDER === 'httpsms') return hasConfiguredHttpSms;
  if (SMS_PROVIDER === 'webhook') return hasConfiguredSmsWebhook;
  if (SMS_PROVIDER === 'textbelt') return hasConfiguredTextbelt;
  return false;
};

const getSmsProviderConfigurationError = () => {
  if (SMS_PROVIDER === 'none') {
    return 'SMS is disabled. Set SMS_PROVIDER to httpsms, textbelt, webhook, or fast2sms.';
  }
  if (SMS_PROVIDER === 'fast2sms' && !FAST2SMS_API_KEY) {
    return 'Fast2SMS is selected, but FAST2SMS_API_KEY is missing.';
  }
  if (SMS_PROVIDER === 'fast2sms' && !hasConfiguredFast2SmsKey) {
    return 'Fast2SMS is selected, but FAST2SMS_API_KEY still looks like placeholder text. Replace it with your real Fast2SMS authorization key.';
  }
  if (SMS_PROVIDER === 'httpsms' && (!HTTPSMS_API_KEY || !HTTPSMS_FROM_NUMBER)) {
    return 'httpSMS is selected, but HTTPSMS_API_KEY or HTTPSMS_FROM_NUMBER is missing.';
  }
  if (SMS_PROVIDER === 'httpsms' && !hasConfiguredHttpSms) {
    return 'httpSMS is selected, but HTTPSMS_API_KEY still looks like placeholder text. Replace it with your real httpSMS API key.';
  }
  if (SMS_PROVIDER === 'webhook' && !SMS_WEBHOOK_URL) {
    return 'Webhook SMS is selected, but SMS_WEBHOOK_URL is missing.';
  }
  if (SMS_PROVIDER === 'webhook' && !hasConfiguredSmsWebhook) {
    return 'Webhook SMS is selected, but SMS_WEBHOOK_URL still looks like placeholder text. Replace it with your real SMS gateway URL.';
  }
  if (SMS_PROVIDER === 'textbelt' && !TEXTBELT_API_KEY) {
    return 'Textbelt is selected, but TEXTBELT_API_KEY is missing. Set it to your real Textbelt key or use the free "textbelt" key.';
  }
  if (SMS_PROVIDER === 'textbelt' && !hasConfiguredTextbelt) {
    return 'Textbelt is selected, but TEXTBELT_API_KEY still looks like placeholder text. Replace it with your real Textbelt key or use the free "textbelt" key.';
  }
  if (smsRuntimeFailureMessage) {
    return smsRuntimeFailureMessage;
  }
  return null;
};

async function sendReminderEmail(to: string, babyName: string, vaccine: string, date: string) {
  if (!to) return console.warn(`No recipient for baby ${babyName}`);
  if (!transporter || !SMTP_USER) return;
  try {
    await transporter.sendMail({
      from: SMTP_USER,
      to,
      subject: 'Vaccination Reminder - ImmuniBaby',
      text: buildVaccinationReminderMessage(babyName, vaccine, date)
    });
    console.log(`Reminder email sent to: ${to}`);
  } catch (err) {
    console.error(`Failed to send email to ${to}:`, err);
  }
}

const toFast2SmsNumber = (value: string | null | undefined) => {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(-10);
  return null;
};

async function sendReminderSms(phoneNumber: string | null | undefined, babyName: string, vaccine: string, date: string) {
  if (!phoneNumber || SMS_PROVIDER === 'none') return;
  return sendSmsMessage(phoneNumber, buildVaccinationReminderMessage(babyName, vaccine, date), {
    kind: 'vaccination-reminder',
    babyName,
    vaccine,
    dueDate: date
  });
}

async function sendSmsMessage(
  phoneNumber: string | null | undefined,
  message: string,
  metadata: Record<string, string> = {}
) {
  if (!phoneNumber || SMS_PROVIDER === 'none') return;
  if (smsRuntimeFailureMessage) {
    throw new Error(smsRuntimeFailureMessage);
  }
  if (SMS_PROVIDER === 'fast2sms') {
    return sendFast2SmsMessage(phoneNumber, message);
  }
  if (SMS_PROVIDER === 'httpsms') {
    return sendHttpSmsMessage(phoneNumber, message);
  }
  if (SMS_PROVIDER === 'webhook') {
    return sendSmsWebhookMessage(phoneNumber, message, metadata);
  }
  if (SMS_PROVIDER === 'textbelt') {
    return sendTextbeltMessage(phoneNumber, message, metadata);
  }
}

async function sendHttpSmsMessage(phoneNumber: string | null | undefined, message: string) {
  if (!phoneNumber || !HTTPSMS_API_KEY || !HTTPSMS_FROM_NUMBER) return;

  try {
    const response = await fetch(`${HTTPSMS_API_BASE_URL.replace(/\/$/, '')}/v1/messages/send`, {
      method: 'POST',
      headers: {
        'x-api-key': HTTPSMS_API_KEY,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: HTTPSMS_FROM_NUMBER,
        to: phoneNumber,
        content: message
      })
    });

    const payload = await response.json().catch(() => null) as
      | { message?: string; status?: string }
      | null;

    if (!response.ok) {
      const fallbackMessage = payload?.message || `HTTP ${response.status}`;
      if (/not authorized to carry out this request/i.test(fallbackMessage)) {
        setSmsRuntimeFailureMessage('httpSMS rejected the request. Make sure HTTPSMS_API_KEY comes from httpsms.com/settings, the phone app is logged in with its phone API key, and HTTPSMS_FROM_NUMBER exactly matches the phone number connected in your httpSMS dashboard.');
      }
      throw new Error(fallbackMessage);
    }

    console.log(`SMS queued through httpSMS for: ${phoneNumber}`);
  } catch (err) {
    console.error(`Failed to send SMS through httpSMS to ${phoneNumber}:`, err);
    throw err;
  }
}

async function sendFast2SmsMessage(phoneNumber: string | null | undefined, message: string) {
  if (!phoneNumber || !FAST2SMS_API_KEY) return;
  const recipient = toFast2SmsNumber(phoneNumber);
  if (!recipient) {
    const error = new Error(`Unsupported phone number format for Fast2SMS: ${phoneNumber}`);
    console.warn(error.message);
    throw error;
  }
  try {
    const response = await fetch('https://www.fast2sms.com/dev/bulkV2', {
      method: 'POST',
      headers: {
        authorization: FAST2SMS_API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
        accept: 'application/json'
      },
      body: new URLSearchParams({
        message,
        language: FAST2SMS_LANGUAGE,
        route: 'q',
        numbers: recipient
      }).toString()
    });

    const payload = await response.json().catch(() => null) as
      | { return?: boolean; message?: string[] | string }
      | null;

    if (!response.ok || payload?.return === false) {
      throw new Error(
        typeof payload?.message === 'string'
          ? payload.message
          : Array.isArray(payload?.message)
            ? payload.message.join(', ')
            : `HTTP ${response.status}`
      );
    }

    console.log(`SMS sent to: ${recipient}`);
  } catch (err) {
    console.error(`Failed to send SMS to ${phoneNumber}:`, err);
    throw err;
  }
}

async function sendSmsWebhookMessage(
  phoneNumber: string | null | undefined,
  message: string,
  metadata: Record<string, string> = {}
) {
  if (!phoneNumber || !SMS_WEBHOOK_URL) return;

  const controller = new AbortController();
  const timeout = Number.isFinite(SMS_WEBHOOK_TIMEOUT_MS) && SMS_WEBHOOK_TIMEOUT_MS > 0
    ? SMS_WEBHOOK_TIMEOUT_MS
    : 10000;
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(SMS_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(SMS_WEBHOOK_SECRET ? { 'x-sms-webhook-secret': SMS_WEBHOOK_SECRET } : {})
      },
      body: JSON.stringify({
        phoneNumber,
        message,
        ...metadata
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(errorBody || `HTTP ${response.status}`);
    }

    console.log(`SMS handed off to webhook for: ${phoneNumber}`);
  } catch (err) {
    console.error(`Failed to hand off SMS to webhook for ${phoneNumber}:`, err);
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function sendTextbeltMessage(
  phoneNumber: string | null | undefined,
  message: string,
  metadata: Record<string, string> = {}
) {
  if (!phoneNumber || !TEXTBELT_API_KEY) return;

  try {
    const response = await fetch('https://textbelt.com/text', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        phone: phoneNumber,
        message: buildTextbeltMessageContent(message, metadata),
        key: TEXTBELT_API_KEY,
        sender: TEXTBELT_SENDER
      })
    });

    const payload = await response.json().catch(() => null) as
      | { success?: boolean; error?: string; textId?: string; quotaRemaining?: number }
      | null;

    if (!response.ok || !payload?.success) {
      const providerError = payload?.error || `HTTP ${response.status}`;
      if (/free sms are disabled for this country/i.test(providerError)) {
        setSmsRuntimeFailureMessage('Textbelt free SMS is blocked for this country. Use a paid Textbelt key or switch SMS_PROVIDER to httpsms, fast2sms, or webhook.');
      }
      throw new Error(providerError);
    }

    console.log(`SMS sent through Textbelt for: ${phoneNumber}${payload.textId ? ` (textId: ${payload.textId})` : ''}`);
  } catch (err) {
    console.error(`Failed to send SMS through Textbelt to ${phoneNumber}:`, err);
    throw err;
  }
}

// ------------------- VACCINATION REMINDERS -------------------
async function checkVaccinationReminders() {
  const today = getTodayDateString();

  const reminders = db.prepare(`
    SELECT v.vaccine_name, v.due_date, u.email, u.phone_number, b.name AS baby_name
    FROM vaccinations v
    JOIN babies b ON v.baby_id = b.id
    JOIN users u ON b.parent_id = u.id
    WHERE v.status = 'Pending' AND v.due_date = ?
  `).all(today);

  if (reminders.length === 0) {
    console.log('No vaccination reminders for today.');
    return;
  }

  await Promise.allSettled(
    reminders.flatMap((reminder: any) => [
      sendReminderEmail(reminder.email, reminder.baby_name, reminder.vaccine_name, reminder.due_date),
      sendReminderSms(reminder.phone_number, reminder.baby_name, reminder.vaccine_name, reminder.due_date)
    ])
  );
}

// ------------------- SMART SCHEDULE RULES (DEMO) -------------------
type VaccineType = 'live' | 'inactivated' | 'other';
type VaccineRule = {
  name: string;
  series: string;
  dose: number;
  min_age_days: number;
  min_gap_days: number;
  type: VaccineType;
  grace_days: number;
};

const LIVE_VACCINE_GAP_DAYS = 28;
const DEFAULT_GRACE_DAYS = 30;

// Demo rules aligned to the current hardcoded schedule. Replace with official guidelines.
const VACCINE_RULES: VaccineRule[] = [
  { name: 'BCG', series: 'BCG', dose: 1, min_age_days: 0, min_gap_days: 0, type: 'live', grace_days: 30 },
  { name: 'Hepatitis B (1st)', series: 'HepB', dose: 1, min_age_days: 0, min_gap_days: 0, type: 'inactivated', grace_days: 30 },
  { name: 'Polio (OPV-0)', series: 'Polio', dose: 0, min_age_days: 0, min_gap_days: 0, type: 'live', grace_days: 30 },
  { name: 'Hepatitis B (2nd)', series: 'HepB', dose: 2, min_age_days: 30, min_gap_days: 30, type: 'inactivated', grace_days: 30 },
  { name: 'DPT (1st)', series: 'DPT', dose: 1, min_age_days: 45, min_gap_days: 0, type: 'inactivated', grace_days: 30 },
  { name: 'Polio (1st)', series: 'Polio', dose: 1, min_age_days: 45, min_gap_days: 45, type: 'live', grace_days: 30 },
  { name: 'DPT (2nd)', series: 'DPT', dose: 2, min_age_days: 75, min_gap_days: 30, type: 'inactivated', grace_days: 30 },
  { name: 'Polio (2nd)', series: 'Polio', dose: 2, min_age_days: 75, min_gap_days: 30, type: 'live', grace_days: 30 },
  { name: 'DPT (3rd)', series: 'DPT', dose: 3, min_age_days: 105, min_gap_days: 30, type: 'inactivated', grace_days: 30 },
  { name: 'Polio (3rd)', series: 'Polio', dose: 3, min_age_days: 105, min_gap_days: 30, type: 'live', grace_days: 30 },
  { name: 'Measles (1st)', series: 'Measles', dose: 1, min_age_days: 270, min_gap_days: 0, type: 'live', grace_days: 30 },
  { name: 'MMR (1st)', series: 'MMR', dose: 1, min_age_days: 450, min_gap_days: 0, type: 'live', grace_days: 30 },
  { name: 'DPT Booster', series: 'DPT', dose: 4, min_age_days: 540, min_gap_days: 435, type: 'inactivated', grace_days: 30 },
  { name: 'Polio Booster', series: 'Polio', dose: 4, min_age_days: 540, min_gap_days: 435, type: 'live', grace_days: 30 }
];

const RULES_BY_NAME = new Map(VACCINE_RULES.map(rule => [rule.name, rule]));

const VACCINATION_SCHEDULE = [
  { name: 'BCG', age: 0 }, { name: 'Hepatitis B (1st)', age: 0 }, { name: 'Polio (OPV-0)', age: 0 },
  { name: 'Hepatitis B (2nd)', age: 1 }, { name: 'DPT (1st)', age: 1.5 }, { name: 'Polio (1st)', age: 1.5 },
  { name: 'DPT (2nd)', age: 2.5 }, { name: 'Polio (2nd)', age: 2.5 }, { name: 'DPT (3rd)', age: 3.5 },
  { name: 'Polio (3rd)', age: 3.5 }, { name: 'Measles (1st)', age: 9 }, { name: 'MMR (1st)', age: 15 },
  { name: 'DPT Booster', age: 18 }, { name: 'Polio Booster', age: 18 }
];

const parseDate = (value: string | null | undefined) => {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  date.setHours(0, 0, 0, 0);
  if (
    date.getFullYear() !== Number(year) ||
    date.getMonth() !== Number(month) - 1 ||
    date.getDate() !== Number(day)
  ) {
    return null;
  }
  return Number.isNaN(date.getTime()) ? null : date;
};

const formatDate = (date: Date) => formatCalendarDate(date);

const addDays = (date: Date, days: number) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

const maxDate = (a: Date, b: Date) => (a > b ? a : b);

const buildVaccinationSchedule = (dob: string) => {
  const birthDate = parseDate(dob);
  if (!birthDate) return null;
  return VACCINATION_SCHEDULE.map(vaccine => {
    const dueDate = new Date(birthDate);
    if (vaccine.age > 0) {
      dueDate.setMonth(dueDate.getMonth() + Math.floor(vaccine.age));
      dueDate.setDate(dueDate.getDate() + Math.floor((vaccine.age % 1) * 30));
    }
    return { name: vaccine.name, due_date: formatDate(dueDate) };
  });
};

const syncVaccinationDatesToBabyDob = () => {
  withDbRetry('Vaccination due date sync', () => {
    const babies = db.prepare('SELECT id, dob FROM babies').all() as Array<{ id: number; dob: string }>;
    const getDueDate = db.prepare('SELECT due_date FROM vaccinations WHERE baby_id = ? AND vaccine_name = ?');
    const updateDueDate = db.prepare('UPDATE vaccinations SET due_date = ? WHERE baby_id = ? AND vaccine_name = ?');

    let updatedCount = 0;

    const sync = db.transaction(() => {
      babies.forEach(baby => {
        const schedule = buildVaccinationSchedule(baby.dob);
        if (!schedule) return;

        schedule.forEach(vaccine => {
          const existing = getDueDate.get(baby.id, vaccine.name) as { due_date?: string } | undefined;
          if (!existing || existing.due_date === vaccine.due_date) return;
          updateDueDate.run(vaccine.due_date, baby.id, vaccine.name);
          updatedCount += 1;
        });
      });
    });

    sync();

    if (updatedCount > 0) {
      console.log(`Corrected ${updatedCount} vaccination due date(s) after timezone-safe date recalculation.`);
    }
  });
};

syncVaccinationDatesToBabyDob();

// ------------------- AUTH HELPERS -------------------
const toPublicUser = (user: { id: number; name: string; email: string; phone_number?: string | null }) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  phone_number: user.phone_number ?? null
});

const signUserToken = (user: { id: number; name: string; email: string; phone_number?: string | null }) =>
  jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '1d' });

// ------------------- SERVER -------------------
async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));

  // ------------------- AUTH MIDDLEWARE -------------------
  const authenticateToken = (req: any, res: any, next: any) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
      if (err) return res.sendStatus(403);
      req.user = user;
      next();
    });
  };

  // ------------------- AUTH ROUTES -------------------
  const handleSignup = async (req: any, res: any) => {
    const { name, email, password, phoneNumber, phone_number } = req.body ?? {};
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const normalizedName = typeof name === 'string' ? name.trim() : '';
    const normalizedPhoneNumber = normalizePhoneNumber(phoneNumber ?? phone_number);
    if (!normalizedName || !normalizedEmail || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }
    if (normalizedPhoneNumber === undefined) {
      return res.status(400).json({ error: 'Phone number must include country code, for example +919876543210' });
    }

    const hashed = await bcrypt.hash(password, 10);
    try {
      const info = db
        .prepare('INSERT INTO users (name, email, password, phone_number) VALUES (?, ?, ?, ?)')
        .run(normalizedName, normalizedEmail, hashed, normalizedPhoneNumber);
      const user = toPublicUser({
        id: Number(info.lastInsertRowid),
        name: normalizedName,
        email: normalizedEmail,
        phone_number: normalizedPhoneNumber
      });
      const token = signUserToken(user);
      res.json({ token, user });
    } catch (err: any) {
      const isDuplicate = err?.code === 'SQLITE_CONSTRAINT_UNIQUE';
      res.status(400).json({ error: isDuplicate ? 'Email already exists' : 'Failed to create account' });
    }
  };

  const handleLogin = async (req: any, res: any) => {
    const { email, password } = req.body ?? {};
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!normalizedEmail || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const publicUser = toPublicUser({ id: user.id, name: user.name, email: user.email, phone_number: user.phone_number });
    const token = signUserToken(publicUser);
    res.json({ token, user: publicUser });
  };

  app.post('/api/auth/signup', handleSignup);
  app.post('/api/auth/login', handleLogin);

  // Backward-compatible routes
  app.post('/api/signup', handleSignup);
  app.post('/api/login', handleLogin);

  app.patch('/api/me', authenticateToken, (req: any, res) => {
    const normalizedPhoneNumber = normalizePhoneNumber(req.body?.phoneNumber ?? req.body?.phone_number);
    if (normalizedPhoneNumber === undefined) {
      return res.status(400).json({ error: 'Phone number must include country code, for example +919876543210' });
    }

    db.prepare('UPDATE users SET phone_number = ? WHERE id = ?').run(normalizedPhoneNumber, req.user.id);
    const user = db.prepare('SELECT id, name, email, phone_number FROM users WHERE id = ?').get(req.user.id) as any;
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({ user: toPublicUser(user) });
  });

  // ------------------- BABY ROUTES -------------------
  app.get('/api/babies', authenticateToken, (req: any, res) => {
    const babies = db.prepare('SELECT * FROM babies WHERE parent_id = ?').all(req.user.id);
    res.json(babies);
  });

  app.post('/api/babies', authenticateToken, (req: any, res) => {
    const { name, dob, notes, photoUrl, photo_url, sex } = req.body ?? {};
    const normalizedSex = sex === 'female' || sex === 'male' ? sex : null;
    if (!normalizedSex) {
      return res.status(400).json({ error: 'Sex is required (male or female).' });
    }
    const photoValue = typeof photoUrl === 'string' && photoUrl.trim()
      ? photoUrl.trim()
      : (typeof photo_url === 'string' && photo_url.trim() ? photo_url.trim() : null);
    const info = db
      .prepare('INSERT INTO babies (name, dob, sex, parent_id, notes, photo_url) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, dob, normalizedSex, req.user.id, notes ?? null, photoValue);
    const babyId = info.lastInsertRowid;

    // ------------------- VACCINATION SCHEDULE -------------------
    const schedule = buildVaccinationSchedule(dob);
    if (!schedule) {
      return res.status(400).json({ error: 'Invalid baby DOB' });
    }

    const insertVaccine = db.prepare('INSERT INTO vaccinations (baby_id, vaccine_name, due_date) VALUES (?, ?, ?)');
    schedule.forEach(v => {
      insertVaccine.run(babyId, v.name, v.due_date);
    });

    res.json({ id: babyId, name, dob, sex: normalizedSex, notes: notes ?? null, photo_url: photoValue });
  });

  app.patch('/api/babies/:id', authenticateToken, (req: any, res) => {
    const babyId = Number(req.params.id);
    if (!Number.isFinite(babyId)) return res.status(400).json({ error: 'Invalid baby id' });

    const { photoUrl, photo_url, sex, name, dob, notes } = req.body ?? {};
    if (photoUrl === undefined && photo_url === undefined && sex === undefined && name === undefined && dob === undefined && notes === undefined) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const updates: string[] = [];
    const params: any[] = [];
    let photoValue: string | null | undefined;
    let normalizedSex: string | null | undefined;
    let normalizedName: string | undefined;
    let normalizedDob: string | undefined;
    let normalizedNotes: string | null | undefined;

    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'Name is required' });
      }
      normalizedName = name.trim();
      updates.push('name = ?');
      params.push(normalizedName);
    }

    if (dob !== undefined) {
      if (typeof dob !== 'string' || !parseDate(dob)) {
        return res.status(400).json({ error: 'Invalid baby DOB' });
      }
      normalizedDob = dob;
      updates.push('dob = ?');
      params.push(normalizedDob);
    }

    if (notes !== undefined) {
      if (notes === null) {
        normalizedNotes = null;
      } else if (typeof notes === 'string') {
        normalizedNotes = notes.trim() ? notes.trim() : null;
      } else {
        return res.status(400).json({ error: 'Notes must be text' });
      }
      updates.push('notes = ?');
      params.push(normalizedNotes);
    }

    if (photoUrl !== undefined || photo_url !== undefined) {
      photoValue = typeof photoUrl === 'string' && photoUrl.trim()
        ? photoUrl.trim()
        : (typeof photo_url === 'string' && photo_url.trim() ? photo_url.trim() : null);
      updates.push('photo_url = ?');
      params.push(photoValue);
    }

    if (sex !== undefined) {
      normalizedSex = sex === 'female' || sex === 'male' ? sex : null;
      if (!normalizedSex) {
        return res.status(400).json({ error: 'Sex must be male or female' });
      }
      updates.push('sex = ?');
      params.push(normalizedSex);
    }

    const ownsBaby = db.prepare('SELECT 1 FROM babies WHERE id = ? AND parent_id = ?').get(babyId, req.user.id);
    if (!ownsBaby) return res.status(404).json({ error: 'Baby not found' });

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const applyUpdate = db.transaction(() => {
      db.prepare(`UPDATE babies SET ${updates.join(', ')} WHERE id = ?`).run(...params, babyId);
      if (normalizedDob) {
        const schedule = buildVaccinationSchedule(normalizedDob);
        if (!schedule) throw new Error('Invalid baby DOB');
        const updateVaccine = db.prepare('UPDATE vaccinations SET due_date = ? WHERE baby_id = ? AND vaccine_name = ?');
        schedule.forEach(v => updateVaccine.run(v.due_date, babyId, v.name));
      }
    });

    try {
      applyUpdate();
    } catch (err) {
      return res.status(400).json({ error: 'Invalid baby DOB' });
    }

    res.json({
      success: true,
      ...(normalizedName !== undefined ? { name: normalizedName } : {}),
      ...(normalizedDob !== undefined ? { dob: normalizedDob } : {}),
      ...(notes !== undefined ? { notes: normalizedNotes } : {}),
      ...(photoValue !== undefined ? { photo_url: photoValue } : {}),
      ...(normalizedSex ? { sex: normalizedSex } : {})
    });
  });

  app.delete('/api/babies/:id', authenticateToken, (req: any, res) => {
    const babyId = Number(req.params.id);
    if (!Number.isFinite(babyId)) return res.status(400).json({ error: 'Invalid baby id' });

    const ownsBaby = db.prepare('SELECT 1 FROM babies WHERE id = ? AND parent_id = ?').get(babyId, req.user.id);
    if (!ownsBaby) return res.status(404).json({ error: 'Baby not found' });

    const deleteBaby = db.transaction((id: number) => {
      db.prepare('DELETE FROM vaccinations WHERE baby_id = ?').run(id);
      db.prepare('DELETE FROM growth_records WHERE baby_id = ?').run(id);
      db.prepare('DELETE FROM milestones WHERE baby_id = ?').run(id);
      db.prepare('DELETE FROM appointments WHERE baby_id = ?').run(id);
      db.prepare('DELETE FROM babies WHERE id = ?').run(id);
    });

    deleteBaby(babyId);
    res.json({ success: true });
  });

  app.get('/api/vaccinations/:babyId', authenticateToken, (req, res) => {
    const vaccines = db.prepare(`
      SELECT * FROM vaccinations
      WHERE baby_id = ?
      ORDER BY
        CASE status WHEN 'Pending' THEN 0 ELSE 1 END,
        due_date ASC
    `).all(req.params.babyId);
    res.json(vaccines);
  });

  app.patch('/api/vaccinations/:id', authenticateToken, (req, res) => {
    const { status } = req.body;
    const normalizedStatus = status === 'Completed' ? 'Completed' : 'Pending';
    const completedDate = normalizedStatus === 'Completed' ? getTodayDateString() : null;
    db.prepare('UPDATE vaccinations SET status = ?, completed_date = ? WHERE id = ?')
      .run(normalizedStatus, completedDate, req.params.id);
    res.json({ success: true });
  });

  // ------------------- REMINDERS + DASHBOARD SUMMARY -------------------
  app.get('/api/reminders', authenticateToken, (req, res) => {
    const type = typeof req.query.type === 'string' ? req.query.type : 'upcoming';
    const todayStr = getTodayDateString();

    let whereClause = "v.status = 'Pending'";
    const params: any[] = [req.user.id];

    if (type === 'overdue') {
      whereClause += ' AND v.due_date < ?';
      params.push(todayStr);
    } else if (type === 'upcoming') {
      whereClause += ' AND v.due_date >= ?';
      params.push(todayStr);
    }

    const reminders = db.prepare(`
      SELECT v.id, v.baby_id, v.vaccine_name, v.due_date, v.status, b.name AS baby_name
      FROM vaccinations v
      JOIN babies b ON v.baby_id = b.id
      WHERE b.parent_id = ? AND ${whereClause}
      ORDER BY v.due_date ASC
    `).all(...params);

    res.json(reminders);
  });

  app.get('/api/dashboard/summary', authenticateToken, (req, res) => {
    const todayStr = getTodayDateString();
    const summary = db.prepare(`
      SELECT
        SUM(CASE WHEN v.status = 'Completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN v.status = 'Pending' AND v.due_date >= ? THEN 1 ELSE 0 END) AS upcoming,
        SUM(CASE WHEN v.status = 'Pending' AND v.due_date < ? THEN 1 ELSE 0 END) AS overdue
      FROM vaccinations v
      JOIN babies b ON v.baby_id = b.id
      WHERE b.parent_id = ?
    `).get(todayStr, todayStr, req.user.id) as any;

    res.json({
      completed: summary?.completed ?? 0,
      upcoming: summary?.upcoming ?? 0,
      overdue: summary?.overdue ?? 0
    });
  });

  // ------------------- SMART SCHEDULE -------------------
  app.get('/api/smart-schedule/:babyId', authenticateToken, (req, res) => {
    const babyId = Number(req.params.babyId);
    if (!Number.isFinite(babyId)) return res.status(400).json({ error: 'Invalid baby id' });

    const baby = db.prepare('SELECT * FROM babies WHERE id = ? AND parent_id = ?').get(babyId, req.user.id);
    if (!baby) return res.status(404).json({ error: 'Baby not found' });

    const dobDate = parseDate(baby.dob);
    if (!dobDate) return res.status(400).json({ error: 'Invalid baby DOB' });

    const vaccinations = db.prepare('SELECT * FROM vaccinations WHERE baby_id = ?').all(babyId);
    const todayStr = getTodayDateString();
    const today = parseDate(todayStr)!;

    const lastCompletedBySeries = new Map<string, Date>();
    let lastLiveCompleted: Date | null = null;

    vaccinations
      .filter((v: any) => v.status === 'Completed')
      .forEach((v: any) => {
        const completedAt = parseDate(v.completed_date || v.due_date);
        if (!completedAt) return;

        const rule = RULES_BY_NAME.get(v.vaccine_name);
        if (!rule) return;

        const existingSeriesDate = lastCompletedBySeries.get(rule.series);
        if (!existingSeriesDate || completedAt > existingSeriesDate) {
          lastCompletedBySeries.set(rule.series, completedAt);
        }

        if (rule.type === 'live') {
          if (!lastLiveCompleted || completedAt > lastLiveCompleted) {
            lastLiveCompleted = completedAt;
          }
        }
      });

    const plan = vaccinations
      .filter((v: any) => v.status === 'Pending')
      .map((v: any) => {
        const rule = RULES_BY_NAME.get(v.vaccine_name);
        const dueDate = parseDate(v.due_date) ?? today;
        let earliest = dueDate;

        if (rule) {
          const minAgeDate = addDays(dobDate, rule.min_age_days);
          earliest = maxDate(earliest, minAgeDate);

          const lastSeriesDate = lastCompletedBySeries.get(rule.series);
          if (lastSeriesDate) {
            earliest = maxDate(earliest, addDays(lastSeriesDate, rule.min_gap_days));
          }

          if (rule.type === 'live' && lastLiveCompleted) {
            earliest = maxDate(earliest, addDays(lastLiveCompleted, LIVE_VACCINE_GAP_DAYS));
          }
        }

        const recommended = maxDate(earliest, today);
        const latest = addDays(recommended, rule?.grace_days ?? DEFAULT_GRACE_DAYS);
        const overdue = typeof v.due_date === 'string' ? v.due_date < todayStr : dueDate < today;

        return {
          id: v.id,
          vaccine_name: v.vaccine_name,
          due_date: v.due_date,
          status: v.status,
          earliest_date: formatDate(earliest),
          recommended_date: formatDate(recommended),
          latest_date: formatDate(latest),
          overdue,
          reason: overdue ? 'Overdue - catch-up window recalculated' : 'On schedule'
        };
      })
      .sort((a: any, b: any) => (a.recommended_date > b.recommended_date ? 1 : -1));

    res.json(plan);
  });

  // ------------------- GROWTH ROUTES -------------------
  app.get('/api/growth/:babyId', authenticateToken, (req, res) => {
    const babyId = Number(req.params.babyId);
    if (!Number.isFinite(babyId)) return res.status(400).json({ error: 'Invalid baby id' });

    const ownsBaby = db.prepare('SELECT 1 FROM babies WHERE id = ? AND parent_id = ?').get(babyId, req.user.id);
    if (!ownsBaby) return res.status(404).json({ error: 'Baby not found' });

    const records = db
      .prepare('SELECT * FROM growth_records WHERE baby_id = ? ORDER BY date DESC, id DESC')
      .all(babyId);
    res.json(records);
  });

  app.post('/api/growth', authenticateToken, (req, res) => {
    const { babyId, date, weight, height, headCircumference, head_circumference } = req.body ?? {};
    const babyIdNum = Number(babyId);
    if (!Number.isFinite(babyIdNum)) return res.status(400).json({ error: 'Valid babyId is required' });

    const dateStr = typeof date === 'string' ? date.trim() : '';
    const weightNum = typeof weight === 'number' ? weight : Number(weight);
    const heightNum = typeof height === 'number' ? height : Number(height);
    const headValue = headCircumference ?? head_circumference;
    const headNum = headValue === undefined || headValue === null || headValue === '' ? null : Number(headValue);

    if (!dateStr || !Number.isFinite(weightNum) || !Number.isFinite(heightNum)) {
      return res.status(400).json({ error: 'Date, weight, and height are required' });
    }
    if (headNum !== null && !Number.isFinite(headNum)) {
      return res.status(400).json({ error: 'Head circumference must be a number' });
    }

    const ownsBaby = db.prepare('SELECT 1 FROM babies WHERE id = ? AND parent_id = ?').get(babyIdNum, req.user.id);
    if (!ownsBaby) return res.status(404).json({ error: 'Baby not found' });

    const info = db
      .prepare('INSERT INTO growth_records (baby_id, date, weight, height, head_circumference) VALUES (?, ?, ?, ?, ?)')
      .run(babyIdNum, dateStr, weightNum, heightNum, headNum);

    res.json({
      id: Number(info.lastInsertRowid),
      baby_id: babyIdNum,
      date: dateStr,
      weight: weightNum,
      height: heightNum,
      head_circumference: headNum
    });
  });

  app.delete('/api/growth/:id', authenticateToken, (req, res) => {
    const recordId = Number(req.params.id);
    if (!Number.isFinite(recordId)) return res.status(400).json({ error: 'Invalid record id' });

    const ownsRecord = db.prepare(`
      SELECT gr.id
      FROM growth_records gr
      JOIN babies b ON gr.baby_id = b.id
      WHERE gr.id = ? AND b.parent_id = ?
    `).get(recordId, req.user.id);
    if (!ownsRecord) return res.status(404).json({ error: 'Record not found' });

    db.prepare('DELETE FROM growth_records WHERE id = ?').run(recordId);
    res.json({ success: true });
  });

  // ------------------- MILESTONE ROUTES -------------------
  app.get('/api/milestones/:babyId', authenticateToken, (req, res) => {
    const babyId = Number(req.params.babyId);
    if (!Number.isFinite(babyId)) return res.status(400).json({ error: 'Invalid baby id' });

    const ownsBaby = db.prepare('SELECT 1 FROM babies WHERE id = ? AND parent_id = ?').get(babyId, req.user.id);
    if (!ownsBaby) return res.status(404).json({ error: 'Baby not found' });

    const milestones = db
      .prepare('SELECT * FROM milestones WHERE baby_id = ? ORDER BY achieved DESC, date DESC, id DESC')
      .all(babyId);
    res.json(milestones);
  });

  app.post('/api/milestones', authenticateToken, (req, res) => {
    const { babyId, title, category, date, achieved } = req.body ?? {};
    const babyIdNum = Number(babyId);
    if (!Number.isFinite(babyIdNum)) return res.status(400).json({ error: 'Valid babyId is required' });

    const titleStr = typeof title === 'string' ? title.trim() : '';
    const categoryStr = typeof category === 'string' ? category.trim() : '';
    const dateStr = typeof date === 'string' && date.trim() ? date.trim() : null;
    const achievedVal = typeof achieved === 'number' ? (achieved ? 1 : 0) : achieved ? 1 : 0;

    if (!titleStr || !categoryStr) {
      return res.status(400).json({ error: 'Title and category are required' });
    }

    const ownsBaby = db.prepare('SELECT 1 FROM babies WHERE id = ? AND parent_id = ?').get(babyIdNum, req.user.id);
    if (!ownsBaby) return res.status(404).json({ error: 'Baby not found' });

    const info = db
      .prepare('INSERT INTO milestones (baby_id, title, date, category, achieved) VALUES (?, ?, ?, ?, ?)')
      .run(babyIdNum, titleStr, dateStr, categoryStr, achievedVal);

    res.json({
      id: Number(info.lastInsertRowid),
      baby_id: babyIdNum,
      title: titleStr,
      date: dateStr,
      category: categoryStr,
      achieved: achievedVal
    });
  });

  app.patch('/api/milestones/:id', authenticateToken, (req, res) => {
    const milestoneId = Number(req.params.id);
    if (!Number.isFinite(milestoneId)) return res.status(400).json({ error: 'Invalid milestone id' });

    const { achieved, date } = req.body ?? {};
    const achievedVal = typeof achieved === 'number' ? (achieved ? 1 : 0) : achieved ? 1 : 0;
    const dateStr = typeof date === 'string' && date.trim() ? date.trim() : null;

    const ownsMilestone = db.prepare(`
      SELECT m.id
      FROM milestones m
      JOIN babies b ON m.baby_id = b.id
      WHERE m.id = ? AND b.parent_id = ?
    `).get(milestoneId, req.user.id);
    if (!ownsMilestone) return res.status(404).json({ error: 'Milestone not found' });

    db.prepare('UPDATE milestones SET achieved = ?, date = ? WHERE id = ?').run(achievedVal, dateStr, milestoneId);
    res.json({ success: true });
  });

  // ------------------- APPOINTMENT ROUTES -------------------
  app.get('/api/appointments/:babyId', authenticateToken, (req, res) => {
    const babyId = Number(req.params.babyId);
    if (!Number.isFinite(babyId)) return res.status(400).json({ error: 'Invalid baby id' });

    const ownsBaby = db.prepare('SELECT 1 FROM babies WHERE id = ? AND parent_id = ?').get(babyId, req.user.id);
    if (!ownsBaby) return res.status(404).json({ error: 'Baby not found' });

    const appointments = db
      .prepare('SELECT * FROM appointments WHERE baby_id = ? ORDER BY date DESC, id DESC')
      .all(babyId);
    res.json(appointments);
  });

  app.post('/api/appointments', authenticateToken, (req, res) => {
    const { babyId, doctorName, date, purpose } = req.body ?? {};
    const babyIdNum = Number(babyId);
    if (!Number.isFinite(babyIdNum)) return res.status(400).json({ error: 'Valid babyId is required' });

    const doctorNameStr = typeof doctorName === 'string' ? doctorName.trim() : '';
    const dateStr = typeof date === 'string' ? date.trim() : '';
    const purposeStr = typeof purpose === 'string' ? purpose.trim() : '';

    if (!doctorNameStr || !dateStr || !purposeStr) {
      return res.status(400).json({ error: 'Doctor name, date, and purpose are required' });
    }

    const ownsBaby = db.prepare('SELECT 1 FROM babies WHERE id = ? AND parent_id = ?').get(babyIdNum, req.user.id);
    if (!ownsBaby) return res.status(404).json({ error: 'Baby not found' });

    const info = db
      .prepare('INSERT INTO appointments (baby_id, doctor_name, date, purpose, status) VALUES (?, ?, ?, ?, ?)')
      .run(babyIdNum, doctorNameStr, dateStr, purposeStr, 'Scheduled');

    res.json({
      id: Number(info.lastInsertRowid),
      baby_id: babyIdNum,
      doctor_name: doctorNameStr,
      date: dateStr,
      purpose: purposeStr,
      status: 'Scheduled'
    });
  });

  app.patch('/api/appointments/:id', authenticateToken, (req, res) => {
    const appointmentId = Number(req.params.id);
    if (!Number.isFinite(appointmentId)) return res.status(400).json({ error: 'Invalid appointment id' });

    const { status } = req.body ?? {};
    const allowedStatuses = new Set(['Scheduled', 'Completed', 'Cancelled']);
    if (!allowedStatuses.has(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const ownsAppointment = db.prepare(`
      SELECT a.id
      FROM appointments a
      JOIN babies b ON a.baby_id = b.id
      WHERE a.id = ? AND b.parent_id = ?
    `).get(appointmentId, req.user.id);
    if (!ownsAppointment) return res.status(404).json({ error: 'Appointment not found' });

    db.prepare('UPDATE appointments SET status = ? WHERE id = ?').run(status, appointmentId);
    res.json({ success: true });
  });

  // ------------------- CRON JOB -------------------
  cron.schedule(REMINDER_CRON, () => {
    console.log('Running daily vaccination reminder check...');
    void checkVaccinationReminders().catch(err => {
      console.error('Failed to run scheduled vaccination reminders:', err);
    });
  }, {
    timezone: REMINDER_TIMEZONE
  });

  // Run once at startup
  void checkVaccinationReminders().catch(err => {
    console.error('Failed to run startup vaccination reminders:', err);
  });

  // ------------------- START SERVER -------------------
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  app.listen(PORT, '0.0.0.0', () => console.log(`Server running on http://localhost:${PORT}`));
}

startServer().catch(err => console.error('Failed to start server:', err));
