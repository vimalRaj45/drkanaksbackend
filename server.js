const fastify = require("fastify")({ logger: true });
const { Pool } = require("pg");
const { v4: uuidv4 } = require("uuid");
const webpush = require("web-push");

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
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// ✅ CORS
fastify.register(require("@fastify/cors"), {
  origin: "*"
});

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

/* ---------------- ROUTES ---------------- */

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
    const id = "USR_" + uuidv4();

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
    const id = "USR_" + uuidv4();

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

  const id = "APT_" + uuidv4();

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

  let query = "SELECT * FROM appointments WHERE 1=1";
  let countQuery = "SELECT COUNT(*) FROM appointments WHERE 1=1";
  const params = [];
  const countParams = [];

  if (date) {
    params.push(date);
    countParams.push(date);
    query += ` AND date = $${params.length}`;
    countQuery += ` AND date = $${countParams.length}`;
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

  query += ` ORDER BY date DESC, time ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(l, offset);

  const data = await pool.query(query, params);
  const total = await pool.query(countQuery, countParams);

  return {
    status: "success",
    page: p,
    limit: l,
    total: parseInt(total.rows[0].count),
    data: data.rows
  };
});

// 5. ADMIN DASHBOARD STATS
fastify.get("/admin/stats", async (req, reply) => {
  const { admin_token } = req.query;
  if (admin_token !== ADMIN_TOKEN) {
    reply.status(401);
    return { status: "error", message: "Unauthorized" };
  }

  const todayStr = new Date().toISOString().split('T')[0];

  const queries = {
    total: "SELECT COUNT(*) FROM appointments",
    today: "SELECT COUNT(*) FROM appointments WHERE date = $1",
    pending: "SELECT COUNT(*) FROM appointments WHERE status = 'PENDING'",
    confirmed: "SELECT COUNT(*) FROM appointments WHERE status = 'CONFIRMED'",
    by_service: "SELECT service, COUNT(*) as count FROM appointments GROUP BY service ORDER BY count DESC",
    weekly_trend: `
      SELECT date, COUNT(*) as count 
      FROM appointments 
      WHERE date >= CURRENT_DATE - INTERVAL '7 days' 
      GROUP BY date 
      ORDER BY date ASC
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
        total: parseInt(total.rows[0].count),
        today: parseInt(today.rows[0].count),
        pending: parseInt(pending.rows[0].count),
        confirmed: parseInt(confirmed.rows[0].count)
      },
      by_service: by_service.rows,
      weekly_trend: weekly.rows
    }
  };
});

// 6. UPDATE STATUS (ADMIN)
fastify.post("/update-status", async (req, reply) => {
  const { appointment_id, status, admin_token, cancel_reason, suggestion } = req.body;

  if (admin_token !== ADMIN_TOKEN) {
    reply.status(401);
    return { status: "error", message: "Unauthorized" };
  }

  // Build dynamic update
  let query = "UPDATE appointments SET status=$1, updated_at=NOW()";
  const params = [status];

  if (cancel_reason) {
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
      const payload = JSON.stringify({
        title: "Appointment Update",
        body: `Hi ${updatedApt.name}, your appointment status is now ${status}. ${suggestion ? 'Suggested: ' + suggestion : ''}`,
        url: "/appointments"
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
    console.log(`🚀 Server running on ${address}`);
  }
);