class SyncManager {
    constructor() {
        this.ws = null;
        this.roomCode = null;
        this.clientId = null;
        this.role = null;
        this.clockOffset = 0; // serverTime = localTime + clockOffset
        this.isConnected = false;
        this.pingInterval = null;
        this.pingSamples = [];
        this.listeners = {};
    }

    on(event, callback) {
        if (!this.listeners[event]) this.listeners[event] = [];
        this.listeners[event].push(callback);
    }

    emit(event, data) {
        if (this.listeners[event]) {
            this.listeners[event].forEach(cb => cb(data));
        }
    }

    connect() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}`;
        
        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            this.isConnected = true;
            this.emit('connection_change', true);
            this.startClockSync();
        };

        this.ws.onclose = () => {
            this.isConnected = false;
            this.emit('connection_change', false);
            clearInterval(this.pingInterval);
            setTimeout(() => {
                if (this.roomCode) this.connect(); // Try reconnect
            }, 3000);
        };

        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleMessage(data);
            } catch (e) {
                console.error('WebSocket parse error', e);
            }
        };
    }

    startClockSync() {
        // Send initial burst
        for (let i = 0; i < 5; i++) {
            setTimeout(() => this.sendPing(), i * 200);
        }
        
        this.pingInterval = setInterval(() => this.sendPing(), 5000);
    }

    sendPing() {
        if (!this.isConnected) return;
        this.ws.send(JSON.stringify({ type: 'PING', clientTime: Date.now() }));
    }

    handleMessage(data) {
        switch (data.type) {
            case 'PONG':
                const now = Date.now();
                const rtt = now - data.clientTime;
                const estimatedServerTime = data.serverTime + (rtt / 2);
                const offset = estimatedServerTime - now;
                
                this.pingSamples.push({ rtt, offset });
                if (this.pingSamples.length > 10) this.pingSamples.shift();
                
                // Use the offset from the sample with the lowest RTT
                this.pingSamples.sort((a, b) => a.rtt - b.rtt);
                this.clockOffset = this.pingSamples[0].offset;
                break;

            case 'ROOM_CREATED':
            case 'ROOM_JOINED':
                this.roomCode = data.roomCode;
                this.clientId = data.clientId;
                if (data.type === 'ROOM_JOINED' && data.playbackState) {
                    this.emit('sync_state_received', data.playbackState);
                }
                break;

            case 'ROOM_STATE':
                this.emit('room_state_update', data);
                const me = data.clients.find(c => c.id === this.clientId);
                if (me) this.role = me.role;
                break;

            case 'PLAY':
            case 'PAUSE':
            case 'SEEK':
            case 'LOAD_TRACK':
                this.emit('playback_command', data);
                // Check if queueSeq mismatches (Step 6)
                if (data.queueSeq != null && window.playerQueueStore) {
                    const localSeq = window.playerQueueStore.getState().sequence;
                    if (localSeq !== data.queueSeq && this.role !== 'HOST') {
                        this.requestFullQueue();
                    }
                }
                break;

            case 'QUEUE_METADATA':
                if (window.playerQueueStore && this.role !== 'HOST') {
                    const localSeq = window.playerQueueStore.getState().sequence;
                    if (localSeq !== data.queueSeq) {
                        this.requestFullQueue();
                    }
                }
                this.emit('queue_metadata_received', data);
                break;

            case 'FULL_QUEUE_RESPONSE':
                if (window.playerQueueStore && Array.isArray(data.items) && this.role !== 'HOST') {
                    window.playerQueueStore.state.items = data.items.map(it => window.playerQueueStore._normalizeQueueItem(it));
                    window.playerQueueStore.state.sequence = data.queueSeq;
                    if (data.queueIndex != null) window.playerQueueStore.state.currentIndex = data.queueIndex;
                    window.playerQueueStore._notify();
                }
                this.emit('full_queue_received', data);
                break;
                
            case 'ERROR':
                alert(data.message);
                break;
        }
    }

    getServerTime() {
        return Date.now() + this.clockOffset;
    }

    createRoom(deviceName) {
        if (!this.isConnected) this.connect();
        setTimeout(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'CREATE_ROOM', deviceName }));
            }
        }, 500); // Give time to connect if fresh
    }

    joinRoom(roomCode, deviceName) {
        if (!this.isConnected) this.connect();
        setTimeout(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'JOIN_ROOM', roomCode, deviceName }));
            }
        }, 500);
    }

    leaveRoom() {
        if (this.isConnected && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'LEAVE_ROOM' }));
        }
        this.roomCode = null;
        this.role = null;
        this.ws.close();
    }

    syncPlay(track, position) {
        if (this.role === 'HOST' && this.isConnected) {
            const queueState = window.playerQueueStore ? window.playerQueueStore.getState() : {};
            this.ws.send(JSON.stringify({
                type: 'SYNC_PLAY',
                track,
                position,
                queueSeq: queueState.sequence || 0,
                queueIndex: queueState.currentIndex || 0,
                queueLength: (queueState.items || []).length
            }));
        }
    }

    syncPause(position) {
        if (this.role === 'HOST' && this.isConnected) {
            const queueState = window.playerQueueStore ? window.playerQueueStore.getState() : {};
            this.ws.send(JSON.stringify({
                type: 'SYNC_PAUSE',
                position,
                queueSeq: queueState.sequence || 0,
                queueIndex: queueState.currentIndex || 0,
                queueLength: (queueState.items || []).length
            }));
        }
    }

    syncSeek(position) {
        if (this.role === 'HOST' && this.isConnected) {
            const queueState = window.playerQueueStore ? window.playerQueueStore.getState() : {};
            this.ws.send(JSON.stringify({
                type: 'SYNC_SEEK',
                position,
                queueSeq: queueState.sequence || 0,
                queueIndex: queueState.currentIndex || 0,
                queueLength: (queueState.items || []).length
            }));
        }
    }

    sendQueue(items, queueSeq, queueIndex) {
        if (this.role === 'HOST' && this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                type: 'SET_QUEUE',
                items,
                queueSeq,
                queueIndex
            }));
        }
    }

    requestFullQueue() {
        if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'REQUEST_FULL_QUEUE' }));
        }
    }
}

window.syncManager = new SyncManager();
