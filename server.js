require("dotenv").config();
const fastify = require("fastify")({ logger: true });
const { Pool } = require("pg");
const { v4: uuidv4 } = require("uuid");
const webpush = require("web-push");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Razorpay = require("razorpay");

// 🔐 CONFIG
const ADMIN_TOKEN = "CHANGE_THIS_SECRET";

// VAPID Keys (Generated)
const VAPID_KEYS = {
  publicKey: "BBa2SEf1E3XMUsI-rLfJb2nMc5Eaexl_1kbwGCucAiWPaXW06EuZanI1vd2T9K8C9UCWNUB4eyKCpOIicFn54Lw",
  privateKey: "br5x7Mlk4OMUAy9q_Wd3IKJwLcVlgkBuGhG6WS_y1_E"
};

webpush.setVapidDetails(
  "mailto:vimalraj5207@gmail.com",
  VAPID_KEYS.publicKey,
  VAPID_KEYS.privateKey
);

// 🟢 Neon DB connection
const pool = new Pool({
  connectionString: "postgresql://neondb_owner:npg_BuXVce8lpZ5f@ep-bold-mud-adftauh5-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=verify-full&uselibpqcompat=true",
  ssl: { rejectUnauthorized: false },
  max: 10
});

// 💳 Razorpay instance
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ✅ CORS
fastify.register(require("@fastify/cors"), {
  origin: "*"
});

/* ---------------- DB INIT ---------------- */

async function dbInit() {
  const client = await pool.connect();
  try {
    // 0. Enable UUID extension
    await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

    // 1. Create tables with native UUID generation and strict types
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        phone TEXT UNIQUE NOT NULL,
        email TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS appointments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        age TEXT,
        appointment_date DATE NOT NULL,
        appointment_time TIME NOT NULL,
        service TEXT DEFAULT 'General Consultation',
        amount INT NOT NULL DEFAULT 10000,
        payment_status TEXT DEFAULT 'INITIATED',
        razorpay_order_id TEXT,
        razorpay_payment_id TEXT,
        status TEXT DEFAULT 'PENDING',
        token TEXT,
        message TEXT,
        consultation_notes TEXT,
        vitals JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        appointment_id UUID REFERENCES appointments(id) ON DELETE CASCADE,
        razorpay_order_id TEXT,
        razorpay_payment_id TEXT,
        amount INT NOT NULL,
        status TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS time_slots (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slot_date DATE NOT NULL,
        slot_time TIME NOT NULL,
        is_booked BOOLEAN DEFAULT FALSE,
        UNIQUE(slot_date, slot_time)
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // 2. Indexes for performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
      CREATE INDEX IF NOT EXISTS idx_appointments_lookup ON appointments(phone, appointment_date, appointment_time);
      CREATE INDEX IF NOT EXISTS idx_order_id ON appointments(razorpay_order_id);
    `);

    // 3. Automated Update Timestamp Trigger
    await client.query(`
      CREATE OR REPLACE FUNCTION update_timestamp()
      RETURNS TRIGGER AS $$
      BEGIN
         NEW.updated_at = CURRENT_TIMESTAMP;
         RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DO $$ 
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_appointments_timestamp') THEN
          CREATE TRIGGER update_appointments_timestamp
          BEFORE UPDATE ON appointments
          FOR EACH ROW
          EXECUTE FUNCTION update_timestamp();
        END IF;
      END $$;
    `);

    // 4. Migration: Ensure columns match requested schema (for already existing tables)
    const columnsToAdd = [
      ["email", "TEXT"],
      ["appointment_date", "DATE"],
      ["appointment_time", "TIME"],
      ["service", "TEXT DEFAULT 'General Consultation'"],
      ["amount", "INT DEFAULT 10000"],
      ["payment_status", "TEXT DEFAULT 'INITIATED'"],
      ["razorpay_order_id", "TEXT"],
      ["razorpay_payment_id", "TEXT"],
      ["status", "TEXT DEFAULT 'PENDING'"],
      ["cancel_reason", "TEXT"], // preserved from previous code for safety
      ["suggestion", "TEXT"],    // preserved from previous code for safety
      ["token", "TEXT"],
      ["message", "TEXT"],
      ["consultation_notes", "TEXT"],
      ["vitals", "JSONB DEFAULT '{}'"],
      ["updated_at", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"]
    ];

    for (const [colName, colType] of columnsToAdd) {
      try {
        await client.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS ${colName} ${colType}`);
      } catch (e) {
        // Log skip for type conflicts if needed
      }
    }

    console.log("✅ Database schema synchronized with Master Blueprint");
  } catch (err) {
    console.error("❌ Database schema sync failed:", err);
  } finally {
    client.release();
  }
}

/* ---------------- HELPERS ---------------- */

function validate(fields, body) {
  for (let f of fields) {
    if (!body[f]) return `Missing field: ${f}`;
  }
  return null;
}

function isValidTimeSlot(date, time) {
  const hour = parseInt(time.split(":")[0]);
  if (hour < 9 || hour > 18) return false;

  const today = new Date();
  const selected = new Date(date);

  if (selected < new Date(today.toDateString())) return false;

  return true;
}

function t12(time) {
  if (!time) return "";
  if (time.includes("AM") || time.includes("PM")) return time; // Already 12h
  let [h, m] = time.split(":");
  let suffix = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${suffix}`;
}

function generateSequenceToken(dateStr, count) {
  // expects dateStr in YYYY-MM-DD
  const [y, m, d] = dateStr.split('-');
  const months = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
  const monthName = months[parseInt(m) - 1];
  const yearShort = y.slice(-2);
  return `${monthName}-${d}-${yearShort}-#${count + 1}`;
}

/* ---------------- ROUTES ---------------- */

// Serve Admin Panel (Resolves file:// CORS issues)
fastify.get("/admin", async (req, reply) => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
  reply.type('text/html').send(html);
});



// 1. CHECK USER
fastify.post("/check-user", async (req, reply) => {
  const { phone } = req.body;

  if (!phone) {
    return { status: "error", message: "Phone required" };
  }

  const result = await pool.query(
    "SELECT * FROM users WHERE phone = $1",
    [phone]
  );

  if (result.rows.length > 0) {
    return { status: "success", data: result.rows[0] };
  }

  return { status: "success", message: "new_user" };
});

// 2. CREATE USER
fastify.post("/create-user", async (req) => {
  const { name, phone } = req.body;

  const err = validate(["name", "phone"], req.body);
  if (err) return { status: "error", message: err };

  try {
    const id = uuidv4();

    await pool.query(
      "INSERT INTO users (id, name, phone) VALUES ($1, $2, $3)",
      [id, name, phone]
    );

    return {
      status: "success",
      message: "User created",
      data: { id, name, phone }
    };
  } catch (e) {
    return { status: "error", message: "User already exists" };
  }
});

// 3. BOOK APPOINTMENT
fastify.post("/book", async (req) => {
  const { name, phone, date, time, service, message } = req.body;

  const err = validate(["name","phone","date","time","service"], req.body);
  if (err) return { status: "error", message: err };

  if (!isValidTimeSlot(date, time)) {
    return { status: "error", message: "Invalid time slot" };
  }

  // Check or create user
  let userRes = await pool.query(
    "SELECT * FROM users WHERE phone=$1",
    [phone]
  );

  let user;

  if (userRes.rows.length === 0) {
    const id = uuidv4();

    await pool.query(
      "INSERT INTO users (id,name,phone) VALUES ($1,$2,$3)",
      [id, name, phone]
    );

    user = { id };
  } else {
    user = userRes.rows[0];
  }

  // Duplicate check
  const dup = await pool.query(
    `SELECT * FROM appointments 
     WHERE phone=$1 AND date=$2 AND time=$3`,
    [phone, date, time]
  );

  if (dup.rows.length > 0) {
    return { status: "error", message: "Duplicate booking" };
  }

  const id = uuidv4();

  await pool.query(
    `INSERT INTO appointments
    (id,user_id,name,phone,date,time,service,message,status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING')`,
    [id, user.id, name, phone, date, time, service, message]
  );

  return {
    status: "success",
    message: "Appointment booked",
    data: { id, status: "PENDING" }
  };
});

// 3.1 FEEDBACK ROUTE (New)
fastify.post("/feedback", async (req) => {
  const { rating, feedback, name, source } = req.body;
  const id = uuidv4();
  
  try {
    // Basic logging of feedback, can be expanded to DB table later
    fastify.log.info({ rating, feedback, name, source }, "Feedback received");
    
    // If you have a feedback table:
    // await pool.query("INSERT INTO feedback (id, rating, feedback, source) VALUES ($1, $2, $3, $4)", [id, rating, feedback, source]);

    return { status: "success", message: "Feedback received. Thank you!" };
  } catch (e) {
    return { status: "error", message: "Failed to save feedback" };
  }
});

// 4. GET APPOINTMENTS (WITH FILTERS & PAGINATION)
fastify.get("/appointments", async (req, reply) => {
  const { admin_token, page = 1, limit = 10, date, status, search } = req.query;

  if (admin_token !== ADMIN_TOKEN) {
    reply.status(401);
    return { status: "error", message: "Unauthorized" };
  }

  const p = parseInt(page);
  const l = parseInt(limit);
  const offset = (p - 1) * l;

  // We select both old and new field names, or coalesce them for consistency
  let query = `
    SELECT *, 
           COALESCE(appointment_date::TEXT, date::TEXT) as synced_date, 
           COALESCE(appointment_time::TEXT, time::TEXT) as synced_time 
    FROM appointments 
    WHERE 1=1`;
  let countQuery = "SELECT COUNT(*) FROM appointments WHERE 1=1";
  const params = [];
  const countParams = [];

  if (date) {
    params.push(date);
    countParams.push(date);
    query += ` AND (appointment_date = $${params.length} OR date = $${params.length})`;
    countQuery += ` AND (appointment_date = $${countParams.length} OR date = $${countParams.length})`;
  }

  if (status) {
    params.push(status);
    countParams.push(status);
    query += ` AND status = $${params.length}`;
    countQuery += ` AND status = $${countParams.length}`;
  }

  if (search) {
    params.push(`%${search}%`);
    countParams.push(`%${search}%`);
    query += ` AND (name ILIKE $${params.length} OR phone LIKE $${params.length})`;
    countQuery += ` AND (name ILIKE $${countParams.length} OR phone LIKE $${countParams.length})`;
  }

  query += ` ORDER BY synced_date DESC, synced_time ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(l, offset);

  const data = await pool.query(query, params);
  const total = await pool.query(countQuery, countParams);

  // Map synced_date back to date for frontend compatibility
  const rows = data.rows.map(row => ({
    ...row,
    date: row.synced_date,
    time: row.synced_time
  }));

  return {
    status: "success",
    page: p,
    limit: l,
    total: parseInt(total.rows[0].count),
    data: rows
  };
});

// 4.1 GET MY APPOINTMENTS (PUBLIC/USER)
fastify.get("/my-appointments/:phone", async (req) => {
  const { phone } = req.params;

  const query = `
    SELECT * FROM (
      SELECT *, 
             COALESCE(appointment_date::TEXT, date::TEXT) as synced_date, 
             COALESCE(appointment_time::TEXT, time::TEXT) as synced_time 
      FROM appointments 
      WHERE phone = $1
    ) AS results
    ORDER BY synced_date DESC, synced_time ASC`;

  const data = await pool.query(query, [phone]);

  // Map synced_date back to date for frontend compatibility
  const rows = data.rows.map(row => ({
    ...row,
    date: row.synced_date,
    time: row.synced_time
  }));

  return {
    status: "success",
    data: rows
  };
});

// 5. ADMIN DASHBOARD STATS
fastify.get("/admin/stats", async (req, reply) => {
  const { admin_token } = req.query;
  if (admin_token !== ADMIN_TOKEN) {
    reply.status(401);
    return { status: "error", message: "Unauthorized" };
  }

  try {
    const todayStr = new Date().toISOString().split('T')[0];

    const queries = {
      total: "SELECT COUNT(*) FROM appointments",
      today: "SELECT COUNT(*) FROM appointments WHERE appointment_date = $1",
      pending: "SELECT COUNT(*) FROM appointments WHERE status = 'PENDING'",
      confirmed: "SELECT COUNT(*) FROM appointments WHERE status = 'CONFIRMED'",
      by_service: "SELECT service, COUNT(*) as count FROM appointments GROUP BY service ORDER BY count DESC",
      weekly_trend: `
        SELECT appointment_date as date, COUNT(*) as count 
        FROM appointments 
        WHERE appointment_date::DATE >= (CURRENT_DATE - INTERVAL '14 days')
        GROUP BY appointment_date 
        ORDER BY appointment_date ASC
      `
    };

    const [total, today, pending, confirmed, by_service, weekly] = await Promise.all([
      pool.query(queries.total),
      pool.query(queries.today, [todayStr]),
      pool.query(queries.pending),
      pool.query(queries.confirmed),
      pool.query(queries.by_service),
      pool.query(queries.weekly_trend)
    ]);

    return {
      status: "success",
      data: {
        summary: {
          total: parseInt(total.rows[0].count || 0),
          today: parseInt(today.rows[0].count || 0),
          pending: parseInt(pending.rows[0].count || 0),
          confirmed: parseInt(confirmed.rows[0].count || 0)
        },
        by_service: by_service.rows,
        weekly_trend: weekly.rows
      }
    };
  } catch (err) {
    fastify.log.error(err, "[/admin/stats] Failure");
    reply.status(500);
    return { status: "error", message: err.message };
  }
});

// 5.1 PUBLIC STATS (FOR HERO SECTION)
fastify.get("/public-stats", async () => {
  const queries = {
    total: "SELECT COUNT(*) FROM appointments",
    confirmed: "SELECT COUNT(*) FROM appointments WHERE status = 'CONFIRMED'"
  };

  const [total, confirmed] = await Promise.all([
    pool.query(queries.total),
    pool.query(queries.confirmed)
  ]);

  const count = parseInt(total.rows[0].count);
  const confirmedCount = parseInt(confirmed.rows[0].count);
  
  // Base numbers plus actual DB counts
  return {
    status: "success",
    data: {
      total_patients: 10000 + count, // 10k base + actual
      success_rate: count > 0 ? Math.min(99, Math.round((confirmedCount / count) * 100)) : 98
    }
  };
});

// 6. UPDATE STATUS & CLINICAL NOTES (ADMIN/DOCTOR)
fastify.post("/update-status", async (req, reply) => {
  const { appointment_id, status, admin_token, cancel_reason, suggestion, consultation_notes, vitals } = req.body;

  if (admin_token !== ADMIN_TOKEN) {
    reply.status(401);
    return { status: "error", message: "Unauthorized" };
  }

  // Build dynamic update
  let query = "UPDATE appointments SET updated_at=NOW()";
  const params = [];

  if (status) {
    params.push(status);
    query += `, status = $${params.length}`;
  }

  if (consultation_notes !== undefined) {
    params.push(consultation_notes);
    query += `, consultation_notes = $${params.length}`;
  }

  if (vitals !== undefined) {
    params.push(JSON.stringify(vitals));
    query += `, vitals = $${params.length}`;
  }

  if (status === 'CANCELLED' && cancel_reason) {
    params.push(cancel_reason);
    query += `, cancel_reason = $${params.length}`;
  }

  if (suggestion) {
    params.push(suggestion);
    query += `, suggestion = $${params.length}`;
  }

  params.push(appointment_id);
  query += ` WHERE id = $${params.length} RETURNING *`;

  const result = await pool.query(query, params);

  if (result.rowCount === 0) {
    return { status: "error", message: "Appointment not found" };
  }

  const updatedApt = result.rows[0];

  // 🚀 SEND TARGETED PUSH NOTIFICATION
  if (updatedApt.user_id) {
    try {
      const subs = await pool.query("SELECT * FROM subscriptions WHERE user_id = $1", [updatedApt.user_id]);
      
      const note = status === 'CONFIRMED' ? (suggestion || '') : (suggestion ? 'Suggested: ' + suggestion : '');
      const payload = JSON.stringify({
        title: "Appointment Update",
        body: `Hi ${updatedApt.name}, your appointment status is now ${status}. ${note}`,
        url: "https://dr-kanaks-clinic.netlify.app"
      });

      const pushPromises = subs.rows.map(s => 
        webpush.sendNotification(s.data, payload).catch(err => {
          if (err.statusCode === 410 || err.statusCode === 404) {
            // Stale subscription, remove it
            return pool.query("DELETE FROM subscriptions WHERE id = $1", [s.id]);
          }
          console.error("Push Error for user", updatedApt.user_id, err);
        })
      );

      await Promise.all(pushPromises);
    } catch (pushErr) {
      console.error("Critical Push Error:", pushErr);
    }
  }

  return { 
    status: "success", 
    message: status === 'CANCELLED' ? "Appointment cancelled with reason" : "Updated", 
    data: updatedApt 
  };
});

// 6.1 FETCH PATIENT HISTORY (FOR DOCTOR)
fastify.get("/patient-history/:phone", async (req, reply) => {
  const { phone } = req.params;
  const { admin_token } = req.query;

  if (admin_token !== ADMIN_TOKEN) {
    reply.status(401);
    return { status: "error", message: "Unauthorized" };
  }

  const result = await pool.query(
    "SELECT * FROM appointments WHERE phone = $1 ORDER BY appointment_date DESC",
    [phone]
  );
  return { status: "success", data: result.rows };
});

// 6.2 GET SETTINGS
fastify.get("/settings", async (req, reply) => {
  const result = await pool.query("SELECT * FROM settings");
  return { status: "success", data: result.rows };
});

// 6.2.1 GET PUBLIC SLOTS (FOR APPOINTMENT FORM)
fastify.get("/api/active-slots", async () => {
  const result = await pool.query("SELECT value FROM settings WHERE key = 'available_slots'");
  if (result.rows.length === 0) {
    const defaults = ["10:30 AM", "11:30 AM", "12:30 PM", "02:00 PM", "03:30 PM", "05:00 PM", "06:30 PM"].map(t => ({ time: t, limit: 10 }));
    return { status: "success", data: defaults };
  }
  return { status: "success", data: JSON.parse(result.rows[0].value) };
});

// 6.2.2 GET QUEUE STATUS (FOR PATIENT TRACKING)
fastify.get("/api/queue-stats/:date", async (req) => {
  const { date } = req.params;
  const result = await pool.query(
    "SELECT COUNT(*) FROM appointments WHERE appointment_date = $1 AND status = 'COMPLETED'",
    [date]
  );
  return { status: "success", count: parseInt(result.rows[0].count) };
});

// 6.3 UPDATE SETTINGS
fastify.post("/settings", async (req, reply) => {
  const { key, value, admin_token } = req.body;
  if (admin_token !== ADMIN_TOKEN) {
    reply.status(401);
    return { status: "error", message: "Unauthorized" };
  }

  await pool.query(
    "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [key, value]
  );
  return { status: "success", message: "Setting updated" };
});

// 7. WEB PUSH SUBSCRIBE (Updated for Targeted Notifications)
fastify.post("/subscribe", async (req, reply) => {
  const { userId, subscription } = req.body;
  
  // Support both { subscription: {...} } and direct {...subscription} from React
  const sub = subscription || req.body;
  const targetId = userId || req.body.userId;

  if (!sub || !sub.endpoint || !targetId) {
    req.log.error({ body: req.body }, "Missing endpoint or userId in subscription attempt");
    reply.status(400);
    return { status: "error", message: "Invalid subscription: missing endpoint or userId" };
  }

  try {
    // 🔍 Check if this specific device already exists for this user
    const existing = await pool.query(
      "SELECT * FROM subscriptions WHERE user_id = $1 AND data->>'endpoint' = $2",
      [targetId, sub.endpoint]
    );

    if (existing.rowCount === 0) {
      await pool.query(
        "INSERT INTO subscriptions (user_id, data) VALUES ($1, $2)",
        [targetId, sub]
      );
      return { status: "success", message: "Subscription linked to user: " + targetId };
    }

    return { status: "success", message: "Device already linked to this user" };
  } catch (err) {
    req.log.error(err, "Subscription Storage Error");
    reply.status(500);
    return { status: "error", message: "Internal server error connecting to DB" };
  }
});

// 8. SERVE ADMIN PAGE
fastify.get("/admin-panel", async (req, reply) => {
  const filePath = path.join(__dirname, "admin.html");
  const content = fs.readFileSync(filePath, "utf8");
  reply.type("text/html").send(content);
});

/* ---------------- PAYMENT ROUTES ---------------- */

// POST /api/book  →  Create appointment + Razorpay order
fastify.post("/api/book", async (req, reply) => {
  const { name, phone, appointment_date, appointment_time, service, message } = req.body;

  // --- Validate required fields ---
  if (!name || !phone || !appointment_date || !appointment_time) {
    reply.status(400);
    return { status: "error", message: "Missing required fields: name, phone, appointment_date, appointment_time" };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Check Granular Slot Capacity (Confirmed + Recent Pending)
    const settingsRes = await client.query("SELECT value FROM settings WHERE key = 'available_slots'");
    if (settingsRes.rows.length > 0) {
      const config = JSON.parse(settingsRes.rows[0].value);
      const slotConfig = config.find(c => c.time === appointment_time); 
      
      if (slotConfig) {
        // Count confirmed appointments OR bookings initiated in the last 15 mins
        const countRes = await client.query(
          `SELECT COUNT(*) FROM appointments 
           WHERE appointment_date = $1 AND appointment_time = $2 
           AND status != 'CANCELLED' 
           AND (status = 'CONFIRMED' OR created_at > NOW() - INTERVAL '15 minutes')`,
          [appointment_date, appointment_time]
        );
        
        if (parseInt(countRes.rows[0].count) >= slotConfig.limit) {
          await client.query("ROLLBACK");
          reply.status(409);
          return { status: "error", message: `Slot Full: The ${slotConfig.time} slot has reached its clinic limit of ${slotConfig.limit} patients.` };
        }
      }
    }

    // 2. Ensure slot record-keeping (optional/legacy sync)
    await client.query(
      `INSERT INTO time_slots (slot_date, slot_time, is_booked)
       VALUES ($1, $2, FALSE)
       ON CONFLICT (slot_date, slot_time) DO NOTHING`,
      [appointment_date, appointment_time]
    );

    // 3. Check or create user
    let userRes = await client.query("SELECT id FROM users WHERE phone = $1", [phone]);
    let userId;
    if (userRes.rows.length === 0) {
      userId = uuidv4();
      await client.query(
        "INSERT INTO users (id, name, phone) VALUES ($1, $2, $3)",
        [userId, name, phone]
      );
    } else {
      userId = userRes.rows[0].id;
    }


    // 4. Generate Daily Sequential Token
    const countRes = await client.query(
      "SELECT COUNT(*) FROM appointments WHERE appointment_date = $1",
      [appointment_date]
    );
    const dailyCount = parseInt(countRes.rows[0].count);
    const token = generateSequenceToken(appointment_date, dailyCount);

    // 5. Insert appointment with INITIATED status
    const serviceName = service || 'General Consultation';
    const appointmentId = uuidv4();
    await client.query(
      `INSERT INTO appointments
         (id, user_id, name, phone, appointment_date, appointment_time, service, message, token, payment_status, status, amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'INITIATED', 'PENDING', 10000)`,
      [appointmentId, userId, name, phone, appointment_date, appointment_time, serviceName, message, token]
    );

    // 6. Create Razorpay order
    const rpOrder = await razorpay.orders.create({
      amount: 10000,        // ₹100 in paise
      currency: "INR",
      receipt: `apt_${appointmentId}`,
      notes: { appointment_id: appointmentId, phone, token }
    });

    // 7. Update appointment with razorpay_order_id
    await client.query(
      "UPDATE appointments SET razorpay_order_id = $1 WHERE id = $2",
      [rpOrder.id, appointmentId]
    );

    // 8. Insert into payments table
    await client.query(
      `INSERT INTO payments (appointment_id, razorpay_order_id, amount, status)
       VALUES ($1, $2, $3, 'CREATED')`,
      [appointmentId, rpOrder.id, 10000]
    );

    await client.query("COMMIT");

    return {
      status: "success",
      data: {
        order_id: rpOrder.id,
        appointment_id: appointmentId,
        token: token,
        amount: 10000,
        currency: "INR",
        key: process.env.RAZORPAY_KEY_ID
      }
    };
  } catch (err) {
    await client.query("ROLLBACK");
    fastify.log.error(err, "[/api/book] Transaction failed");
    reply.status(500);
    return { status: "error", message: "Booking failed. Please try again." };
  } finally {
    client.release();
  }
});

// POST /api/verify  →  Verify Razorpay signature & confirm appointment
fastify.post("/api/verify", async (req, reply) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, appointment_id } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !appointment_id) {
    reply.status(400);
    return { status: "error", message: "Missing verification fields" };
  }

  // --- HMAC-SHA256 signature verification ---
  const body = razorpay_order_id + "|" + razorpay_payment_id;
  const expectedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest("hex");

  const isValid = crypto.timingSafeEqual(
    Buffer.from(expectedSignature, "hex"),
    Buffer.from(razorpay_signature, "hex")
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (isValid) {
      // ✅ Update appointment → PAID + CONFIRMED
      await client.query(
        `UPDATE appointments
         SET payment_status = 'PAID',
             status = 'CONFIRMED',
             razorpay_payment_id = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [razorpay_payment_id, appointment_id]
      );

      // ✅ Update payments → SUCCESS
      await client.query(
        `UPDATE payments
         SET status = 'SUCCESS', razorpay_payment_id = $1
         WHERE razorpay_order_id = $2`,
        [razorpay_payment_id, razorpay_order_id]
      );

      // ✅ Mark slot as booked
      const aptRes = await client.query(
        "SELECT appointment_date, appointment_time FROM appointments WHERE id = $1",
        [appointment_id]
      );
      if (aptRes.rows.length > 0) {
        const { appointment_date, appointment_time } = aptRes.rows[0];
        await client.query(
          `UPDATE time_slots SET is_booked = TRUE
           WHERE slot_date = $1 AND slot_time = $2`,
          [appointment_date, appointment_time]
        );
      }

      await client.query("COMMIT");
      return {
        status: "success",
        message: "Payment verified. Appointment confirmed!",
        data: { appointment_id, payment_id: razorpay_payment_id }
      };
    } else {
      // ❌ Signature mismatch — mark as FAILED
      await client.query(
        `UPDATE appointments
         SET payment_status = 'FAILED', updated_at = NOW()
         WHERE id = $1`,
        [appointment_id]
      );
      await client.query(
        "UPDATE payments SET status = 'FAILED' WHERE razorpay_order_id = $1",
        [razorpay_order_id]
      );

      await client.query("COMMIT");
      reply.status(400);
      return { status: "error", message: "Payment verification failed. Invalid signature." };
    }
  } catch (err) {
    await client.query("ROLLBACK");
    fastify.log.error(err, "[/api/verify] Transaction failed");
    reply.status(500);
    return { status: "error", message: "Verification error. Please contact support." };
  } finally {
    client.release();
  }
});

/* ---------------- START SERVER ---------------- */

fastify.listen(
  {
    port: process.env.PORT || 3000,
    host: "0.0.0.0"
  },
  (err, address) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    dbInit();
    console.log(`🚀 Server running on ${address}`);
  }
);