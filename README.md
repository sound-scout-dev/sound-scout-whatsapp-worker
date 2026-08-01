# 🎵 SoundScout WhatsApp Worker

A standalone microservice that connects SoundScout to the official WhatsApp network. It manages OTP verification, sends instant rental booking alerts, and powers the WhatsApp AI chatbot.

## 🛠️ Tech Stack
* **Runtime:** Node.js / Express.js
* **WhatsApp Client:** `@whiskeysockets/baileys` (Multi-device WebSockets connection)
* **Architecture:** In-memory message queue with rate limiting and keep-alive ping cycles.

## 🚀 Key Microservice Modules
* **Baileys WebSocket Engine:** Maintains persistent WhatsApp authentication state. Filters out internal 15-digit WhatsApp Linked Device IDs (`@lid`) to resolve clean phone numbers.
* **OTP Verification State Machine:** Dispatches numeric verification codes over WhatsApp and verifies user input.
* **Automated Alerts:** Sends instant notification messages to vendors when an organizer books equipment, including direct WhatsApp contact links.
* **24/7 AI Chatbot:** Proxies incoming WhatsApp messages to the AI microservice to answer event planning questions automatically.

## ⚙️ Setup & Execution

### Prerequisites
* Node.js v18+

### Installation
```bash
git clone [https://github.com/sound-scout-dev/sound-scout-whatsapp-worker.git](https://github.com/sound-scout-dev/sound-scout-whatsapp-worker.git)
cd sound-scout-whatsapp-worker
npm install
```

### Environment Variables (`.env`)
Create a `.env` file in the root directory and add:
```env
PORT=4000
WORKER_SECRET=super_secret_key
BACKEND_URL=http://localhost:5000
AI_SERVICE_URL=http://localhost:8000
```

### Run Locally
```bash
# Upon first run, you will need to scan the generated QR code with your WhatsApp app.
npm start
```
