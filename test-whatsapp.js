require("dotenv").config();

async function testWhatsapp() {
  const idInstance = process.env.GREEN_API_ID_INSTANCE;
  const apiTokenInstance = process.env.GREEN_API_TOKEN_INSTANCE;
  const recipientPhone = process.env.GREEN_API_RECIPIENT_PHONE;

  console.log("🚀 Initializing Green-API WhatsApp Test...");
  console.log(`🔹 Instance ID: ${idInstance}`);
  console.log(`🔹 Recipient: ${recipientPhone}`);

  if (!idInstance || !apiTokenInstance || !recipientPhone || idInstance.includes("YOUR_GREEN")) {
    console.error("❌ Error: Green-API credentials are not set correctly in your .env file!");
    return;
  }

  const testMessage = `*Green-API Test Message* 🧪\n\n` +
    `Hello! Your WhatsApp notification system for Dr. Kanaks clinic is working successfully!\n\n` +
    `Time: ${new Date().toLocaleString()}`;

  const url = `https://api.green-api.com/waInstance${idInstance}/sendMessage/${apiTokenInstance}`;

  try {
    const cleanPhone = recipientPhone.replace(/[^0-9]/g, '');
    console.log("Sending request to Green-API...");
    
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chatId: `${cleanPhone}@c.us`,
        message: testMessage
      })
    });

    if (res.ok) {
      const responseData = await res.json();
      console.log("✅ SUCCESS! Message sent successfully!");
      console.log("Response Data:", responseData);
    } else {
      console.error(`❌ FAILED! Green-API returned status ${res.status}`);
      console.error("Response:", await res.text());
    }
  } catch (err) {
    console.error("❌ ERROR! Request failed:", err);
  }
}

testWhatsapp();
