async function triggerOtp() {
  console.log("Triggering OTP request to localhost:3000...");
  try {
    const res = await fetch("http://localhost:3000/api/admin/send-otp", {
      method: "POST"
    });
    const data = await res.json();
    console.log("Response:", data);
  } catch (err) {
    console.error("Failed to request OTP:", err);
  }
}

triggerOtp();
