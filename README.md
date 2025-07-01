# Secure Location Sharing App 🔐📍

This app allows two users to share their locations securely using E2EE (ECDH + AES-GCM) and visualize locations on a map.

## 🚀 Features

- Real-time location sharing
- QR-code based key exchange
- End-to-end encryption (ECDH + AES-GCM)
- 5-minute auto-expiry timer

## 🛠 Setup Instructions

### Backend

```bash
cd server
npm install express ws
node server.js
