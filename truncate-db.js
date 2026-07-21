const { Pool } = require("pg");

// Use DATABASE_URL from env if set, otherwise default to the active Neon DB instance
const connectionString = process.env.DATABASE_URL || "postgresql://neondb_owner:npg_BuXVce8lpZ5f@ep-bold-mud-adftauh5-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=verify-full&uselibpqcompat=true";

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }
});

async function truncateAll() {
  console.log("⚠️ Initializing database truncation...");
  const client = await pool.connect();
  try {
    // Truncate all main tables using CASCADE to respect foreign key references
    const query = `
      TRUNCATE TABLE 
        feedback, 
        uploaded_images, 
        notifications, 
        settings, 
        subscriptions, 
        time_slots, 
        payments, 
        appointments, 
        users 
      CASCADE;
    `;
    await client.query(query);
    console.log("✅ Database truncation complete! All tables cleared successfully.");
  } catch (err) {
    console.error("❌ Truncation failed:", err);
  } finally {
    client.release();
    await pool.end();
  }
}

truncateAll();
