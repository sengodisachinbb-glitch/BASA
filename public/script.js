// ============================================
// LIQUID MUSIC — Complete Application Engine
// ============================================

// 1. STATE & CONFIG
let savedPrevTracks = [];
try {
    savedPrevTracks = JSON.parse(localStorage.getItem('basa_previous_tracks') || '[]');
} catch (e) {}

let savedQueueTracks = [];
try {
    savedQueueTracks = JSON.parse(localStorage.getItem('basa_queue') || '[]');
} catch (e) {}

const state = {
    user: null,
    token: localStorage.getItem('basa_token') || localStorage.getItem('liquid_music_token'),
    currentView: 'home',
    currentPlaylistId: null,
    playlists: [],
    likedTrackIds: new Set(),
    queue: Array.isArray(savedQueueTracks) ? savedQueueTracks : [],
    queueIndex: -1,
    previousTracks: Array.isArray(savedPrevTracks) ? savedPrevTracks : [],
    isPlaying: false,
    shuffle: false,
    repeat: 'none',
    volume: parseInt(localStorage.getItem('basa_volume') || localStorage.getItem('liquid_music_volume') || '80'),
    searchTimeout: null,
    currentTrack: null,
    queueActiveTab: 'upnext',
};

function saveQueueState() {
    try {
        localStorage.setItem('basa_previous_tracks', JSON.stringify(state.previousTracks.slice(-50)));
        localStorage.setItem('basa_queue', JSON.stringify(state.queue.slice(0, 100)));
    } catch (e) {}
}

// Audio element replaced by YouTube IFrame API
// window.playbackManager is defined in youtubePlayer.js

// 2. API HELPER
async function api(endpoint, options = {}) {
    const headers = {};
    if (state.token) headers['Authorization'] = `Bearer ${state.token}`;

    if (!(options.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(`/api${endpoint}`, {
        ...options,
        headers: { ...headers, ...options.headers }
    });

    if (res.status === 204) return null;

    let data;
    try { data = await res.json(); }
    catch (e) { data = { error: 'Invalid response' }; }

    if (!res.ok) {
        if (res.status === 401) { logout(); }
        throw new Error(data.error || 'API error');
    }
    return data;
}

// 3. TOAST NOTIFICATIONS
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.style.cssText = `
        padding: 12px 24px; border-radius: 12px; font-size: 13px; color: #fff;
        background: rgba(20,20,30,0.85); backdrop-filter: blur(16px);
        border: 1px solid rgba(255,255,255,0.08); min-width: 240px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.3);
        border-left: 3px solid ${type === 'error' ? '#ff6b6b' : type === 'success' ? '#71ffba' : '#7b6eff'};
        transform: translateX(120%); transition: transform 0.4s cubic-bezier(0.2,0.8,0.2,1), opacity 0.3s;
    `;
    toast.textContent = message;
    container.appendChild(toast);

    requestAnimationFrame(() => { toast.style.transform = 'translateX(0)'; });

    setTimeout(() => {
        toast.style.transform = 'translateX(120%)';
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 400);
    }, 3000);
}

// 4. ROUTER
function navigate(hash) {
    window.location.hash = hash;
}

function showView(viewId) {
    document.querySelectorAll('.view').forEach(v => {
        v.style.display = v.id === viewId ? 'block' : 'none';
        v.classList.toggle('active', v.id === viewId);
    });
    state.currentView = viewId.replace('view-', '');

    document.querySelectorAll('.sidebar-nav a').forEach(link => {
        link.classList.toggle('active', link.getAttribute('href') === `#${state.currentView}`);
    });
}

function setupRouter() {
    function handleRoute() {
        const hash = window.location.hash || '#home';

        if (hash === '#home') {
            showView('view-home');
            loadHome();
        } else if (hash === '#search') {
            showView('view-search');
        } else if (hash === '#library') {
            showView('view-library');
            loadLibrary();
        } else if (hash === '#uploads') {
            showView('view-uploads');
            loadUploads();
        } else if (hash === '#sync') {
            showView('view-sync');
        } else if (hash === '#telegram') {
            showView('view-telegram');
            loadTelegramVault();
        } else if (hash.startsWith('#playlist/')) {
            const id = hash.split('/')[1];
            showView('view-playlist');
            loadPlaylist(id);
        }
    }
    window.addEventListener('hashchange', handleRoute);
}

// 5. AUTH MODULE
async function initAuth() {
    if (state.token) {
        try {
            const data = await api('/auth/me');
            state.user = data.user;
            updateAuthUI();
            loadPlaylists();
        } catch (err) {
            state.token = null;
            localStorage.removeItem('liquid_music_token');
            updateAuthUI();
        }
    } else {
        updateAuthUI();
    }
}

function showAuthModal(mode = 'login') {
    const modal = document.getElementById('auth-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.style.display = 'grid';

    const title = document.getElementById('auth-modal-title');
    const signupFields = document.getElementById('signup-fields');
    const submitBtn = document.getElementById('auth-submit');
    const switchText = document.getElementById('auth-switch-text');
    const switchBtn = document.getElementById('auth-switch-btn');
    const form = document.getElementById('auth-form');

    if (form) form.dataset.mode = mode;

    if (mode === 'login') {
        if (title) title.textContent = 'Sign In';
        if (signupFields) signupFields.classList.add('hidden');
        if (submitBtn) submitBtn.textContent = 'Sign In';
        if (switchText) switchText.textContent = "Don't have an account?";
        if (switchBtn) switchBtn.textContent = 'Sign Up';
    } else {
        if (title) title.textContent = 'Create Account';
        if (signupFields) signupFields.classList.remove('hidden');
        if (submitBtn) submitBtn.textContent = 'Create Account';
        if (switchText) switchText.textContent = 'Already have an account?';
        if (switchBtn) switchBtn.textContent = 'Sign In';
    }
}

function hideAuthModal() {
    const modal = document.getElementById('auth-modal');
    if (modal) { modal.style.display = 'none'; modal.classList.add('hidden'); }
}

async function handleAuthSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const mode = form.dataset.mode || 'login';
    const email = document.getElementById('auth-email')?.value;
    const password = document.getElementById('auth-password')?.value;
    const username = document.getElementById('auth-username')?.value;
    const errorEl = document.getElementById('auth-error');

    if (errorEl) { errorEl.classList.add('hidden'); errorEl.textContent = ''; }

    const body = { email, password };
    if (mode === 'signup') body.username = username;

    try {
        const data = await api(`/auth/${mode}`, {
            method: 'POST',
            body: JSON.stringify(body)
        });
        loginUser(data.token, data.user);
        hideAuthModal();
        form.reset();
        showToast(`Welcome${data.user.username ? ', ' + data.user.username : ''}!`, 'success');
    } catch (err) {
        if (errorEl) { errorEl.textContent = err.message; errorEl.classList.remove('hidden'); }
        showToast(err.message, 'error');
    }
}

function loginUser(token, user) {
    state.token = token;
    state.user = user;
    localStorage.setItem('liquid_music_token', token);
    updateAuthUI();
    loadPlaylists();
    loadHome();
}

function logout() {
    state.token = null;
    state.user = null;
    state.playlists = [];
    state.likedTrackIds.clear();
    localStorage.removeItem('liquid_music_token');
    updateAuthUI();
    updatePlaylistSidebar();

    if (state.currentView === 'library' || state.currentView === 'uploads') {
        navigate('#home');
    }
}

function updateAuthUI() {
    const authBtn = document.getElementById('auth-btn');
    const userMenu = document.getElementById('user-menu');
    const userName = document.getElementById('user-name');
    const userAvatar = document.getElementById('user-avatar');
    const uploadNavBtn = document.getElementById('upload-nav-btn');

    if (state.user) {
        if (authBtn) authBtn.style.display = 'none';
        if (userMenu) { userMenu.style.display = 'flex'; userMenu.classList.remove('hidden'); }
        if (userName) userName.textContent = state.user.username || state.user.email;
        if (userAvatar) userAvatar.textContent = (state.user.username || 'U')[0].toUpperCase();
        if (uploadNavBtn) uploadNavBtn.style.display = 'inline-flex';
    } else {
        if (authBtn) authBtn.style.display = 'inline-flex';
        if (userMenu) { userMenu.style.display = 'none'; userMenu.classList.add('hidden'); }
        if (uploadNavBtn) uploadNavBtn.style.display = 'none';
    }
}

// 6. SEARCH
function setupSearch() {
    const searchInput = document.getElementById('search-input');
    const qualityFilter = document.getElementById('quality-filter');
    if (!searchInput) return;

    if (qualityFilter) {
        qualityFilter.addEventListener('change', () => {
            const query = searchInput.value.trim();
            if (query.length > 0) searchMusic(query);
            else if (state.currentView === 'home') loadHome();
        });
    }

    searchInput.addEventListener('input', (e) => {
        clearTimeout(state.searchTimeout);
        const query = e.target.value.trim();
        if (query.length > 0) {
            if (state.currentView !== 'search') navigate('#search');
            state.searchTimeout = setTimeout(() => searchMusic(query), 400);
        }
    });

    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            clearTimeout(state.searchTimeout);
            const q = e.target.value.trim();
            if (q) { navigate('#search'); searchMusic(q); }
        }
    });
}

function filterTracksByQuality(tracks, qualityPreference) {
    if (qualityPreference === 'AUTO' || !qualityPreference) return tracks;
    
    return tracks.filter(t => {
        const effectiveQuality = t.quality || 'SOURCE_DEPENDENT'; 
        
        if (qualityPreference === 'HI_RES_LOSSLESS') {
            return effectiveQuality === 'HI_RES_LOSSLESS';
        }
        if (qualityPreference === 'LOSSLESS') {
            return effectiveQuality === 'LOSSLESS' || effectiveQuality === 'HI_RES_LOSSLESS';
        }
        if (qualityPreference === 'HIGH') {
            return effectiveQuality === 'HIGH' || effectiveQuality === 'LOSSLESS' || effectiveQuality === 'HI_RES_LOSSLESS';
        }
        return true;
    });
}

function rankAutoTracks(tracks, query) {
    // For AUTO: Put high quality local files matching query ahead of YouTube 
    const q = (query || '').toLowerCase();
    return tracks.sort((a, b) => {
        const aTitle = (a.title || '').toLowerCase();
        const bTitle = (b.title || '').toLowerCase();
        const aMatch = aTitle.includes(q) ? 1 : 0;
        const bMatch = bTitle.includes(q) ? 1 : 0;
        
        // Both match relevance similarly
        if (aMatch === bMatch) {
            const qScore = { 'HI_RES_LOSSLESS': 4, 'LOSSLESS': 3, 'HIGH': 2, 'STANDARD': 1, 'SOURCE_DEPENDENT': 0, 'UNKNOWN': 0 };
            const aQ = qScore[a.quality || 'SOURCE_DEPENDENT'] || 0;
            const bQ = qScore[b.quality || 'SOURCE_DEPENDENT'] || 0;
            return bQ - aQ;
        }
        return bMatch - aMatch;
    });
}

async function searchMusic(query) {
    const container = document.getElementById('search-results');
    const qualityFilter = document.getElementById('quality-filter');
    const selectedQuality = qualityFilter ? qualityFilter.value : 'AUTO';
    
    if (!container) return;

    container.innerHTML = '<div class="loader">Searching...</div>';
    try {
        let musicTracks = [];
        let localTracks = [];
        
        try {
            const searchData = await api(`/music/search?q=${encodeURIComponent(query)}&source=all&limit=30`);
            musicTracks = searchData.data || [];
        } catch (e) { console.error("Search Error", e); }
        
        if (state.user) {
            try {
                const localData = await api('/upload/tracks');
                const qLower = query.toLowerCase();
                localTracks = (localData.tracks || []).filter(t => 
                    (t.title && t.title.toLowerCase().includes(qLower)) || 
                    (t.artist && t.artist.toLowerCase().includes(qLower))
                ).map(t => ({...t, source: 'local'}));
            } catch (e) { console.error("Local Search Error", e); }
        }

        let allTracks = [...localTracks, ...musicTracks];
        
        if (selectedQuality === 'AUTO') {
            allTracks = rankAutoTracks(allTracks, query);
        }
        
        const filteredTracks = filterTracksByQuality(allTracks, selectedQuality);
        
        if (filteredTracks.length > 0) {
            window.currentSearchTracks = filteredTracks;
            container.innerHTML = filteredTracks.map((t, idx) => renderTrackCard(t, t.source, idx, 'search')).join('');
        } else {
            if (selectedQuality !== 'AUTO') {
                container.innerHTML = `
                    <div class="empty-state">
                        <div style="margin-bottom:10px;">No ${selectedQuality.replace('_', ' ').toLowerCase()} version available.</div>
                        <button class="button button-primary" onclick="document.getElementById('quality-filter').value='AUTO'; searchMusic('${query.replace(/'/g, "\\'")}');">Play best available</button>
                    </div>`;
            } else {
                container.innerHTML = '<div class="empty-state">No results found. Try a different search.</div>';
            }
        }
    } catch (err) {
        container.innerHTML = '<div class="empty-state">Search failed. Please try again.</div>';
    }
}

// 7. HOME VIEW
async function loadHome() {
    const chartsGrid = document.getElementById('charts-grid');
    const losslessGrid = document.getElementById('lossless-grid');
    const recentGrid = document.getElementById('recent-grid');

    if (chartsGrid) {
        chartsGrid.innerHTML = '<div class="loader">Loading trending music...</div>';
        try {
            const data = await api('/music/charts?limit=20');
            let tracks = data.data || [];
            
            const qualityFilter = document.getElementById('quality-filter');
            const selectedQuality = qualityFilter ? qualityFilter.value : 'AUTO';
            
            tracks = filterTracksByQuality(tracks, selectedQuality);
            if (tracks.length > 0) {
                window.currentChartsTracks = tracks;
                chartsGrid.innerHTML = tracks.map((t, idx) => renderTrackCard(t, t.source || 'youtube', idx, 'charts')).join('');
            } else {
                chartsGrid.innerHTML = '<div class="empty-state">No trending tracks available matching the quality filter.</div>';
            }
        } catch (err) {
            chartsGrid.innerHTML = '<div class="empty-state">Could not load charts. Try searching instead.</div>';
        }
    }

    if (losslessGrid) {
        losslessGrid.innerHTML = '<div class="loader">Loading Hi-Fi &amp; Lossless music...</div>';
        try {
            const data = await api('/music/lossless?limit=12');
            const tracks = data.data || [];
            if (tracks.length > 0) {
                window.currentLosslessTracks = tracks;
                losslessGrid.innerHTML = tracks.map((t, idx) => renderTrackCard(t, t.source, idx, 'lossless')).join('');
            } else {
                losslessGrid.innerHTML = '<div class="empty-state">No lossless tracks available yet. Search Internet Archive or sync Telegram audio.</div>';
            }
        } catch (e) {
            console.error('Lossless loading error', e);
            losslessGrid.innerHTML = '<div class="empty-state">Unable to load lossless collection.</div>';
        }
    }

    if (recentGrid && state.token) {
        try {
            const data = await api('/library/history?limit=10');
            let tracks = data.tracks || [];
            // Handle legacy data: filter out tracks without id/videoId and filter out Shorts
            tracks = tracks.filter(item => item.track_data && (item.track_data.videoId || item.track_data.id) && !isShortTrack(item.track_data));
            if (tracks.length > 0) {
                recentGrid.innerHTML = tracks.map((item, idx) => renderTrackCard(item.track_data, item.track_source, idx, 'recent')).join('');
            } else {
                recentGrid.innerHTML = '<p class="empty-state">Your recently played tracks will appear here</p>';
            }
        } catch (err) {
            recentGrid.innerHTML = '<p class="empty-state">Your recently played tracks will appear here</p>';
        }
    }
}

// 8. TRACK RENDERING
function mapTrackToStandard(track, source = 'youtube') {
    let id, cover, title, artist, preview, audioUrl, fallbackUrl;
    const effectiveSource = track.source || source || 'youtube';

    if (effectiveSource === 'local') {
        id = track.id;
        cover = track.cover_url ? `/api/upload/cover/${track.id}?token=${state.token || ''}` : (track.cover || '');
        title = track.title || 'Unknown';
        artist = track.artist || 'Unknown Artist';
        preview = track.preview || `/api/upload/stream/${track.id}?token=${state.token || ''}`;
        audioUrl = preview;
    } else if (effectiveSource === 'telegram') {
        id = track.id;
        cover = track.cover || track.cover_url || `/api/telegram/cover/${track.id}`;
        title = track.title || 'Unknown Title';
        artist = track.artist || 'Unknown Artist';
        preview = track.preview || track.audioUrl || `/api/telegram/stream/${track.id}`;
        audioUrl = `/api/telegram/stream/${track.id}`;
    } else if (effectiveSource === 'archive') {
        id = track.id || track.sourceId || track.archive_identifier;
        cover = track.cover || track.cover_url || (track.archive_identifier ? `https://archive.org/services/img/${track.archive_identifier}` : '');
        title = track.title || 'Unknown Title';
        artist = track.artist || 'Internet Archive';
        preview = track.preview || track.audioUrl || track.audio_url || '';
        audioUrl = track.audioUrl || track.audio_url || preview;
        fallbackUrl = track.fallbackUrl || track.fallback_url || null;
    } else {
        id = track.id || track.videoId;
        cover = track.cover || track.artwork?.['480x480'] || track.artwork?.['150x150'] || track.artwork || '';
        title = track.title || 'Unknown';
        artist = track.user?.name || track.artist || 'Unknown Artist';
        preview = track.videoId || track.preview || track.id;
        audioUrl = preview;
    }

    return { 
        id, title, artist, album: track.album?.title || track.album || '', cover, preview,
        audioUrl, fallbackUrl, source: effectiveSource,
        sourceId: track.sourceId || track.archive_identifier || id,
        quality: track.quality, format: track.format, codec: track.codec, lossless: track.lossless,
        sampleRate: track.sampleRate || track.sample_rate, 
        bitDepth: track.bitDepth || track.bit_depth, 
        bitrate: track.bitrate,
        license: track.license, licenseUrl: track.licenseUrl || track.license_url,
        rightsStatus: track.rightsStatus || track.rights_status,
        status: track.status,
        isCached: track.isCached !== undefined ? track.isCached : (effectiveSource !== 'telegram' ? true : false),
        sourceName: track.sourceName,
        sourcePriority: track.sourcePriority,
        qualityRankBadge: track.qualityRankBadge
    };
}

function renderTrackCard(track, source = 'youtube', index = -1, contextType = '') {
    const trackObj = mapTrackToStandard(track, source);
    const encoded = encodeURIComponent(JSON.stringify(trackObj));

    const coverHtml = trackObj.cover
        ? `<img src="${trackObj.cover}" alt="${trackObj.title}" loading="lazy" onerror="this.style.display='none'">`
        : `<div style="width:100%;height:100%;display:grid;place-items:center;font-size:32px;opacity:0.2">🎵</div>`;

    const clickCall = index >= 0 && contextType
        ? `playTrackFromData('${encoded}', '${contextType}', ${index})`
        : `playTrackFromData('${encoded}')`;

    return `
    <div class="track-card glass-subtle" onclick="${clickCall}">
        <div class="track-card-cover">
            ${coverHtml}
            <div class="track-card-play"><div class="track-card-play-btn">▶</div></div>
            <button class="track-card-queue-btn" onclick="event.stopPropagation();addToQueueFromData('${encoded}')" title="Add to Queue" aria-label="Add to Queue">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            </button>
        </div>
        <div class="track-card-info">
            <div class="track-card-title">${escapeHtml(trackObj.title)}</div>
            <div class="track-card-artist">${escapeHtml(trackObj.artist)}</div>
            ${renderQualityBadge(trackObj)}
        </div>
    </div>`;
}

function renderQualityBadge(track) {
    if (!track) return '';
    let badgeText = '';
    let badgeClass = 'badge-standard';
    
    if (track.source === 'youtube') {
        badgeText = 'YouTube · SOURCE DEPENDENT';
    } else if (track.source === 'archive') {
        const formatStr = track.format ? track.format.toUpperCase() : 'FLAC';
        const spec = (track.bitDepth && track.sampleRate) ? ` · ${track.bitDepth}-bit / ${Math.round(track.sampleRate / 1000)} kHz` : '';
        if (track.quality === 'HI_RES_LOSSLESS') {
            badgeText = `HI-RES LOSSLESS · ${formatStr}${spec} · CC LICENSE`;
            badgeClass = 'badge-gold';
        } else {
            badgeText = `LOSSLESS · ${formatStr}${spec} · CC LICENSE`;
            badgeClass = 'badge-gold';
        }
    } else if (track.source === 'telegram') {
        const formatStr = track.format ? track.format.toUpperCase() : 'AUDIO';
        const spec = (track.bitDepth && track.sampleRate) ? ` · ${track.bitDepth}-bit / ${Math.round(track.sampleRate / 1000)} kHz` : '';
        const cacheTag = track.isCached ? ' · READY' : ' · ON-DEMAND';
        if (track.quality === 'HI_RES_LOSSLESS') {
            badgeText = `HI-RES LOSSLESS · ${formatStr}${spec} · TELEGRAM VAULT${cacheTag}`;
            badgeClass = 'badge-gold';
        } else if (track.quality === 'LOSSLESS') {
            badgeText = `LOSSLESS · ${formatStr}${spec} · TELEGRAM VAULT${cacheTag}`;
            badgeClass = 'badge-gold';
        } else if (track.quality === 'HIGH' && track.bitrate) {
            badgeText = `${formatStr} · ${Math.round(track.bitrate / 1000)} kbps · TELEGRAM VAULT${cacheTag}`;
            badgeClass = 'badge-standard';
        } else {
            badgeText = `${formatStr} · TELEGRAM VAULT${cacheTag}`;
            badgeClass = 'badge-standard';
        }
    } else {
        const formatStr = track.format ? track.format.toUpperCase() : 'UNKNOWN';
        if (track.quality === 'HI_RES_LOSSLESS') {
            const spec = (track.bitDepth && track.sampleRate) ? ` · ${track.bitDepth}-bit / ${Math.round(track.sampleRate / 1000)} kHz` : '';
            badgeText = `${formatStr} · HI-RES LOSSLESS${spec}`;
            badgeClass = 'badge-gold';
        } else if (track.quality === 'LOSSLESS') {
            const spec = (track.bitDepth && track.sampleRate) ? ` · ${track.bitDepth}-bit / ${Math.round(track.sampleRate / 1000)} kHz` : '';
            badgeText = `${formatStr} · LOSSLESS${spec}`;
            badgeClass = 'badge-gold';
        } else if (track.quality === 'HIGH' && track.bitrate) {
            badgeText = `${formatStr} · ${Math.round(track.bitrate / 1000)} kbps`;
        } else if (track.quality && track.quality !== 'UNKNOWN') {
            badgeText = `${formatStr} · ${track.quality}`;
        } else if (formatStr !== 'UNKNOWN') {
            badgeText = formatStr;
        }
    }
    
    if (!badgeText || badgeText === 'UNKNOWN') return '';
    return `<div class="quality-badge ${badgeClass}">${escapeHtml(badgeText)}</div>`;
}

function renderTrackListItem(track, index, source, options = {}) {
    const trackObj = mapTrackToStandard(track, source);
    const encoded = encodeURIComponent(JSON.stringify(trackObj));
    const isLiked = state.likedTrackIds.has(String(trackObj.id));

    let actions = `
        <button class="track-action-btn ${isLiked ? 'liked' : ''}" onclick="event.stopPropagation();toggleLike('${trackObj.id}','${trackObj.source}','${encoded}')" title="Like">${isLiked ? '♥' : '♡'}</button>
        <button class="track-action-btn" onclick="event.stopPropagation();addToQueueFromData('${encoded}')" title="Add to Queue">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>
        </button>
        <button class="track-action-btn" onclick="event.stopPropagation();showAddToPlaylist(event,'${trackObj.id}','${trackObj.source}','${encoded}')" title="Add to playlist">+</button>
    `;
    if (options.isUpload) {
        actions += `<button class="track-action-btn" onclick="event.stopPropagation();deleteUpload('${trackObj.id}')" title="Delete">🗑</button>`;
    }
    if (options.playlistEntryId) {
        actions += `<button class="track-action-btn" onclick="event.stopPropagation();removeFromPlaylist('${options.playlistId}','${options.playlistEntryId}')" title="Remove">✕</button>`;
    }

    const clickCall = options.contextType
        ? `playTrackFromData('${encoded}', '${options.contextType}', ${index})`
        : `playTrackFromData('${encoded}')`;

    return `
    <div class="track-list-item" onclick="${clickCall}">
        <span class="track-list-num">${index + 1}</span>
        <img class="track-list-cover" src="${trackObj.cover || ''}" alt="" loading="lazy" onerror="this.style.opacity='0.1'">
        <div class="track-list-info">
            <span class="track-list-title">${escapeHtml(trackObj.title)}</span>
            <div class="track-list-artist-row">
                <span class="track-list-artist">${escapeHtml(trackObj.artist)}</span>
                ${renderQualityBadge(trackObj)}
            </div>
        </div>
        <span class="track-list-album">${escapeHtml(trackObj.album)}</span>
        <span class="track-list-duration">${formatDuration(track.duration || 0)}</span>
        <div class="track-list-actions">${actions}</div>
    </div>`;
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// 7.5. SHORTS FILTERING
function isShortTrack(trackData) {
    if (!trackData) return false;
    if (trackData.source !== 'youtube') return false; // Only filter YouTube shorts, preserve lossless audio
    
    const title = (trackData.title || '').toLowerCase();
    const url = (trackData.url || trackData.preview || '').toLowerCase();
    
    if (title.includes('shorts') || title.includes('#shorts') || title.includes('youtube short')) return true;
    if (url.includes('/shorts/')) return true;
    
    return false;
}

// 9. AUDIO PLAYER ENGINE & QUEUE
function playTrackFromData(encodedData, contextType = null, index = -1) {
    try {
        const trackData = JSON.parse(decodeURIComponent(encodedData));
        
        let contextList = null;
        if (contextType === 'charts' && window.currentChartsTracks) {
            contextList = window.currentChartsTracks.map(t => mapTrackToStandard(t, t.source || 'youtube'));
        } else if (contextType === 'lossless' && window.currentLosslessTracks) {
            contextList = window.currentLosslessTracks.map(t => mapTrackToStandard(t, t.source));
        } else if (contextType === 'search' && window.currentSearchTracks) {
            contextList = window.currentSearchTracks.map(t => mapTrackToStandard(t, t.source));
        } else if (contextType === 'library' && window.currentLibraryTracks) {
            contextList = window.currentLibraryTracks.map(t => mapTrackToStandard(t, t.source));
        } else if (contextType === 'playlist' && window.currentPlaylistTracks) {
            contextList = window.currentPlaylistTracks.map(t => mapTrackToStandard(t, t.source));
        }

        if (contextList && contextList.length > 0 && index >= 0 && index < contextList.length) {
            playFromList(contextList, index);
        } else {
            // Standalone play: preserve existing upcoming queue if any, or start with this track
            state.queue = [trackData];
            state.queueIndex = 0;
            playTrack(trackData);
        }
    } catch (e) {
        console.error('Failed to parse track data', e);
    }
}

function playTrack(trackData, forceLocal = false, isBackwardNav = false) {
    if (!forceLocal && window.syncManager && window.syncManager.roomCode) {
        if (window.syncManager.role === 'HOST') {
            if (window.syncManager.ws && window.syncManager.ws.readyState === WebSocket.OPEN) {
                window.syncManager.ws.send(JSON.stringify({ type: 'TRACK_CHANGE', track: trackData }));
            }
        }
        return;
    }

    if (!trackData || (!trackData.preview && !trackData.videoId && !trackData.id)) {
        showToast('Stream URL not available', 'error');
        return;
    }

    // Save outgoing track into previousTracks (unless navigating backwards)
    if (state.currentTrack && state.currentTrack.id && String(state.currentTrack.id) !== String(trackData.id) && !isBackwardNav) {
        const lastPrev = state.previousTracks[state.previousTracks.length - 1];
        if (!lastPrev || String(lastPrev.id) !== String(state.currentTrack.id)) {
            state.previousTracks.push(state.currentTrack);
            if (state.previousTracks.length > 50) state.previousTracks.shift();
        }
    }

    state.currentTrack = trackData;
    saveQueueState();

    window.playbackManager.loadTrack(trackData);
    state.isPlaying = true;
    updatePlayerUI(trackData);
    renderQueueDrawer();

    if (state.token) {
        api('/library/history', {
            method: 'POST',
            body: JSON.stringify({
                track_id: String(trackData.id),
                track_source: trackData.source || 'youtube',
                track_data: trackData
            })
        }).catch(() => {});
        checkIfLiked(trackData.id, trackData.source || 'youtube');
    }
}

function playFromList(tracks, index = 0) {
    if (!tracks || tracks.length === 0) return;
    state.queue = tracks;
    state.queueIndex = Math.max(0, Math.min(index, tracks.length - 1));
    saveQueueState();
    playTrack(state.queue[state.queueIndex]);
}

function playNext() {
    if (state.repeat === 'one') {
        window.playbackManager.seekTo(0);
        window.playbackManager.play();
        return;
    }

    if (state.queue.length === 0) {
        state.isPlaying = false;
        updatePlayPauseButton();
        renderQueueDrawer();
        return;
    }

    let attempts = 0;
    while (attempts < state.queue.length) {
        if (state.shuffle) {
            state.queueIndex = Math.floor(Math.random() * state.queue.length);
        } else if (state.queueIndex < state.queue.length - 1) {
            state.queueIndex++;
        } else if (state.repeat === 'all') {
            state.queueIndex = 0;
        } else {
            // End of queue reached
            state.isPlaying = false;
            updatePlayPauseButton();
            renderQueueDrawer();
            return;
        }

        const nextTrack = state.queue[state.queueIndex];
        if (!isShortTrack(nextTrack)) {
            playTrack(nextTrack);
            return;
        }
        attempts++;
    }
}

function playPrev() {
    // 1. If playing > 3 seconds in, restart the song (standard music player UX)
    if (window.playbackManager && window.playbackManager.getCurrentTime() > 3) {
        window.playbackManager.seekTo(0);
        return;
    }

    // 2. If we are in an active queue list and not at the beginning:
    if (state.queueIndex > 0 && state.queue.length > 0) {
        let attempts = 0;
        while (attempts < state.queue.length) {
            if (state.queueIndex > 0) {
                state.queueIndex--;
            } else if (state.repeat === 'all') {
                state.queueIndex = state.queue.length - 1;
            } else {
                break;
            }
            const prevTrack = state.queue[state.queueIndex];
            if (!isShortTrack(prevTrack)) {
                playTrack(prevTrack, false, true);
                return;
            }
            attempts++;
        }
    }

    // 3. If at start of queue (or standalone song) and we have previous tracks in history:
    if (state.previousTracks && state.previousTracks.length > 0) {
        const prevTrack = state.previousTracks.pop();
        if (state.currentTrack) {
            if (state.queue.length === 0 || state.queue[state.queueIndex]?.id !== state.currentTrack.id) {
                state.queue = [prevTrack, state.currentTrack, ...state.queue];
            } else {
                state.queue.unshift(prevTrack);
            }
            state.queueIndex = 0;
        } else {
            state.queue.unshift(prevTrack);
            state.queueIndex = 0;
        }
        saveQueueState();
        playTrack(prevTrack, false, true);
        return;
    }

    // 4. Fallback: seek to beginning
    if (window.playbackManager) {
        window.playbackManager.seekTo(0);
    }
}

// ============================================
// QUEUE & PREVIOUS SONGS MANAGEMENT
// ============================================

function addToQueue(trackData) {
    if (!trackData) return;
    state.queue.push(trackData);
    saveQueueState();
    showToast(`Added "${trackData.title}" to Queue`, 'info');
    updateQueueBadge();
    renderQueueDrawer();
}

function addToQueueFromData(encodedData) {
    try {
        const trackData = JSON.parse(decodeURIComponent(encodedData));
        addToQueue(trackData);
    } catch (e) {
        console.error('Failed to add track to queue', e);
    }
}

function playNextInQueue(trackData) {
    if (!trackData) return;
    if (state.queue.length === 0 || state.queueIndex === -1) {
        state.queue = [trackData];
        state.queueIndex = 0;
        playTrack(trackData);
    } else {
        state.queue.splice(state.queueIndex + 1, 0, trackData);
        saveQueueState();
        showToast(`"${trackData.title}" will play next`, 'info');
        updateQueueBadge();
        renderQueueDrawer();
    }
}

function removeFromQueue(index) {
    if (index < 0 || index >= state.queue.length) return;
    if (index < state.queueIndex) {
        state.queueIndex--;
    } else if (index === state.queueIndex) {
        state.queueIndex = Math.max(0, state.queueIndex - 1);
    }
    state.queue.splice(index, 1);
    saveQueueState();
    updateQueueBadge();
    renderQueueDrawer();
    showToast('Removed from queue');
}

function clearQueue() {
    if (state.currentTrack) {
        state.queue = [state.currentTrack];
        state.queueIndex = 0;
    } else {
        state.queue = [];
        state.queueIndex = -1;
    }
    saveQueueState();
    updateQueueBadge();
    renderQueueDrawer();
    showToast('Upcoming queue cleared');
}

function clearPreviousTracks() {
    state.previousTracks = [];
    saveQueueState();
    updateQueueBadge();
    renderQueueDrawer();
    showToast('Previous tracks history cleared');
}

function replayPreviousTrack(index) {
    if (index < 0 || index >= state.previousTracks.length) return;
    const track = state.previousTracks[index];
    state.previousTracks.splice(index, 1);
    if (state.currentTrack) {
        state.queue.unshift(state.currentTrack);
        state.queueIndex = 0;
    }
    saveQueueState();
    playTrack(track, false, true);
    showToast(`Playing "${track.title}"`, 'info');
}

function playFromQueueIndex(index) {
    if (index < 0 || index >= state.queue.length) return;
    state.queueIndex = index;
    playTrack(state.queue[state.queueIndex]);
}

function updateQueueBadge() {
    const upnextCountEl = document.getElementById('queue-upnext-count');
    const historyCountEl = document.getElementById('queue-history-count');
    const queueBtn = document.getElementById('queue-btn');
    
    const upcomingCount = Math.max(0, state.queue.length - (state.queueIndex + 1));
    if (upnextCountEl) upnextCountEl.textContent = upcomingCount;
    if (historyCountEl) historyCountEl.textContent = state.previousTracks.length;

    if (queueBtn) {
        let dot = queueBtn.querySelector('.queue-btn-dot');
        if (upcomingCount > 0) {
            if (!dot) {
                dot = document.createElement('span');
                dot.className = 'queue-btn-dot';
                queueBtn.appendChild(dot);
            }
        } else if (dot) {
            dot.remove();
        }
    }
}

function toggleQueueDrawer() {
    const drawer = document.getElementById('queue-drawer');
    if (!drawer) return;
    const isHidden = drawer.classList.contains('hidden');
    if (isHidden) {
        openQueueDrawer();
    } else {
        closeQueueDrawer();
    }
}

function openQueueDrawer() {
    const drawer = document.getElementById('queue-drawer');
    const backdrop = document.getElementById('queue-drawer-backdrop');
    const queueBtn = document.getElementById('queue-btn');
    const fsQueueBtn = document.getElementById('fs-queue-btn');
    if (!drawer) return;
    drawer.classList.remove('hidden');
    if (backdrop) backdrop.classList.remove('hidden');
    if (queueBtn) queueBtn.classList.add('active');
    if (fsQueueBtn) fsQueueBtn.classList.add('active');
    renderQueueDrawer();
}

function closeQueueDrawer() {
    const drawer = document.getElementById('queue-drawer');
    const backdrop = document.getElementById('queue-drawer-backdrop');
    const queueBtn = document.getElementById('queue-btn');
    const fsQueueBtn = document.getElementById('fs-queue-btn');
    if (!drawer) return;
    drawer.classList.add('hidden');
    if (backdrop) backdrop.classList.add('hidden');
    if (queueBtn) queueBtn.classList.remove('active');
    if (fsQueueBtn) fsQueueBtn.classList.remove('active');
}

function switchQueueTab(tab) {
    state.queueActiveTab = tab;
    const tabUpnext = document.getElementById('queue-tab-upnext');
    const tabHistory = document.getElementById('queue-tab-history');
    const viewUpnext = document.getElementById('queue-view-upnext');
    const viewHistory = document.getElementById('queue-view-history');

    if (tab === 'upnext') {
        if (tabUpnext) tabUpnext.classList.add('active');
        if (tabHistory) tabHistory.classList.remove('active');
        if (viewUpnext) { viewUpnext.classList.remove('hidden'); viewUpnext.classList.add('active'); }
        if (viewHistory) { viewHistory.classList.add('hidden'); viewHistory.classList.remove('active'); }
    } else {
        if (tabHistory) tabHistory.classList.add('active');
        if (tabUpnext) tabUpnext.classList.remove('active');
        if (viewHistory) { viewHistory.classList.remove('hidden'); viewHistory.classList.add('active'); }
        if (viewUpnext) { viewUpnext.classList.add('hidden'); viewUpnext.classList.remove('active'); }
    }
    renderQueueDrawer();
}

function renderQueueDrawer() {
    updateQueueBadge();

    // 1. Now Playing Section
    const nowCard = document.getElementById('queue-now-playing-card');
    const nowCover = document.getElementById('queue-now-cover');
    const nowTitle = document.getElementById('queue-now-title');
    const nowArtist = document.getElementById('queue-now-artist');
    const nowBadge = document.getElementById('queue-now-badge');
    const eqBars = document.getElementById('queue-eq-bars');

    if (state.currentTrack) {
        if (nowCover) nowCover.src = state.currentTrack.cover || '';
        if (nowTitle) nowTitle.textContent = state.currentTrack.title || 'Unknown Title';
        if (nowArtist) nowArtist.textContent = state.currentTrack.artist || 'Unknown Artist';
        if (nowBadge) nowBadge.innerHTML = renderQualityBadge(state.currentTrack);
        if (eqBars) eqBars.style.display = state.isPlaying ? 'flex' : 'none';
        if (nowCard) nowCard.style.opacity = '1';
    } else {
        if (nowCover) nowCover.src = '';
        if (nowTitle) nowTitle.textContent = 'Not Playing';
        if (nowArtist) nowArtist.textContent = 'Select a track to start';
        if (nowBadge) nowBadge.innerHTML = '';
        if (eqBars) eqBars.style.display = 'none';
        if (nowCard) nowCard.style.opacity = '0.6';
    }

    // 2. Up Next List
    const upnextContainer = document.getElementById('queue-upnext-list');
    if (upnextContainer) {
        const upcomingTracks = [];
        for (let i = state.queueIndex + 1; i < state.queue.length; i++) {
            upcomingTracks.push({ track: state.queue[i], index: i });
        }

        if (upcomingTracks.length === 0) {
            upnextContainer.innerHTML = `
                <div class="queue-empty-state">
                    <div class="queue-empty-icon">🎵</div>
                    <p>No upcoming tracks in queue.</p>
                    <span style="font-size:11px;opacity:0.6;">Click "+ Queue" on any track to line it up next.</span>
                </div>
            `;
        } else {
            upnextContainer.innerHTML = upcomingTracks.map(({ track, index }) => {
                const cover = track.cover || '';
                return `
                    <div class="queue-item" onclick="playFromQueueIndex(${index})">
                        <div class="queue-item-thumb-wrap">
                            <img class="queue-item-thumb" src="${cover}" alt="" onerror="this.style.opacity='0.2'">
                            <div class="queue-item-play-overlay">▶</div>
                        </div>
                        <div class="queue-item-info">
                            <span class="queue-item-title">${escapeHtml(track.title || 'Unknown')}</span>
                            <span class="queue-item-artist">${escapeHtml(track.artist || 'Unknown Artist')}</span>
                        </div>
                        <div class="queue-item-actions">
                            <button class="queue-item-remove-btn" onclick="event.stopPropagation();removeFromQueue(${index})" title="Remove from Queue">✕</button>
                        </div>
                    </div>
                `;
            }).join('');
        }
    }

    // 3. Previous Songs (History) List
    const historyContainer = document.getElementById('queue-history-list');
    if (historyContainer) {
        if (!state.previousTracks || state.previousTracks.length === 0) {
            historyContainer.innerHTML = `
                <div class="queue-empty-state">
                    <div class="queue-empty-icon">🕒</div>
                    <p>No previous songs yet.</p>
                    <span style="font-size:11px;opacity:0.6;">Songs you finish or skip will appear here.</span>
                </div>
            `;
        } else {
            // Render in reverse order (most recently played at the top)
            const reversedHistory = state.previousTracks.slice().reverse();
            historyContainer.innerHTML = reversedHistory.map((track, revIdx) => {
                const realIdx = state.previousTracks.length - 1 - revIdx;
                const cover = track.cover || '';
                return `
                    <div class="queue-item" onclick="replayPreviousTrack(${realIdx})">
                        <div class="queue-item-thumb-wrap">
                            <img class="queue-item-thumb" src="${cover}" alt="" onerror="this.style.opacity='0.2'">
                            <div class="queue-item-play-overlay">↺</div>
                        </div>
                        <div class="queue-item-info">
                            <span class="queue-item-title">${escapeHtml(track.title || 'Unknown')}</span>
                            <span class="queue-item-artist">${escapeHtml(track.artist || 'Unknown Artist')}</span>
                        </div>
                        <div class="queue-item-actions">
                            <button class="queue-action-link" style="font-size:11px;" onclick="event.stopPropagation();replayPreviousTrack(${realIdx})">Replay</button>
                        </div>
                    </div>
                `;
            }).join('');
        }
    }
}

function updatePlayerUI(trackData) {
    const coverEl = document.getElementById('player-cover');
    const titleEl = document.getElementById('player-title');
    const artistEl = document.getElementById('player-artist');

    // Full Screen Player Elements
    const fsCoverImg = document.getElementById('fs-cover-image');
    const fsTitleEl = document.getElementById('fs-title');
    const fsArtistEl = document.getElementById('fs-artist');

    const fallbackSrc = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400'><rect width='100%25' height='100%25' fill='%231a1a1a'/><text x='50%25' y='50%25' font-size='80' fill='%23444' text-anchor='middle' dominant-baseline='middle'>🎵</text></svg>";

    if (coverEl) {
        if (trackData.cover) {
            coverEl.innerHTML = `<img src="${trackData.cover}" alt="${escapeHtml(trackData.title)}" onerror="this.onerror=null; this.src='${fallbackSrc}';">`;
            
            // Update FS Cover and trigger color extraction
            if (fsCoverImg) {
                fsCoverImg.crossOrigin = "Anonymous";
                fsCoverImg.onerror = function() {
                    this.onerror = null;
                    this.src = fallbackSrc;
                    document.documentElement.style.setProperty('--album-art', `url('${fallbackSrc}')`);
                };
                fsCoverImg.src = trackData.cover;
                document.documentElement.style.setProperty('--album-art', `url('${trackData.cover}')`);
                fsCoverImg.onload = () => extractColorsFromImage(fsCoverImg);
            }
        } else {
            coverEl.innerHTML = `<div style="width:100%;height:100%;display:grid;place-items:center;font-size:32px;opacity:0.2">🎵</div>`;
            if (fsCoverImg) {
                fsCoverImg.onerror = null;
                fsCoverImg.src = fallbackSrc;
                document.documentElement.style.setProperty('--album-art', `url('${fallbackSrc}')`);
            }
        }
    }
    if (titleEl) titleEl.textContent = trackData.title;
    if (artistEl) artistEl.textContent = trackData.artist;

    if (fsTitleEl) fsTitleEl.textContent = trackData.title;
    if (fsArtistEl) fsArtistEl.textContent = trackData.artist;
    
    const fsQualityContainer = document.getElementById('fs-quality-badge-container');
    if (fsQualityContainer) {
        fsQualityContainer.innerHTML = renderQualityBadge(trackData);
    }

    document.title = `${trackData.title} — ${trackData.artist} | BASA`;

    // Highlight playing track in lists
    document.querySelectorAll('.track-list-item').forEach(item => {
        item.classList.toggle('playing', String(item.dataset?.trackId) === String(trackData.id));
    });
}

function updatePlayPauseButton() {
    const btn = document.getElementById('play-btn');
    if (btn) btn.textContent = state.isPlaying ? '⏸' : '▶';

    const fsPlayIcon = document.getElementById('fs-play-icon');
    if (fsPlayIcon) {
        if (state.isPlaying) {
            fsPlayIcon.innerHTML = `<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>`; // Pause SVG
        } else {
            fsPlayIcon.innerHTML = `<path d="M8 5v14l11-7z"/>`; // Play SVG
        }
    }
}

function setupPlayer() {
    const playBtn = document.getElementById('play-btn');
    const nextBtn = document.getElementById('next-btn');
    const prevBtn = document.getElementById('prev-btn');
    const shuffleBtn = document.getElementById('shuffle-btn');
    const repeatBtn = document.getElementById('repeat-btn');
    const progressBar = document.getElementById('progress-bar');
    const progressFill = document.getElementById('progress-fill');
    const volumeBar = document.getElementById('volume-bar');
    const volumeFill = document.getElementById('volume-fill');
    const volumeBtn = document.getElementById('volume-btn');
    const currentTimeEl = document.getElementById('current-time');
    const totalTimeEl = document.getElementById('total-time');

    if (playBtn) {
        playBtn.addEventListener('click', () => {
            if (!window.playbackManager.currentTrack) return;
            // Prevent playing if the player isn't fully ready yet
            if (!window.playbackManager.isReady) {
                showToast('Player is still loading, please wait...', 'info');
                return;
            }
            if (state.isPlaying) window.playbackManager.pause();
            else window.playbackManager.resume();
        });
    }
    if (nextBtn) nextBtn.addEventListener('click', playNext);
    if (prevBtn) prevBtn.addEventListener('click', playPrev);

    // Queue button & drawer listeners
    const queueBtn = document.getElementById('queue-btn');
    const queueCloseBtn = document.getElementById('queue-close-btn');
    const queueBackdrop = document.getElementById('queue-drawer-backdrop');
    const fsQueueBtn = document.getElementById('fs-queue-btn');
    if (queueBtn) queueBtn.addEventListener('click', toggleQueueDrawer);
    if (queueCloseBtn) queueCloseBtn.addEventListener('click', closeQueueDrawer);
    if (queueBackdrop) queueBackdrop.addEventListener('click', closeQueueDrawer);
    if (fsQueueBtn) fsQueueBtn.addEventListener('click', toggleQueueDrawer);

    if (shuffleBtn) {
        shuffleBtn.addEventListener('click', () => {
            state.shuffle = !state.shuffle;
            shuffleBtn.classList.toggle('active', state.shuffle);
            showToast(state.shuffle ? 'Shuffle on' : 'Shuffle off');
        });
    }
    if (repeatBtn) {
        repeatBtn.addEventListener('click', () => {
            if (state.repeat === 'none') { state.repeat = 'all'; repeatBtn.classList.add('active'); repeatBtn.textContent = '🔁'; showToast('Repeat all'); }
            else if (state.repeat === 'all') { state.repeat = 'one'; repeatBtn.textContent = '🔂'; showToast('Repeat one'); }
            else { state.repeat = 'none'; repeatBtn.classList.remove('active'); repeatBtn.textContent = '↻'; showToast('Repeat off'); }
        });
    }

    window.playbackManager.onStateChange = (stateName) => {
        if (stateName === 'playing') {
            state.isPlaying = true;
            updatePlayPauseButton();
            renderQueueDrawer();
            if (totalTimeEl) totalTimeEl.textContent = formatDuration(window.playbackManager.getDuration());
            const fsTotalTimeEl = document.getElementById('fs-total-time');
            if (fsTotalTimeEl) fsTotalTimeEl.textContent = formatDuration(window.playbackManager.getDuration());
        } else if (stateName === 'paused') {
            state.isPlaying = false;
            updatePlayPauseButton();
            renderQueueDrawer();
        } else if (stateName === 'ended') {
            playNext();
        }
    };
    
    window.playbackManager.onError = (err) => {
        showToast(err, 'error');
        state.isPlaying = false;
        updatePlayPauseButton();
    };
    
    setInterval(() => {
        if (state.isPlaying && window.playbackManager.isReady) {
            const currentTime = window.playbackManager.getCurrentTime();
            const duration = window.playbackManager.getDuration();
            if (duration > 0) {
                const pct = (currentTime / duration) * 100;
                if (progressBar && !progressBar.matches(':active')) progressBar.value = pct;
                if (progressFill && !progressBar.matches(':active')) progressFill.style.width = `${pct}%`;
                if (currentTimeEl) currentTimeEl.textContent = formatDuration(currentTime);

                const fsProgressBar = document.getElementById('fs-progress-bar');
                const fsProgressFill = document.getElementById('fs-progress-fill');
                const fsCurrentTimeEl = document.getElementById('fs-current-time');
                if (fsProgressBar && !fsProgressBar.matches(':active')) fsProgressBar.value = pct;
                if (fsProgressFill && !fsProgressBar.matches(':active')) fsProgressFill.style.width = `${pct}%`;
                if (fsCurrentTimeEl) fsCurrentTimeEl.textContent = formatDuration(currentTime);
            }
        }
    }, 500);

    if (progressBar) {
        progressBar.addEventListener('input', (e) => {
            const duration = window.playbackManager.getDuration();
            if (duration > 0) {
                window.playbackManager.seekTo((e.target.value / 100) * duration);
            }
        });
    }
    const fsProgressBar = document.getElementById('fs-progress-bar');
    if (fsProgressBar) {
        fsProgressBar.addEventListener('input', (e) => {
            const duration = window.playbackManager.getDuration();
            if (duration > 0) {
                window.playbackManager.seekTo((e.target.value / 100) * duration);
            }
        });
    }

    if (volumeBar) {
        volumeBar.value = state.volume;
        if (volumeFill) volumeFill.style.width = `${state.volume}%`;
        window.playbackManager.onReadyCallback = () => {
            window.playbackManager.setVolume(state.volume);
        };
        volumeBar.addEventListener('input', (e) => {
            state.volume = parseInt(e.target.value);
            window.playbackManager.setVolume(state.volume);
            if (volumeFill) volumeFill.style.width = `${state.volume}%`;
            localStorage.setItem('liquid_music_volume', state.volume);
        });
    }

    let isMuted = false;
    let preMuteVolume = state.volume;
    
    function setMuteState(muted) {
        isMuted = muted;
        const volBtns = [document.getElementById('volume-btn'), document.getElementById('fs-volume-btn')];
        const vBars = [document.getElementById('volume-bar'), document.getElementById('fs-volume-bar')];
        const vFills = [document.getElementById('volume-fill'), document.getElementById('fs-volume-fill')];

        if (isMuted) {
            preMuteVolume = state.volume;
            window.playbackManager.setVolume(0);
            vFills.forEach(f => f && (f.style.width = '0%'));
            vBars.forEach(b => b && (b.value = 0));
        } else {
            window.playbackManager.setVolume(preMuteVolume);
            vFills.forEach(f => f && (f.style.width = `${preMuteVolume}%`));
            vBars.forEach(b => b && (b.value = preMuteVolume));
        }
        volBtns.forEach(btn => {
            if (btn) btn.innerHTML = isMuted 
                ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"></line><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon></svg>'
                : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
        });
    }

    if (volumeBtn) volumeBtn.addEventListener('click', () => setMuteState(!isMuted));
    const fsVolumeBtn = document.getElementById('fs-volume-btn');
    if (fsVolumeBtn) fsVolumeBtn.addEventListener('click', () => setMuteState(!isMuted));

    function syncVolume(val) {
        state.volume = parseInt(val);
        window.playbackManager.setVolume(state.volume);
        localStorage.setItem('liquid_music_volume', state.volume);
        [document.getElementById('volume-fill'), document.getElementById('fs-volume-fill')].forEach(f => f && (f.style.width = `${state.volume}%`));
        [document.getElementById('volume-bar'), document.getElementById('fs-volume-bar')].forEach(b => b && (b.value = state.volume));
    }
    
    if (volumeBar) {
        volumeBar.value = state.volume;
        if (volumeFill) volumeFill.style.width = `${state.volume}%`;
        window.playbackManager.onReadyCallback = () => window.playbackManager.setVolume(state.volume);
        volumeBar.addEventListener('input', (e) => syncVolume(e.target.value));
    }

    const fsVolumeBar = document.getElementById('fs-volume-bar');
    if (fsVolumeBar) {
        fsVolumeBar.value = state.volume;
        const fsVolumeFill = document.getElementById('fs-volume-fill');
        if (fsVolumeFill) fsVolumeFill.style.width = `${state.volume}%`;
        fsVolumeBar.addEventListener('input', (e) => syncVolume(e.target.value));
    }
}

function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        switch (e.code) {
            case 'Space': 
                e.preventDefault(); 
                if (window.playbackManager.currentTrack && window.playbackManager.isReady) { 
                    state.isPlaying ? window.playbackManager.pause() : window.playbackManager.resume(); 
                } 
                break;
            case 'KeyQ':
                e.preventDefault();
                toggleQueueDrawer();
                break;
            case 'ArrowRight': 
                e.preventDefault(); 
                if (window.playbackManager.currentTrack) window.playbackManager.seek(window.playbackManager.getCurrentTime() + 5); 
                break;
            case 'ArrowLeft': 
                e.preventDefault(); 
                if (window.playbackManager.currentTrack) window.playbackManager.seek(Math.max(window.playbackManager.getCurrentTime() - 5, 0)); 
                break;
        }
    });
}

// 10. LIBRARY MODULE
async function loadLibrary() {
    const list = document.getElementById('liked-list');
    if (!list) return;
    if (!state.token) {
        list.innerHTML = '<div class="empty-state">Please sign in to view your liked songs</div>';
        return;
    }

    list.innerHTML = '<div class="loader">Loading liked songs...</div>';
    try {
        const data = await api('/library/liked');
        let items = data.tracks || [];
        // Handle tracks with videoId (YouTube) or id (Archive/Telegram/Local)
        items = items.filter(item => item.track_data && (item.track_data.videoId || item.track_data.id));
        if (items.length > 0) {
            list.innerHTML = items.map((item, i) =>
                renderTrackListItem(item.track_data, i, item.track_source)
            ).join('');
        } else {
            list.innerHTML = '<div class="empty-state">No liked songs yet. Like songs by clicking ♡</div>';
        }
    } catch (err) {
        list.innerHTML = '<div class="empty-state">Failed to load library</div>';
    }
}

async function toggleLike(trackId, source, encodedData) {
    if (!state.token) { showToast('Please sign in to like tracks', 'error'); return; }

    const trackData = JSON.parse(decodeURIComponent(encodedData));
    const isLiked = state.likedTrackIds.has(String(trackId));

    try {
        if (isLiked) {
            await api(`/library/like/${trackId}?source=${source}`, { method: 'DELETE' });
            state.likedTrackIds.delete(String(trackId));
            showToast('Removed from likes');
        } else {
            await api('/library/like', {
                method: 'POST',
                body: JSON.stringify({ track_id: String(trackId), track_source: source, track_data: trackData })
            });
            state.likedTrackIds.add(String(trackId));
            showToast('Added to likes ♥', 'success');
        }

        // Update player like button
        updatePlayerLikeButton();

        // Refresh library view if active
        if (state.currentView === 'library') loadLibrary();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function updatePlayerLikeButton() {
    const btn = document.getElementById('player-like-btn');
    if (!btn || !state.currentTrack) return;
    const liked = state.likedTrackIds.has(String(state.currentTrack.id));
    btn.textContent = liked ? '♥' : '♡';
    btn.classList.toggle('liked', liked);
}

async function checkIfLiked(trackId, source) {
    if (!state.token) return;
    try {
        const data = await api(`/library/liked/check/${trackId}?source=${source || 'youtube'}`);
        if (data.liked) state.likedTrackIds.add(String(trackId));
        else state.likedTrackIds.delete(String(trackId));
        updatePlayerLikeButton();
    } catch (err) { /* ignore */ }
}

// 11. PLAYLIST MODULE
async function loadPlaylists() {
    if (!state.token) return;
    try {
        const data = await api('/playlists');
        state.playlists = data.playlists || [];
        updatePlaylistSidebar();
    } catch (err) {
        console.error('Failed to load playlists', err);
    }
}

function updatePlaylistSidebar() {
    const list = document.getElementById('playlist-list');
    if (!list) return;

    if (!state.token || state.playlists.length === 0) {
        list.innerHTML = `<li class="playlist-empty">${state.token ? 'No playlists yet' : 'Sign in to create playlists'}</li>`;
        return;
    }

    list.innerHTML = state.playlists.map(pl => `
        <li><a href="#playlist/${pl.id}" class="playlist-link">${escapeHtml(pl.name)} <span class="playlist-count">${pl.track_count || 0}</span></a></li>
    `).join('');
}

async function loadPlaylist(id) {
    state.currentPlaylistId = id;
    const tracksContainer = document.getElementById('playlist-tracks');
    const nameEl = document.getElementById('playlist-name');
    const descEl = document.getElementById('playlist-desc');
    const countEl = document.getElementById('playlist-track-count');
    const playAllBtn = document.getElementById('playlist-play-all');
    const deleteBtn = document.getElementById('playlist-delete-btn');
    const coverEl = document.getElementById('playlist-cover');

    if (!tracksContainer) return;
    tracksContainer.innerHTML = '<div class="loader">Loading playlist...</div>';

    try {
        const data = await api(`/playlists/${id}`);
        const playlist = data.playlist;
        let tracks = data.tracks || [];
        // Handle tracks with videoId (YouTube) or id (Archive/Telegram/Local) and filter out Shorts
        tracks = tracks.filter(t => t.track_data && (t.track_data.videoId || t.track_data.id) && !isShortTrack(t.track_data));

        if (nameEl) nameEl.textContent = playlist.name;
        if (descEl) descEl.textContent = playlist.description || '';
        if (countEl) countEl.textContent = `${tracks.length} track${tracks.length !== 1 ? 's' : ''}`;
        if (coverEl && playlist.cover_url) {
            coverEl.innerHTML = `<img src="${playlist.cover_url}" alt="${escapeHtml(playlist.name)}">`;
        }

        if (deleteBtn) deleteBtn.onclick = () => deletePlaylist(id);

        if (tracks.length > 0) {
            const trackObjs = tracks.map(t => ({
                ...t.track_data,
                source: t.track_source,
                playlistEntryId: t.id
            }));

            if (playAllBtn) playAllBtn.onclick = () => playFromList(trackObjs, 0);

            tracksContainer.innerHTML = tracks.map((item, i) =>
                renderTrackListItem(item.track_data, i, item.track_source, {
                    playlistId: id,
                    playlistEntryId: item.id
                })
            ).join('');
        } else {
            tracksContainer.innerHTML = '<div class="empty-state">This playlist is empty. Search for songs and add them!</div>';
        }
    } catch (err) {
        tracksContainer.innerHTML = '<div class="empty-state">Failed to load playlist</div>';
    }
}

async function createPlaylistSubmit(e) {
    e.preventDefault();
    const nameInput = document.getElementById('playlist-name-input');
    const descInput = document.getElementById('playlist-desc-input');
    const name = nameInput?.value?.trim();
    const desc = descInput?.value?.trim() || '';

    if (!name) { showToast('Please enter a playlist name', 'error'); return; }

    try {
        await api('/playlists', { method: 'POST', body: JSON.stringify({ name, description: desc }) });
        showToast('Playlist created!', 'success');
        hideModal('playlist-modal');
        if (nameInput) nameInput.value = '';
        if (descInput) descInput.value = '';
        loadPlaylists();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function deletePlaylist(id) {
    if (!confirm('Delete this playlist? This cannot be undone.')) return;
    try {
        await api(`/playlists/${id}`, { method: 'DELETE' });
        showToast('Playlist deleted');
        loadPlaylists();
        navigate('#home');
    } catch (err) { showToast(err.message, 'error'); }
}

async function removeFromPlaylist(playlistId, entryId) {
    try {
        await api(`/playlists/${playlistId}/tracks/${entryId}`, { method: 'DELETE' });
        showToast('Track removed');
        if (state.currentPlaylistId === playlistId) loadPlaylist(playlistId);
    } catch (err) { showToast(err.message, 'error'); }
}

function showAddToPlaylist(event, trackId, source, encodedData) {
    event.stopPropagation();
    if (!state.token) { showToast('Please sign in to add to playlists', 'error'); return; }

    const menu = document.getElementById('context-menu');
    if (!menu) return;

    const plList = document.getElementById('context-menu-playlists');
    if (plList) {
        if (state.playlists.length === 0) {
            plList.innerHTML = '<li style="padding:10px;color:rgba(255,255,255,0.4);font-size:12px">No playlists yet</li>';
        } else {
            plList.innerHTML = state.playlists.map(pl => `
                <li onclick="addToPlaylist('${pl.id}','${trackId}','${source}','${encodedData}')">${escapeHtml(pl.name)}</li>
            `).join('');
        }
    }

    menu.classList.remove('hidden');
    menu.style.display = 'block';

    const x = Math.min(event.clientX, window.innerWidth - 220);
    const y = Math.min(event.clientY, window.innerHeight - 200);
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
}

async function addToPlaylist(playlistId, trackId, source, encodedData) {
    const trackData = JSON.parse(decodeURIComponent(encodedData));
    try {
        await api(`/playlists/${playlistId}/tracks`, {
            method: 'POST',
            body: JSON.stringify({ track_id: String(trackId), track_source: source, track_data: trackData })
        });
        showToast('Added to playlist', 'success');
    } catch (err) { showToast(err.message, 'error'); }
    finally {
        const menu = document.getElementById('context-menu');
        if (menu) { menu.style.display = 'none'; menu.classList.add('hidden'); }
    }
}

// 12. UPLOAD MODULE
async function loadUploads() {
    const list = document.getElementById('upload-list');
    if (!list) return;
    if (!state.token) {
        list.innerHTML = '<div class="empty-state">Please sign in to view uploads</div>';
        return;
    }

    list.innerHTML = '<div class="loader">Loading uploads...</div>';
    try {
        const data = await api('/upload/tracks');
        const tracks = data.tracks || [];
        if (tracks.length > 0) {
            list.innerHTML = tracks.map((t, i) => renderTrackListItem(t, i, 'local', { isUpload: true })).join('');
        } else {
            list.innerHTML = '<div class="empty-state">No uploads yet. Drag & drop audio files above!</div>';
        }
    } catch (err) {
        list.innerHTML = '<div class="empty-state">Failed to load uploads</div>';
    }
}

function setupUpload() {
    const fileInput = document.getElementById('file-input');
    const uploadZone = document.getElementById('upload-zone');
    const uploadNavBtn = document.getElementById('upload-nav-btn');

    if (fileInput) {
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) uploadFiles(e.target.files);
        });
    }
    if (uploadZone) {
        uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
        uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
        uploadZone.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadZone.classList.remove('drag-over');
            if (e.dataTransfer.files.length > 0) uploadFiles(e.dataTransfer.files);
        });
    }
    if (uploadNavBtn) {
        uploadNavBtn.addEventListener('click', () => {
            if (!state.token) { showToast('Please sign in to upload', 'error'); return; }
            navigate('#uploads');
        });
    }
}

async function uploadFiles(files) {
    if (!state.token) { showToast('Please sign in to upload', 'error'); return; }
    showToast(`Uploading ${files.length} file(s)...`);

    for (const file of files) {
        const formData = new FormData();
        formData.append('audio', file);
        formData.append('title', file.name.replace(/\.[^.]+$/, ''));
        try {
            const res = await api('/upload', { method: 'POST', body: formData });
            const q = res.track?.quality !== 'UNKNOWN' ? res.track?.quality : '';
            const f = res.track?.format || 'UNKNOWN';
            showToast(`Uploaded ${res.track?.title} (${f} ${q})`, 'success');
        } catch (err) {
            showToast(`Failed: ${file.name} — ${err.message}`, 'error');
        }
    }
    if (state.currentView === 'uploads') loadUploads();
}

async function deleteUpload(id) {
    if (!confirm('Delete this uploaded track?')) return;
    try {
        await api(`/upload/${id}`, { method: 'DELETE' });
        showToast('Upload deleted');
        if (state.currentView === 'uploads') loadUploads();
    } catch (err) { showToast(err.message, 'error'); }
}

// 13. MODALS & CONTEXT MENU
function setupModals() {
    // Auth modal
    const authBtn = document.getElementById('auth-btn');
    const authClose = document.getElementById('auth-modal-close');
    const authSwitch = document.getElementById('auth-switch-btn');
    const authForm = document.getElementById('auth-form');
    const logoutBtn = document.getElementById('logout-btn');
    const playerLikeBtn = document.getElementById('player-like-btn');

    if (authBtn) authBtn.addEventListener('click', () => showAuthModal('login'));
    if (authClose) authClose.addEventListener('click', hideAuthModal);
    if (authSwitch) {
        authSwitch.addEventListener('click', () => {
            const mode = authForm?.dataset.mode || 'login';
            showAuthModal(mode === 'login' ? 'signup' : 'login');
        });
    }
    if (authForm) authForm.addEventListener('submit', handleAuthSubmit);
    if (logoutBtn) logoutBtn.addEventListener('click', logout);

    // Player like button
    if (playerLikeBtn) {
        playerLikeBtn.addEventListener('click', () => {
            if (!state.currentTrack) return;
            const encoded = encodeURIComponent(JSON.stringify(state.currentTrack));
            toggleLike(state.currentTrack.id, state.currentTrack.source || 'youtube', encoded);
        });
    }

    // Playlist modal
    const createBtn = document.getElementById('create-playlist-btn');
    const playlistClose = document.getElementById('playlist-modal-close');
    const playlistForm = document.getElementById('playlist-form');

    if (createBtn) {
        createBtn.addEventListener('click', () => {
            if (!state.token) { showToast('Please sign in to create playlists', 'error'); return; }
            showModal('playlist-modal');
        });
    }
    if (playlistClose) playlistClose.addEventListener('click', () => hideModal('playlist-modal'));
    if (playlistForm) playlistForm.addEventListener('submit', createPlaylistSubmit);

    // Close modals on backdrop click
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) { overlay.style.display = 'none'; overlay.classList.add('hidden'); }
        });
    });
}

function showModal(id) {
    const modal = document.getElementById(id);
    if (modal) { modal.style.display = 'grid'; modal.classList.remove('hidden'); }
}

function hideModal(id) {
    const modal = document.getElementById(id);
    if (modal) { modal.style.display = 'none'; modal.classList.add('hidden'); }
}

function setupContextMenu() {
    document.addEventListener('click', (e) => {
        const menu = document.getElementById('context-menu');
        if (menu && !menu.contains(e.target) && menu.style.display === 'block') {
            menu.style.display = 'none';
            menu.classList.add('hidden');
        }
    });
}

// 14. NAVBAR SCROLL
function setupNavbarScroll() {
    const navbar = document.getElementById('navbar');
    if (!navbar) return;
    let lastScroll = 0;
    const mainContent = document.getElementById('main-content');
    const scrollTarget = mainContent || window;

    (mainContent || document).addEventListener('scroll', () => {
        const scrollY = mainContent ? mainContent.scrollTop : window.scrollY;
        navbar.classList.toggle('scrolled', scrollY > 20);
        lastScroll = scrollY;
    });
}

// 15. GLASS EFFECTS
function setupGlassEffects() {
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    if (prefersReduced || isTouch) return;

    let mx = window.innerWidth / 2, my = window.innerHeight / 2;
    let vx = 0, vy = 0, sv = 0, lx = mx, ly = my;

    document.addEventListener('mousemove', (e) => {
        vx = e.clientX - lx; vy = e.clientY - ly;
        lx = e.clientX; ly = e.clientY;
        mx = e.clientX; my = e.clientY;
    });

    function animate() {
        const vel = Math.sqrt(vx * vx + vy * vy);
        sv = sv * 0.92 + vel * 0.08;

        document.querySelectorAll('.glass-subtle, .glass-standard, .glass-premium, .glass-floating, [data-prism]').forEach(el => {
            const r = el.getBoundingClientRect();
            if (r.bottom < 0 || r.top > window.innerHeight) return;

            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            const dx = mx - cx, dy = my - cy;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const maxD = Math.max(r.width, r.height) * 1.2;
            const prox = Math.max(0, 1 - dist / maxD);

            const lxPct = ((mx - r.left) / r.width) * 100;
            const lyPct = ((my - r.top) / r.height) * 100;
            el.style.setProperty('--light-x', `${lxPct}%`);
            el.style.setProperty('--light-y', `${lyPct}%`);
            el.style.setProperty('--cursor-proximity', prox.toFixed(3));

            const inner = el.querySelector('.glass-inner-depth');
            if (inner) {
                el.style.setProperty('--parallax-x', `${(dx * 0.08).toFixed(1)}px`);
                el.style.setProperty('--parallax-y', `${(dy * 0.08).toFixed(1)}px`);
            }

            if (el.hasAttribute('data-prism')) {
                const angle = Math.atan2(dy, dx) * (180 / Math.PI);
                const intensity = Math.min(1, sv * prox * 0.025);
                el.style.setProperty('--prism-angle', `${angle}deg`);
                el.style.setProperty('--prism-opacity', intensity.toFixed(3));
            }
        });

        vx *= 0.92; vy *= 0.92;
        requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);
}

// 16. INITIALIZATION
document.addEventListener('DOMContentLoaded', () => {
    window.ytAudioPlayer.init('yt-player');
    window.playbackManager.initYouTube(window.ytAudioPlayer);
    window.playbackManager.initSync(window.syncManager);
    initAuth();
    setupRouter();
    setupSearch();
    setupPlayer();
    setupUpload();
    setupModals();
    setupContextMenu();
    setupKeyboardShortcuts();
    setupNavbarScroll();
    setupGlassEffects();
    setupFullScreenPlayer();
    setupSync();

    // Navigate to initial hash or home
    const hash = window.location.hash || '#home';
    navigate(hash);
    // Trigger initial route
    if (hash === '#home' || hash === '') {
        showView('view-home');
        loadHome();
    }
});

// 17. FULL SCREEN PLAYER & LIQUID GLASS PHYSICS
function extractColorsFromImage(imgEl) {
    if (!imgEl || !imgEl.complete) return;
    try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = 64;
        canvas.height = 64;
        ctx.drawImage(imgEl, 0, 0, 64, 64);
        const data = ctx.getImageData(0, 0, 64, 64).data;
        let r = 0, g = 0, b = 0, count = 0;
        // Sample border pixels more lightly, center more heavily or just average all
        for (let i = 0; i < data.length; i += 16) {
            r += data[i];
            g += data[i+1];
            b += data[i+2];
            count++;
        }
        r = Math.floor(r/count); g = Math.floor(g/count); b = Math.floor(b/count);
        
        // Setup a secondary color by shifting hue or just taking a specific section
        let r2 = 255 - r, g2 = 255 - g, b2 = 255 - b; // simplistic complement
        
        document.documentElement.style.setProperty('--fs-color-primary', `rgb(${r},${g},${b})`);
        document.documentElement.style.setProperty('--fs-color-secondary', `rgb(${r2},${g2},${b2})`);
    } catch(e) {
        // Tainted canvas (CORS) - ignore
    }
}

function setupFullScreenPlayer() {
    const fsPlayer = document.getElementById('fs-player');
    const trackInfoBtn = document.getElementById('player-track-info');
    const closeBtn = document.getElementById('fs-close-btn');
    const lyricsBtn = document.getElementById('fs-lyrics-btn');
    const lyricsPanel = document.getElementById('fs-lyrics-panel');

    if (trackInfoBtn && fsPlayer) {
        trackInfoBtn.addEventListener('click', () => {
            if (!state.currentTrack) return;
            fsPlayer.classList.remove('hidden');
            fsPlayer.setAttribute('aria-hidden', 'false');
            document.body.classList.add('fullscreen-player-open');
            // Allow display change before opacity fade
            setTimeout(() => fsPlayer.classList.add('active'), 10);
            
            // Re-extract color if cover was updated before it was open
            const img = document.getElementById('fs-cover-image');
            if (img && img.src) extractColorsFromImage(img);
        });
    }

    if (closeBtn && fsPlayer) {
        closeBtn.addEventListener('click', () => {
            fsPlayer.classList.remove('active');
            fsPlayer.setAttribute('aria-hidden', 'true');
            document.body.classList.remove('fullscreen-player-open');
            setTimeout(() => fsPlayer.classList.add('hidden'), 500); // Wait for fade
        });
    }

    if (lyricsBtn && lyricsPanel) {
        lyricsBtn.addEventListener('click', () => {
            lyricsPanel.classList.toggle('show-lyrics');
        });
    }

    // Keyboard ESC to close
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && fsPlayer && fsPlayer.classList.contains('active')) {
            closeBtn.click();
        }
    });

    // Setup duplicate controls
    const fsPlayBtn = document.getElementById('fs-play-btn');
    const fsNextBtn = document.getElementById('fs-next-btn');
    const fsPrevBtn = document.getElementById('fs-prev-btn');
    const fsShuffleBtn = document.getElementById('fs-shuffle-btn');
    const fsRepeatBtn = document.getElementById('fs-repeat-btn');

    if (fsPlayBtn) {
        fsPlayBtn.addEventListener('click', () => {
            const mainPlay = document.getElementById('play-btn');
            if (mainPlay) mainPlay.click();
        });
    }
    if (fsNextBtn) fsNextBtn.addEventListener('click', playNext);
    if (fsPrevBtn) fsPrevBtn.addEventListener('click', playPrev);
    
    if (fsShuffleBtn) {
        fsShuffleBtn.addEventListener('click', () => {
            const mainShuffle = document.getElementById('shuffle-btn');
            if (mainShuffle) mainShuffle.click();
            fsShuffleBtn.classList.toggle('active', state.shuffle);
        });
    }
    if (fsRepeatBtn) {
        fsRepeatBtn.addEventListener('click', () => {
            const mainRepeat = document.getElementById('repeat-btn');
            if (mainRepeat) mainRepeat.click();
        });
    }

    // 3D Glass Physics and Interaction loop
    const glassContainer = document.getElementById('fs-glass-container');
    
    // Check for reduced motion
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    
    let targetX = 0, targetY = 0; // Mouse normalized coords (-1 to 1)
    let currentX = 0, currentY = 0; // Interpolated coords
    let velocity = 0;
    let targetVelocity = 0;
    
    function onMove(e) {
        if (prefersReducedMotion.matches || !fsPlayer.classList.contains('active')) return;
        
        let clientX = e.touches ? e.touches[0].clientX : e.clientX;
        let clientY = e.touches ? e.touches[0].clientY : e.clientY;
        
        const rect = fsPlayer.getBoundingClientRect();
        
        // Normalize coordinates from -1 to 1 based on screen center
        targetX = ((clientX - rect.left) / rect.width) * 2 - 1;
        targetY = ((clientY - rect.top) / rect.height) * 2 - 1;

        // Set CSS mouse vars (0% to 100%) for gradient backgrounds
        document.documentElement.style.setProperty('--fs-mouse-x', `${(clientX / rect.width) * 100}%`);
        document.documentElement.style.setProperty('--fs-mouse-y', `${(clientY / rect.height) * 100}%`);
        
        targetVelocity = 3; // Boost velocity during movement
    }
    
    fsPlayer.addEventListener('mousemove', onMove);
    fsPlayer.addEventListener('touchmove', onMove, { passive: true });

    function renderPhysics() {
        if (!prefersReducedMotion.matches && fsPlayer.classList.contains('active')) {
            // Smoothly decay velocity for edge lighting
            velocity += (targetVelocity - velocity) * 0.1;
            targetVelocity *= 0.95; // Decay target
            
            document.documentElement.style.setProperty('--fs-velocity', velocity.toFixed(3));
        }
        requestAnimationFrame(renderPhysics);
    }
    
    requestAnimationFrame(renderPhysics);
}

// 18. MULTI-DEVICE SYNC
function setupSync() {
    const btnCreate = document.getElementById('btn-create-room');
    const btnJoin = document.getElementById('btn-join-room');
    const btnLeave = document.getElementById('btn-leave-room');
    const inputDeviceName = document.getElementById('sync-device-name');
    const inputJoinCode = document.getElementById('sync-join-code');
    const displayCode = document.getElementById('sync-display-code');
    const deviceList = document.getElementById('sync-device-list');
    
    const activeRoomView = document.getElementById('sync-active-room');
    const setupView = document.getElementById('sync-setup');

    if (!window.syncManager) return;

    btnCreate.addEventListener('click', () => {
        const name = inputDeviceName.value.trim() || 'Host Device';
        window.syncManager.createRoom(name);
    });

    btnJoin.addEventListener('click', () => {
        const name = inputDeviceName.value.trim() || 'Client Device';
        const code = inputJoinCode.value.trim();
        if (code.length === 6) {
            window.syncManager.joinRoom(code, name);
        } else {
            showToast('Enter a valid 6-letter room code', 'error');
        }
    });

    btnLeave.addEventListener('click', () => {
        window.syncManager.leaveRoom();
        activeRoomView.classList.add('hidden');
        setupView.classList.remove('hidden');
    });

    window.syncManager.on('room_state_update', (data) => {
        setupView.classList.add('hidden');
        activeRoomView.classList.remove('hidden');
        displayCode.textContent = data.roomCode;
        
        deviceList.innerHTML = '';
        data.clients.forEach(client => {
            const li = document.createElement('li');
            li.className = 'track-list-item';
            li.innerHTML = `
                <div style="display:flex; justify-content:space-between; width:100%;">
                    <span>${escapeHtml(client.name)} ${client.id === window.syncManager.clientId ? '(You)' : ''}</span>
                    <span class="badge-gold">${client.role}</span>
                </div>
            `;
            deviceList.appendChild(li);
        });
    });
}

// Global window bindings for interop with PlaybackManager & YouTube Player
window.playTrack = playTrack;
window.playNext = playNext;
window.playPrev = playPrev;
window.playTrackFromData = playTrackFromData;
window.playFromList = playFromList;
window.addToQueue = addToQueue;
window.addToQueueFromData = addToQueueFromData;
window.playNextInQueue = playNextInQueue;
window.removeFromQueue = removeFromQueue;
window.clearQueue = clearQueue;
window.clearPreviousTracks = clearPreviousTracks;
window.replayPreviousTrack = replayPreviousTrack;
window.playFromQueueIndex = playFromQueueIndex;
window.toggleQueueDrawer = toggleQueueDrawer;
window.openQueueDrawer = openQueueDrawer;
window.closeQueueDrawer = closeQueueDrawer;
window.switchQueueTab = switchQueueTab;
window.renderQueueDrawer = renderQueueDrawer;
window.toggleLike = toggleLike;
window.showAddToPlaylist = showAddToPlaylist;

// Telegram Vault Controller Functions
window.loadTelegramVault = loadTelegramVault;
window.switchVaultTab = switchVaultTab;
window.loadVaultSources = loadVaultSources;
window.startSourceIndexing = startSourceIndexing;
window.pauseSourceIndexing = pauseSourceIndexing;
window.stopSourceIndexing = stopSourceIndexing;
window.deleteVaultSource = deleteVaultSource;
window.openAddSourceModal = openAddSourceModal;
window.closeAddSourceModal = closeAddSourceModal;
window.handleAddSourceSubmit = handleAddSourceSubmit;
window.loadVaultRequests = loadVaultRequests;
window.playTrackById = playTrackById;
window.processVaultQueue = processVaultQueue;
window.openSongRequestModal = openSongRequestModal;
window.closeSongRequestModal = closeSongRequestModal;
window.handleSongRequestSubmit = handleSongRequestSubmit;
window.cleanVaultCache = cleanVaultCache;

// ============================================
// 10. TELEGRAM VAULT & REQUEST SYSTEM CONTROLLER
// ============================================

async function loadTelegramVault() {
    try {
        const statusRes = await api('/telegram/status');
        if (statusRes) {
            const elSources = document.getElementById('vault-stat-sources');
            const elIndexed = document.getElementById('vault-stat-indexed');
            const elCached = document.getElementById('vault-stat-cached');
            const elStorage = document.getElementById('vault-stat-storage');
            const elLimit = document.getElementById('vault-stat-limit');

            if (elSources) elSources.textContent = statusRes.totalSources || 0;
            if (elIndexed) elIndexed.textContent = (statusRes.totalIndexedAudio || 0).toLocaleString();
            if (elCached) elCached.textContent = (statusRes.totalCachedTracks || 0).toLocaleString();
            if (elStorage) elStorage.textContent = `${(statusRes.cacheUsageGb || 0).toFixed(2)} GB`;
            if (elLimit) {
                elLimit.innerHTML = `Max ${statusRes.maxCacheGb || 25} GB · <a href="javascript:void(0)" onclick="cleanVaultCache()" style="color:var(--accent);text-decoration:underline;">Clean Cache</a>`;
            }
        }
    } catch (e) {
        console.error('[Telegram Vault] Status load error:', e);
    }

    loadVaultSources();
    loadVaultRequests();
}

function switchVaultTab(tab) {
    const viewSources = document.getElementById('vault-view-sources');
    const viewRequests = document.getElementById('vault-view-requests');
    const btnSources = document.getElementById('vault-tab-sources');
    const btnRequests = document.getElementById('vault-tab-requests');

    if (tab === 'sources') {
        if (viewSources) { viewSources.classList.remove('hidden'); viewSources.classList.add('active'); }
        if (viewRequests) { viewRequests.classList.add('hidden'); viewRequests.classList.remove('active'); }
        if (btnSources) btnSources.classList.add('active');
        if (btnRequests) btnRequests.classList.remove('active');
        loadVaultSources();
    } else {
        if (viewSources) { viewSources.classList.add('hidden'); viewSources.classList.remove('active'); }
        if (viewRequests) { viewRequests.classList.remove('hidden'); viewRequests.classList.add('active'); }
        if (btnSources) btnSources.classList.remove('active');
        if (btnRequests) btnRequests.classList.add('active');
        loadVaultRequests();
    }
}

async function loadVaultSources() {
    const listEl = document.getElementById('vault-sources-list');
    if (!listEl) return;

    try {
        const res = await api('/telegram/sources');
        const sources = res.data || [];

        if (sources.length === 0) {
            listEl.innerHTML = `
                <div class="empty-state">
                    <p>No Telegram sources configured yet.</p>
                    <button class="button button-primary" style="margin-top:12px;" onclick="openAddSourceModal()">+ Add Your First Source</button>
                </div>
            `;
            return;
        }

        listEl.innerHTML = sources.map(s => {
            const isIndexing = s.indexing_status === 'INDEXING';
            const isPaused = s.indexing_status === 'PAUSED';
            const statusClass = isIndexing ? 'indexing' : (isPaused ? 'paused' : (s.status === 'CONNECTED' || s.status === 'READY' ? 'ready' : 'idle'));
            const statusText = isIndexing ? 'INDEXING METADATA' : (isPaused ? 'INDEXING PAUSED' : (s.status || 'IDLE'));

            const pBadgeClass = s.priority === 1 ? 'p1' : '';

            let actionsHtml = '';
            if (isIndexing) {
                actionsHtml = `
                    <button class="button button-secondary" style="font-size:11px; padding:4px 8px;" onclick="pauseSourceIndexing('${s.id}')">⏸ Pause</button>
                    <button class="button button-secondary" style="font-size:11px; padding:4px 8px; color:#ff6b6b;" onclick="stopSourceIndexing('${s.id}')">⏹ Stop</button>
                `;
            } else {
                actionsHtml = `
                    <button class="button button-primary" style="font-size:11px; padding:4px 10px;" onclick="startSourceIndexing('${s.id}')">▶ Index Source</button>
                    <button class="button button-ghost" style="font-size:11px; padding:4px 6px; color:#ff6b6b;" onclick="deleteVaultSource('${s.id}')" title="Delete Source">🗑</button>
                `;
            }

            return `
                <div class="vault-source-card">
                    <div class="source-info">
                        <div class="source-title-row">
                            <span class="source-name">${escapeHtml(s.name)}</span>
                            <span class="priority-badge ${pBadgeClass}">Priority ${s.priority}</span>
                            <span class="status-pill ${statusClass}">${statusText}</span>
                        </div>
                        <div class="source-details">
                            <span>Chat: <code>${escapeHtml(s.chat_id)}</code></span>
                            ${s.username ? `<span>Username: ${escapeHtml(s.username)}</span>` : ''}
                            <span>Indexed Audio: <strong>${(s.indexed_audio || 0).toLocaleString()}</strong></span>
                            <span>Checkpoint Msg ID: <code>${s.last_indexed_message_id || 0}</code></span>
                        </div>
                    </div>
                    <div class="source-actions">
                        ${actionsHtml}
                    </div>
                </div>
            `;
        }).join('');
    } catch (err) {
        listEl.innerHTML = `<div class="empty-state">Failed to load sources: ${escapeHtml(err.message)}</div>`;
    }
}

async function startSourceIndexing(sourceId) {
    try {
        showToast('Initiating background metadata indexing (No mass downloading)...', 'info');
        const res = await api(`/telegram/sources/${sourceId}/index`, { method: 'POST' });
        showToast(res.message || 'Indexing started', 'success');
        loadVaultSources();
    } catch (err) {
        showToast(`Could not start indexing: ${err.message}`, 'error');
    }
}

async function pauseSourceIndexing(sourceId) {
    try {
        const res = await api(`/telegram/sources/${sourceId}/pause`, { method: 'POST' });
        showToast('Indexing paused', 'info');
        loadVaultSources();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function stopSourceIndexing(sourceId) {
    try {
        const res = await api(`/telegram/sources/${sourceId}/stop`, { method: 'POST' });
        showToast('Indexing stopped', 'info');
        loadVaultSources();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function deleteVaultSource(sourceId) {
    if (!confirm('Are you sure you want to delete this Telegram source and remove its index records?')) return;
    try {
        await api(`/telegram/sources/${sourceId}`, { method: 'DELETE' });
        showToast('Source deleted', 'success');
        loadTelegramVault();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function openAddSourceModal() {
    const modal = document.getElementById('source-modal');
    if (modal) { modal.classList.remove('hidden'); modal.style.display = 'grid'; }
}

function closeAddSourceModal() {
    const modal = document.getElementById('source-modal');
    if (modal) { modal.classList.add('hidden'); modal.style.display = 'none'; }
}

async function handleAddSourceSubmit(event) {
    event.preventDefault();
    const name = document.getElementById('source-name-input')?.value;
    const chatId = document.getElementById('source-chat-input')?.value;
    const username = document.getElementById('source-username-input')?.value;
    const priority = parseInt(document.getElementById('source-priority-input')?.value || '1', 10);

    try {
        await api('/telegram/sources', {
            method: 'POST',
            body: JSON.stringify({ name, chat_id: chatId, username, priority })
        });
        showToast(`Source "${name}" configured!`, 'success');
        closeAddSourceModal();
        document.getElementById('source-form')?.reset();
        loadTelegramVault();
    } catch (err) {
        showToast(`Failed to add source: ${err.message}`, 'error');
    }
}

async function loadVaultRequests() {
    const container = document.getElementById('vault-requests-container');
    const countBadge = document.getElementById('vault-request-count');
    if (!container) return;

    try {
        const res = await api('/telegram/requests');
        const requests = res.data || [];

        if (countBadge) countBadge.textContent = requests.length;

        if (requests.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <p>No song requests in the queue yet.</p>
                    <button class="button button-primary" style="margin-top:12px;" onclick="openSongRequestModal()">📥 Submit First Request</button>
                </div>
            `;
            return;
        }

        container.innerHTML = requests.map(r => {
            const statusClass = (r.status || 'PENDING').toLowerCase();
            let statusLabel = r.status;
            if (r.status === 'READY') statusLabel = 'READY TO PLAY';
            if (r.status === 'FOUND') statusLabel = 'FOUND IN VAULT';
            if (r.status === 'NOT_FOUND') statusLabel = 'NOT IN ANY SOURCE';

            const sourcesMap = r.sourcesStatus || {};
            const sourcePills = Object.entries(sourcesMap).map(([srcId, st]) => {
                const isFound = st === 'SEARCHED_FOUND';
                const pillColor = isFound ? 'rgba(113,255,186,0.15)' : 'rgba(255,255,255,0.06)';
                const textColor = isFound ? '#71ffba' : 'var(--text-tertiary)';
                return `<span style="font-size:10px; padding:2px 6px; border-radius:4px; background:${pillColor}; color:${textColor};">${srcId.replace('source_', '')}: ${st}</span>`;
            }).join(' ');

            return `
                <div class="vault-request-card">
                    <div>
                        <div class="request-query-text">${escapeHtml(r.query)}</div>
                        <div class="request-listeners">
                            <span>👥 <strong>${r.waitingCount || 1}</strong> listener${(r.waitingCount > 1 ? 's' : '')} waiting</span>
                            <span style="opacity:0.4;">·</span>
                            <span>Normalized: <code>${escapeHtml(r.normalizedQuery || '')}</code></span>
                        </div>
                        <div style="display:flex; gap:6px; margin-top:6px; flex-wrap:wrap;">
                            ${sourcePills}
                        </div>
                    </div>
                    <div class="request-meta-right">
                        <span class="status-pill ${statusClass}">${statusLabel}</span>
                        ${r.resultTrackId ? `<button class="button button-secondary" style="font-size:11px; padding:4px 10px;" onclick="playTrackById('${r.resultTrackId}')">▶ Play</button>` : ''}
                    </div>
                </div>
            `;
        }).join('');
    } catch (err) {
        container.innerHTML = `<div class="empty-state">Failed to load requests: ${escapeHtml(err.message)}</div>`;
    }
}

async function playTrackById(trackId) {
    try {
        const res = await api(`/telegram/prepare/${trackId}`);
        if (res.track) {
            playTrack(res.track);
        } else {
            playTrack({ id: trackId, source: 'telegram', title: 'Lossless Track' });
        }
    } catch (e) {
        playTrack({ id: trackId, source: 'telegram', title: 'Lossless Track' });
    }
}

async function processVaultQueue() {
    try {
        showToast('Evaluating requests across sources in priority order...', 'info');
        const res = await api('/telegram/requests/process', { method: 'POST' });
        showToast(`Processed ${res.processed || 0} queue requests!`, 'success');
        loadVaultRequests();
    } catch (err) {
        showToast(`Queue processing failed: ${err.message}`, 'error');
    }
}

function openSongRequestModal(prefillQuery = '') {
    const modal = document.getElementById('request-song-modal');
    const input = document.getElementById('request-query-input');
    if (modal) {
        modal.classList.remove('hidden');
        modal.style.display = 'grid';
        if (input) {
            input.value = prefillQuery || (document.getElementById('search-input')?.value || '');
            input.focus();
        }
    }
}

function closeSongRequestModal() {
    const modal = document.getElementById('request-song-modal');
    if (modal) { modal.classList.add('hidden'); modal.style.display = 'none'; }
}

async function handleSongRequestSubmit(event) {
    event.preventDefault();
    const query = document.getElementById('request-query-input')?.value;
    if (!query) return;

    try {
        const res = await api('/telegram/request', {
            method: 'POST',
            body: JSON.stringify({ query })
        });
        showToast(res.message || 'Song request registered!', 'success');
        closeSongRequestModal();
        document.getElementById('request-song-form')?.reset();
        if (state.currentView === 'telegram') loadVaultRequests();
    } catch (err) {
        showToast(`Request submission failed: ${err.message}`, 'error');
    }
}

async function cleanVaultCache() {
    if (!confirm('Run LRU cache cleanup to enforce storage limits? Least-recently-played tracks will be evicted if limit is exceeded.')) return;
    try {
        showToast('Running cache maintenance...', 'info');
        const res = await api('/telegram/cache/clean', { method: 'POST' });
        showToast(res.message || 'Cache cleaned successfully', 'success');
        loadTelegramVault();
    } catch (err) {
        showToast(`Cache cleanup failed: ${err.message}`, 'error');
    }
}




