import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import dotenv from 'dotenv'
import { setupSocketHandlers } from './socket-handlers'

dotenv.config()

const app = express()
const httpServer = createServer(app)

// CORS
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    credentials: true
}))

app.use(express.json())

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: '1.0.0'
    })
})

// Socket.io
const io = new Server(httpServer, {
    cors: {
        origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
        credentials: true
    },
    pingTimeout: 60000,
    pingInterval: 25000
})

// Setup socket handlers
setupSocketHandlers(io)

const PORT = process.env.PORT || 3001

httpServer.listen(PORT, () => {
    console.log(`🎥 CliniGo Signaling Server`)
    console.log(`📡 WebSocket: ws://localhost:${PORT}`)
    console.log(`🌐 HTTP: http://localhost:${PORT}`)
    console.log(`✅ Server running`)
})

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, closing server...')
    httpServer.close(() => {
        console.log('Server closed')
        process.exit(0)
    })
})
