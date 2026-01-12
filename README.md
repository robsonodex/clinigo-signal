# CliniGo Signaling Server

WebRTC signaling server for CliniGo video consultations.

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your credentials
npm run dev
```

## Deploy (Railway)

```bash
npm install -g @railway/cli
railway login
railway init
railway variables set PORT=3001
railway variables set SUPABASE_URL=https://xxx.supabase.co
railway variables set SUPABASE_SERVICE_ROLE_KEY=xxx
railway variables set ALLOWED_ORIGINS=https://clinigo.app
railway up
```

## Environment Variables

- `PORT` - Server port (default: 3001)
- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Service role key for admin access
- `ALLOWED_ORIGINS` - Comma-separated CORS origins
- `NODE_ENV` - Environment (development/production)

## Architecture

- **Express** - HTTP server
- **Socket.io** - WebSocket communication
- **Supabase** - Authentication & database
- **TypeScript** - Type safety

## Endpoints

- `GET /health` - Health check
- WebSocket on port 3001

## Events

### Client → Server
- `join-room` - Join video room
- `webrtc-offer` - Send WebRTC offer
- `webrtc-answer` - Send WebRTC answer
- `webrtc-ice-candidate` - Send ICE candidate
- `toggle-audio` - Toggle audio on/off
- `toggle-video` - Toggle video on/off
- `share-screen` - Toggle screen sharing
- `chat-message` - Send chat message
- `start-recording` - Start recording (doctors only)
- `stop-recording` - Stop recording
- `quality-metrics` - Send quality metrics
- `leave-room` - Leave room

### Server → Client
- `room-users` - Current participants
- `user-joined` - New participant joined
- `user-left` - Participant left
- `webrtc-offer` - Received WebRTC offer
- `webrtc-answer` - Received WebRTC answer
- `webrtc-ice-candidate` - Received ICE candidate
- `user-audio-toggle` - User toggled audio
- `user-video-toggle` - User toggled video
- `user-screen-share` - User toggled screen share
- `chat-message` - Received chat message
- `recording-started` - Recording started
- `recording-stopped` - Recording stopped
- `error` - Error message
