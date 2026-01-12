import { Server, Socket } from 'socket.io'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
)

interface Room {
    roomId: string
    appointmentId: string
    participants: Map<string, {
        socketId: string
        userId: string
        role: 'doctor' | 'patient'
        joinedAt: Date
    }>
    createdAt: Date
    metadata: {
        clinicId: string
        recordingEnabled: boolean
    }
}

const activeRooms = new Map<string, Room>()

export function setupSocketHandlers(io: Server) {
    // Authentication middleware
    io.use(async (socket, next) => {
        const token = socket.handshake.auth.token

        if (!token) {
            return next(new Error('Authentication error'))
        }

        try {
            const { data: { user }, error } = await supabase.auth.getUser(token)

            if (error || !user) {
                return next(new Error('Invalid token'))
            }

            socket.data.userId = user.id
            socket.data.userEmail = user.email
            next()
        } catch (error) {
            next(new Error('Authentication failed'))
        }
    })

    io.on('connection', (socket) => {
        console.log(`✅ User connected: ${socket.data.userId}`)

        // JOIN ROOM
        socket.on('join-room', async (data: {
            roomId: string
            appointmentId: string
            role: 'doctor' | 'patient'
        }) => {
            try {
                const { roomId, appointmentId, role } = data

                // Validate appointment
                const { data: appointment, error } = await supabase
                    .from('appointments')
                    .select('*, clinic:clinics(id), doctor:doctors(id), patient:patients(id)')
                    .eq('id', appointmentId)
                    .single()

                if (error || !appointment) {
                    socket.emit('error', { message: 'Agendamento não encontrado' })
                    return
                }

                // Create room if doesn't exist
                if (!activeRooms.has(roomId)) {
                    activeRooms.set(roomId, {
                        roomId,
                        appointmentId,
                        participants: new Map(),
                        createdAt: new Date(),
                        metadata: {
                            clinicId: appointment.clinic_id,
                            recordingEnabled: false
                        }
                    })

                    // Create session in DB
                    await supabase
                        .from('video_sessions')
                        .insert({
                            room_id: roomId,
                            appointment_id: appointmentId,
                            clinic_id: appointment.clinic_id,
                            started_at: new Date()
                        })
                }

                const room = activeRooms.get(roomId)!

                // Add participant
                room.participants.set(socket.id, {
                    socketId: socket.id,
                    userId: socket.data.userId,
                    role,
                    joinedAt: new Date()
                })

                socket.join(roomId)
                socket.data.roomId = roomId
                socket.data.role = role

                // Update participants in DB
                await supabase
                    .from('video_sessions')
                    .update({
                        participants: Array.from(room.participants.values())
                    })
                    .eq('room_id', roomId)

                // Notify others
                socket.to(roomId).emit('user-joined', {
                    userId: socket.data.userId,
                    role,
                    socketId: socket.id
                })

                // Send current participants
                socket.emit('room-users', {
                    users: Array.from(room.participants.values()),
                    mySocketId: socket.id
                })

                console.log(`👥 ${role} joined room ${roomId}`)
            } catch (error) {
                console.error('Error joining room:', error)
                socket.emit('error', { message: 'Erro ao entrar na sala' })
            }
        })

        // WEBRTC SIGNALING
        socket.on('webrtc-offer', (data: {
            targetSocketId: string
            offer: RTCSessionDescriptionInit
        }) => {
            io.to(data.targetSocketId).emit('webrtc-offer', {
                offer: data.offer,
                senderSocketId: socket.id,
                senderUserId: socket.data.userId
            })
        })

        socket.on('webrtc-answer', (data: {
            targetSocketId: string
            answer: RTCSessionDescriptionInit
        }) => {
            io.to(data.targetSocketId).emit('webrtc-answer', {
                answer: data.answer,
                senderSocketId: socket.id
            })
        })

        socket.on('webrtc-ice-candidate', (data: {
            targetSocketId: string
            candidate: RTCIceCandidateInit
        }) => {
            io.to(data.targetSocketId).emit('webrtc-ice-candidate', {
                candidate: data.candidate,
                senderSocketId: socket.id
            })
        })

        // MEDIA CONTROLS
        socket.on('toggle-audio', (enabled: boolean) => {
            if (socket.data.roomId) {
                socket.to(socket.data.roomId).emit('user-audio-toggle', {
                    userId: socket.data.userId,
                    socketId: socket.id,
                    enabled
                })
            }
        })

        socket.on('toggle-video', (enabled: boolean) => {
            if (socket.data.roomId) {
                socket.to(socket.data.roomId).emit('user-video-toggle', {
                    userId: socket.data.userId,
                    socketId: socket.id,
                    enabled
                })
            }
        })

        socket.on('share-screen', (enabled: boolean) => {
            if (socket.data.roomId) {
                socket.to(socket.data.roomId).emit('user-screen-share', {
                    userId: socket.data.userId,
                    socketId: socket.id,
                    enabled
                })
            }
        })

        // CHAT
        socket.on('chat-message', (message: string) => {
            if (socket.data.roomId) {
                socket.to(socket.data.roomId).emit('chat-message', {
                    userId: socket.data.userId,
                    message,
                    timestamp: new Date()
                })
            }
        })

        // RECORDING
        socket.on('start-recording', async () => {
            if (socket.data.role !== 'doctor') {
                socket.emit('error', { message: 'Apenas médicos podem gravar' })
                return
            }

            const room = activeRooms.get(socket.data.roomId)
            if (room) {
                room.metadata.recordingEnabled = true

                const { data: recording } = await supabase
                    .from('video_recordings')
                    .insert({
                        session_id: room.roomId,
                        appointment_id: room.appointmentId,
                        clinic_id: room.metadata.clinicId,
                        started_by: socket.data.userId,
                        started_at: new Date()
                    })
                    .select()
                    .single()

                socket.to(socket.data.roomId).emit('recording-started', {
                    recordingId: recording?.id
                })

                socket.emit('recording-started', {
                    recordingId: recording?.id
                })
            }
        })

        socket.on('stop-recording', async (recordingId: string) => {
            await supabase
                .from('video_recordings')
                .update({
                    ended_at: new Date(),
                    status: 'completed'
                })
                .eq('id', recordingId)

            if (socket.data.roomId) {
                socket.to(socket.data.roomId).emit('recording-stopped')
            }
        })

        // QUALITY METRICS
        socket.on('quality-metrics', async (metrics: any) => {
            if (socket.data.roomId) {
                await supabase
                    .from('video_quality_metrics')
                    .insert({
                        session_id: socket.data.roomId,
                        user_id: socket.data.userId,
                        metrics
                    })
            }
        })

        // LEAVE & DISCONNECT
        socket.on('leave-room', async () => {
            await handleUserLeave(socket, io)
        })

        socket.on('disconnect', async () => {
            await handleUserLeave(socket, io)
            console.log(`❌ User disconnected: ${socket.data.userId}`)
        })
    })
}

async function handleUserLeave(socket: Socket, io: Server) {
    if (!socket.data.roomId) return

    const room = activeRooms.get(socket.data.roomId)
    if (!room) return

    room.participants.delete(socket.id)

    socket.to(socket.data.roomId).emit('user-left', {
        userId: socket.data.userId,
        socketId: socket.id
    })

    if (room.participants.size === 0) {
        const duration = new Date().getTime() - room.createdAt.getTime()

        await supabase
            .from('video_sessions')
            .update({
                ended_at: new Date(),
                duration_seconds: Math.floor(duration / 1000)
            })
            .eq('room_id', room.roomId)

        activeRooms.delete(socket.data.roomId)
        console.log(`🗑️  Room ${socket.data.roomId} closed`)
    } else {
        await supabase
            .from('video_sessions')
            .update({
                participants: Array.from(room.participants.values())
            })
            .eq('room_id', room.roomId)
    }

    socket.leave(socket.data.roomId)
}
