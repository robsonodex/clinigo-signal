/**
 * Clin WhatsApp Chatbot — Baileys Integration
 * 
 * Roda 24/7 dentro do servidor Railway.
 * Escuta mensagens recebidas no WhatsApp de vendas do CliniGo
 * e responde automaticamente usando a API do Clin.
 * 
 * Funciona independente da Vercel (serverless).
 */

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WASocket,
  type ConnectionState,
} from '@whiskeysockets/baileys'
import { createClient } from '@supabase/supabase-js'
import pino from 'pino'
import * as fs from 'fs'
import * as path from 'path'
import type { Express } from 'express'

const logger = pino({ level: 'warn' })

// ========== CONFIG ==========
const CLIN_API_URL = process.env.CLIN_API_URL || 'https://clinigo.app/api/chatbot'
const AUTH_DIR = path.join(process.cwd(), '.clin-auth')

// ========== STATE ==========
let clinSocket: WASocket | null = null
let clinStatus: 'disconnected' | 'connecting' | 'connected' = 'disconnected'
let clinQrCode: string | null = null
let clinPhoneNumber: string | null = null

// Histórico de conversas in-memory
const conversations = new Map<string, { role: string; content: string }[]>()

// ========== SUPABASE ==========
function getSupabase() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key)
}

// ========== HANDLER DE MENSAGENS ==========
async function handleIncomingMessage(socket: WASocket, senderJid: string, text: string) {
  const senderPhone = senderJid.split('@')[0]

  // Obter ou criar histórico
  if (!conversations.has(senderPhone)) {
    conversations.set(senderPhone, [])
  }
  const history = conversations.get(senderPhone)!
  history.push({ role: 'user', content: text })

  // Limitar histórico
  if (history.length > 20) {
    history.splice(0, history.length - 20)
  }

  // Indicar que está digitando
  try {
    await socket.presenceSubscribe(senderJid)
    await socket.sendPresenceUpdate('composing', senderJid)
  } catch { /* best effort */ }

  try {
    // Chamar API do Clin
    const response = await fetch(CLIN_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        sessionId: `wa-${senderPhone}`,
        sourcePage: 'whatsapp',
        history: history.slice(-10),
      }),
    })

    if (!response.ok) {
      throw new Error(`API retornou ${response.status}`)
    }

    const data = await response.json()
    const reply = data.reply || 'Desculpe, estou com dificuldade técnica. Tente novamente em instantes! 😊'

    // Adicionar resposta ao histórico
    history.push({ role: 'assistant', content: reply })

    // Parar digitação
    try {
      await socket.sendPresenceUpdate('paused', senderJid)
    } catch { /* best effort */ }

    // Enviar resposta
    await socket.sendMessage(senderJid, { text: reply })
    console.log(`[Clin] ✅ Respondido para ${senderPhone}`)

  } catch (err) {
    console.error(`[Clin] ❌ Erro ao chamar API:`, err)

    try {
      await socket.sendPresenceUpdate('paused', senderJid)
    } catch { /* best effort */ }

    await socket.sendMessage(senderJid, {
      text: 'Oi! 😊 Estou com uma dificuldade técnica momentânea. Mas não se preocupe, nossa equipe já foi notificada e vai te atender em breve!'
    })
  }
}

// ========== INICIAR SESSÃO BAILEYS ==========
async function startClinSession() {
  if (clinStatus === 'connecting') return
  clinStatus = 'connecting'
  clinQrCode = null

  // Garantir diretório de auth
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true })
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()

  const socket = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger as any),
    },
    logger: logger as any,
    printQRInTerminal: true, // Imprime QR no terminal do Railway (útil para debug)
    browser: ['CliniGo Clin', 'Chrome', '120.0.0'],
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  })

  clinSocket = socket

  // ===== EVENTOS =====

  socket.ev.on('connection.update', async (update: Partial<ConnectionState>) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      clinQrCode = qr // String raw do QR (não base64)
      clinStatus = 'connecting'
      console.log(`[Clin] 📱 QR Code gerado. Escaneie pelo endpoint /clin/qr`)
    }

    if (connection === 'open') {
      clinStatus = 'connected'
      clinQrCode = null
      clinPhoneNumber = socket.user?.id?.split(':')[0] || socket.user?.id?.split('@')[0] || null
      console.log(`[Clin] ✅ WhatsApp conectado (${clinPhoneNumber})`)

      // Registrar no Supabase
      const supabase = getSupabase()
      if (supabase) {
        await supabase.from('whatsapp_sessions').upsert({
          clinic_id: 'clin-sales-bot',
          instance_name: 'clin-railway',
          status: 'connected',
          phone_number: clinPhoneNumber,
          connected_at: new Date().toISOString(),
          qr_code: null,
          error_message: null,
          last_health_check: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'clinic_id' })
      }
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut

      console.log(`[Clin] Conexão fechada (code=${statusCode}, reconnect=${shouldReconnect})`)

      clinSocket = null
      clinQrCode = null

      if (shouldReconnect) {
        console.log(`[Clin] 🔄 Reconectando em 5s...`)
        setTimeout(startClinSession, 5000)
      } else {
        clinStatus = 'disconnected'
        clinPhoneNumber = null

        // Limpar auth para forçar novo QR
        if (fs.existsSync(AUTH_DIR)) {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true })
        }

        const supabase = getSupabase()
        if (supabase) {
          await supabase.from('whatsapp_sessions').update({
            status: 'disconnected',
            disconnected_at: new Date().toISOString(),
            qr_code: null,
            phone_number: null,
            updated_at: new Date().toISOString(),
          }).eq('clinic_id', 'clin-sales-bot')
        }
      }
    }
  })

  // Salvar credenciais
  socket.ev.on('creds.update', saveCreds)

  // ===== LISTENER DE MENSAGENS =====
  socket.ev.on('messages.upsert', async (m) => {
    for (const msg of m.messages) {
      // Ignorar: mensagens nossas, grupos, broadcasts, status
      if (msg.key.fromMe) continue
      if (msg.key.remoteJid?.endsWith('@g.us')) continue
      if (msg.key.remoteJid === 'status@broadcast') continue

      const text = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || ''

      if (!text.trim()) continue

      const senderJid = msg.key.remoteJid!
      console.log(`[Clin] 📩 Mensagem de ${senderJid.split('@')[0]}: ${text.substring(0, 50)}`)

      try {
        await handleIncomingMessage(socket, senderJid, text)
      } catch (err) {
        console.error(`[Clin] Erro ao processar mensagem:`, err)
      }
    }
  })

  console.log(`[Clin] 🤖 Listener de mensagens WhatsApp ativado`)
}

// ========== EXPRESS ROUTES ==========
export function setupClinRoutes(app: Express) {
  // Status do Clin
  app.get('/clin/status', (req, res) => {
    res.json({
      status: clinStatus,
      phone_number: clinPhoneNumber,
      connected: clinStatus === 'connected',
      conversations_active: conversations.size,
      uptime: process.uptime(),
    })
  })

  // QR Code
  app.get('/clin/qr', async (req, res) => {
    if (clinStatus === 'connected') {
      return res.json({ status: 'connected', qr: null, phone_number: clinPhoneNumber })
    }

    // Se não tem QR, iniciar sessão
    if (!clinQrCode && clinStatus !== 'connecting') {
      startClinSession().catch(console.error)
    }

    // Esperar QR (até 10s)
    for (let i = 0; i < 20; i++) {
      if (clinQrCode || clinStatus === 'connected') break
      await new Promise(r => setTimeout(r, 500))
    }

    if (clinStatus === 'connected') {
      return res.json({ status: 'connected', qr: null, phone_number: clinPhoneNumber })
    }

    // Gerar QR como base64 data URI
    if (clinQrCode) {
      try {
        const QRCode = await import('qrcode')
        const qrDataUri = await QRCode.toDataURL(clinQrCode, { width: 300, margin: 2 })
        return res.json({ status: 'connecting', qr: qrDataUri })
      } catch {
        return res.json({ status: 'connecting', qr: null, raw_qr: clinQrCode })
      }
    }

    res.json({ status: clinStatus, qr: null })
  })

  // Conectar (POST)
  app.post('/clin/connect', async (req, res) => {
    if (clinStatus === 'connected') {
      return res.json({ status: 'connected', phone_number: clinPhoneNumber })
    }
    startClinSession().catch(console.error)
    res.json({ status: 'connecting', message: 'Iniciando sessão. Acesse /clin/qr para obter o QR Code.' })
  })

  // Desconectar (POST)
  app.post('/clin/disconnect', async (req, res) => {
    if (clinSocket) {
      try {
        await clinSocket.logout()
      } catch {
        try { clinSocket.end(undefined) } catch { /* best effort */ }
      }
    }

    clinSocket = null
    clinStatus = 'disconnected'
    clinPhoneNumber = null
    clinQrCode = null
    conversations.clear()

    // Limpar auth
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true })
    }

    res.json({ status: 'disconnected' })
  })

  console.log(`[Clin] 📡 Rotas HTTP registradas: /clin/status, /clin/qr, /clin/connect, /clin/disconnect`)
}

// ========== AUTO-START ==========
export function initClin() {
  // Se já tem auth salvo, reconectar automaticamente
  if (fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
    console.log(`[Clin] 🔄 Auth state encontrado, reconectando...`)
    startClinSession().catch(console.error)
  } else {
    console.log(`[Clin] ⏳ Aguardando conexão via /clin/connect ou /clin/qr`)
  }
}
