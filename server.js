require('dotenv').config();

const express = require('express');
const webpush = require('web-push');
const cron = require('node-cron');

if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
  throw new Error('Missing VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY in .env');
}

webpush.setVapidDetails(
  'mailto:you@example.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const app = express();
app.use(express.json());

// Allow local development servers to access the reminder API.
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const isLocalOrigin =
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

  if (isLocalOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// In-memory storage: data is lost when this server restarts.
const devices = new Map();

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'MSpace reminders' });
});

app.post('/subscribe', (req, res) => {
  const { deviceId, endpoint, keys } = req.body;

  if (!deviceId || !endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'Invalid push subscription.' });
  }

  const existing = devices.get(deviceId) || { sent: new Set() };

  devices.set(deviceId, {
    ...existing,
    sub: { endpoint, keys }
  });

  res.sendStatus(201);
});

app.post('/reminders', (req, res) => {
  const { device, timezone, meds, events } = req.body;

  if (!device || !timezone || !Array.isArray(meds) ||
      !Array.isArray(events)) {
    return res.status(400).json({ error: 'Invalid reminder data.' });
  }

  try {
    // Validate the timezone.
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    return res.status(400).json({ error: 'Invalid timezone.' });
  }

  const existing = devices.get(device) || { sent: new Set() };

  devices.set(device, {
    ...existing,
    timezone,
    meds,
    events
  });

  res.sendStatus(200);
});

function getLocalParts(timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short'
  }).formatToParts(new Date());

  const value = Object.fromEntries(
    parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value])
  );

  const weekdayNumbers = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3,
    Thu: 4, Fri: 5, Sat: 6
  };

  return {
    date: `${value.year}-${value.month}-${value.day}`,
    time: `${value.hour}:${value.minute}`,
    weekday: weekdayNumbers[value.weekday]
  };
}

async function sendPush(dev, payload) {
  try {
    await webpush.sendNotification(
      dev.sub,
      JSON.stringify(payload)
    );
  } catch (err) {
    console.error('Push failed:', err.statusCode || err.message);

    if (err.statusCode === 404 || err.statusCode === 410) {
      // Subscription expired or was removed.
      for (const [id, saved] of devices) {
        if (saved.sub?.endpoint === dev.sub.endpoint) {
          devices.delete(id);
        }
      }
    }
  }
}

cron.schedule('* * * * *', async () => {
  for (const dev of devices.values()) {
    if (!dev.sub || !dev.timezone) continue;

    const now = getLocalParts(dev.timezone);

    // Medication reminders
    for (const med of dev.meds || []) {
      if (med.schedule === 'Weekly' &&
          Number(med.weekday) !== now.weekday) {
        continue;
      }

      const times = Array.isArray(med.times) ? med.times : [];

      for (const time of times) {
        if (!time || time !== now.time) continue;

        const tag = `med_${med.id}_${now.date}_${time}`;
        if (dev.sent.has(tag)) continue;

        dev.sent.add(tag);

        await sendPush(dev, {
          title: `💊 ${med.name}`,
          body: `Scheduled dose: ${med.dose || 'as prescribed'} — ${time}`,
          tag
        });
      }
    }

    // Calendar and appointment reminders
    for (const event of dev.events || []) {
      if (event.date !== now.date || event.time !== now.time) continue;

      const tag = `evt_${event.id}_${event.date}_${event.time}`;
      if (dev.sent.has(tag)) continue;

      dev.sent.add(tag);

      await sendPush(dev, {
        title: `📅 ${event.title || 'Appointment'}`,
        body: `${event.type || 'Event'} at ${event.time}`,
        tag
      });
    }

    // Keep the in-memory deduplication set from growing indefinitely.
    if (dev.sent.size > 5000) dev.sent.clear();
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, '0.0.0.0', () => {
  console.log(`MSpace reminder server running on port ${port}`);
});