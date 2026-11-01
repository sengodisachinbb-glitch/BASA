const { WebSocketServer, WebSocket } = require('ws');
const { v4: uuidv4 } = require('uuid');

const rooms = new Map();

function generateRoomCode() {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let i = 0; i < 6; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

function setupSyncRoomManager(server) {
    const wss = new WebSocketServer({ server });

    wss.on('connection', (ws) => {
        let currentRoom = null;
        let clientId = uuidv4();
        let clientName = 'Unknown Device';

        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                if (data.type === 'PING') {
                    ws.send(JSON.stringify({
                        type: 'PONG',
                        clientTime: data.clientTime,
                        serverTime: Date.now()
                    }));
                    return;
                }

                switch (data.type) {
                    case 'CREATE_ROOM':
                        const newRoomCode = generateRoomCode();
                        rooms.set(newRoomCode, {
                            roomCode: newRoomCode,
                            hostId: clientId,
                            clients: new Map(),
                            playbackState: {
                                track: null, // Full track object
                                position: 0,
                                playing: false,
                                updatedAt: Date.now()
                            }
                        });
                        currentRoom = rooms.get(newRoomCode);
                        clientName = data.deviceName || 'Host Device';
                        currentRoom.clients.set(clientId, { ws, name: clientName, role: 'HOST' });
                        
                        ws.send(JSON.stringify({
                            type: 'ROOM_CREATED',
                            roomCode: newRoomCode,
                            clientId
                        }));
                        broadcastRoomState(currentRoom);
                        break;

                    case 'JOIN_ROOM':
                        const joinCode = (data.roomCode || '').toUpperCase();
                        if (rooms.has(joinCode)) {
                            currentRoom = rooms.get(joinCode);
                            clientName = data.deviceName || 'Client Device';
                            currentRoom.clients.set(clientId, { ws, name: clientName, role: 'CLIENT' });
                            
                            ws.send(JSON.stringify({
                                type: 'ROOM_JOINED',
                                roomCode: joinCode,
                                clientId,
                                playbackState: currentRoom.playbackState
                            }));
                            broadcastRoomState(currentRoom);
                        } else {
                            ws.send(JSON.stringify({ type: 'ERROR', message: 'Room not found' }));
                        }
                        break;

                    case 'LEAVE_ROOM':
                        if (currentRoom) {
                            currentRoom.clients.delete(clientId);
                            if (currentRoom.clients.size === 0) {
                                rooms.delete(currentRoom.roomCode);
                            } else {
                                if (currentRoom.hostId === clientId) {
                                    // Assign new host randomly
                                    const nextClient = currentRoom.clients.keys().next().value;
                                    currentRoom.hostId = nextClient;
                                    currentRoom.clients.get(nextClient).role = 'HOST';
                                }
                                broadcastRoomState(currentRoom);
                            }
                            currentRoom = null;
                        }
                        break;

                    case 'SYNC_PLAY':
                        if (currentRoom && currentRoom.hostId === clientId) {
                            currentRoom.playbackState.track = data.track || currentRoom.playbackState.track;
                            currentRoom.playbackState.position = data.position;
                            currentRoom.playbackState.playing = true;
                            currentRoom.playbackState.updatedAt = Date.now();
                            if (data.queueSeq != null) currentRoom.playbackState.queueSeq = data.queueSeq;
                            if (data.queueIndex != null) currentRoom.playbackState.queueIndex = data.queueIndex;
                            if (data.queueLength != null) currentRoom.playbackState.queueLength = data.queueLength;
                            
                            // Schedule 2000ms in future
                            const startAt = Date.now() + 2000;
                            
                            broadcastToRoom(currentRoom, {
                                type: 'PLAY',
                                track: currentRoom.playbackState.track,
                                position: data.position,
                                queueSeq: currentRoom.playbackState.queueSeq,
                                queueIndex: currentRoom.playbackState.queueIndex,
                                queueLength: currentRoom.playbackState.queueLength,
                                startAt: startAt,
                                serverTime: Date.now()
                            });
                        }
                        break;

                    case 'SYNC_PAUSE':
                        if (currentRoom && currentRoom.hostId === clientId) {
                            currentRoom.playbackState.position = data.position;
                            currentRoom.playbackState.playing = false;
                            currentRoom.playbackState.updatedAt = Date.now();
                            if (data.queueSeq != null) currentRoom.playbackState.queueSeq = data.queueSeq;
                            if (data.queueIndex != null) currentRoom.playbackState.queueIndex = data.queueIndex;
                            if (data.queueLength != null) currentRoom.playbackState.queueLength = data.queueLength;
                            
                            // Schedule 500ms in future for pause (less latency needed)
                            const applyAt = Date.now() + 500;
                            
                            broadcastToRoom(currentRoom, {
                                type: 'PAUSE',
                                position: data.position,
                                queueSeq: currentRoom.playbackState.queueSeq,
                                queueIndex: currentRoom.playbackState.queueIndex,
                                queueLength: currentRoom.playbackState.queueLength,
                                applyAt: applyAt,
                                serverTime: Date.now()
                            });
                        }
                        break;
                        
                    case 'SYNC_SEEK':
                        if (currentRoom && currentRoom.hostId === clientId) {
                            currentRoom.playbackState.position = data.position;
                            currentRoom.playbackState.updatedAt = Date.now();
                            if (data.queueSeq != null) currentRoom.playbackState.queueSeq = data.queueSeq;
                            if (data.queueIndex != null) currentRoom.playbackState.queueIndex = data.queueIndex;
                            if (data.queueLength != null) currentRoom.playbackState.queueLength = data.queueLength;
                            
                            const applyAt = Date.now() + 500;
                            
                            broadcastToRoom(currentRoom, {
                                type: 'SEEK',
                                position: data.position,
                                queueSeq: currentRoom.playbackState.queueSeq,
                                queueIndex: currentRoom.playbackState.queueIndex,
                                queueLength: currentRoom.playbackState.queueLength,
                                applyAt: applyAt,
                                serverTime: Date.now()
                            });
                        }
                        break;
                        
                    case 'TRACK_CHANGE':
                        if (currentRoom && currentRoom.hostId === clientId) {
                            currentRoom.playbackState.track = data.track;
                            currentRoom.playbackState.position = 0;
                            currentRoom.playbackState.playing = false;
                            currentRoom.playbackState.updatedAt = Date.now();
                            if (data.queueSeq != null) currentRoom.playbackState.queueSeq = data.queueSeq;
                            if (data.queueIndex != null) currentRoom.playbackState.queueIndex = data.queueIndex;
                            if (data.queueLength != null) currentRoom.playbackState.queueLength = data.queueLength;
                            
                            broadcastToRoom(currentRoom, {
                                type: 'LOAD_TRACK',
                                track: data.track,
                                queueSeq: currentRoom.playbackState.queueSeq,
                                queueIndex: currentRoom.playbackState.queueIndex,
                                queueLength: currentRoom.playbackState.queueLength,
                                serverTime: Date.now()
                            });
                        }
                        break;

                    case 'SET_QUEUE':
                        // Step 6: Keep heavy queue array out of high-frequency playback ticks
                        if (currentRoom && currentRoom.hostId === clientId) {
                            currentRoom.queueItems = Array.isArray(data.items) ? data.items : [];
                            currentRoom.playbackState.queueSeq = data.queueSeq || ((currentRoom.playbackState.queueSeq || 0) + 1);
                            currentRoom.playbackState.queueIndex = data.queueIndex ?? 0;
                            currentRoom.playbackState.queueLength = currentRoom.queueItems.length;

                            broadcastToRoom(currentRoom, {
                                type: 'QUEUE_METADATA',
                                queueSeq: currentRoom.playbackState.queueSeq,
                                queueLength: currentRoom.queueItems.length,
                                queueIndex: currentRoom.playbackState.queueIndex
                            });
                        }
                        break;

                    case 'REQUEST_FULL_QUEUE':
                        // Client requests full queue payload when queueSeq mismatches
                        if (currentRoom) {
                            ws.send(JSON.stringify({
                                type: 'FULL_QUEUE_RESPONSE',
                                queueSeq: currentRoom.playbackState.queueSeq || 0,
                                queueIndex: currentRoom.playbackState.queueIndex || 0,
                                items: currentRoom.queueItems || []
                            }));
                        }
                        break;
                }
            } catch (e) {
                console.error('WebSocket parse error:', e);
            }
        });

        ws.on('close', () => {
            if (currentRoom) {
                currentRoom.clients.delete(clientId);
                if (currentRoom.clients.size === 0) {
                    rooms.delete(currentRoom.roomCode);
                } else {
                    if (currentRoom.hostId === clientId) {
                        const nextClient = currentRoom.clients.keys().next().value;
                        currentRoom.hostId = nextClient;
                        currentRoom.clients.get(nextClient).role = 'HOST';
                    }
                    broadcastRoomState(currentRoom);
                }
            }
        });
    });

    function broadcastRoomState(room) {
        const clientsArray = [];
        room.clients.forEach((client, id) => {
            clientsArray.push({ id, name: client.name, role: client.role });
        });

        broadcastToRoom(room, {
            type: 'ROOM_STATE',
            roomCode: room.roomCode,
            hostId: room.hostId,
            clients: clientsArray
        });
    }

    function broadcastToRoom(room, message) {
        const msgStr = JSON.stringify(message);
        room.clients.forEach(client => {
            if (client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(msgStr);
            }
        });
    }
}

module.exports = setupSyncRoomManager;
