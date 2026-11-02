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

let savedUserQueue = [];
try {
    savedUserQueue = JSON.parse(localStorage.getItem('basa_user_queue') || '[]');
} catch (e) {}

let savedContextQueue = [];
try {
    savedContextQueue = JSON.parse(localStorage.getItem('basa_context_queue') || '[]');
} catch (e) {}

function generateQueueEntryId() {
    return 'qe_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 9);
}

function wrapQueueEntry(track, tier = 'USER_QUEUE') {
    if (!track) return null;
    const qId = track.queueEntryId || generateQueueEntryId();
    return {
        ...track,
        queueEntryId: qId,
        tier: tier
    };
}

const state = {
    user: null,
    token: localStorage.getItem('basa_token') || localStorage.getItem('liquid_music_token'),
    currentView: 'home',
    currentPlaylistId: null,
    playlists: [],
    likedTrackIds: new Set(),
    // Three-Tier Spotify/Apple Music Queue Architecture (Ported from BASA 2.0 QueueTimeline.kt)
    userQueue: Array.isArray(savedUserQueue) ? savedUserQueue : [],
    contextQueue: Array.isArray(savedContextQueue) ? savedContextQueue : (Array.isArray(savedQueueTracks) ? savedQueueTracks : []),
    contextName: localStorage.getItem('basa_context_name') || 'Current Context',
    contextIndex: parseInt(localStorage.getItem('basa_context_index') || '0', 10),
    autoplayEnabled: localStorage.getItem('basa_autoplay_enabled') !== 'false',
    queue: Array.isArray(savedQueueTracks) ? savedQueueTracks : [],
    queueIndex: -1,
    previousTracks: Array.isArray(savedPrevTracks) ? savedPrevTracks : [],
    isPlaying: false,
    shuffle: false,
    repeat: 'none',
    volume: parseInt(localStorage.getItem('basa_volume') || localStorage.getItem('liquid_music_volume') || '80'),
    searchTimeout: null,
    currentTrack: null,
    currentCanonicalTrackId: null,
    recentCanonicalTrackIds: [],
    queueActiveTab: 'upnext',
    recommendedQueue: [],
    isFetchingRecommendations: false,
    currentTrackStartTime: 0
};

function saveQueueState() {
    try {
        localStorage.setItem('basa_previous_tracks', JSON.stringify(state.previousTracks.slice(-50)));
        localStorage.setItem('basa_user_queue', JSON.stringify((state.userQueue || []).slice(0, 50)));
        localStorage.setItem('basa_context_queue', JSON.stringify((state.contextQueue || []).slice(0, 100)));
        localStorage.setItem('basa_context_name', state.contextName || 'Current Context');
        localStorage.setItem('basa_context_index', String(state.contextIndex || 0));
        localStorage.setItem('basa_autoplay_enabled', String(state.autoplayEnabled !== false));

        // Keep legacy basa_queue updated for compatibility with any external tools
        const legacy = [
            ...(state.contextQueue ? state.contextQueue.slice(0, (state.contextIndex || 0) + 1) : []),
            ...(state.userQueue || []),
            ...(state.contextQueue ? state.contextQueue.slice((state.contextIndex || 0) + 1) : [])
        ];
        state.queue = legacy;
        state.queueIndex = state.contextIndex || 0;
        localStorage.setItem('basa_queue', JSON.stringify(legacy.slice(0, 100)));
    } catch (e) {}
}

// Synchronized lyrics engine globals (hoisted to prevent TDZ ReferenceError)
let currentLyricsData = null;
let currentLyricsTrackId = null;
let activeLyricIndex = -1;
let lyricsOffsetSeconds = 0;
let isUserInteractingWithLyrics = false;
let userLyricsScrollTimeout = null;

// Fullscreen player mode globals
let fsPlayerMode = 'artwork'; // 'artwork' (Apple Music centered player) or 'lyrics' (split view)
let isLyricsAvailable = false;
let userWantsLyrics = false;
let fsTimeDisplayMode = localStorage.getItem('basa_fs_time_mode') || 'remaining';

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
let lastToastMsg = '';
let lastToastTime = 0;

function showToast(message, type = 'info') {
    const now = Date.now();
    // Prevent spamming identical toasts within 1500ms
    if (message === lastToastMsg && (now - lastToastTime < 1500)) {
        return;
    }
    lastToastMsg = message;
    lastToastTime = now;

    const container = document.getElementById('toast-container');
    if (!container) return;

    // Cap maximum concurrent toasts on screen to 3
    while (container.children.length >= 3) {
        container.removeChild(container.firstChild);
    }

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
        } else if (hash === '#explore') {
            showView('view-explore');
            loadExploreTrending();
        } else if (hash === '#search') {
            showView('view-search');
        } else if (hash === '#library') {
            showView('view-library');
            loadLibrary();
        } else if (hash === '#replay') {
            showView('view-replay');
            loadReplayView();
        } else if (hash === '#equalizer') {
            showView('view-equalizer');
            initScreenEqualizer();
        } else if (hash === '#sources') {
            showView('view-sources');
        } else if (hash === '#uploads') {
            showView('view-uploads');
            loadUploads();
        } else if (hash === '#sync') {
            showView('view-sync');
        } else if (hash === '#lossless') {
            showView('view-lossless');
            loadLosslessStudio();
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

// 6. SEARCH & SPOTIFY SUGGESTIONS DROPDOWN SYSTEM
const RECENT_SEARCHES_STORAGE_KEY = 'basa_recent_searches';
let searchSuggestionsAbortController = null;
let searchSuggestionsSelectedIndex = -1;
let currentSuggestionsList = [];
let searchDebounceTimer = null;

// Seed initial recent searches matching Spotify user context if empty
const DEFAULT_SPOTIFY_RECENT_SEARCHES = [
    {
        id: 'rec_jailer_song',
        title: 'Tiger Muthuvel Pandian (From "Jailer 2")',
        artist: 'Anirudh Ravichander, M.S Krsna, Super Subu',
        cover: 'https://i.scdn.co/image/ab67616d0000b27341ea22b31a31eb2ce698bf4e',
        type: 'song',
        explicit: false,
        isVideo: false
    },
    {
        id: 'rec_jailer_album',
        title: 'Jailer 2 (Original Motion Picture Soundtrack)',
        artist: 'Anirudh Ravichander',
        cover: 'https://i.scdn.co/image/ab67616d0000b27341ea22b31a31eb2ce698bf4e',
        type: 'album',
        explicit: false,
        isVideo: false
    },
    {
        id: 'rec_low_life',
        title: 'Low Life (feat. The Weeknd)',
        artist: 'Future, The Weeknd',
        cover: 'https://i.scdn.co/image/ab67616d0000b27318db0d31c4b752df7859b8a0',
        type: 'song',
        explicit: true,
        isVideo: true
    },
    {
        id: 'rec_around_me',
        title: 'Around Me (feat. Don Toliver)',
        artist: 'Metro Boomin, Don Toliver',
        cover: 'https://i.scdn.co/image/ab67616d0000b27313e54d6687e65678d60466c2',
        type: 'song',
        explicit: true,
        isVideo: false
    },
    {
        id: 'rec_metro_artist',
        title: 'Metro Boomin',
        artist: 'Artist',
        cover: 'https://i.scdn.co/image/ab6761610000e5eb6046e7f2ac9587c6759c8855',
        type: 'artist',
        verified: true
    },
    {
        id: 'rec_am_i_dreaming',
        title: 'Am I Dreaming (Metro Boomin & A$AP Rocky, Roisee)',
        artist: 'Metro Boomin, A$AP Rocky, Roisee',
        cover: 'https://i.scdn.co/image/ab67616d0000b273bb62c4a4574929c0f997f642',
        type: 'song',
        explicit: false,
        isVideo: false
    }
];

function getRecentSearches() {
    try {
        const raw = localStorage.getItem(RECENT_SEARCHES_STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
        localStorage.setItem(RECENT_SEARCHES_STORAGE_KEY, JSON.stringify(DEFAULT_SPOTIFY_RECENT_SEARCHES));
        return DEFAULT_SPOTIFY_RECENT_SEARCHES;
    } catch (e) {
        return DEFAULT_SPOTIFY_RECENT_SEARCHES;
    }
}

function saveRecentSearch(item) {
    if (!item || !item.title) return;
    try {
        let list = getRecentSearches();
        list = list.filter(x => {
            if (item.id && x.id === item.id) return false;
            if (x.title && x.title.toLowerCase() === item.title.toLowerCase() && x.type === item.type) return false;
            return true;
        });
        list.unshift(item);
        if (list.length > 12) list = list.slice(0, 12);
        localStorage.setItem(RECENT_SEARCHES_STORAGE_KEY, JSON.stringify(list));
    } catch (e) {
        console.error('Failed to save recent search', e);
    }
}

function removeRecentSearch(itemId, e) {
    if (e) {
        e.stopPropagation();
        e.preventDefault();
    }
    try {
        let list = getRecentSearches();
        list = list.filter(x => x.id !== itemId);
        localStorage.setItem(RECENT_SEARCHES_STORAGE_KEY, JSON.stringify(list));
        renderRecentSearchesDropdown();
    } catch (err) {
        console.error('Failed to remove recent search', err);
    }
}

function clearAllRecentSearches(e) {
    if (e) {
        e.stopPropagation();
        e.preventDefault();
    }
    try {
        localStorage.setItem(RECENT_SEARCHES_STORAGE_KEY, JSON.stringify([]));
        renderRecentSearchesDropdown();
    } catch (err) {
        console.error('Failed to clear recent searches', err);
    }
}

function openSearchDropdown() {
    const dropdown = document.getElementById('search-suggestions-dropdown');
    const input = document.getElementById('search-input');
    if (!dropdown || !input) return;

    dropdown.classList.remove('hidden');
    input.setAttribute('aria-expanded', 'true');
    searchSuggestionsSelectedIndex = -1;

    const query = input.value.trim();
    if (!query) {
        renderRecentSearchesDropdown();
    } else {
        fetchSearchSuggestions(query);
    }
}

function closeSearchDropdown() {
    const dropdown = document.getElementById('search-suggestions-dropdown');
    const input = document.getElementById('search-input');
    if (dropdown) dropdown.classList.add('hidden');
    if (input) input.setAttribute('aria-expanded', 'false');
    searchSuggestionsSelectedIndex = -1;
}

function renderRecentSearchesDropdown() {
    const dropdown = document.getElementById('search-suggestions-dropdown');
    if (!dropdown) return;

    const list = getRecentSearches();
    currentSuggestionsList = list;
    searchSuggestionsSelectedIndex = -1;

    if (!list || list.length === 0) {
        dropdown.innerHTML = `
            <div class="sp-sugg-empty">
                <div class="sp-sugg-empty-title">No recent searches</div>
                <div class="sp-sugg-tip">Search for artists, songs, or albums to build your history</div>
            </div>
        `;
        return;
    }

    const itemsHtml = list.map((item, index) => {
        const isArtist = item.type === 'artist';
        const isAlbum = item.type === 'album';
        const explicitBadge = item.explicit ? '<span class="sp-badge-e">E</span>' : '';
        const videoBadge = item.isVideo ? `
            <svg class="sp-badge-video" width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                <path d="m10 15 5-3-5-3v6zm11-12H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14z"/>
            </svg>` : '';
        const verifiedIcon = (isArtist || item.verified) ? `
            <svg class="sp-sugg-verified-badge" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
            </svg>` : '';

        let subText = item.artist || '';
        if (isArtist) {
            subText = 'Artist';
        } else if (isAlbum) {
            subText = 'Album • ' + (item.artist || 'Unknown');
        } else {
            subText = 'Song • ' + (item.artist || 'Unknown');
        }

        return `
            <li class="sp-sugg-item" data-index="${index}" onclick="selectSearchSuggestion(${index})">
                <div class="sp-sugg-thumb-wrap ${isArtist ? 'is-artist' : ''}">
                    <img src="${item.cover || '/logo-mark.png'}" alt="" onerror="this.src='/logo-mark.png'">
                </div>
                <div class="sp-sugg-meta">
                    <div class="sp-sugg-title-row">
                        <span class="sp-sugg-title-text">${escapeHtml(item.title)}</span>
                        ${verifiedIcon}
                    </div>
                    <div class="sp-sugg-sub-row">
                        ${explicitBadge}
                        ${videoBadge}
                        <span class="sp-sugg-sub-text">${escapeHtml(subText)}</span>
                    </div>
                </div>
                <button type="button" class="sp-sugg-remove-btn" title="Remove from recent searches" onclick="removeRecentSearch('${escapeHtml(item.id)}', event)">✕</button>
            </li>
        `;
    }).join('');

    dropdown.innerHTML = `
        <div class="sp-sugg-header">
            <span class="sp-sugg-title">Recent searches</span>
            <button type="button" class="sp-sugg-clear-all" onclick="clearAllRecentSearches(event)">Clear all</button>
        </div>
        <ul class="sp-sugg-list" role="listbox">
            ${itemsHtml}
        </ul>
    `;
}

async function fetchSearchSuggestions(query) {
    const dropdown = document.getElementById('search-suggestions-dropdown');
    if (!dropdown) return;

    if (searchSuggestionsAbortController) {
        searchSuggestionsAbortController.abort();
    }
    searchSuggestionsAbortController = new AbortController();

    dropdown.innerHTML = `
        <div class="sp-sugg-header">
            <span class="sp-sugg-title">Suggestions</span>
            <span class="sp-sugg-hint">Searching...</span>
        </div>
        <div class="sp-sugg-empty" style="padding: 24px 16px;">
            <div class="loader" style="margin: 0 auto 8px;"></div>
            <div class="sp-sugg-tip">Finding matching songs, artists and albums</div>
        </div>
    `;

    try {
        const res = await fetch(`/api/music/search?q=${encodeURIComponent(query)}&limit=8`, {
            signal: searchSuggestionsAbortController.signal
        });
        if (!res.ok) throw new Error('Search failed');
        const json = await res.json();
        const tracks = json.data || [];

        renderSuggestionsDropdown(tracks, query);
    } catch (err) {
        if (err.name === 'AbortError') return;
        dropdown.innerHTML = `
            <div class="sp-sugg-header">
                <span class="sp-sugg-title">Suggestions</span>
            </div>
            <div class="sp-sugg-empty">
                <div class="sp-sugg-empty-title">No suggestions available</div>
                <div class="sp-sugg-tip">Press Enter to search all sources</div>
            </div>
        `;
    }
}

function renderSuggestionsDropdown(tracks, query) {
    const dropdown = document.getElementById('search-suggestions-dropdown');
    if (!dropdown) return;

    if (!tracks || tracks.length === 0) {
        dropdown.innerHTML = `
            <div class="sp-sugg-header">
                <span class="sp-sugg-title">Suggestions</span>
            </div>
            <div class="sp-sugg-empty">
                <div class="sp-sugg-empty-title">No direct suggestions for "${escapeHtml(query)}"</div>
                <div class="sp-sugg-tip">Press Enter to perform a deep multi-source search</div>
            </div>
        `;
        currentSuggestionsList = [];
        searchSuggestionsSelectedIndex = -1;
        return;
    }

    const suggestions = [];
    const qLower = query.toLowerCase().trim();

    // 1. Check if the query matches an artist in the results
    const artistCandidate = tracks.find(t => {
        const a = (t.artist || '').toLowerCase();
        return a === qLower || a.includes(qLower) || qLower.includes(a);
    });

    if (artistCandidate && artistCandidate.artist) {
        suggestions.push({
            id: 'artist_' + encodeURIComponent(artistCandidate.artist),
            title: artistCandidate.artist,
            artist: 'Artist',
            cover: artistCandidate.thumbnail || artistCandidate.cover || '/logo-mark.png',
            type: 'artist',
            verified: true
        });
    }

    // 2. Add top matching song entries
    tracks.slice(0, 6).forEach((t, i) => {
        const cleaned = cleanMusicTitle(t.title, t.artist);
        suggestions.push({
            id: t.id || t.videoId || ('sugg_' + i),
            title: cleaned.title,
            artist: cleaned.artist,
            cover: t.thumbnail || t.cover || '/logo-mark.png',
            type: 'song',
            explicit: cleaned.explicit || !!t.explicit,
            isVideo: (t.source === 'youtube' && !t.isAudioOnly) || !!t.isVideo,
            rawTrack: t
        });

        // 3. If an album is identified and distinct from song title, add Album entry
        if (t.album && t.album.toLowerCase() !== cleaned.title.toLowerCase() && suggestions.filter(s => s.type === 'album').length === 0) {
            suggestions.push({
                id: 'album_' + encodeURIComponent(t.album),
                title: t.album,
                artist: cleaned.artist,
                cover: t.thumbnail || t.cover || '/logo-mark.png',
                type: 'album',
                explicit: false
            });
        }
    });

    currentSuggestionsList = suggestions;
    searchSuggestionsSelectedIndex = -1;

    const itemsHtml = suggestions.map((item, index) => {
        const isArtist = item.type === 'artist';
        const isAlbum = item.type === 'album';
        const explicitBadge = item.explicit ? '<span class="sp-badge-e">E</span>' : '';
        const videoBadge = item.isVideo ? `
            <svg class="sp-badge-video" width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                <path d="m10 15 5-3-5-3v6zm11-12H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14z"/>
            </svg>` : '';
        const verifiedIcon = (isArtist || item.verified) ? `
            <svg class="sp-sugg-verified-badge" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
            </svg>` : '';

        let subText = item.artist || '';
        if (isArtist) {
            subText = 'Artist';
        } else if (isAlbum) {
            subText = 'Album • ' + (item.artist || 'Unknown');
        } else {
            subText = 'Song • ' + (item.artist || 'Unknown');
        }

        return `
            <li class="sp-sugg-item" data-index="${index}" onclick="selectSearchSuggestion(${index})">
                <div class="sp-sugg-thumb-wrap ${isArtist ? 'is-artist' : ''}">
                    <img src="${item.cover || '/logo-mark.png'}" alt="" onerror="this.src='/logo-mark.png'">
                </div>
                <div class="sp-sugg-meta">
                    <div class="sp-sugg-title-row">
                        <span class="sp-sugg-title-text">${escapeHtml(item.title)}</span>
                        ${verifiedIcon}
                    </div>
                    <div class="sp-sugg-sub-row">
                        ${explicitBadge}
                        ${videoBadge}
                        <span class="sp-sugg-sub-text">${escapeHtml(subText)}</span>
                    </div>
                </div>
            </li>
        `;
    }).join('');

    dropdown.innerHTML = `
        <div class="sp-sugg-header">
            <span class="sp-sugg-title">Suggestions</span>
            <span class="sp-sugg-hint">Press Enter for all results</span>
        </div>
        <ul class="sp-sugg-list" role="listbox">
            ${itemsHtml}
        </ul>
    `;
}

function selectSearchSuggestion(index) {
    if (!currentSuggestionsList || !currentSuggestionsList[index]) return;
    const item = currentSuggestionsList[index];

    saveRecentSearch(item);
    closeSearchDropdown();

    if (item.type === 'artist' || item.type === 'album') {
        const searchInput = document.getElementById('search-input');
        if (searchInput) searchInput.value = item.title;
        navigate('#search');
        searchMusic(item.title);
    } else {
        const trackToPlay = item.rawTrack ? item.rawTrack : {
            id: item.id,
            title: item.title,
            artist: item.artist,
            thumbnail: item.cover,
            explicit: item.explicit,
            source: item.source || 'youtube'
        };
        const stdTrack = mapTrackToStandard(trackToPlay, trackToPlay.source || 'youtube');
        state.queue = [stdTrack];
        state.queueIndex = 0;
        saveQueueState();
        playTrack(stdTrack);
    }
}

function updateSearchKeyboardSelection(newIndex) {
    const dropdown = document.getElementById('search-suggestions-dropdown');
    if (!dropdown) return;

    const items = dropdown.querySelectorAll('.sp-sugg-item');
    if (!items || items.length === 0) return;

    searchSuggestionsSelectedIndex = Math.max(0, Math.min(newIndex, items.length - 1));
    items.forEach((el, idx) => {
        if (idx === searchSuggestionsSelectedIndex) {
            el.classList.add('keyboard-selected');
            el.scrollIntoView({ block: 'nearest' });
        } else {
            el.classList.remove('keyboard-selected');
        }
    });
}

function setupSearch() {
    const searchInput = document.getElementById('search-input');
    const qualityFilter = document.getElementById('quality-filter');
    if (!searchInput) return;

    // Detect Mac OS to display ⌘ L on the shortcut badge
    const isMac = (navigator.platform && navigator.platform.toUpperCase().indexOf('MAC') >= 0) || 
                  (navigator.userAgent && navigator.userAgent.toUpperCase().indexOf('MAC') >= 0);
    const kbdContainer = document.getElementById('sp-search-kbd');
    if (kbdContainer && isMac) {
        kbdContainer.innerHTML = '<kbd class="sp-search-kbd">⌘</kbd><kbd class="sp-search-kbd">L</kbd>';
    }

    if (qualityFilter) {
        qualityFilter.addEventListener('change', () => {
            const query = searchInput.value.trim();
            if (query.length > 0) searchMusic(query);
            else if (state.currentView === 'home') loadHome();
        });
    }

    // Open dropdown on focus or click
    searchInput.addEventListener('focus', () => {
        openSearchDropdown();
    });

    searchInput.addEventListener('click', () => {
        openSearchDropdown();
    });

    searchInput.addEventListener('input', (e) => {
        clearTimeout(searchDebounceTimer);
        const query = e.target.value.trim();
        openSearchDropdown();
        if (query.length === 0) {
            renderRecentSearchesDropdown();
        } else {
            searchDebounceTimer = setTimeout(() => {
                fetchSearchSuggestions(query);
            }, 180);
        }
    });

    searchInput.addEventListener('keydown', (e) => {
        const dropdown = document.getElementById('search-suggestions-dropdown');
        const isDropdownOpen = dropdown && !dropdown.classList.contains('hidden');

        if (e.key === 'ArrowDown') {
            if (isDropdownOpen && currentSuggestionsList.length > 0) {
                e.preventDefault();
                updateSearchKeyboardSelection(searchSuggestionsSelectedIndex + 1);
            }
        } else if (e.key === 'ArrowUp') {
            if (isDropdownOpen && currentSuggestionsList.length > 0) {
                e.preventDefault();
                updateSearchKeyboardSelection(searchSuggestionsSelectedIndex - 1);
            }
        } else if (e.key === 'Enter') {
            e.preventDefault();
            clearTimeout(searchDebounceTimer);
            if (isDropdownOpen && searchSuggestionsSelectedIndex >= 0 && searchSuggestionsSelectedIndex < currentSuggestionsList.length) {
                selectSearchSuggestion(searchSuggestionsSelectedIndex);
            } else {
                closeSearchDropdown();
                const q = searchInput.value.trim();
                if (q) {
                    navigate('#search');
                    searchMusic(q);
                }
            }
        } else if (e.key === 'Escape') {
            closeSearchDropdown();
            searchInput.blur();
        }
    });

    // Close dropdown when clicking outside search-wrapper
    document.addEventListener('click', (e) => {
        const wrapper = document.getElementById('search-wrapper');
        if (wrapper && !wrapper.contains(e.target)) {
            closeSearchDropdown();
        }
    });

    // Global keyboard shortcuts: Ctrl+L or Cmd+L, or '/' when not in input
    document.addEventListener('keydown', (e) => {
        const isModifierL = (e.ctrlKey || e.metaKey) && (e.key === 'l' || e.key === 'L');
        const isSlash = e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) && !document.activeElement?.isContentEditable;

        if (isModifierL || isSlash) {
            e.preventDefault();
            searchInput.focus();
            searchInput.select();
            openSearchDropdown();
        }
    });
}

// Global exports for search suggestions inline HTML events
window.removeRecentSearch = removeRecentSearch;
window.clearAllRecentSearches = clearAllRecentSearches;
window.selectSearchSuggestion = selectSearchSuggestion;
window.openSearchDropdown = openSearchDropdown;
window.closeSearchDropdown = closeSearchDropdown;
window.saveRecentSearch = saveRecentSearch;

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

function cleanMusicTitle(rawTitle, rawArtist = '') {
    if (!rawTitle) return { title: 'Unknown Title', artist: rawArtist || 'Unknown Artist', explicit: false };

    let title = rawTitle;
    let artist = rawArtist;
    let explicit = false;

    if (/\bexplicit\b|\[E\]|\(E\)/i.test(title)) {
        explicit = true;
    }

    // Strip bracketed specifications and video qualifiers
    title = title
        .replace(/\[[^\]]*\b(?:official\s*(?:video|audio|music\s*video)|lyric\s*video|lyrics|hd|4k|8k|uhd|full\s*video|visualizer|audio|video|explicit)\b[^\]]*\]/gi, '')
        .replace(/\([^)]*\b(?:official\s*(?:video|audio|music\s*video)|lyric\s*video|lyrics|hd|4k|8k|uhd|full\s*video|visualizer|audio|video|explicit)\b[^)]*\)/gi, '')
        .replace(/\[\s*(?:from\s+.*?|ost|original\s*soundtrack)\s*\]/gi, '')
        .replace(/\b(?:official\s*(?:audio|video|music\s*video)|lyric\s*video|visualizer|4k|hd)\b/gi, '')
        .trim();

    // If title has "Artist - Song", split cleanly
    if (title.includes(' - ') && (!artist || artist === 'YouTube' || artist === 'Unknown Artist')) {
        const parts = title.split(' - ');
        if (parts.length >= 2) {
            artist = parts[0].trim();
            title = parts.slice(1).join(' - ').trim();
        }
    }

    return { title: title || rawTitle, artist: artist || rawArtist || 'Unknown Artist', explicit };
}

function rankAutoTracks(tracks, query) {
    const q = (query || '').toLowerCase().trim();
    const qTokens = q.split(/\s+/).filter(Boolean);

    // Filter out obvious non-music / movie scene noise
    const nonMusicPatterns = /\b(fight|scene|train fight|action scene|comedy scene|movie scene|full movie|trailer|teaser|review|reaction|interview)\b/i;

    return tracks.sort((a, b) => {
        const aTitle = (a.title || '').toLowerCase();
        const bTitle = (b.title || '').toLowerCase();
        const aArtist = (a.artist || '').toLowerCase();
        const bArtist = (b.artist || '').toLowerCase();

        // Check non-music noise
        const aIsNoise = nonMusicPatterns.test(aTitle) && !aTitle.includes('theme') && !aTitle.includes('song') && !aTitle.includes('track');
        const bIsNoise = nonMusicPatterns.test(bTitle) && !bTitle.includes('theme') && !bTitle.includes('song') && !bTitle.includes('track');
        if (aIsNoise !== bIsNoise) return aIsNoise ? 1 : -1;

        // Exact artist match gets top priority
        const aArtistExact = aArtist === q || aArtist.includes(q);
        const bArtistExact = bArtist === q || bArtist.includes(q);
        if (aArtistExact !== bArtistExact) return bArtistExact ? 1 : -1;

        // Token match count
        const aMatches = qTokens.filter(t => aTitle.includes(t) || aArtist.includes(t)).length;
        const bMatches = qTokens.filter(t => bTitle.includes(t) || bArtist.includes(t)).length;
        if (aMatches !== bMatches) return bMatches - aMatches;

        const qScore = { 'HI_RES_LOSSLESS': 4, 'LOSSLESS': 3, 'HIGH': 2, 'STANDARD': 1, 'SOURCE_DEPENDENT': 0, 'UNKNOWN': 0 };
        const aQ = qScore[a.quality || 'SOURCE_DEPENDENT'] || 0;
        const bQ = qScore[b.quality || 'SOURCE_DEPENDENT'] || 0;
        return bQ - aQ;
    });
}

let currentSearchSourceFilter = 'ALL';
let currentSpotifySearchTab = 'all';

function setSpotifySearchTab(tab) {
    currentSpotifySearchTab = tab;
    document.querySelectorAll('.sp-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    if (window.currentSearchTracks && window.currentSearchTracks.length > 0) {
        const container = document.getElementById('search-results');
        const searchInput = document.getElementById('search-input');
        const query = searchInput ? searchInput.value.trim() : '';
        renderSpotifySearchResults(container, window.currentSearchTracks, tab, query);
    }
}

function setSearchSourceFilter(source) {
    currentSearchSourceFilter = source ? source.toUpperCase() : 'ALL';
    const sel = document.getElementById('search-source-select');
    if (sel && sel.value !== currentSearchSourceFilter) {
        sel.value = currentSearchSourceFilter;
    }

    const searchInput = document.getElementById('search-input');
    const query = searchInput ? searchInput.value.trim() : '';
    if (query) {
        searchMusic(query);
    }
}

async function searchMusic(query) {
    const container = document.getElementById('search-results');
    const qualityFilter = document.getElementById('quality-filter');
    const selectedQuality = qualityFilter ? qualityFilter.value : 'AUTO';
    
    if (!container) return;

    container.innerHTML = '<div class="loader">Searching music...</div>';
    try {
        let musicTracks = [];
        let localTracks = [];
        const sourceFilter = currentSearchSourceFilter.toLowerCase();

        if (sourceFilter === 'spotify') {
            try {
                const spRes = await api(`/music/providers/spotify/search?q=${encodeURIComponent(query)}&limit=30`);
                musicTracks = (spRes.data || spRes.tracks || []).map(t => ({ ...t, source: 'spotify' }));
            } catch (e) { console.error("Spotify Search Error", e); }
        } else if (sourceFilter === 'ytmusic') {
            try {
                const ytmRes = await api(`/music/providers/ytmusic/search?q=${encodeURIComponent(query)}&limit=30`);
                musicTracks = (ytmRes.data || ytmRes.tracks || []).map(t => ({ ...t, source: 'ytmusic' }));
            } catch (e) { console.error("YTMusic Search Error", e); }
        } else if (sourceFilter === 'jiosaavn') {
            try {
                const jioRes = await api(`/music/search?q=${encodeURIComponent(query)}&source=jiosaavn&limit=30`);
                musicTracks = (jioRes.data || []).map(t => ({ ...t, source: 'jiosaavn' }));
            } catch (e) { console.error("JioSaavn Search Error", e); }
        } else if (sourceFilter === 'lossless') {
            try {
                const lossRes = await api(`/music/search?q=${encodeURIComponent(query)}&source=lossless&limit=30`);
                musicTracks = (lossRes.data || []).map(t => ({ ...t, source: t.source || 'local' }));
            } catch (e) { console.error("Lossless Search Error", e); }
        } else if (sourceFilter === 'local') {
            if (window.localLibrary) {
                try {
                    const idbTracks = await window.localLibrary.search(query);
                    localTracks = idbTracks.map(t => ({ ...t, source: 'local' }));
                } catch (e) { console.error("Local Library Search Error", e); }
            }
            if (state.user) {
                try {
                    const localData = await api('/upload/tracks');
                    const qLower = query.toLowerCase();
                    const upTracks = (localData.tracks || []).filter(t => 
                        (t.title && t.title.toLowerCase().includes(qLower)) || 
                        (t.artist && t.artist.toLowerCase().includes(qLower))
                    ).map(t => ({...t, source: 'local'}));
                    localTracks = [...localTracks, ...upTracks];
                } catch (e) { console.error("Local Search Error", e); }
            }
        } else {
            // ALL sources: multi-source search + local IndexedDB + uploads
            try {
                const searchData = await api(`/music/search?q=${encodeURIComponent(query)}&source=all&limit=30`);
                musicTracks = searchData.data || [];
            } catch (e) { console.error("Search Error", e); }

            if (window.localLibrary) {
                try {
                    const idbTracks = await window.localLibrary.search(query);
                    localTracks = idbTracks.map(t => ({ ...t, source: 'local' }));
                } catch (e) {}
            }
            if (state.user) {
                try {
                    const localData = await api('/upload/tracks');
                    const qLower = query.toLowerCase();
                    const upTracks = (localData.tracks || []).filter(t => 
                        (t.title && t.title.toLowerCase().includes(qLower)) || 
                        (t.artist && t.artist.toLowerCase().includes(qLower))
                    ).map(t => ({...t, source: 'local'}));
                    localTracks = [...localTracks, ...upTracks];
                } catch (e) { console.error("Local Search Error", e); }
            }
        }

        let allTracks = [...localTracks, ...musicTracks];
        
        if (selectedQuality === 'AUTO' && sourceFilter === 'all') {
            allTracks = rankAutoTracks(allTracks, query);
        }
        
        const filteredTracks = filterTracksByQuality(allTracks, selectedQuality);
        
        if (filteredTracks.length > 0) {
            window.currentSearchTracks = filteredTracks;
            // Save top search result into recent searches history
            const topTrack = filteredTracks[0];
            if (topTrack && typeof saveRecentSearch === 'function') {
                saveRecentSearch({
                    id: topTrack.id || ('search_' + encodeURIComponent(query)),
                    title: topTrack.title || query,
                    artist: topTrack.artist || 'Unknown',
                    album: topTrack.album || '',
                    cover: topTrack.thumbnail || topTrack.cover || '/logo-mark.png',
                    type: 'song',
                    explicit: !!topTrack.explicit,
                    isVideo: !!topTrack.isVideo
                });
            }
            renderSpotifySearchResults(container, filteredTracks, currentSpotifySearchTab, query);
        } else {
            if (selectedQuality !== 'AUTO') {
                container.innerHTML = `
                    <div class="empty-state">
                        <div style="margin-bottom:10px;">No ${selectedQuality.replace('_', ' ').toLowerCase()} version available.</div>
                        <button class="button button-primary" onclick="document.getElementById('quality-filter').value='AUTO'; searchMusic('${query.replace(/'/g, "\\'")}');">Play best available</button>
                    </div>`;
            } else {
                container.innerHTML = '<div class="empty-state">No results found for this query. Try a different query or source filter.</div>';
            }
        }
    } catch (err) {
        container.innerHTML = '<div class="empty-state">Search failed. Please try again.</div>';
    }
}

function renderSpotifySearchResults(container, tracks, tab = 'all', query = '') {
    if (!container) return;
    if (!tracks || tracks.length === 0) {
        container.innerHTML = '<div class="empty-state">No results found for this query.</div>';
        return;
    }

    window.currentSearchTracks = tracks;

    // Normalize track metadata
    const standardTracks = tracks.map((t, idx) => {
        const std = mapTrackToStandard(t, t.source || 'youtube');
        const cleaned = cleanMusicTitle(std.title, std.artist);
        return {
            ...std,
            originalIndex: idx,
            displayTitle: cleaned.title,
            displayArtist: cleaned.artist,
            explicit: cleaned.explicit || std.explicit
        };
    });

    if (tab === 'songs') {
        container.innerHTML = `
            <div class="sp-songs-col" style="width: 100%;">
                <h3 class="sp-section-heading">Songs</h3>
                <div class="sp-songs-list">
                    ${standardTracks.map((t, idx) => renderSpotifyTrackRow(t, idx)).join('')}
                </div>
            </div>
        `;
        return;
    }

    if (tab === 'artists') {
        const artists = extractArtistsFromTracks(standardTracks, query);
        container.innerHTML = `
            <div>
                <h3 class="sp-section-heading">Artists</h3>
                <div class="sp-artists-grid">
                    ${artists.map(a => renderSpotifyArtistCard(a)).join('')}
                </div>
            </div>
        `;
        return;
    }

    if (tab === 'albums') {
        const albums = extractAlbumsFromTracks(standardTracks);
        container.innerHTML = `
            <div>
                <h3 class="sp-section-heading">Albums</h3>
                <div class="sp-albums-grid">
                    ${albums.map(al => renderSpotifyAlbumCard(al)).join('')}
                </div>
            </div>
        `;
        return;
    }

    // Default 'all' tab (Spotify Split Layout: Top Result Card + Songs List + Artists + Albums)
    const topTrack = standardTracks[0];
    const topSongs = standardTracks.slice(0, 4);
    const artists = extractArtistsFromTracks(standardTracks, query).slice(0, 4);
    const albums = extractAlbumsFromTracks(standardTracks).slice(0, 4);
    const moreSongs = standardTracks.slice(4, 12);

    const topEncoded = encodeURIComponent(JSON.stringify(topTrack));

    container.innerHTML = `
        <div class="sp-top-split-section">
            <!-- Top Result Card -->
            <div class="sp-top-result-col">
                <h3 class="sp-section-heading">Top result</h3>
                <div class="sp-top-result-card" onclick="playTrackFromData('${topEncoded}', 'search', 0)">
                    <div class="sp-top-card-cover-wrap">
                        <img src="${topTrack.cover || '/logo-mark.png'}" alt="${escapeHtml(topTrack.displayTitle)}" onerror="this.src='/logo-mark.png'">
                    </div>
                    <div class="sp-top-card-info">
                        <h2 class="sp-top-card-title">${escapeHtml(topTrack.displayTitle)}</h2>
                        <div class="sp-top-card-sub">
                            <span class="sp-badge-tag">Song</span>
                            <span>•</span>
                            <span class="sp-top-card-artist">${escapeHtml(topTrack.displayArtist)}</span>
                        </div>
                    </div>
                    <div class="sp-top-play-btn" title="Play">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                    </div>
                </div>
            </div>

            <!-- Songs List (Top 4 Rows) -->
            <div class="sp-songs-col">
                <h3 class="sp-section-heading">Songs</h3>
                <div class="sp-songs-list">
                    ${topSongs.map((t, idx) => renderSpotifyTrackRow(t, idx)).join('')}
                </div>
            </div>
        </div>

        ${artists.length > 0 ? `
            <div>
                <h3 class="sp-section-heading">Artists</h3>
                <div class="sp-artists-grid">
                    ${artists.map(a => renderSpotifyArtistCard(a)).join('')}
                </div>
            </div>
        ` : ''}

        ${albums.length > 0 ? `
            <div>
                <h3 class="sp-section-heading">Albums</h3>
                <div class="sp-albums-grid">
                    ${albums.map(al => renderSpotifyAlbumCard(al)).join('')}
                </div>
            </div>
        ` : ''}

        ${moreSongs.length > 0 ? `
            <div>
                <h3 class="sp-section-heading">More Songs</h3>
                <div class="sp-songs-list">
                    ${moreSongs.map((t, idx) => renderSpotifyTrackRow(t, idx + 4)).join('')}
                </div>
            </div>
        ` : ''}
    `;
}

function renderSpotifyTrackRow(track, index) {
    const encoded = encodeURIComponent(JSON.stringify(track));
    const durFormatted = track.duration ? formatDuration(track.duration) : '';
    const isCurrentPlaying = state.currentTrack && state.currentTrack.id === track.id;

    return `
        <div class="sp-track-row ${isCurrentPlaying ? 'playing' : ''}" onclick="playTrackFromData('${encoded}', 'search', ${index})">
            <div class="sp-row-thumb-wrap">
                <img src="${track.cover || '/logo-mark.png'}" alt="${escapeHtml(track.displayTitle)}" loading="lazy" onerror="this.src='/logo-mark.png'">
                <div class="sp-row-play-icon">▶</div>
            </div>
            <div class="sp-row-meta">
                <div class="sp-row-title">${escapeHtml(track.displayTitle)} ${track.explicit ? '<span class="sp-explicit-tag">E</span>' : ''}</div>
                <div class="sp-row-artist">${escapeHtml(track.displayArtist)}</div>
            </div>
            <div class="sp-row-type">Song</div>
            <div class="sp-row-duration">${durFormatted}</div>
            <button class="sp-row-btn" onclick="event.stopPropagation(); toggleLikeTrack('${track.id}')" title="Save to Your Library">♡</button>
            <button class="sp-row-btn" onclick="event.stopPropagation(); addToQueueFromData('${encoded}')" title="Add to Queue">+</button>
        </div>
    `;
}

function extractArtistsFromTracks(tracks, query = '') {
    const map = new Map();
    for (const t of tracks) {
        const artist = (t.displayArtist || t.artist || '').trim();
        if (!artist || artist === 'Unknown Artist') continue;
        const mainArtist = artist.split(/[,&/]|feat\.|\bwith\b/i)[0].trim();
        if (!map.has(mainArtist.toLowerCase())) {
            map.set(mainArtist.toLowerCase(), {
                name: mainArtist,
                cover: t.cover || '/logo-mark.png'
            });
        }
    }
    return Array.from(map.values());
}

function extractAlbumsFromTracks(tracks) {
    const map = new Map();
    for (const t of tracks) {
        let album = (t.album || '').trim();
        if (!album && t.displayTitle.includes('(')) {
            const match = t.displayTitle.match(/\((.*?)\)/);
            if (match && !match[1].toLowerCase().includes('feat') && !match[1].toLowerCase().includes('video')) {
                album = match[1];
            }
        }
        if (!album) continue;
        if (!map.has(album.toLowerCase())) {
            map.set(album.toLowerCase(), {
                name: album,
                artist: t.displayArtist || t.artist,
                cover: t.cover || '/logo-mark.png',
                year: t.releaseYear || new Date().getFullYear()
            });
        }
    }
    return Array.from(map.values());
}

function renderSpotifyArtistCard(artist) {
    return `
        <div class="sp-artist-card" onclick="filterSearchByArtist('${escapeHtml(artist.name)}')">
            <div class="sp-artist-avatar-wrap">
                <img src="${artist.cover}" alt="${escapeHtml(artist.name)}" onerror="this.src='/logo-mark.png'">
            </div>
            <div class="sp-artist-name">${escapeHtml(artist.name)}</div>
            <div class="sp-artist-role">Artist</div>
            <button class="sp-follow-btn" onclick="event.stopPropagation(); toggleFollowArtist('${escapeHtml(artist.name)}', this)">Follow</button>
        </div>
    `;
}

function renderSpotifyAlbumCard(album) {
    return `
        <div class="sp-album-card" onclick="searchMusic('${escapeHtml(album.name)}')">
            <div class="sp-album-cover-wrap">
                <img src="${album.cover}" alt="${escapeHtml(album.name)}" onerror="this.src='/logo-mark.png'">
                <div class="sp-album-play-btn">▶</div>
            </div>
            <div class="sp-album-title">${escapeHtml(album.name)}</div>
            <div class="sp-album-meta">${album.year} • Album</div>
        </div>
    `;
}

function filterSearchByArtist(artistName) {
    const input = document.getElementById('search-input');
    if (input) input.value = artistName;
    searchMusic(artistName);
}

function toggleFollowArtist(artistName, btn) {
    if (!btn) return;
    const isFollowing = btn.classList.contains('following');
    btn.classList.toggle('following', !isFollowing);
    btn.textContent = isFollowing ? 'Follow' : 'Following';
    if (typeof showToast === 'function') {
        showToast(!isFollowing ? `Following ${artistName}` : `Unfollowed ${artistName}`, 'info');
    }
}

// ==================================================================
// SPOTIFY RIGHT-HAND "NOW PLAYING" SIDECAR CONTROLLERS
// ==================================================================

function toggleNowPlayingSidecar(forcedState) {
    const sidecar = document.getElementById('now-playing-panel');
    const toggleBtn = document.getElementById('toggle-now-playing-btn');
    if (!sidecar) return;

    const isCurrentlyCollapsed = sidecar.classList.contains('collapsed');
    const willCollapse = typeof forcedState === 'boolean' ? !forcedState : !isCurrentlyCollapsed;

    sidecar.classList.toggle('collapsed', willCollapse);
    if (toggleBtn) {
        toggleBtn.classList.toggle('active', !willCollapse);
    }
    try {
        localStorage.setItem('basa_now_playing_sidecar', willCollapse ? '0' : '1');
    } catch (e) {}
}

function updateNowPlayingSidecar(trackData) {
    if (!trackData) return;
    const npCover = document.getElementById('np-cover-img');
    const npTitle = document.getElementById('np-track-title');
    const npArtist = document.getElementById('np-track-artist');
    const npContext = document.getElementById('np-context-title');
    const npLikeBtn = document.getElementById('np-like-btn');

    if (npCover && trackData.cover) npCover.src = trackData.cover;
    if (npTitle) npTitle.textContent = trackData.title || 'Not Playing';
    if (npArtist) npArtist.textContent = trackData.artist || '';
    if (npContext) npContext.textContent = trackData.title ? `Based on ${trackData.title}` : 'Now Playing';

    if (npLikeBtn && trackData.id) {
        checkIfLiked(trackData.id, trackData.source).then(liked => {
            if (npLikeBtn) {
                npLikeBtn.textContent = liked ? '♥' : '♡';
                npLikeBtn.classList.toggle('active', Boolean(liked));
            }
        }).catch(() => {});
    }

    // Populate Related Music Videos / Up Next
    const npList = document.getElementById('np-related-list');
    if (npList) {
        const upcoming = window.playerQueueStore ? window.playerQueueStore.getUpcomingItems().slice(0, 4) : [];
        if (upcoming.length > 0) {
            npList.innerHTML = upcoming.map((item, idx) => {
                const s = item.song;
                const encoded = encodeURIComponent(JSON.stringify(mapTrackToStandard(s, s.source || 'youtube')));
                return `
                    <div class="np-related-item" onclick="playTrackFromData('${encoded}', 'related', ${idx})">
                        <div class="np-related-thumb-wrap">
                            <img src="${s.cover || '/logo-mark.png'}" alt="${escapeHtml(s.title)}" onerror="this.src='/logo-mark.png'">
                        </div>
                        <div class="np-related-info">
                            <span class="np-related-track-title">${escapeHtml(s.title)}</span>
                            <span class="np-related-track-artist">${escapeHtml(s.artist)}</span>
                        </div>
                    </div>
                `;
            }).join('');
        } else if (state.recommendedQueue && state.recommendedQueue.length > 0) {
            npList.innerHTML = state.recommendedQueue.slice(0, 3).map((s, idx) => {
                const encoded = encodeURIComponent(JSON.stringify(mapTrackToStandard(s, s.source || 'youtube')));
                return `
                    <div class="np-related-item" onclick="playTrackFromData('${encoded}', 'related', ${idx})">
                        <div class="np-related-thumb-wrap">
                            <img src="${s.cover || '/logo-mark.png'}" alt="${escapeHtml(s.title)}" onerror="this.src='/logo-mark.png'">
                        </div>
                        <div class="np-related-info">
                            <span class="np-related-track-title">${escapeHtml(s.title)}</span>
                            <span class="np-related-track-artist">${escapeHtml(s.artist)}</span>
                        </div>
                    </div>
                `;
            }).join('');
        }
    }
}

function openFullscreenLyrics() {
    userWantsLyrics = true;
    if (typeof openFullScreenPlayer === 'function') {
        openFullScreenPlayer();
    }
    if (typeof setFsPlayerMode === 'function') {
        setFsPlayerMode('lyrics');
    }
}

function toggleLikeCurrentTrack() {
    if (state.currentTrack && state.currentTrack.id) {
        toggleLikeTrack(state.currentTrack.id);
        const npLike = document.getElementById('np-like-btn');
        if (npLike) {
            const isLiked = npLike.textContent === '♥';
            npLike.textContent = isLiked ? '♡' : '♥';
            npLike.classList.toggle('active', !isLiked);
        }
    }
}

function copyCurrentTrackLink() {
    if (state.currentTrack) {
        const text = `${state.currentTrack.title} by ${state.currentTrack.artist} on BASA`;
        if (navigator.clipboard) {
            navigator.clipboard.writeText(text).then(() => {
                if (typeof showToast === 'function') showToast('Copied song info to clipboard!', 'info');
            });
        }
    }
}

// 7. HOME VIEW — BASA V2 PERSONALIZED RECOMMENDATIONS & LANGUAGE-AWARE NEW RELEASES

let activeNewReleaseLanguage = localStorage.getItem('basa_active_release_lang') || 'Tamil';
let activeNewReleaseRequestId = 0;

/**
 * Initializes language pills with accessible keyboard and click handlers (Section 10, 33, 46).
 */
function initLanguagePills() {
    const container = document.getElementById('lang-pills-container');
    if (!container) return;

    const savedLang = localStorage.getItem('basa_active_release_lang') || 'Tamil';
    activeNewReleaseLanguage = savedLang;

    container.querySelectorAll('.lang-pill').forEach(pill => {
        const pillLang = pill.getAttribute('data-lang');
        const isActive = pillLang.toLowerCase() === savedLang.toLowerCase();
        pill.classList.toggle('active', isActive);
        pill.setAttribute('aria-pressed', isActive ? 'true' : 'false');

        // Accessible click / keyboard selection
        pill.onclick = (e) => {
            e.preventDefault();
            container.querySelectorAll('.lang-pill').forEach(p => {
                p.classList.remove('active');
                p.setAttribute('aria-pressed', 'false');
            });
            pill.classList.add('active');
            pill.setAttribute('aria-pressed', 'true');

            activeNewReleaseLanguage = pillLang;
            localStorage.setItem('basa_active_release_lang', pillLang);

            // Fetch new releases for selected language without recomputing user detected language (Section 10, 33)
            loadNewReleases(pillLang);
        };
    });
}

/**
 * Loads personalized recommendations based on authoritative DB history (authenticated) or guest session (Section 1, 2, 26, 27).
 */
async function loadPersonalizedRecommendations() {
    const recGrid = document.getElementById('recommended-grid');
    const recSubtitle = document.getElementById('recommended-subtitle');
    const tasteBadge = document.getElementById('taste-detected-badge');
    if (!recGrid) return;

    recGrid.innerHTML = '<div class="grid-skeleton">Curating your recommendations...</div>';

    try {
        let data = null;
        if (state.token) {
            // Authenticated: DB is authoritative (Section 2)
            data = await api('/music/personalized-recommendations');
        } else {
            // Guest session: inspect localStorage history
            let guestHistory = [];
            try {
                const raw = localStorage.getItem('basa_guest_history');
                if (raw) guestHistory = JSON.parse(raw);
            } catch (e) {}

            if (guestHistory && guestHistory.length > 0) {
                const res = await fetch('/api/music/personalized-recommendations/session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tracks: guestHistory })
                });
                data = await res.json();
            } else {
                data = await api('/music/personalized-recommendations');
            }
        }

        const tracks = (data && data.recommendations) || [];
        if (tracks.length > 0) {
            window.currentRecommendedTracks = tracks;
            recGrid.innerHTML = tracks.map((t, idx) => renderTrackCard(t, t.source || 'youtube', idx, 'recommended')).join('');

            // Evidence-based taste badge & subtitle (Section 9, 45)
            if (data.detectedFrom === 'HISTORY') {
                if (tasteBadge) {
                    const confPct = Math.round((data.languageConfidence || 0.75) * 100);
                    tasteBadge.textContent = `${data.topLanguage} Taste · ${confPct}%`;
                    tasteBadge.style.display = 'inline-flex';
                }
                if (recSubtitle) {
                    recSubtitle.textContent = `Personalized for your ${data.topLanguage} listening history`;
                }
            } else {
                if (tasteBadge) tasteBadge.style.display = 'none';
                if (recSubtitle) {
                    recSubtitle.textContent = 'Curated recommendations for you';
                }
            }
        } else {
            recGrid.innerHTML = '<div class="empty-state">Listen to a few more songs to personalize your recommendations.</div>';
        }
    } catch (err) {
        console.warn('[Home] Recommendations load error:', err);
        recGrid.innerHTML = '<div class="empty-state">Listen to a few more songs to personalize your recommendations.</div>';
    }
}

/**
 * Loads language-aware new releases with date/year verification and stale response cancellation (Section 16, 28, 33).
 */
async function loadNewReleases(language = activeNewReleaseLanguage) {
    const releaseGrid = document.getElementById('new-releases-grid');
    const langTitle = document.getElementById('new-releases-lang-title');
    const releaseSubtitle = document.getElementById('new-releases-subtitle');
    if (!releaseGrid) return;

    // Stale request handling: track latest request ID so rapid clicks don't overwrite with old responses (Section 33)
    const currentRequestId = ++activeNewReleaseRequestId;

    if (langTitle) langTitle.textContent = language;
    releaseGrid.innerHTML = `<div class="grid-skeleton">Verifying new releases for ${escapeHtml(language)}...</div>`;

    try {
        const data = await api(`/music/new-releases?language=${encodeURIComponent(language)}`);

        // Discard stale responses if user clicked another pill in the meantime (Section 33)
        if (currentRequestId !== activeNewReleaseRequestId) {
            return;
        }

        const releases = (data && data.releases) || [];
        if (releases.length > 0) {
            window.currentNewReleases = releases;
            releaseGrid.innerHTML = releases.map((t, idx) => renderTrackCard(t, t.source || 'jiosaavn', idx, 'newreleases')).join('');
            if (releaseSubtitle) {
                if (data.languageSource === 'AUTO_DETECTED') {
                    releaseSubtitle.textContent = `Showing verified ${data.language} releases`;
                } else {
                    releaseSubtitle.textContent = `Showing ${data.language} releases`;
                }
            }
        } else {
            // Empty state requirement (Section 48): never fake new releases
            releaseGrid.innerHTML = `<div class="empty-state">No verified new releases found for ${escapeHtml(language)} right now.</div>`;
        }
    } catch (err) {
        if (currentRequestId === activeNewReleaseRequestId) {
            console.warn('[Home] New releases load error:', err);
            releaseGrid.innerHTML = `<div class="empty-state">No verified new releases found for ${escapeHtml(language)} right now.</div>`;
        }
    }
}

async function loadTrendingCharts() {
    const chartsGrid = document.getElementById('charts-grid');
    if (!chartsGrid) return;

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

async function loadLosslessMusic() {
    const losslessGrid = document.getElementById('lossless-grid');
    if (!losslessGrid) return;

    losslessGrid.innerHTML = '<div class="loader">Loading Hi-Fi &amp; Lossless music...</div>';
    try {
        const data = await api('/music/lossless?limit=12');
        const tracks = data.data || [];
        if (tracks.length > 0) {
            window.currentLosslessTracks = tracks;
            losslessGrid.innerHTML = tracks.map((t, idx) => renderTrackCard(t, t.source, idx, 'lossless')).join('');
        } else {
            losslessGrid.innerHTML = '<div class="empty-state">No lossless tracks available yet. Submit a request to ingest master audio.</div>';
        }
    } catch (e) {
        console.error('Lossless loading error', e);
        losslessGrid.innerHTML = '<div class="empty-state">Unable to load lossless collection.</div>';
    }
}

async function loadRecentlyPlayed() {
    const recentGrid = document.getElementById('recent-grid');
    if (!recentGrid) return;

    if (state.token) {
        try {
            const data = await api('/library/history?limit=10');
            let tracks = data.tracks || [];
            tracks = tracks.filter(item => item.track_data && (item.track_data.videoId || item.track_data.id) && !isShortTrack(item.track_data));
            if (tracks.length > 0) {
                window.currentRecentTracks = tracks.map(item => ({ ...item.track_data, source: item.track_source }));
                recentGrid.innerHTML = tracks.map((item, idx) => renderTrackCard(item.track_data, item.track_source, idx, 'recent')).join('');
            } else {
                recentGrid.innerHTML = '<p class="empty-state">Your recently played tracks will appear here</p>';
            }
        } catch (err) {
            recentGrid.innerHTML = '<p class="empty-state">Your recently played tracks will appear here</p>';
        }
    } else {
        recentGrid.innerHTML = '<p class="empty-state">Your recently played tracks will appear here</p>';
    }
}

/**
 * Parallel fault-isolated Home loader using Promise.allSettled() (Section 32, 50, 52).
 */
async function loadHome() {
    initLanguagePills();

    // Sections load in parallel. If any one section fails, others still render cleanly.
    await Promise.allSettled([
        loadPersonalizedRecommendations(),
        loadNewReleases(activeNewReleaseLanguage),
        loadTrendingCharts(),
        loadLosslessMusic(),
        loadRecentlyPlayed()
    ]);
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
    } else if (effectiveSource === 'lossless') {
        id = track.id;
        cover = track.cover || track.cover_url || '';
        title = track.title || 'Unknown Title';
        artist = track.artist || 'Unknown Artist';
        preview = track.preview || track.audioUrl || '';
        audioUrl = preview;
    } else if (effectiveSource === 'jiosaavn' || (track.id && String(track.id).startsWith('saavn_')) || (track.streamUrl && track.streamUrl.includes('saavncdn.com'))) {
        id = track.id;
        cover = track.cover || track.cover_url || (typeof track.artwork === 'string' ? track.artwork : (track.artwork?.['500x500'] || track.artwork?.url)) || '';
        title = track.title || 'Unknown Title';
        artist = track.artist || 'Unknown Artist';
        const rawStream = track.streamUrl || track.directStreamUrl || track.audioUrl || '';
        preview = (rawStream && rawStream.startsWith('http')) ? rawStream : `/api/music/jiosaavn-stream/${encodeURIComponent(track.id || track.sourceId || '')}`;
        audioUrl = preview;
    } else {
        id = track.id || track.videoId;
        cover = track.cover || 
            (typeof track.artwork === 'string' ? track.artwork : (track.artwork?.['500x500'] || track.artwork?.['480x480'] || track.artwork?.['150x150'] || track.artwork?.url)) ||
            (Array.isArray(track.image) ? (track.image[track.image.length - 1]?.link || track.image[track.image.length - 1]?.url || (typeof track.image[0] === 'string' ? track.image[0] : '')) : (typeof track.image === 'string' ? track.image : '')) ||
            track.thumbnail ||
            (Array.isArray(track.thumbnails) ? track.thumbnails[track.thumbnails.length - 1]?.url : '') ||
            '';
        if (!cover && (effectiveSource === 'youtube' || (typeof id === 'string' && id.length === 11))) {
            const ytVid = track.videoId || id;
            if (ytVid && typeof ytVid === 'string' && !ytVid.startsWith('http') && !ytVid.startsWith('/')) {
                cover = `https://i.ytimg.com/vi/${ytVid}/hqdefault.jpg`;
            }
        }
        title = track.title || 'Unknown';
        artist = track.user?.name || track.artist || 'Unknown Artist';
        preview = track.videoId || track.preview || track.id;
        audioUrl = preview;
    }

    const durationMs = track.durationMs != null ? Number(track.durationMs) : (track.duration ? Number(track.duration) * 1000 : null);
    const durationSec = track.duration != null ? Number(track.duration) : (track.durationSec != null ? Number(track.durationSec) : (durationMs != null ? Math.round(durationMs / 1000) : 0));

    return { 
        id, videoId: track.videoId || id || preview, title, artist, album: track.album?.title || track.album || '', cover, preview,
        duration: durationSec, durationMs, durationSec,
        audioUrl, fallbackUrl, source: effectiveSource,
        streamUrl: track.streamUrl || track.directStreamUrl || (effectiveSource === 'jiosaavn' ? preview : (effectiveSource === 'local' ? preview : '')),
        sourceId: track.sourceId || id,
        quality: track.quality, format: track.format, codec: track.codec,
        lossless: Boolean(track.isLossless || track.lossless),
        isLossless: Boolean(track.isLossless || track.lossless),
        isHiRes: Boolean(track.isHiRes || track.quality === 'HI_RES_LOSSLESS'),
        sampleRate: track.sampleRate || track.sample_rate, 
        bitDepth: track.bitDepth || track.bit_depth, 
        bitrate: track.bitrate,
        license: track.license, licenseUrl: track.licenseUrl || track.license_url,
        rightsStatus: track.rightsStatus || track.rights_status,
        status: track.status,
        isCached: track.isCached !== undefined ? track.isCached : true,
        sourceName: track.sourceName,
        sourcePriority: track.sourcePriority,
        qualityRankBadge: track.qualityRankBadge,
        candidates: track.candidates || [],
        availableSources: track.availableSources || [],
        requiresUpgrade: track.requiresUpgrade || false,
        upgradeStatus: track.upgradeStatus || null,
        recordingVersion: track.recordingVersion || track.versionType || 'ORIGINAL',
        versionType: track.versionType || track.recordingVersion || 'ORIGINAL',
        isOfficial: Boolean(track.isOfficial),
        isOriginal: track.isOriginal !== undefined ? Boolean(track.isOriginal) : true,
        canonicalTrackId: track.canonicalTrackId || track.canonicalId || null,
        reason: track.reason || '',
        releaseTag: track.releaseTag || null,
        releaseDate: track.releaseDate || null
    };
}

function renderTrackCard(track, source = 'youtube', index = -1, contextType = '') {
    // Layer 9 Defense-in-depth: Never render a YouTube Short card
    if (typeof isDisallowedShortFormCandidate === 'function' && isDisallowedShortFormCandidate(track)) {
        return '';
    }
    const trackObj = mapTrackToStandard(track, source);
    const encoded = encodeURIComponent(JSON.stringify(trackObj));

    const coverHtml = trackObj.cover
        ? `<img src="${trackObj.cover}" alt="${trackObj.title}" loading="lazy" onerror="this.style.display='none'">`
        : `<div style="width:100%;height:100%;display:grid;place-items:center;font-size:32px;opacity:0.2">🎵</div>`;

    const clickCall = index >= 0 && contextType
        ? `playTrackFromData('${encoded}', '${contextType}', ${index})`
        : `playTrackFromData('${encoded}')`;

    // Release tag badge on cover (Section 17, 29: e.g. "NEW 2026" or "2026")
    const releaseTagHtml = trackObj.releaseTag
        ? `<div class="new-release-tag-badge">${escapeHtml(trackObj.releaseTag)}</div>`
        : '';

    // Distinguish primary original recording or version in search results (Section 39)
    let versionBadgeHtml = '';
    if (contextType === 'search') {
        if (trackObj.isOriginal || trackObj.recordingVersion === 'ORIGINAL') {
            if (index === 0) {
                versionBadgeHtml = `<div class="track-card-version-badge primary-original">★ PRIMARY RECORDING</div>`;
            } else if (trackObj.isOfficial) {
                versionBadgeHtml = `<div class="track-card-version-badge primary-original">★ OFFICIAL</div>`;
            }
        } else if (trackObj.recordingVersion && trackObj.recordingVersion !== 'ORIGINAL') {
            versionBadgeHtml = `<div class="track-card-version-badge version-alternate">${escapeHtml(trackObj.recordingVersion)}</div>`;
        }
    }

    return `
    <div class="track-card glass-subtle" onclick="${clickCall}">
        <div class="track-card-cover">
            ${releaseTagHtml}
            ${coverHtml}
            <div class="track-card-play"><div class="track-card-play-btn">▶</div></div>
            <button class="track-card-queue-btn" onclick="event.stopPropagation();addToQueueFromData('${encoded}')" title="Add to Queue" aria-label="Add to Queue">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            </button>
        </div>
        <div class="track-card-info">
            <div class="track-card-title">${escapeHtml(trackObj.title)}</div>
            <div class="track-card-artist" style="cursor:pointer;" onclick="event.stopPropagation();openArtistModal('${escapeHtml(trackObj.artist)}', '${trackObj.cover || ''}')">${escapeHtml(trackObj.artist)}</div>
            ${versionBadgeHtml}
            ${renderQualityBadge(trackObj)}
        </div>
    </div>`;
}

function renderQualityBadge(track) {
    if (!track) return '';

    const isCurrent = window.playbackManager && window.playbackManager.currentTrack && window.playbackManager.currentTrack.id === track.id;
    const currentState = isCurrent ? window.playbackManager.playerState : null;

    if (track.upgradeStatus === 'buffering' || currentState === 'PREPARING_UPGRADE' || currentState === 'UPGRADING') {
        return `<div class="quality-badge badge-resolving" title="Buffering lossless stream for seamless handoff..."><span class="badge-icon">⏳</span><span class="badge-title">Upgrading...</span></div>`;
    }

    // Check if track is actively resolving or preparing upgrade
    if (track.upgradeStatus === 'resolving' || currentState === 'RESOLVING_LOSSLESS' ||
        (isCurrent && window.playbackManager.pendingUpgradeCandidate)) {
        return `<div class="quality-badge badge-resolving" title="Resolving higher quality audio stream in background..."><span class="badge-icon">⚡</span><span class="badge-title">Resolving Hi-Res...</span></div>`;
    }

    const fmtLower = String(track.codec || track.format || '').toLowerCase();
    const isFlacOrLossless = fmtLower === 'flac' || fmtLower.includes('flac');

    // Section 11 & 26: Display lossless badge ONLY if actual source is verified
    const isVerifiedLossless = isFlacOrLossless && (
        track.verificationStatus === 'VERIFIED' ||
        track.losslessVerification === 'VERIFIED' ||
        track.playableLosslessVerified === true ||
        track.isCached === true ||
        track.cached === true
    );

    if (isVerifiedLossless) {
        const bitDepth = Number(track.bitDepth) || (track.quality === 'HI_RES_LOSSLESS' ? 24 : 16);
        const sampleRate = Number(track.sampleRate) || (track.quality === 'HI_RES_LOSSLESS' ? 96000 : 44100);
        const isHiRes = bitDepth > 16 || sampleRate > 48000 || track.quality === 'HI_RES_LOSSLESS';

        const bitStr = `${bitDepth}-bit`;
        const rateStr = `${Math.round(sampleRate / 1000)} kHz`;

        if (isHiRes) {
            return `<div class="quality-badge badge-hires" title="Hi-Res Lossless Audio (FLAC · ${bitStr} / ${rateStr})"><span class="badge-icon">◆</span><span class="badge-title">HI-RES LOSSLESS</span><span class="badge-sep">·</span><span class="badge-meta">FLAC · ${bitStr} / ${rateStr}</span></div>`;
        } else {
            return `<div class="quality-badge badge-lossless" title="Studio Lossless Quality (FLAC · ${bitStr} / ${rateStr})"><span class="badge-icon">✦</span><span class="badge-title">LOSSLESS</span><span class="badge-sep">·</span><span class="badge-meta">FLAC · ${bitStr} / ${rateStr}</span></div>`;
        }
    }

    // Section 19: Ordinary search & track cards remain clean. No provider chips (YouTube, JioSaavn, Qobuz, etc.)
    return '';
}

function renderPlayerQualityBadge(track) {
    if (!track) return '';

    const isCurrent = window.playbackManager && window.playbackManager.currentTrack && window.playbackManager.currentTrack.id === track.id;
    const currentState = isCurrent ? window.playbackManager.playerState : null;
    const provider = String(track.source || track.provider || (window.playbackManager ? window.playbackManager.provider : '') || '').toLowerCase();

    // 1. Actively Upgrading State (Seamless crossfade in progress)
    if (track.upgradeStatus === 'buffering' || currentState === 'PREPARING_UPGRADE' || currentState === 'UPGRADING') {
        return `<div class="quality-badge badge-resolving" onclick="openPipelineInspectorModal()" style="cursor:pointer;" title="Buffering studio lossless stream for seamless handoff... Click to inspect audio signal path"><span class="badge-icon">⏳</span><span class="badge-title">UPGRADING</span><span class="badge-sep">·</span><span class="badge-meta">TO FLAC</span></div>`;
    }

    // 2. Actively Resolving Hi-Res / Lossless in Background
    if (track.upgradeStatus === 'resolving' || currentState === 'RESOLVING_LOSSLESS' ||
        (isCurrent && window.playbackManager && window.playbackManager.pendingUpgradeCandidate)) {
        return `<div class="quality-badge badge-resolving" onclick="openPipelineInspectorModal()" style="cursor:pointer;" title="Resolving studio lossless stream in background... Click to inspect audio signal path"><span class="badge-icon">⚡</span><span class="badge-title">RESOLVING</span><span class="badge-sep">·</span><span class="badge-meta">HI-RES</span></div>`;
    }

    const fmtLower = String(track.codec || track.format || '').toLowerCase();
    const isFlacOrLossless = fmtLower === 'flac' || fmtLower.includes('flac') || fmtLower === 'alac' || fmtLower === 'wav';

    // 3. Verified Lossless Audio (FLAC / ALAC / WAV or Verified Source)
    const isVerifiedLossless = isFlacOrLossless && (
        track.verificationStatus === 'VERIFIED' ||
        track.losslessVerification === 'VERIFIED' ||
        track.playableLosslessVerified === true ||
        track.isCached === true ||
        track.cached === true ||
        track.isLossless === true ||
        track.quality === 'HI_RES_LOSSLESS' ||
        track.quality === 'LOSSLESS' ||
        provider === 'local'
    );

    if (isVerifiedLossless) {
        const bitDepth = Number(track.bitDepth) || (track.quality === 'HI_RES_LOSSLESS' ? 24 : 16);
        const sampleRate = Number(track.sampleRate) || (track.quality === 'HI_RES_LOSSLESS' ? 96000 : 44100);
        const isHiRes = bitDepth > 16 || sampleRate > 48000 || track.quality === 'HI_RES_LOSSLESS';

        const bitStr = `${bitDepth}-bit`;
        const rateStr = `${Math.round(sampleRate / 1000)} kHz`;

        if (isHiRes) {
            return `<div class="quality-badge badge-hires" onclick="openPipelineInspectorModal()" style="cursor:pointer;" title="Hi-Res Lossless Audio (FLAC · ${bitStr} / ${rateStr}) — Click to inspect audio signal path"><span class="badge-icon">◆</span><span class="badge-title">HI-RES LOSSLESS</span><span class="badge-sep">·</span><span class="badge-meta">${bitDepth}/96 FLAC</span></div>`;
        } else {
            return `<div class="quality-badge badge-lossless" onclick="openPipelineInspectorModal()" style="cursor:pointer;" title="Studio Lossless Quality (FLAC · ${bitStr} / ${rateStr}) — Click to inspect audio signal path"><span class="badge-icon">✦</span><span class="badge-title">LOSSLESS</span><span class="badge-sep">·</span><span class="badge-meta">16/44.1 FLAC</span></div>`;
        }
    }

    // 4. HD Audio (JioSaavn 320 kbps AAC / High Bitrate)
    const isJioSaavn = provider === 'jiosaavn' || String(track.id || '').startsWith('saavn_') || Boolean(track.providerMetadata?.encrypted_media_url);
    const bitrate = Number(track.bitrate) || (isJioSaavn ? 320 : null);

    if (isJioSaavn || bitrate >= 320 || track.quality === 'HIGH') {
        const codecStr = (track.codec || 'AAC').toUpperCase();
        const bitStr = bitrate ? `${bitrate}k` : '320k';
        return `<div class="quality-badge badge-high" onclick="openPipelineInspectorModal()" style="cursor:pointer;" title="High-Definition Audio (${bitStr} ${codecStr} · JioSaavn HD Stream) — Click to inspect audio signal path"><span class="badge-icon">✦</span><span class="badge-title">HD AUDIO</span><span class="badge-sep">·</span><span class="badge-meta">${bitStr} ${codecStr}</span></div>`;
    }

    // 5. Standard Quality Stream (YouTube Opus 160k / AAC 128-256k)
    const codecStr = (track.codec || (provider === 'youtube' ? 'Opus' : 'AAC')).toUpperCase();
    const bitStr = bitrate ? `${bitrate}k` : (codecStr === 'OPUS' ? '160k' : '160k');
    return `<div class="quality-badge badge-standard" onclick="openPipelineInspectorModal()" style="cursor:pointer;" title="Standard Quality Stream (${bitStr} ${codecStr}) — Click to inspect audio signal path"><span class="badge-icon">●</span><span class="badge-title">STANDARD</span><span class="badge-sep">·</span><span class="badge-meta">${bitStr} ${codecStr}</span></div>`;
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
        <button class="track-action-btn" onclick="event.stopPropagation();downloadTrackFromData('${encoded}')" title="Download Audio">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
        </button>
        <button class="track-action-btn" onclick="event.stopPropagation();showAddToPlaylist(event,'${trackObj.id}','${trackObj.source}','${encoded}')" title="Add to playlist">+</button>
    `;
    if (options.isUpload) {
        actions += `<button class="track-action-btn" onclick="event.stopPropagation();deleteUpload('${trackObj.id}')" title="Delete">🗑</button>`;
    }
    if (options.playlistEntryId) {
        actions += `<button class="track-action-btn" onclick="event.stopPropagation();removeFromPlaylist('${options.playlistId}','${options.playlistEntryId}')" title="Remove">✕</button>`;
    }

    // Render source chips if multiple candidates exist
    let sourcesChipsHtml = '';
    if (trackObj.availableSources && trackObj.availableSources.length > 1) {
        const chips = trackObj.availableSources.map(s => {
            const label = s.source === 'youtube' ? 'YouTube' : (s.source === 'jiosaavn' ? 'JioSaavn HD' : (s.isHiRes ? 'Hi-Res' : 'FLAC'));
            const icon = s.isHiRes ? '💎' : (s.isLossless ? '✦' : '▶');
            return `<span class="source-chip" title="${escapeHtml(s.title)} (${s.quality || 'Audio'})" onclick="event.stopPropagation();openCandidateSourcesModal('${encoded}')">${icon} ${label}</span>`;
        }).join('');
        sourcesChipsHtml = `<div class="sources-chips-row" style="display:inline-flex; margin-left:8px;">${chips}</div>`;
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
                <span class="track-list-artist" style="cursor:pointer;" onclick="event.stopPropagation();openArtistModal('${escapeHtml(trackObj.artist)}', '${trackObj.cover || ''}')">${escapeHtml(trackObj.artist)}</span>
                ${renderQualityBadge(trackObj)}
                ${sourcesChipsHtml}
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
        
        // Search results are query matches, NOT a continuous playlist/album!
        // When a user selects a search result, play it standalone and let Smart Up Next take over.
        if (contextType === 'search') {
            state.queue = [trackData];
            state.queueIndex = 0;
            saveQueueState();
            playTrack(trackData);
            return;
        }

        let contextList = null;
        if (contextType === 'charts' && window.currentChartsTracks) {
            contextList = window.currentChartsTracks.map(t => mapTrackToStandard(t, t.source || 'youtube'));
        } else if (contextType === 'lossless' && window.currentLosslessTracks) {
            contextList = window.currentLosslessTracks.map(t => mapTrackToStandard(t, t.source));
        } else if (contextType === 'library' && window.currentLibraryTracks) {
            contextList = window.currentLibraryTracks.map(t => mapTrackToStandard(t, t.source));
        } else if (contextType === 'playlist' && window.currentPlaylistTracks) {
            contextList = window.currentPlaylistTracks.map(t => mapTrackToStandard(t, t.source));
        } else if ((contextType === 'upload' || contextType === 'local') && window.currentUploadTracks) {
            contextList = window.currentUploadTracks.map(t => mapTrackToStandard(t, 'local'));
        } else if (contextType === 'recent' && window.currentRecentTracks) {
            contextList = window.currentRecentTracks.map(t => mapTrackToStandard(t, t.source || 'youtube'));
        }

        if (contextList && contextList.length > 0 && index >= 0 && index < contextList.length) {
            playFromList(contextList, index);
        } else {
            // Standalone play: preserve upcoming queue if any, starting with this track
            const upcoming = (state.queue && state.queueIndex >= 0 && state.queueIndex < state.queue.length - 1)
                ? state.queue.slice(state.queueIndex + 1).filter(t => !isSameSongFamily(trackData, t))
                : [];
            state.queue = [trackData, ...upcoming];
            state.queueIndex = 0;
            saveQueueState();
            playTrack(trackData);
        }
    } catch (e) {
        console.error('Failed to parse track data', e);
    }
}

// Client-side Song Family & Recommendation Safety Validation (Section 16, 17, 18)
function cleanBaseTitle(title, artist = '') {
    if (!title) return '';
    let str = String(title).toLowerCase();
    if (artist && str.includes(' - ')) {
        const parts = str.split(/\s+-\s+/);
        const normArt = String(artist).toLowerCase().trim();
        if (parts[0].includes(normArt)) {
            str = parts.slice(1).join(' - ');
        }
    }
    str = str.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ');
    // Video quality / resolution noise
    str = str.replace(/\b(?:8k\/?4k|4k\/?8k|8k|4k|1080p|720p|uhd|hd|hq)\b/gi, ' ');
    // Release and video qualifiers
    str = str.replace(/\b(?:official\s*(?:audio|video|music\s*video)|lyric\s*video|lyrics|full\s*video\s*song|full\s*video|full\s*song|audio\s*song|video\s*song|visualizer|topic|interlude|promo)\b/gi, ' ');
    // Version modifiers
    str = str.replace(/\b(?:remix|slowed(?:\s*\+\s*reverb)?|reverb|sped\s*up|speed\s*up|nightcore|fast(?:\s*version)?|bass\s*boost(?:ed)?|orchestral(?:\s*version)?|live(?:\s+at\s+[^\])]+|\s+in\s+[^\])]+)?|acoustic(?:\s*version)?|unplugged|cover|instrumental|karaoke|extended(?:\s*mix|\s*version)?|remastered|radio\s*edit)\b/gi, ' ');

    // Indian / YouTube titles often format: 'Song Title | Movie Name'
    if (str.includes('|')) {
        const seg = str.split('|')[0].trim();
        if (seg.length >= 3) str = seg;
    }

    str = str.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    return str;
}

function isSameSongFamily(trackA, trackB) {
    if (!trackA || !trackB) return false;
    const idA = trackA.canonicalTrackId || trackA.canonicalId;
    const idB = trackB.canonicalTrackId || trackB.canonicalId;
    if (idA && idB && idA === idB) return true;

    const baseA = cleanBaseTitle(trackA.title || '', trackA.artist || '');
    const baseB = cleanBaseTitle(trackB.title || '', trackB.artist || '');
    if (!baseA || !baseB || baseA.length < 2 || baseB.length < 2) return false;

    const isMatch = (baseA === baseB) || 
                    (baseA.length >= 8 && baseB.length >= 8 && (baseA.startsWith(baseB + ' ') || baseB.startsWith(baseA + ' ')));

    if (isMatch) {
        const titleA = String(trackA.title || '').toLowerCase();
        const titleB = String(trackB.title || '').toLowerCase();
        const versionWords = /\b(cover|remix|slowed|sped\s*up|fast|bass\s*boost|orchestral|live|acoustic|instrumental|karaoke|extended)\b/i;
        if (versionWords.test(titleA) || versionWords.test(titleB)) {
            return true;
        }
        const artA = String(trackA.artist || '').toLowerCase().trim();
        const artB = String(trackB.artist || '').toLowerCase().trim();
        if (!artA || !artB || artA === artB || artA.includes(artB) || artB.includes(artA)) {
            const durA = Number(trackA.duration) || 0;
            const durB = Number(trackB.duration) || 0;
            if (durA > 0 && durB > 0 && Math.abs(durA - durB) > 45) {
                return false;
            }
            return true;
        }
    }
    return false;
}

function validateRecommendationQueue(queue, currentTrack, recentHistory = []) {
    if (!Array.isArray(queue) || queue.length === 0) return [];
    const valid = [];
    const seenCanonical = new Set();
    const currCanonId = currentTrack ? (currentTrack.canonicalTrackId || currentTrack.canonicalId || currentTrack.id) : null;

    for (const item of queue) {
        if (!item) continue;
        if (typeof isDisallowedShortFormCandidate === 'function' && isDisallowedShortFormCandidate(item)) continue;
        const candId = item.canonicalTrackId || item.canonicalId || item.id;
        if (!candId) continue;

        if (currCanonId && candId === currCanonId) continue;
        if (seenCanonical.has(candId)) continue;
        if (currentTrack && isSameSongFamily(currentTrack, item)) continue;

        if (recentHistory && recentHistory.length > 0) {
            if (recentHistory[0] === candId) continue;
            const rIdx = recentHistory.indexOf(candId);
            if (rIdx !== -1 && rIdx < 15) continue;
        }

        seenCanonical.add(candId);
        valid.push(item);
    }
    return valid;
}

function isValidNextRecommendation(candidate, currentTrack, recentHistory = []) {
    if (!candidate) return false;
    if (typeof isDisallowedShortFormCandidate === 'function' && isDisallowedShortFormCandidate(candidate)) return false;
    const currCanonId = currentTrack ? (currentTrack.canonicalTrackId || currentTrack.canonicalId || currentTrack.id) : null;
    const candId = candidate.canonicalTrackId || candidate.canonicalId || candidate.id;

    if (currCanonId && candId === currCanonId) return false;
    if (currentTrack && isSameSongFamily(currentTrack, candidate)) return false;

    if (recentHistory && recentHistory.length > 0) {
        if (recentHistory[0] === candId) return false;
        const rIdx = recentHistory.indexOf(candId);
        if (rIdx !== -1 && rIdx < 15) return false;
    }
    return true;
}

function repairRecommendedQueue() {
    if (!state.recommendedQueue || state.recommendedQueue.length === 0) return;
    state.recommendedQueue = validateRecommendationQueue(
        state.recommendedQueue,
        state.currentTrack,
        state.recentCanonicalTrackIds || []
    );
}

function repairManualQueue() {
    if (!state.queue || state.queue.length <= 1) return;
    const current = state.currentTrack;
    if (!current) return;

    const currentCanonId = current.canonicalTrackId || current.canonicalId || current.id;
    const currentBaseTitle = cleanBaseTitle(current.title, current.artist);

    // Keep history up to queueIndex
    const pastAndCurrent = state.queue.slice(0, state.queueIndex + 1);
    const upcoming = state.queue.slice(state.queueIndex + 1);

    const seenFamilies = new Set();
    if (currentBaseTitle) seenFamilies.add(currentBaseTitle);

    const filteredUpcoming = [];
    for (const item of upcoming) {
        if (!item) continue;
        if (typeof isDisallowedShortFormCandidate === 'function' && isDisallowedShortFormCandidate(item)) continue;
        const itemCanonId = item.canonicalTrackId || item.canonicalId || item.id;
        
        // Exclude exact canonicalTrackId as current
        if (currentCanonId && itemCanonId === currentCanonId) continue;
        
        // Exclude same song family as current
        if (isSameSongFamily(current, item)) continue;

        // Exclude duplicate song family within upcoming queue
        const itemBaseTitle = cleanBaseTitle(item.title, item.artist);
        if (itemBaseTitle && seenFamilies.has(itemBaseTitle)) continue;
        if (itemBaseTitle) seenFamilies.add(itemBaseTitle);

        filteredUpcoming.push(item);
    }

    state.queue = [...pastAndCurrent, ...filteredUpcoming];
    saveQueueState();
}

async function fetchUpNextRecommendations(trackData) {
    if (!trackData) return;
    const trackId = trackData.canonicalTrackId || trackData.canonicalId || trackData.id || '';
    const title = trackData.title || '';
    const artist = trackData.artist || '';
    const album = trackData.album || '';

    state.isFetchingRecommendations = true;
    try {
        const queryParams = new URLSearchParams({
            trackId: String(trackId),
            canonicalTrackId: String(trackData.canonicalTrackId || trackId),
            title,
            artist,
            album,
            limit: '8',
            sessionId: state.user?.id || 'guest_session'
        });
        const res = await api(`/music/recommendations?${queryParams.toString()}`);
        if (res && res.success && Array.isArray(res.recommendations)) {
            const mapped = res.recommendations.map(r => mapTrackToStandard(r, r.source || 'youtube'));
            state.recommendedQueue = validateRecommendationQueue(mapped, state.currentTrack, state.recentCanonicalTrackIds || []);
            renderQueueDrawer();
        }
    } catch (err) {
        console.warn('[Recommendations] Failed to fetch Up Next:', err.message);
    } finally {
        state.isFetchingRecommendations = false;
    }
}

function playTrack(trackData, forceLocal = false, isBackwardNav = false, fromQueueStore = false) {
    if (!fromQueueStore && window.playbackManager) {
        window.playbackManager.consecutiveAutoSkips = 0;
    }
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

    // Keep unified playerQueueStore in sync if track was initiated externally (Step 1)
    if (!fromQueueStore && window.playerQueueStore) {
        window.playerQueueStore.play(trackData);
    }

    // Record into recent searches for instant search suggestions history
    if (trackData && (trackData.title || trackData.name)) {
        try {
            saveRecentSearch({
                id: String(trackData.id || trackData.videoId || Date.now()),
                title: trackData.title || trackData.name,
                artist: trackData.artist || 'Unknown Artist',
                cover: trackData.thumbnail || trackData.cover || '/logo-mark.png',
                type: 'song',
                explicit: !!trackData.explicit,
                isVideo: (trackData.source === 'youtube' && !trackData.isAudioOnly) || !!trackData.isVideo,
                rawTrack: trackData
            });
        } catch (e) {}
    }

    // Record session feedback on outgoing track (skip vs complete)
    if (state.currentTrack && state.currentTrackStartTime > 0 && !isBackwardNav) {
        const elapsedSec = (Date.now() - state.currentTrackStartTime) / 1000;
        const action = elapsedSec < 25 ? 'skip' : (elapsedSec > 60 ? 'complete' : null);
        if (action) {
            api('/music/session-feedback', {
                method: 'POST',
                body: JSON.stringify({
                    trackId: String(state.currentTrack.id),
                    action,
                    durationPlayed: elapsedSec,
                    track: state.currentTrack,
                    sessionId: state.user?.id || 'guest_session'
                })
            }).catch(() => {});

            // Log event to /api/events (Step 3)
            api('/events', {
                method: 'POST',
                body: JSON.stringify({
                    songId: String(state.currentTrack.id),
                    eventType: action,
                    listenedSeconds: elapsedSec,
                    durationSeconds: state.currentTrack.duration || 0
                })
            }).catch(() => {});
        }
    }
    state.currentTrackStartTime = Date.now();

    // Log play event to /api/events (Step 3)
    if (trackData && trackData.id) {
        api('/events', {
            method: 'POST',
            body: JSON.stringify({
                songId: String(trackData.id),
                eventType: 'play',
                listenedSeconds: 0,
                durationSeconds: trackData.duration || 0
            })
        }).catch(() => {});
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
    const canonId = trackData.canonicalTrackId || trackData.canonicalId || trackData.id;
    state.currentCanonicalTrackId = canonId;
    if (canonId) {
        state.recentCanonicalTrackIds = [canonId, ...(state.recentCanonicalTrackIds || []).filter(x => x !== canonId)].slice(0, 20);
    }
    // Dynamic repair: purge current song family from both pre-generated and manual queues immediately
    repairRecommendedQueue();
    repairManualQueue();

    saveQueueState();

    const loadId = window.playbackManager ? ++window.playbackManager.currentLoadId : Date.now();

    // Trigger asynchronous lyrics fetch with monotonic loadId (Step 2)
    loadLyricsForTrack(trackData, loadId);

    // Asynchronously pre-generate Up Next queue for instantaneous Next response (Section 32, 41)
    fetchUpNextRecommendations(trackData);

    window.playbackManager.loadTrack(trackData, { loadId, userInitiated: !fromQueueStore });
    state.isPlaying = true;
    updatePlayerUI(trackData);
    renderQueueDrawer();

    // Section 12: Trigger background lossless discovery if playing fast source
    if (canonId && !trackData.isLossless && !trackData.isHiRes && window.playbackManager.tryLosslessUpgrade) {
        window.playbackManager.tryLosslessUpgrade(canonId);
    }

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
    } else {
        // Record guest listening event for guest personalized recommendations (Section 2, 27)
        try {
            let guestHistory = [];
            const raw = localStorage.getItem('basa_guest_history');
            if (raw) guestHistory = JSON.parse(raw);
            const canonicalTrackId = trackData.canonicalTrackId || trackData.canonicalId || `ct_${trackData.id}`;
            guestHistory.unshift({
                canonicalTrackId,
                title: trackData.title,
                artist: trackData.artist,
                album: trackData.album || '',
                playedAt: new Date().toISOString(),
                playedSeconds: 180,
                durationSeconds: trackData.duration || 200,
                completed: true
            });
            if (guestHistory.length > 50) guestHistory = guestHistory.slice(0, 50);
            localStorage.setItem('basa_guest_history', JSON.stringify(guestHistory));
        } catch (e) {}
    }
}

function playFromList(tracks, index = 0, contextName = 'Current Context') {
    if (!tracks || tracks.length === 0) return;
    state.contextName = contextName || 'Current Context';
    state.contextQueue = tracks.map(t => wrapQueueEntry(t, 'CONTEXT'));
    state.contextIndex = Math.max(0, Math.min(index, state.contextQueue.length - 1));
    saveQueueState();

    if (window.playerQueueStore) {
        window.playerQueueStore.replace(tracks, 'CONTEXT', state.contextIndex);
    }

    playTrack(state.contextQueue[state.contextIndex], false, false, true);
}

let lastNavClickTimestamp = 0;
let navCoalesceTimer = null;
const COALESCE_DELAY_MS = 120;

function playNext(isUserInitiated = false, isAutoSkipOnError = false) {
    if (isUserInitiated && window.playbackManager) {
        window.playbackManager.consecutiveAutoSkips = 0;
    }

    // 1. If repeat is 'one', only loop current song when it ended naturally.
    if (state.repeat === 'one' && !isUserInitiated && !isAutoSkipOnError) {
        if (window.playbackManager) {
            window.playbackManager.seekTo(0);
            window.playbackManager.play();
        }
        return;
    }

    // Single Source of Truth: Unified PlayerQueueStore (Step 1, Step 3, Step 8)
    if (window.playerQueueStore) {
        const nextItem = window.playerQueueStore.next(isUserInitiated);
        if (nextItem && nextItem.song) {
            // Step 8: Optimistic UI updates target song immediately at 0ms
            state.currentTrack = nextItem.song;
            updatePlayerUI(nextItem.song);
            renderQueueDrawer();

            // Step 3: Coalesce rapid clicks; natural track-end plays immediately
            if (!isUserInitiated) {
                if (navCoalesceTimer) clearTimeout(navCoalesceTimer);
                playTrack(nextItem.song, false, false, true);
            } else {
                if (navCoalesceTimer) clearTimeout(navCoalesceTimer);
                navCoalesceTimer = setTimeout(() => {
                    playTrack(nextItem.song, false, false, true);
                }, COALESCE_DELAY_MS);
            }
            return;
        } else if (window.playerQueueStore.getUpcomingItems().length === 0 && !isAutoSkipOnError) {
            state.isPlaying = false;
            updatePlayPauseButton();
            renderQueueDrawer();
            return;
        }
    }

    // 2. TIER 1: USER_QUEUE (Ported from BASA 2.0 QueueTimeline.kt — explicit user additions play first!)
    if (state.userQueue && state.userQueue.length > 0) {
        const nextTrack = state.userQueue.shift();
        saveQueueState();
        playTrack(nextTrack);
        return;
    }

    // 3. TIER 2: CONTEXT QUEUE (Next track from album, playlist, charts, or initial search)
    if (state.contextQueue && state.contextIndex < state.contextQueue.length - 1) {
        state.contextIndex++;
        const nextTrack = state.contextQueue[state.contextIndex];
        saveQueueState();
        playTrack(nextTrack);
        return;
    }

    // 4. TIER 3: AUTOPLAY / SUGGESTIONS (Endless musical continuation if AutoPlay is enabled)
    if (state.autoplayEnabled !== false) {
        repairRecommendedQueue();
        while (state.recommendedQueue && state.recommendedQueue.length > 0) {
            const nextTrack = state.recommendedQueue.shift();
            if (isValidNextRecommendation(nextTrack, state.currentTrack, state.recentCanonicalTrackIds || [])) {
                // Progressive replenishment: refill AutoPlay queue in background when running low
                if (state.recommendedQueue.length <= 2) {
                    fetchUpNextRecommendations(nextTrack);
                }
                playTrack(nextTrack);
                return;
            }
        }
        // Fallback: If recommended queue ran out of songs, refresh with current track
        if (state.currentTrack) {
            fetchUpNextRecommendations(state.currentTrack);
        }
    }

    // 5. Repeat All (Wrap around context)
    if (state.repeat === 'all' && state.contextQueue && state.contextQueue.length > 0) {
        state.contextIndex = 0;
        playTrack(state.contextQueue[0]);
        return;
    }

    // Fallback: Charts context
    if (window.currentChartsTracks && window.currentChartsTracks.length > 0) {
        const contextList = window.currentChartsTracks.map(t => mapTrackToStandard(t, t.source || 'youtube'));
        playFromList(contextList, 0, 'Top Charts');
        return;
    }

    state.isPlaying = false;
    updatePlayPauseButton();
    renderQueueDrawer();
}

function playPrev() {
    if (window.playbackManager) {
        window.playbackManager.consecutiveAutoSkips = 0;
    }

    // 1. If playing > 3 seconds in, restart the song (standard music player UX)
    if (window.playbackManager && window.playbackManager.getCurrentTime() > 3) {
        window.playbackManager.seekTo(0);
        return;
    }

    // Unified PlayerQueueStore (Step 1, Step 3, Step 8)
    if (window.playerQueueStore) {
        const prevItem = window.playerQueueStore.previous(() => 
            window.playbackManager ? window.playbackManager.getCurrentTime() : 0
        );
        if (prevItem && prevItem.song) {
            // Step 8: Optimistic UI updates target song immediately at 0ms
            state.currentTrack = prevItem.song;
            updatePlayerUI(prevItem.song);
            renderQueueDrawer();

            // Step 3: Coalesce rapid clicks
            if (navCoalesceTimer) clearTimeout(navCoalesceTimer);
            navCoalesceTimer = setTimeout(() => {
                playTrack(prevItem.song, false, true, true);
            }, COALESCE_DELAY_MS);
            return;
        } else {
            return;
        }
    }

    // 2. If in active context list and not at the beginning:
    if (state.contextQueue && state.contextIndex > 0) {
        state.contextIndex--;
        const prevTrack = state.contextQueue[state.contextIndex];
        saveQueueState();
        playTrack(prevTrack, false, true);
        return;
    }

    // 3. If previous tracks history has items:
    if (state.previousTracks && state.previousTracks.length > 0) {
        const prevTrack = state.previousTracks.pop();
        if (state.currentTrack) {
            if (!state.userQueue) state.userQueue = [];
            state.userQueue.unshift(state.currentTrack);
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
// THREE-TIER QUEUE & PREVIOUS SONGS MANAGEMENT
// ============================================

function addToQueue(trackData) {
    if (!trackData) return;
    if (window.playerQueueStore) {
        window.playerQueueStore.add(trackData, 'USER_ADDED');
    }
    const entry = wrapQueueEntry(trackData, 'USER_QUEUE');
    if (!state.userQueue) state.userQueue = [];
    state.userQueue.push(entry);
    saveQueueState();
    showToast(`Added "${trackData.title || 'song'}" to Queue`, 'info');
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
    if (window.playerQueueStore) {
        window.playerQueueStore.playNext(trackData);
    }
    const entry = wrapQueueEntry(trackData, 'USER_QUEUE');
    if (!state.userQueue) state.userQueue = [];
    if (!state.currentTrack) {
        state.userQueue = [entry];
        playTrack(entry);
    } else {
        state.userQueue.unshift(entry);
        saveQueueState();
        showToast(`"${trackData.title || 'song'}" will play next`, 'info');
        updateQueueBadge();
        renderQueueDrawer();
    }
}

function playNextInQueueFromData(encodedData) {
    try {
        const trackData = JSON.parse(decodeURIComponent(encodedData));
        playNextInQueue(trackData);
    } catch (e) {
        console.error('Failed to play next in queue', e);
    }
}

function removeFromQueue(identifier, songId = null) {
    if (window.playerQueueStore) {
        window.playerQueueStore.remove(identifier, songId);
    }
    if (typeof identifier === 'string') {
        state.userQueue = (state.userQueue || []).filter(item => item.queueEntryId !== identifier && item.id !== identifier);
        state.contextQueue = (state.contextQueue || []).filter(item => item.queueEntryId !== identifier && item.id !== identifier);
    } else if (typeof identifier === 'number') {
        const userLen = state.userQueue ? state.userQueue.length : 0;
        if (identifier < userLen) {
            state.userQueue.splice(identifier, 1);
        } else {
            const contextOffset = identifier - userLen;
            const actualContextIdx = state.contextIndex + 1 + contextOffset;
            if (state.contextQueue && actualContextIdx < state.contextQueue.length) {
                state.contextQueue.splice(actualContextIdx, 1);
            }
        }
    }
    saveQueueState();
    updateQueueBadge();
    renderQueueDrawer();
    showToast('Removed from queue · <a href="#" onclick="undoQueueAction();return false;" style="color:#38ef7d;font-weight:600;text-decoration:underline;">Undo</a>', 'info');
}

function undoQueueAction() {
    if (window.playerQueueStore) {
        const ok = window.playerQueueStore.undo();
        if (ok) {
            updateQueueBadge();
            renderQueueDrawer();
            showToast('Restored previous queue item', 'info');
            return;
        }
    }
    showToast('Nothing to undo', 'info');
}

function clearUserQueue() {
    if (window.playerQueueStore) {
        window.playerQueueStore.clear('USER_ADDED');
    }
    state.userQueue = [];
    saveQueueState();
    updateQueueBadge();
    renderQueueDrawer();
    showToast('Manual queue cleared · <a href="#" onclick="undoQueueAction();return false;" style="color:#38ef7d;font-weight:600;text-decoration:underline;">Undo</a>', 'info');
}

function clearAutoplay() {
    if (window.playerQueueStore) {
        window.playerQueueStore.clearAutoplay();
    }
    state.recommendedQueue = [];
    saveQueueState();
    updateQueueBadge();
    renderQueueDrawer();
    showToast('Autoplay recommendations cleared · <a href="#" onclick="undoQueueAction();return false;" style="color:#38ef7d;font-weight:600;text-decoration:underline;">Undo</a>', 'info');
}

function clearQueue() {
    if (window.playerQueueStore) {
        window.playerQueueStore.clear();
    }
    state.userQueue = [];
    if (state.contextQueue) {
        state.contextQueue = state.contextQueue.slice(0, state.contextIndex + 1);
    }
    state.recommendedQueue = [];
    saveQueueState();
    updateQueueBadge();
    renderQueueDrawer();
    showToast('Upcoming queue cleared · <a href="#" onclick="undoQueueAction();return false;" style="color:#38ef7d;font-weight:600;text-decoration:underline;">Undo</a>', 'info');
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
        if (!state.userQueue) state.userQueue = [];
        state.userQueue.unshift(state.currentTrack);
    }
    saveQueueState();
    playTrack(track, false, true);
    showToast(`Playing "${track.title}"`, 'info');
}

function playFromQueueIndex(index, tier = 'CONTEXT') {
    if (tier === 'USER_QUEUE') {
        if (state.userQueue && index >= 0 && index < state.userQueue.length) {
            const track = state.userQueue.splice(index, 1)[0];
            saveQueueState();
            playTrack(track);
        }
    } else {
        if (state.contextQueue && index >= 0 && index < state.contextQueue.length) {
            state.contextIndex = index;
            saveQueueState();
            playTrack(state.contextQueue[state.contextIndex]);
        }
    }
}

function toggleAutoPlay(enabled) {
    state.autoplayEnabled = Boolean(enabled);
    localStorage.setItem('basa_autoplay_enabled', String(state.autoplayEnabled));
    const checkbox = document.getElementById('queue-autoplay-toggle');
    if (checkbox) checkbox.checked = state.autoplayEnabled;
    if (state.autoplayEnabled && (!state.recommendedQueue || state.recommendedQueue.length === 0) && state.currentTrack) {
        fetchUpNextRecommendations(state.currentTrack);
    }
    updateQueueBadge();
    renderQueueDrawer();
    showToast(state.autoplayEnabled ? '⚡ AutoPlay enabled (endless radio)' : '⚡ AutoPlay paused', 'info');
}

function updateQueueBadge() {
    const upnextCountEl = document.getElementById('queue-upnext-count');
    const historyCountEl = document.getElementById('queue-history-count');
    const queueBtn = document.getElementById('queue-btn');

    const userCount = state.userQueue ? state.userQueue.length : 0;
    const contextRemaining = state.contextQueue ? Math.max(0, state.contextQueue.length - (state.contextIndex + 1)) : 0;
    const autoCount = (state.autoplayEnabled !== false && state.recommendedQueue) ? state.recommendedQueue.length : 0;
    const upcomingCount = userCount + contextRemaining + autoCount;

    if (upnextCountEl) upnextCountEl.textContent = upcomingCount;
    if (historyCountEl) historyCountEl.textContent = state.previousTracks ? state.previousTracks.length : 0;

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
    const backdrop = document.getElementById('queue-drawer-backdrop');
    const queueBtn = document.getElementById('queue-btn');
    const fsQueueBtn = document.getElementById('fs-queue-btn');
    if (!drawer) return;

    const isHidden = drawer.classList.contains('hidden');
    if (isHidden) {
        drawer.classList.remove('hidden');
        if (backdrop) backdrop.classList.remove('hidden');
        if (queueBtn) queueBtn.classList.add('active');
        if (fsQueueBtn) fsQueueBtn.classList.add('active');
        renderQueueDrawer();
    } else {
        closeQueueDrawer();
    }
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

let draggedQueueIndex = null;
let draggedQueueType = null;

function handleQueueDragStart(e, index, queueType) {
    draggedQueueIndex = index;
    draggedQueueType = queueType;
    e.dataTransfer.effectAllowed = 'move';
    if (e.currentTarget) e.currentTarget.classList.add('dragging');
}

function handleQueueDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
}

function handleQueueDrop(e, targetIndex, targetQueueType) {
    e.preventDefault();
    e.stopPropagation();
    document.querySelectorAll('.queue-item.dragging').forEach(el => el.classList.remove('dragging'));
    if (draggedQueueIndex === null || draggedQueueType !== targetQueueType) return;
    if (draggedQueueIndex === targetIndex) return;

    if (window.playerQueueStore) {
        window.playerQueueStore.reorderQueue(draggedQueueIndex, targetIndex, targetQueueType);
    } else if (state.userQueue) {
        const [moved] = state.userQueue.splice(draggedQueueIndex, 1);
        state.userQueue.splice(targetIndex, 0, moved);
        saveQueueState();
        renderQueueDrawer();
    }
    draggedQueueIndex = null;
    draggedQueueType = null;
}

function renderQueueDrawer() {
    updateQueueBadge();

    // Sync AutoPlay toggle switch state
    const autoPlayCheckbox = document.getElementById('queue-autoplay-toggle');
    if (autoPlayCheckbox) {
        autoPlayCheckbox.checked = state.autoplayEnabled !== false;
    }

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
        if (nowBadge) nowBadge.innerHTML = renderPlayerQualityBadge(state.currentTrack);
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

    // 2. Up Next List (Three-Tier Spotify/Apple Music Hierarchy)
    const upnextContainer = document.getElementById('queue-upnext-list');
    if (upnextContainer) {
        let contentHtml = '';

        // TIER 1: USER QUEUE / PLAY NEXT (Explicit user additions with drag-to-reorder)
        const userItems = window.playerQueueStore 
            ? window.playerQueueStore.getUserQueueItems().map(it => ({ ...it.song, queueItemId: it.queueItemId, source: it.source }))
            : (state.userQueue || []);

        if (userItems.length > 0) {
            const hasUndo = Boolean(window.playerQueueStore && window.playerQueueStore.undoStack.length > 0);
            const userItemsHtml = userItems.map((track, uIdx) => {
                const cover = track.coverUrl || track.cover || '';
                const entryId = track.queueItemId || track.queueEntryId || `u_${uIdx}`;
                const qualityHtml = renderQualityBadge(track);
                const isPlayNext = track.source === 'PLAY_NEXT';
                const tagLabel = isPlayNext ? '<span class="queue-autoplay-pill" style="margin-left:4px;">Play Next</span>' : '';

                return `
                    <div class="queue-item" draggable="true"
                         ondragstart="handleQueueDragStart(event, ${uIdx}, 'userQueue')"
                         ondragover="handleQueueDragOver(event)"
                         ondrop="handleQueueDrop(event, ${uIdx}, 'userQueue')"
                         onclick="playFromQueueIndex(${uIdx}, 'USER_QUEUE')">
                        <div class="queue-item-drag-handle" title="Drag to reorder">⋮⋮</div>
                        <div class="queue-item-thumb-wrap">
                            <img class="queue-item-thumb" src="${cover}" alt="" onerror="this.style.opacity='0.2'">
                            <div class="queue-item-play-overlay">▶</div>
                        </div>
                        <div class="queue-item-info">
                            <span class="queue-item-title">${escapeHtml(track.title || 'Unknown')} ${tagLabel}</span>
                            <span class="queue-item-artist">${escapeHtml(track.artist || 'Unknown Artist')}</span>
                            ${qualityHtml}
                        </div>
                        <div class="queue-item-actions">
                            <button class="queue-item-remove-btn" onclick="event.stopPropagation();removeFromQueue('${entryId}', '${track.id || ''}')" title="Remove from Queue">✕</button>
                        </div>
                    </div>
                `;
            }).join('');

            contentHtml += `
                <div class="queue-section-subhead queue-subhead-user" style="display:flex; justify-content:space-between; align-items:center;">
                    <span>📌 PLAYING NEXT (${userItems.length})</span>
                    <div style="display:flex; gap:6px;">
                        ${hasUndo ? '<button class="queue-mini-clear-btn" style="color:#38ef7d;border-color:rgba(56,239,125,0.4);" onclick="undoQueueAction()" title="Undo last remove/clear">Undo</button>' : ''}
                        <button class="queue-mini-clear-btn" onclick="clearUserQueue()" title="Clear manual user queue">Clear</button>
                    </div>
                </div>
                ${userItemsHtml}
            `;
        }

        // TIER 2: CONTEXT QUEUE (Remaining tracks from album, playlist, or initial search)
        let contextUpcoming = [];
        if (window.playerQueueStore) {
            contextUpcoming = window.playerQueueStore.getContextItems().map((it, idx) => ({
                track: it.song,
                index: idx,
                queueItemId: it.queueItemId
            }));
        } else if (state.contextQueue) {
            for (let i = (state.contextIndex || 0) + 1; i < state.contextQueue.length; i++) {
                contextUpcoming.push({ track: state.contextQueue[i], index: i, queueItemId: state.contextQueue[i].queueEntryId });
            }
        }

        if (contextUpcoming.length > 0) {
            const contextItemsHtml = contextUpcoming.map(({ track, index, queueItemId }) => {
                const cover = track.coverUrl || track.cover || '';
                const entryId = queueItemId || track.queueEntryId || `c_${index}`;
                return `
                    <div class="queue-item" onclick="playFromQueueIndex(${index}, 'CONTEXT')">
                        <div class="queue-item-thumb-wrap">
                            <img class="queue-item-thumb" src="${cover}" alt="" onerror="this.style.opacity='0.2'">
                            <div class="queue-item-play-overlay">▶</div>
                        </div>
                        <div class="queue-item-info">
                            <span class="queue-item-title">${escapeHtml(track.title || 'Unknown')}</span>
                            <span class="queue-item-artist">${escapeHtml(track.artist || 'Unknown Artist')}</span>
                        </div>
                        <div class="queue-item-actions">
                            <button class="queue-item-remove-btn" onclick="event.stopPropagation();removeFromQueue('${entryId}', '${track.id || ''}')" title="Remove from Context Queue">✕</button>
                        </div>
                    </div>
                `;
            }).join('');

            contentHtml += `
                <div class="queue-section-subhead queue-subhead-context">
                    <span>💿 NEXT FROM ${escapeHtml(state.contextName || 'CURRENT CONTEXT')} (${contextUpcoming.length})</span>
                </div>
                ${contextItemsHtml}
            `;
        }

        // TIER 3: AUTOPLAY / SUGGESTIONS (Endless musical continuation)
        const autoItems = window.playerQueueStore
            ? window.playerQueueStore.getAutoplayItems().map(it => ({ ...it.song, queueItemId: it.queueItemId }))
            : (state.recommendedQueue || []);

        if (state.autoplayEnabled !== false && autoItems.length > 0) {
            const recItemsHtml = autoItems.map((track, rIdx) => {
                const cover = track.coverUrl || track.cover || '';
                const reason = track.recommendationReason || track.reason || (track.mood ? `Vibe · ${track.mood}` : 'Musical continuity');
                const aiBadge = track.aiCurated ? '<span class="queue-ai-badge" style="display:inline-flex; align-items:center; background:linear-gradient(135deg, rgba(147,51,234,0.3), rgba(59,130,246,0.3)); border:1px solid rgba(147,51,234,0.4); border-radius:4px; font-size:9px; font-weight:700; color:#c084fc; padding:1px 5px; margin-left:6px;">✨ AI DJ</span>' : '';
                const entryId = track.queueItemId || track.queueEntryId || `a_${rIdx}`;
                const encoded = encodeURIComponent(JSON.stringify(track));
                return `
                    <div class="queue-item" onclick="playTrackFromData('${encoded}')">
                        <div class="queue-item-thumb-wrap">
                            <img class="queue-item-thumb" src="${cover}" alt="" onerror="this.style.opacity='0.2'">
                            <div class="queue-item-play-overlay">▶</div>
                        </div>
                        <div class="queue-item-info">
                            <div style="display:flex; align-items:center;">
                                <span class="queue-item-title">${escapeHtml(track.title || 'Unknown')}</span>
                                ${aiBadge}
                            </div>
                            <span class="queue-item-artist">${escapeHtml(track.artist || 'Unknown Artist')}</span>
                            <span class="rec-reason-pill">${escapeHtml(reason)}</span>
                        </div>
                        <div class="queue-item-actions" style="display:flex; align-items:center; gap:6px;">
                            <button class="queue-action-link" style="font-size:11px;" onclick="event.stopPropagation();addToQueueFromData('${encoded}')" title="Add to Queue">+ Queue</button>
                            <button class="queue-item-remove-btn" onclick="event.stopPropagation();removeFromQueue('${entryId}', '${track.id || ''}')" title="Remove from Autoplay">✕</button>
                        </div>
                    </div>
                `;
            }).join('');

            contentHtml += `
                <div class="queue-section-subhead queue-subhead-autoplay" style="display:flex; justify-content:space-between; align-items:center;">
                    <div style="display:flex; align-items:center; gap:6px;">
                        <span>✨ AUTOPLAY · SIMILAR SONGS</span>
                        <span class="queue-autoplay-pill">Radio</span>
                    </div>
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span style="font-size:10px; opacity:0.6;">Plays when queue finishes</span>
                        <button class="queue-mini-clear-btn" onclick="clearAutoplay()" title="Clear autoplay recommendations">Clear</button>
                    </div>
                </div>
                ${recItemsHtml}
            `;
        }

        if (!contentHtml) {
            if (state.isFetchingRecommendations) {
                upnextContainer.innerHTML = `
                    <div class="queue-empty-state">
                        <div class="queue-empty-icon">⏳</div>
                        <p>Curating songs for your vibe...</p>
                    </div>
                `;
            } else {
                upnextContainer.innerHTML = `
                    <div class="queue-empty-state">
                        <div class="queue-empty-icon">🎵</div>
                        <p>No upcoming tracks in queue.</p>
                        <span style="font-size:11px;opacity:0.6;">Click "+ Queue" on any track or start playback for auto-curated music.</span>
                    </div>
                `;
            }
        } else {
            upnextContainer.innerHTML = contentHtml;
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
            const existingImg = coverEl.querySelector('img');
            if (existingImg && existingImg.src !== trackData.cover) {
                existingImg.classList.add('switching');
                const tempImg = new Image();
                tempImg.src = trackData.cover;
                tempImg.onload = () => {
                    existingImg.src = trackData.cover;
                    existingImg.alt = escapeHtml(trackData.title);
                    existingImg.classList.remove('switching');
                };
                tempImg.onerror = () => {
                    existingImg.src = fallbackSrc;
                    existingImg.classList.remove('switching');
                };
            } else if (!existingImg) {
                coverEl.innerHTML = `<img src="${trackData.cover}" alt="${escapeHtml(trackData.title)}" onerror="this.onerror=null; this.src='${fallbackSrc}';">`;
            }
            
            // Update FS Cover and trigger color extraction with smooth crossfade
            if (fsCoverImg) {
                fsCoverImg.crossOrigin = "Anonymous";
                if (fsCoverImg.src && fsCoverImg.src !== trackData.cover) {
                    fsCoverImg.classList.add('switching');
                }
                const tempFsImg = new Image();
                tempFsImg.crossOrigin = "Anonymous";
                tempFsImg.src = trackData.cover;
                tempFsImg.onload = () => {
                    fsCoverImg.src = trackData.cover;
                    fsCoverImg.classList.remove('switching');
                    document.documentElement.style.setProperty('--album-art', `url('${trackData.cover}')`);
                    extractColorsFromImage(fsCoverImg);
                };
                tempFsImg.onerror = () => {
                    fsCoverImg.src = fallbackSrc;
                    fsCoverImg.classList.remove('switching');
                    document.documentElement.style.setProperty('--album-art', `url('${fallbackSrc}')`);
                };
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

    // Smooth track text morph animation
    const miniTrackText = document.querySelector('.player-track-text');
    if (miniTrackText) {
        miniTrackText.classList.remove('track-text-transition');
        void miniTrackText.offsetWidth;
        miniTrackText.classList.add('track-text-transition');
    }
    const fsInfoArea = document.querySelector('.fs-info-area');
    if (fsInfoArea) {
        fsInfoArea.classList.remove('track-text-transition');
        void fsInfoArea.offsetWidth;
        fsInfoArea.classList.add('track-text-transition');
    }

    if (titleEl) titleEl.textContent = trackData.title;
    if (artistEl) artistEl.textContent = trackData.artist;

    if (fsTitleEl) fsTitleEl.textContent = trackData.title;
    if (fsArtistEl) fsArtistEl.textContent = trackData.artist;
    
    const fsQualityContainer = document.getElementById('fs-quality-badge-container');
    if (fsQualityContainer) {
        fsQualityContainer.innerHTML = renderPlayerQualityBadge(trackData);
    }

    const playerQualityContainer = document.getElementById('player-quality-badge-container');
    if (playerQualityContainer) {
        playerQualityContainer.innerHTML = renderPlayerQualityBadge(trackData);
    }

    const queueNowBadge = document.getElementById('queue-now-badge');
    if (queueNowBadge) {
        queueNowBadge.innerHTML = renderPlayerQualityBadge(trackData);
    }

    document.title = `${trackData.title} — ${trackData.artist} | BASA`;

    // Highlight playing track in lists
    document.querySelectorAll('.track-list-item').forEach(item => {
        item.classList.toggle('playing', String(item.dataset?.trackId) === String(trackData.id));
    });

    updatePlayerLikeButton();
    if (trackData && trackData.id) {
        checkIfLiked(trackData.id, trackData.source);
    }

    // Immediately display track duration from metadata
    const metaDuration = (Number.isFinite(trackData?.duration) && trackData.duration > 0)
        ? trackData.duration
        : ((Number.isFinite(trackData?.durationSec) && trackData.durationSec > 0)
            ? trackData.durationSec
            : ((Number.isFinite(trackData?.durationMs) && trackData.durationMs > 0)
                ? Math.round(trackData.durationMs / 1000)
                : 0));
    if (metaDuration > 0) {
        const durFormatted = formatDuration(metaDuration);
        const totalTimeEl = document.getElementById('total-time');
        const fsTotalTimeEl = document.getElementById('fs-total-time');
        if (totalTimeEl) {
            totalTimeEl.textContent = durFormatted;
            totalTimeEl.dataset.lastDur = String(Math.round(metaDuration));
        }
        if (fsTotalTimeEl) {
            fsTotalTimeEl.textContent = (fsTimeDisplayMode === 'remaining') ? `-${durFormatted}` : durFormatted;
            fsTotalTimeEl.dataset.lastDur = String(Math.round(metaDuration));
        }
    }

    // Update Spotify-Style Now Playing Sidecar
    updateNowPlayingSidecar(trackData);
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
            if (state.isPlaying) {
                window.playbackManager.pause();
                state.isPlaying = false;
                updatePlayPauseButton();
            } else {
                window.playbackManager.resume();
                state.isPlaying = true;
                updatePlayPauseButton();
            }
        });
    }
    if (nextBtn) nextBtn.addEventListener('click', () => playNext(true));
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
            if (window.playerQueueStore) {
                window.playerQueueStore.setShuffle(state.shuffle);
            }
            shuffleBtn.classList.toggle('active', state.shuffle);
            showToast(state.shuffle ? 'Shuffle on (Bag mode)' : 'Shuffle off (Order restored)');
        });
    }
    if (repeatBtn) {
        repeatBtn.addEventListener('click', () => {
            if (state.repeat === 'none' || state.repeat === 'off') { 
                state.repeat = 'all'; 
                repeatBtn.classList.add('active'); 
                repeatBtn.textContent = '🔁'; 
                showToast('Repeat all'); 
            } else if (state.repeat === 'all') { 
                state.repeat = 'one'; 
                repeatBtn.textContent = '🔂'; 
                showToast('Repeat one'); 
            } else { 
                state.repeat = 'off'; 
                repeatBtn.classList.remove('active'); 
                repeatBtn.textContent = '↻'; 
                showToast('Repeat off'); 
            }
            if (window.playerQueueStore) {
                window.playerQueueStore.setRepeat(state.repeat === 'none' ? 'off' : state.repeat);
            }
        });
    }

    // Two-stage fast-start upgrade listeners (Section 12)
    window.playbackManager.onUpgradeStatusChange = (status, candidate) => {
        if (state.currentTrack) {
            state.currentTrack.upgradeStatus = status;
            updatePlayerUI(state.currentTrack);
        }
        const banner = document.getElementById('lossless-upgrade-banner');
        const textEl = document.getElementById('upgrade-banner-text');
        if (status === 'available' && candidate) {
            if (banner && textEl) {
                const bit = candidate.bitDepth || 24;
                const rate = candidate.sampleRate ? `${Math.round(candidate.sampleRate / 1000)} kHz` : '96 kHz';
                textEl.textContent = `Lossless available · Switch to FLAC (${bit}-bit / ${rate})`;
                banner.classList.remove('hidden');
            }
        } else if (status === 'completed' || status === 'idle' || status === 'failed') {
            if (banner) banner.classList.add('hidden');
        }
    };

    window.playbackManager.onPlayerStateChange = (playerState, currentTrack) => {
        if (state.currentTrack) {
            updatePlayerUI(state.currentTrack);
        }
    };

    window.playbackManager.onUpgraded = (upgradedTrack) => {
        state.currentTrack = upgradedTrack;
        updatePlayerUI(upgradedTrack);
        renderQueueDrawer();
    };

    window.playbackManager.onDurationChange = (dur, loadId) => {
        if (loadId && window.playbackManager && loadId !== window.playbackManager.currentLoadId) {
            return;
        }
        if (dur > 0) {
            const durText = formatDuration(dur);
            if (totalTimeEl) {
                totalTimeEl.textContent = durText;
                totalTimeEl.dataset.lastDur = String(Math.round(dur));
            }
            const fsTotalTimeEl = document.getElementById('fs-total-time');
            if (fsTotalTimeEl) {
                fsTotalTimeEl.textContent = durText;
                fsTotalTimeEl.dataset.lastDur = String(Math.round(dur));
            }
        }
    };

    window.playbackManager.onStateChange = (stateName, loadId) => {
        if (loadId && window.playbackManager && loadId !== window.playbackManager.currentLoadId) {
            return;
        }
        if (stateName === 'playing' || stateName === 'loadedmetadata') {
            if (stateName === 'playing') {
                state.isPlaying = true;
                updatePlayPauseButton();
                renderQueueDrawer();
            }
            const dur = window.playbackManager.getDuration();
            if (dur > 0) {
                const durText = formatDuration(dur);
                if (totalTimeEl) {
                    totalTimeEl.textContent = durText;
                    totalTimeEl.dataset.lastDur = String(Math.round(dur));
                }
                const fsTotalTimeEl = document.getElementById('fs-total-time');
                if (fsTotalTimeEl) {
                    fsTotalTimeEl.textContent = durText;
                    fsTotalTimeEl.dataset.lastDur = String(Math.round(dur));
                }
            }
        } else if (stateName === 'paused') {
            state.isPlaying = false;
            updatePlayPauseButton();
            renderQueueDrawer();
        } else if (stateName === 'ended') {
            playNext(false);
        }
    };
    
    window.playbackManager.onError = (err) => {
        showToast(err, 'error');
        state.isPlaying = false;
        updatePlayPauseButton();
    };

    let isUserScrubbing = false;

    // Direct hardware-timed update from HTML5 Audio timeupdate
    window.playbackManager.onTimeUpdate = (currentTime, duration, loadId) => {
        if (loadId && window.playbackManager && loadId !== window.playbackManager.currentLoadId) {
            return;
        }
        if (isUserScrubbing) return;
        const curText = formatDuration(currentTime);
        if (currentTimeEl) currentTimeEl.textContent = curText;
        const fsCurrentTimeEl = document.getElementById('fs-current-time');
        if (fsCurrentTimeEl) fsCurrentTimeEl.textContent = curText;

        if (duration > 0) {
            const pct = Math.min(100, Math.max(0, (currentTime / duration) * 100));
            if (progressBar && !progressBar.matches(':active')) progressBar.value = pct;
            if (progressFill && !progressBar.matches(':active')) progressFill.style.width = `${pct}%`;

            const fsProgressBar = document.getElementById('fs-progress-bar');
            const fsProgressFill = document.getElementById('fs-progress-fill');
            if (fsProgressBar && !fsProgressBar.matches(':active')) fsProgressBar.value = pct;
            if (fsProgressFill && !fsProgressFill.matches(':active')) fsProgressFill.style.width = `${pct}%`;

            const durFormatted = formatDuration(duration);
            if (totalTimeEl && totalTimeEl.textContent !== durFormatted) {
                totalTimeEl.textContent = durFormatted;
            }
            const fsTotalTimeEl = document.getElementById('fs-total-time');
            if (fsTotalTimeEl && fsTotalTimeEl.textContent !== durFormatted) {
                fsTotalTimeEl.textContent = durFormatted;
            }
        }
    };
    
    let smoothProgressPct = 0;
    let lastRenderedSec = -1;
    let lastRenderedDur = -1;

    function runHighFpsPlayerLoop() {
        try {
            if (state.isPlaying && window.playbackManager) {
                const currentTime = window.playbackManager.getCurrentTime();
                const duration = window.playbackManager.getDuration();
                
                // High-FPS continuous lyrics synchronization evaluation
                try {
                    syncLyricsTick(currentTime);
                } catch (e) {}

                // Update text timestamp once per whole second to eliminate DOM thrashing
                if (!isUserScrubbing) {
                    const currentSec = Math.floor(currentTime);
                    if (currentSec !== lastRenderedSec) {
                        lastRenderedSec = currentSec;
                        const curText = formatDuration(currentTime);
                        if (currentTimeEl) currentTimeEl.textContent = curText;
                        const fsCurrentTimeEl = document.getElementById('fs-current-time');
                        if (fsCurrentTimeEl) fsCurrentTimeEl.textContent = curText;

                        // Continuous remaining time calculation for fullscreen player (Apple Music style)
                        const fsTotalTimeEl = document.getElementById('fs-total-time');
                        if (fsTotalTimeEl && duration > 0) {
                            if (fsTimeDisplayMode === 'remaining') {
                                const remSec = Math.max(0, duration - currentTime);
                                fsTotalTimeEl.textContent = `-${formatDuration(remSec)}`;
                            } else {
                                fsTotalTimeEl.textContent = formatDuration(duration);
                            }
                        }
                    }

                    // High-refresh-rate smooth sub-pixel progress bar glide (lerp)
                    if (duration > 0) {
                        const targetPct = Math.min(100, Math.max(0, (currentTime / duration) * 100));
                        const diff = targetPct - smoothProgressPct;
                        if (Math.abs(diff) > 2.5 || diff < 0) {
                            // User seek / track start / jump
                            smoothProgressPct = targetPct;
                        } else {
                            // Continuous fluid glide (35% lerp per display frame yields liquid smoothness)
                            smoothProgressPct += diff * 0.35;
                        }

                        if (progressBar && !progressBar.matches(':active')) progressBar.value = smoothProgressPct;
                        if (progressFill && !progressBar?.matches(':active')) progressFill.style.width = `${smoothProgressPct}%`;

                        const fsProgressBar = document.getElementById('fs-progress-bar');
                        const fsProgressFill = document.getElementById('fs-progress-fill');
                        if (fsProgressBar && !fsProgressBar.matches(':active')) fsProgressBar.value = smoothProgressPct;
                        if (fsProgressFill && !fsProgressBar?.matches(':active')) fsProgressFill.style.width = `${smoothProgressPct}%`;

                        const durSec = Math.round(duration);
                        if (durSec !== lastRenderedDur) {
                            lastRenderedDur = durSec;
                            const durFormatted = formatDuration(duration);
                            if (totalTimeEl) totalTimeEl.textContent = durFormatted;
                            const fsTotalTimeEl = document.getElementById('fs-total-time');
                            if (fsTotalTimeEl) {
                                if (fsTimeDisplayMode === 'remaining') {
                                    const remSec = Math.max(0, duration - currentTime);
                                    fsTotalTimeEl.textContent = `-${formatDuration(remSec)}`;
                                } else {
                                    fsTotalTimeEl.textContent = durFormatted;
                                }
                            }
                        }
                    }
                }

                // Update loaded/buffering fraction
                const bufferedFrac = typeof window.playbackManager.getBufferedFraction === 'function'
                    ? window.playbackManager.getBufferedFraction()
                    : 0;
                if (bufferedFrac > 0) {
                    const bufPct = Math.min(100, Math.max(0, bufferedFrac * 100));
                    const pb = document.getElementById('progress-buffer');
                    if (pb) pb.style.width = `${bufPct}%`;
                    const fspb = document.getElementById('fs-progress-buffer');
                    if (fspb) fspb.style.width = `${bufPct}%`;
                }
            }
        } catch (err) {
            console.warn('[PlayerTick] Non-fatal tick error:', err);
        }
        requestAnimationFrame(runHighFpsPlayerLoop);
    }
    requestAnimationFrame(runHighFpsPlayerLoop);

    // Fast-seek helper for instant responsive scrubbing & clicking
    function applySeek(pct) {
        pct = Math.min(100, Math.max(0, pct));
        if (progressFill) progressFill.style.width = `${pct}%`;
        if (progressBar) progressBar.value = pct;

        const fsBar = document.getElementById('fs-progress-bar');
        const fsFill = document.getElementById('fs-progress-fill');
        if (fsBar) fsBar.value = pct;
        if (fsFill) fsFill.style.width = `${pct}%`;

        const duration = window.playbackManager.getDuration();
        if (duration > 0) {
            const seekTime = (pct / 100) * duration;
            if (currentTimeEl) currentTimeEl.textContent = formatDuration(seekTime);
            const fsTime = document.getElementById('fs-current-time');
            if (fsTime) fsTime.textContent = formatDuration(seekTime);
            window.playbackManager.seekTo(seekTime);
        }
    }

    // Direct click-to-seek on progress bar wrapper
    const progressBarWrapper = document.querySelector('.player-progress .progress-bar-wrapper');
    if (progressBarWrapper) {
        progressBarWrapper.addEventListener('click', (e) => {
            if (e.target === progressBar) return;
            const rect = progressBarWrapper.getBoundingClientRect();
            if (rect.width <= 0) return;
            const pct = ((e.clientX - rect.left) / rect.width) * 100;
            applySeek(pct);
        });
    }

    if (progressBar) {
        progressBar.addEventListener('input', (e) => {
            isUserScrubbing = true;
            const pct = parseFloat(e.target.value) || 0;
            if (progressFill) progressFill.style.width = `${pct}%`;
            const duration = window.playbackManager.getDuration();
            if (duration > 0) {
                const seekTime = (pct / 100) * duration;
                if (currentTimeEl) currentTimeEl.textContent = formatDuration(seekTime);
            }
            const fsBar = document.getElementById('fs-progress-bar');
            const fsFill = document.getElementById('fs-progress-fill');
            const fsTime = document.getElementById('fs-current-time');
            if (fsBar) fsBar.value = pct;
            if (fsFill) fsFill.style.width = `${pct}%`;
            if (fsTime && duration > 0) fsTime.textContent = formatDuration((pct / 100) * duration);
        });

        progressBar.addEventListener('change', (e) => {
            const duration = window.playbackManager.getDuration();
            const pct = parseFloat(e.target.value) || 0;
            if (duration > 0) {
                window.playbackManager.seekTo((pct / 100) * duration);
            }
            setTimeout(() => { isUserScrubbing = false; }, 150);
        });
    }

    const fsProgressBarWrapper = document.querySelector('.fs-progress-wrapper');
    const fsProgressBar = document.getElementById('fs-progress-bar');
    if (fsProgressBarWrapper) {
        fsProgressBarWrapper.addEventListener('click', (e) => {
            if (e.target === fsProgressBar) return;
            const rect = fsProgressBarWrapper.getBoundingClientRect();
            if (rect.width <= 0) return;
            const pct = ((e.clientX - rect.left) / rect.width) * 100;
            applySeek(pct);
        });
    }

    if (fsProgressBar) {
        fsProgressBar.addEventListener('input', (e) => {
            isUserScrubbing = true;
            const pct = parseFloat(e.target.value) || 0;
            const fsFill = document.getElementById('fs-progress-fill');
            if (fsFill) fsFill.style.width = `${pct}%`;
            const duration = window.playbackManager.getDuration();
            if (duration > 0) {
                const seekTime = (pct / 100) * duration;
                const fsTime = document.getElementById('fs-current-time');
                if (fsTime) fsTime.textContent = formatDuration(seekTime);
            }
            if (progressBar) progressBar.value = pct;
            if (progressFill) progressFill.style.width = `${pct}%`;
            if (currentTimeEl && duration > 0) currentTimeEl.textContent = formatDuration((pct / 100) * duration);
        });

        fsProgressBar.addEventListener('change', (e) => {
            const duration = window.playbackManager.getDuration();
            const pct = parseFloat(e.target.value) || 0;
            if (duration > 0) {
                window.playbackManager.seekTo((pct / 100) * duration);
            }
            setTimeout(() => { isUserScrubbing = false; }, 150);
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
            const fsVolVal = document.getElementById('fs-volume-val');
            if (fsVolVal) fsVolVal.textContent = '0%';
        } else {
            window.playbackManager.setVolume(preMuteVolume);
            vFills.forEach(f => f && (f.style.width = `${preMuteVolume}%`));
            vBars.forEach(b => b && (b.value = preMuteVolume));
            const fsVolVal = document.getElementById('fs-volume-val');
            if (fsVolVal) fsVolVal.textContent = `${preMuteVolume}%`;
        }
        volBtns.forEach(btn => {
            if (btn) btn.innerHTML = isMuted 
                ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"></line><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon></svg>'
                : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
        });
    }

    if (volumeBtn) volumeBtn.addEventListener('click', () => setMuteState(!isMuted));
    const fsVolumeBtn = document.getElementById('fs-volume-btn');
    if (fsVolumeBtn) fsVolumeBtn.addEventListener('dblclick', () => setMuteState(!isMuted));

    function syncVolume(val) {
        state.volume = parseInt(val);
        window.playbackManager.setVolume(state.volume);
        localStorage.setItem('liquid_music_volume', state.volume);
        [document.getElementById('volume-fill'), document.getElementById('fs-volume-fill')].forEach(f => f && (f.style.width = `${state.volume}%`));
        [document.getElementById('volume-bar'), document.getElementById('fs-volume-bar')].forEach(b => b && (b.value = state.volume));
        const fsVolVal = document.getElementById('fs-volume-val');
        if (fsVolVal) fsVolVal.textContent = `${state.volume}%`;
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
        // Handle tracks with videoId (YouTube) or id (Archive/JioSaavn/Local)
        items = items.filter(item => item.track_data && (item.track_data.videoId || item.track_data.id));
        if (items.length > 0) {
            window.currentLibraryTracks = items.map(item => ({ ...item.track_data, source: item.track_source }));
            list.innerHTML = items.map((item, i) =>
                renderTrackListItem(item.track_data, i, item.track_source, { contextType: 'library' })
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

            // Send session feedback to boost similar musical DNA (Section 25, 38)
            api('/music/session-feedback', {
                method: 'POST',
                body: JSON.stringify({
                    trackId: String(trackId),
                    action: 'like',
                    durationPlayed: 0,
                    track: trackData,
                    sessionId: state.user?.id || 'guest_session'
                })
            }).catch(() => {});
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
    if (!state.currentTrack) return;
    const liked = state.likedTrackIds.has(String(state.currentTrack.id));
    
    // 1. Bottom Mini-Player Like Button
    const btn = document.getElementById('player-like-btn');
    if (btn) {
        btn.textContent = liked ? '♥' : '♡';
        btn.classList.toggle('liked', liked);
        btn.setAttribute('title', liked ? 'Remove from Favorites' : 'Add to Favorites');
    }

    // 2. Fullscreen Player Like Button
    const fsBtn = document.getElementById('fs-like-btn');
    if (fsBtn) {
        fsBtn.classList.toggle('liked', liked);
        fsBtn.setAttribute('title', liked ? 'Remove from Favorites' : 'Add to Favorites');
        const icon = fsBtn.querySelector('.fs-heart-icon');
        if (icon) {
            if (liked) {
                icon.setAttribute('fill', '#ff3b5c');
                icon.setAttribute('stroke', '#ff3b5c');
            } else {
                icon.setAttribute('fill', 'none');
                icon.setAttribute('stroke', 'currentColor');
            }
        }
    }
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
        // Handle tracks with videoId (YouTube) or id (Archive/JioSaavn/Local) and filter out Shorts
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
            window.currentPlaylistTracks = trackObjs;

            if (playAllBtn) playAllBtn.onclick = () => playFromList(trackObjs, 0);

            tracksContainer.innerHTML = tracks.map((item, i) =>
                renderTrackListItem(item.track_data, i, item.track_source, {
                    playlistId: id,
                    playlistEntryId: item.id,
                    contextType: 'playlist'
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
            window.currentUploadTracks = tracks.map(t => ({ ...t, source: 'local' }));
            list.innerHTML = tracks.map((t, i) => renderTrackListItem(t, i, 'local', { isUpload: true, contextType: 'upload' })).join('');
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

    // Initialize Spotify-Style Now Playing Sidecar
    const savedSidecarState = localStorage.getItem('basa_now_playing_sidecar');
    const shouldOpenSidecar = savedSidecarState !== null ? savedSidecarState === '1' : window.innerWidth > 1150;
    toggleNowPlayingSidecar(shouldOpenSidecar);

    // Step 5: Restore queue and track details after refresh without auto-playing
    if (window.playerQueueStore) {
        window.playerQueueStore.subscribe(() => {
            renderQueueDrawer();
        });

        const currentSong = window.playerQueueStore.getCurrentSong();
        if (currentSong) {
            state.currentTrack = currentSong;
            updatePlayerUI(currentSong);
            renderQueueDrawer();
            // Note: Does NOT auto-play so user retains control
        }
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

function setFsPlayerMode(mode) {
    fsPlayerMode = mode;
    const layout = document.getElementById('fs-layout-container') || document.querySelector('.fs-split-layout');
    const lyricsBtn = document.getElementById('fs-lyrics-btn');
    const lyricsPanel = document.getElementById('fs-lyrics-panel');

    if (!layout) return;

    if (mode === 'lyrics' && isLyricsAvailable) {
        layout.classList.remove('fs-mode-artwork');
        layout.classList.add('fs-mode-lyrics');
        if (lyricsPanel) lyricsPanel.classList.add('show-lyrics');
        if (lyricsBtn) {
            lyricsBtn.classList.add('active');
            lyricsBtn.setAttribute('aria-pressed', 'true');
            lyricsBtn.title = 'Hide Lyrics';
        }
        if (window.playbackManager) {
            syncLyricsTick(window.playbackManager.getCurrentTime(), true);
        }
    } else {
        // Mode 1: Centered Artwork Mode (Apple Music style)
        layout.classList.remove('fs-mode-lyrics');
        layout.classList.add('fs-mode-artwork');
        if (lyricsPanel) lyricsPanel.classList.remove('show-lyrics');
        if (lyricsBtn) {
            lyricsBtn.classList.remove('active');
            lyricsBtn.setAttribute('aria-pressed', 'false');
            lyricsBtn.title = isLyricsAvailable ? 'Show Lyrics' : 'Lyrics not available for this track';
        }
    }
}

function updateFsLyricsButtonState(available, loading = false) {
    isLyricsAvailable = available;
    const lyricsBtn = document.getElementById('fs-lyrics-btn');
    if (!lyricsBtn) return;

    if (loading) {
        lyricsBtn.classList.add('loading');
        lyricsBtn.classList.remove('disabled');
        lyricsBtn.title = 'Looking for lyrics...';
    } else if (available) {
        lyricsBtn.classList.remove('loading', 'disabled');
        lyricsBtn.title = (fsPlayerMode === 'lyrics') ? 'Hide Lyrics' : 'Show Lyrics';
    } else {
        lyricsBtn.classList.remove('loading', 'active');
        lyricsBtn.classList.add('disabled');
        lyricsBtn.title = 'Lyrics not available for this track';
    }
}

function setupFullScreenPlayer() {
    const fsPlayer = document.getElementById('fs-player');
    const trackInfoBtn = document.getElementById('player-track-info');
    const closeBtn = document.getElementById('fs-close-btn');
    const fsFsBtn = document.getElementById('fs-fullscreen-toggle-btn');
    const lyricsBtn = document.getElementById('fs-lyrics-btn');
    const lyricsPanel = document.getElementById('fs-lyrics-panel');

    // Default to artwork centered mode initially
    setFsPlayerMode('artwork');

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

            // Determine mode on open
            if (isLyricsAvailable && userWantsLyrics) {
                setFsPlayerMode('lyrics');
            } else {
                setFsPlayerMode('artwork');
            }

            // Ensure lyrics are loaded
            if (state.currentTrack && (!currentLyricsData || currentLyricsTrackId !== state.currentTrack.id)) {
                loadLyricsForTrack(state.currentTrack);
            } else if (currentLyricsData && currentLyricsData.synced && fsPlayerMode === 'lyrics') {
                setTimeout(() => {
                    const ct = window.playbackManager ? window.playbackManager.getCurrentTime() : 0;
                    syncLyricsTick(ct, true);
                }, 120);
            }

            // Start live audio visualizer for Fullscreen Player
            const visCanvas = document.getElementById('fs-visualizer-canvas');
            if (visCanvas && window.eqVisualizer && window.dspEngine && window.dspEngine.analyzer) {
                window.eqVisualizer.startLiveVisualizer(visCanvas, window.dspEngine.analyzer);
            }
        });
    }

    // Toggle spectrum / waveform on visualizer canvas click
    const visCanvasEl = document.getElementById('fs-visualizer-canvas');
    if (visCanvasEl) {
        visCanvasEl.addEventListener('click', () => {
            if (window.eqVisualizer) {
                const newMode = window.eqVisualizer.toggleMode();
                showToast(`Visualizer mode: ${newMode}`, 'info');
            }
        });
    }

    // Native Fullscreen toggle button (top right: ⤢)
    if (fsFsBtn && fsPlayer) {
        fsFsBtn.addEventListener('click', () => {
            if (!document.fullscreenElement) {
                if (fsPlayer.requestFullscreen) {
                    fsPlayer.requestFullscreen();
                } else if (fsPlayer.webkitRequestFullscreen) {
                    fsPlayer.webkitRequestFullscreen();
                }
            } else {
                if (document.exitFullscreen) {
                    document.exitFullscreen();
                } else if (document.webkitExitFullscreen) {
                    document.webkitExitFullscreen();
                }
            }
        });
    }

    document.addEventListener('fullscreenchange', () => {
        const fsIcon = document.getElementById('fs-fs-icon');
        if (fsIcon) {
            if (document.fullscreenElement) {
                fsIcon.innerHTML = `
                    <polyline points="4 14 10 14 10 20"/>
                    <polyline points="20 10 14 10 14 4"/>
                    <line x1="14" y1="10" x2="21" y2="3"/>
                    <line x1="3" y1="21" x2="10" y2="14"/>
                `;
            } else {
                fsIcon.innerHTML = `
                    <polyline points="15 3 21 3 21 9"/>
                    <polyline points="9 21 3 21 3 15"/>
                    <line x1="21" y1="3" x2="14" y2="10"/>
                    <line x1="3" y1="21" x2="10" y2="14"/>
                `;
            }
        }
    });

    // Close button (top right: ✕)
    if (closeBtn && fsPlayer) {
        closeBtn.addEventListener('click', () => {
            if (document.fullscreenElement) {
                document.exitFullscreen().catch(() => {});
            }
            if (window.eqVisualizer) {
                window.eqVisualizer.stopLiveVisualizer();
            }
            fsPlayer.classList.remove('active');
            fsPlayer.setAttribute('aria-hidden', 'true');
            document.body.classList.remove('fullscreen-player-open');
            setTimeout(() => fsPlayer.classList.add('hidden'), 500); // Wait for fade
        });
    }

    // Lyrics toggle button (Apple Music speech bubble)
    if (lyricsBtn) {
        lyricsBtn.addEventListener('click', () => {
            if (!isLyricsAvailable) {
                showToast('Lyrics not available for this track', 'info');
                return;
            }
            const nextMode = (fsPlayerMode === 'lyrics') ? 'artwork' : 'lyrics';
            userWantsLyrics = (nextMode === 'lyrics');
            setFsPlayerMode(nextMode);
        });
    }

    // Remaining vs Total Time Toggle Click
    const fsTotalTimeEl = document.getElementById('fs-total-time');
    if (fsTotalTimeEl) {
        fsTotalTimeEl.addEventListener('click', () => {
            fsTimeDisplayMode = (fsTimeDisplayMode === 'remaining') ? 'total' : 'remaining';
            localStorage.setItem('basa_fs_time_mode', fsTimeDisplayMode);
            const dur = window.playbackManager ? window.playbackManager.getDuration() : 0;
            const ct = window.playbackManager ? window.playbackManager.getCurrentTime() : 0;
            if (dur > 0) {
                if (fsTimeDisplayMode === 'remaining') {
                    const remSec = Math.max(0, dur - ct);
                    fsTotalTimeEl.textContent = `-${formatDuration(remSec)}`;
                } else {
                    fsTotalTimeEl.textContent = formatDuration(dur);
                }
            }
        });
    }

    // Volume Popover Interactivity
    const fsVolumeWrap = document.getElementById('fs-volume-wrap');
    const fsVolumeBtn = document.getElementById('fs-volume-btn');
    const fsVolumePopover = document.getElementById('fs-volume-popover');
    let volPopoverTimeout = null;

    if (fsVolumeWrap && fsVolumePopover) {
        fsVolumeWrap.addEventListener('mouseenter', () => {
            if (volPopoverTimeout) clearTimeout(volPopoverTimeout);
            fsVolumePopover.classList.remove('hidden');
        });
        fsVolumeWrap.addEventListener('mouseleave', () => {
            volPopoverTimeout = setTimeout(() => {
                fsVolumePopover.classList.add('hidden');
            }, 400);
        });
    }

    if (fsVolumeBtn) {
        fsVolumeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (fsVolumePopover) {
                fsVolumePopover.classList.toggle('hidden');
            }
        });
    }

    // Close volume popover on click outside
    document.addEventListener('click', (e) => {
        if (fsVolumePopover && !fsVolumePopover.contains(e.target) && !fsVolumeWrap.contains(e.target)) {
            fsVolumePopover.classList.add('hidden');
        }
    });

    // Like / Favorite button in Fullscreen player
    const fsLikeBtn = document.getElementById('fs-like-btn');
    if (fsLikeBtn) {
        fsLikeBtn.addEventListener('click', () => {
            if (!state.currentTrack) return;
            const encoded = encodeURIComponent(JSON.stringify(state.currentTrack));
            toggleLike(state.currentTrack.id, state.currentTrack.source || 'youtube', encoded);
            fsLikeBtn.classList.add('pop');
            setTimeout(() => fsLikeBtn.classList.remove('pop'), 350);
        });
    }

    // Top Right Options Menu in Fullscreen player
    const fsOptionsBtn = document.getElementById('fs-options-btn');
    const fsOptionsMenu = document.getElementById('fs-options-menu');
    const fsOptionsTrackName = document.getElementById('fs-options-track-name');

    function closeFsOptionsMenu() {
        if (fsOptionsMenu) {
            fsOptionsMenu.classList.add('hidden');
            fsOptionsMenu.setAttribute('aria-hidden', 'true');
        }
    }

    if (fsOptionsBtn && fsOptionsMenu) {
        fsOptionsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isHidden = fsOptionsMenu.classList.contains('hidden');
            if (isHidden) {
                if (fsOptionsTrackName && state.currentTrack) {
                    fsOptionsTrackName.textContent = `${state.currentTrack.title || 'Track'} • ${state.currentTrack.artist || ''}`;
                }
                const optLikeText = document.getElementById('fs-opt-like-text');
                if (optLikeText && state.currentTrack) {
                    optLikeText.textContent = state.isLiked ? 'Remove from Favorites' : 'Add to Favorites';
                }
                const optRepeatText = document.getElementById('fs-opt-repeat-text');
                if (optRepeatText) {
                    optRepeatText.textContent = `Repeat: ${state.repeat || 'Off'}`;
                }
                fsOptionsMenu.classList.remove('hidden');
                fsOptionsMenu.setAttribute('aria-hidden', 'false');
            } else {
                closeFsOptionsMenu();
            }
        });

        // Close options on click outside
        document.addEventListener('click', (e) => {
            if (!fsOptionsMenu.contains(e.target) && e.target !== fsOptionsBtn) {
                closeFsOptionsMenu();
            }
        });

        // Menu Option: Like / Favorite
        const optLike = document.getElementById('fs-opt-like');
        if (optLike) {
            optLike.addEventListener('click', () => {
                closeFsOptionsMenu();
                if (state.currentTrack) {
                    const encoded = encodeURIComponent(JSON.stringify(state.currentTrack));
                    toggleLike(state.currentTrack.id, state.currentTrack.source || 'youtube', encoded);
                }
            });
        }

        // Menu Option: Shuffle
        const optShuffle = document.getElementById('fs-opt-shuffle');
        if (optShuffle) {
            optShuffle.addEventListener('click', () => {
                closeFsOptionsMenu();
                const mainShuffle = document.getElementById('shuffle-btn');
                if (mainShuffle) mainShuffle.click();
            });
        }

        // Menu Option: Repeat
        const optRepeat = document.getElementById('fs-opt-repeat');
        if (optRepeat) {
            optRepeat.addEventListener('click', () => {
                closeFsOptionsMenu();
                const mainRepeat = document.getElementById('repeat-btn');
                if (mainRepeat) mainRepeat.click();
            });
        }

        // Option 1: Available Audio Sources & Lossless
        const optSources = document.getElementById('fs-opt-sources');
        if (optSources) {
            optSources.addEventListener('click', () => {
                closeFsOptionsMenu();
                if (state.currentTrack) {
                    const encoded = encodeURIComponent(JSON.stringify(state.currentTrack));
                    openCandidateSourcesModal(encoded);
                } else {
                    showToast('No track playing', 'info');
                }
            });
        }

        // Option 2: Audio & Resolution Settings
        const optSettings = document.getElementById('fs-opt-settings');
        if (optSettings) {
            optSettings.addEventListener('click', () => {
                closeFsOptionsMenu();
                openAudioSettingsModal();
            });
        }

        // Option 3: Request Lossless Master
        const optRequest = document.getElementById('fs-opt-request');
        if (optRequest) {
            optRequest.addEventListener('click', () => {
                closeFsOptionsMenu();
                const query = state.currentTrack ? `${state.currentTrack.title} - ${state.currentTrack.artist || ''}` : '';
                openSongRequestModal(query);
            });
        }

        // Option 4: Download Audio
        const optDownload = document.getElementById('fs-opt-download');
        if (optDownload) {
            optDownload.addEventListener('click', () => {
                closeFsOptionsMenu();
                if (state.currentTrack) {
                    downloadTrackFromData(encodeURIComponent(JSON.stringify(state.currentTrack)));
                } else {
                    showToast('No track playing to download', 'info');
                }
            });
        }

        // Option 5: Copy Track Info / Share
        const optShare = document.getElementById('fs-opt-share');
        if (optShare) {
            optShare.addEventListener('click', async () => {
                closeFsOptionsMenu();
                if (state.currentTrack) {
                    const shareText = `🎵 Listening to "${state.currentTrack.title}" by ${state.currentTrack.artist || 'Unknown'} on BASA`;
                    try {
                        await navigator.clipboard.writeText(shareText);
                        showToast('Track info copied to clipboard!', 'success');
                    } catch {
                        showToast(shareText, 'info');
                    }
                }
            });
        }
    }

    // Lyrics Timing Offset Controls
    const offsetMinus = document.getElementById('fs-lyrics-offset-minus');
    const offsetPlus = document.getElementById('fs-lyrics-offset-plus');
    const offsetReset = document.getElementById('fs-lyrics-offset-reset');
    if (offsetMinus) offsetMinus.addEventListener('click', () => setLyricsOffset(-0.5));
    if (offsetPlus) offsetPlus.addEventListener('click', () => setLyricsOffset(+0.5));
    if (offsetReset) offsetReset.addEventListener('click', () => setLyricsOffset(0));

    // Keyboard ESC to close with priority: options menu -> queue drawer -> full player
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && fsPlayer && fsPlayer.classList.contains('active')) {
            if (fsOptionsMenu && !fsOptionsMenu.classList.contains('hidden')) {
                closeFsOptionsMenu();
                return;
            }
            const queueDrawer = document.getElementById('queue-drawer');
            if (queueDrawer && !queueDrawer.classList.contains('hidden')) {
                closeQueueDrawer();
                return;
            }
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
    if (fsNextBtn) fsNextBtn.addEventListener('click', () => playNext(true));
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

function startOrOpenJamSession() {
    closeQueueDrawer();
    navigate('#sync');
    setTimeout(() => {
        const btnCreate = document.getElementById('btn-create-room');
        if (btnCreate) {
            btnCreate.click();
            showToast('🎵 Jam session started! Share your invite code with friends.', 'success');
        }
    }, 150);
}
window.startOrOpenJamSession = startOrOpenJamSession;

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
window.undoQueueAction = undoQueueAction;
window.clearUserQueue = clearUserQueue;
window.clearAutoplay = clearAutoplay;
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

// Lossless Studio & Master Engine Controller Functions
window.loadLosslessStudio = loadLosslessLibrary;
window.loadLosslessLibrary = loadLosslessLibrary;
window.setLosslessLibraryFilter = setLosslessLibraryFilter;
window.filterLosslessLibrary = filterLosslessLibrary;
window.playTrackById = playTrackById;

// ============================================
// 10. LOSSLESS STUDIO CONTROLLER
// ============================================

async function loadLosslessStudio() {
    loadLosslessLibrary();
}

// ============================================
// VERIFIED LOSSLESS LIBRARY (Section 18)
// ============================================
let verifiedLosslessTracks = [];
let activeLosslessFilter = 'all';

async function loadLosslessLibrary() {
    const listEl = document.getElementById('vault-library-list');
    const countEl = document.getElementById('vault-library-count');
    if (!listEl) return;
    listEl.innerHTML = '<div class="loader">Loading verified lossless tracks...</div>';

    try {
        const res = await api('/music/lossless/cache');
        if (res && res.cachedSources) {
            // Section 18: Only verified sources belong in Verified Lossless!
            verifiedLosslessTracks = res.cachedSources.filter(s => 
                s.playableLosslessVerified === true || s.verificationStatus === 'VERIFIED' || s.is_verified === 1
            );
            if (countEl) countEl.textContent = String(verifiedLosslessTracks.length);
            renderLosslessLibraryList(verifiedLosslessTracks);
        } else {
            listEl.innerHTML = '<p class="empty-state" style="padding: 24px; text-align: center; color: var(--text-tertiary);">No verified lossless tracks cached yet.</p>';
        }
    } catch (e) {
        console.error('Error loading verified lossless library:', e);
        listEl.innerHTML = `<p class="error-state" style="padding: 24px; text-align: center; color: #ff6b6b;">Failed to load verified lossless tracks: ${escapeHtml(e.message)}</p>`;
    }
}

function setLosslessLibraryFilter(filter, el) {
    activeLosslessFilter = filter;
    document.querySelectorAll('#vault-view-library .lang-pill').forEach(p => p.classList.remove('active'));
    if (el) el.classList.add('active');
    applyLosslessLibraryFilters();
}

function filterLosslessLibrary(query) {
    applyLosslessLibraryFilters(query);
}

function applyLosslessLibraryFilters(queryText = null) {
    const searchInput = document.getElementById('lossless-library-search');
    const q = (queryText !== null ? queryText : (searchInput ? searchInput.value : '')).toLowerCase().trim();

    let filtered = verifiedLosslessTracks.filter(t => {
        // Filter by category (Section 18: All, Hi-Res, Lossless, Recently Cached, Local FLAC)
        if (activeLosslessFilter === 'hires') {
            const bit = Number(t.bit_depth || t.bitDepth) || 0;
            const rate = Number(t.sample_rate || t.sampleRate) || 0;
            if (bit <= 16 && rate <= 48000) return false;
        } else if (activeLosslessFilter === 'lossless') {
            const bit = Number(t.bit_depth || t.bitDepth) || 0;
            const rate = Number(t.sample_rate || t.sampleRate) || 0;
            if (bit > 16 || rate > 48000) return false;
        } else if (activeLosslessFilter === 'cached') {
            if (!t.cached_at && !t.cachedAt && !t.last_played_at) return false;
        } else if (activeLosslessFilter === 'local') {
            if (t.provider !== 'local' && t.source !== 'local' && t.source_type !== 'LOCAL_FILE') return false;
        }

        // Filter by search query
        if (q) {
            const title = String(t.title || '').toLowerCase();
            const artist = String(t.artist || '').toLowerCase();
            const album = String(t.album || '').toLowerCase();
            return title.includes(q) || artist.includes(q) || album.includes(q);
        }
        return true;
    });

    renderLosslessLibraryList(filtered);
}

function renderLosslessLibraryList(tracks) {
    const listEl = document.getElementById('vault-library-list');
    if (!listEl) return;

    if (!tracks || tracks.length === 0) {
        listEl.innerHTML = '<p class="empty-state" style="padding: 24px; text-align: center; color: var(--text-tertiary);">No verified tracks match the selected filter.</p>';
        return;
    }

    listEl.innerHTML = tracks.map((track, idx) => {
        const bitDepth = track.bit_depth || track.bitDepth || 16;
        const sampleRate = track.sample_rate || track.sampleRate || 44100;
        const isHiRes = Number(bitDepth) > 16 || Number(sampleRate) > 48000;
        const rateKhz = `${Math.round(sampleRate / 1000)} kHz`;
        const sizeMb = track.file_size ? `${(track.file_size / (1024 * 1024)).toFixed(1)} MB` : '';
        const trackObj = {
            id: track.canonical_track_id || track.id,
            canonicalTrackId: track.canonical_track_id || track.id,
            title: track.title || 'Verified Lossless Track',
            artist: track.artist || 'Unknown Artist',
            album: track.album || '',
            cover: track.cover_url || track.cover || '/logo.png',
            duration: track.duration || 0,
            source: track.provider || 'lossless',
            format: 'FLAC',
            codec: 'FLAC',
            isLossless: true,
            lossless: true,
            isHiRes,
            quality: isHiRes ? 'HI_RES_LOSSLESS' : 'LOSSLESS',
            bitDepth,
            sampleRate,
            verificationStatus: 'VERIFIED',
            playableLosslessVerified: true,
            isCached: true,
            preview: `/api/music/lossless/stream/${encodeURIComponent(track.canonical_track_id || track.id)}`
        };
        const encoded = encodeURIComponent(JSON.stringify(trackObj));

        return `
            <div class="track-list-item glass-subtle" style="display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-radius: 8px; margin-bottom: 8px;" onclick="playTrackFromData('${encoded}')">
                <div style="display: flex; align-items: center; gap: 12px;">
                    <div style="width: 40px; height: 40px; border-radius: 6px; overflow: hidden; background: #1a1a24; flex-shrink: 0;">
                        <img src="${trackObj.cover}" alt="" style="width: 100%; height: 100%; object-fit: cover;" onerror="this.style.opacity='0.2'">
                    </div>
                    <div>
                        <div style="font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 8px;">
                            ${escapeHtml(trackObj.title)}
                            <span class="source-badge ${isHiRes ? 'hires' : 'lossless'}" style="font-size: 10px; padding: 2px 6px; border-radius: 4px; font-weight: 700;">
                                ${isHiRes ? 'HI-RES LOSSLESS' : 'LOSSLESS'} · ${bitDepth}-bit/${rateKhz}
                            </span>
                            <span style="font-size: 10px; background: rgba(16, 185, 129, 0.2); color: #10b981; border: 1px solid rgba(16,185,129,0.4); border-radius: 4px; padding: 2px 6px; font-weight: 700;">VERIFIED</span>
                        </div>
                        <div style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">
                            ${escapeHtml(trackObj.artist)} ${trackObj.album ? '· ' + escapeHtml(trackObj.album) : ''} · ${(track.provider || 'FLAC').toUpperCase()} ${sizeMb ? '· ' + sizeMb : ''}
                        </div>
                    </div>
                </div>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <button class="button button-primary" style="font-size: 12px; padding: 6px 14px;" onclick="event.stopPropagation();playTrackFromData('${encoded}')">
                        ▶ Play
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

// Manual lossless upgrade trigger & dismissal (Section 12)
function executeManualLosslessUpgrade() {
    if (!window.playbackManager || !window.playbackManager.pendingUpgradeCandidate) return;
    const cand = window.playbackManager.pendingUpgradeCandidate;
    dismissLosslessUpgradeBanner();
    showToast('Upgrading to Studio Lossless FLAC...', 'info');
    window.playbackManager.switchSource(cand.id, cand, { explicit: false });
}

function dismissLosslessUpgradeBanner() {
    const banner = document.getElementById('lossless-upgrade-banner');
    if (banner) banner.classList.add('hidden');
}

window.loadLosslessLibrary = loadLosslessLibrary;
window.setLosslessLibraryFilter = setLosslessLibraryFilter;
window.filterLosslessLibrary = filterLosslessLibrary;
window.executeManualLosslessUpgrade = executeManualLosslessUpgrade;
window.dismissLosslessUpgradeBanner = dismissLosslessUpgradeBanner;

async function playTrackById(trackId) {
    playTrack({ id: trackId, source: 'lossless', title: 'Lossless Track' });
}

// ============================================
// 19. AUDIO SETTINGS & CANDIDATE SOURCES MODALS
// ============================================

function openAudioSettingsModal() {
    const modal = document.getElementById('audio-settings-modal');
    if (!modal) return;
    
    const settings = window.playbackManager ? window.playbackManager.settings : {};
    const playbackModeSelect = document.getElementById('setting-playback-mode');
    const fastStartCheckbox = document.getElementById('setting-fast-start');
    const autoUpgradeCheckbox = document.getElementById('setting-auto-upgrade');
    const preferCachedCheckbox = document.getElementById('setting-prefer-cached');
    const preferredQualitySelect = document.getElementById('setting-preferred-quality');
    
    if (playbackModeSelect && settings.playbackMode) playbackModeSelect.value = settings.playbackMode;
    if (fastStartCheckbox) fastStartCheckbox.checked = settings.fastStart !== false;
    if (autoUpgradeCheckbox) autoUpgradeCheckbox.checked = settings.autoLosslessUpgrade !== false;
    if (preferCachedCheckbox) preferCachedCheckbox.checked = settings.preferCached !== false;
    if (preferredQualitySelect && settings.preferredQuality) preferredQualitySelect.value = settings.preferredQuality;
    
    // Sync live DSP engine settings to UI controls
    if (window.dspEngine) {
        const cfg = window.dspEngine.config;
        const modeEl = document.getElementById('setting-dsp-mode');
        const presetEl = document.getElementById('setting-dsp-preset');
        const bassEl = document.getElementById('setting-bass-boost');
        const trebleEl = document.getElementById('setting-treble-boost');
        const resEl = document.getElementById('setting-resample-target');
        const profEl = document.getElementById('setting-dsp-profile');
        const stereoEl = document.getElementById('setting-stereo-width');
        const crossEl = document.getElementById('setting-crossfeed');

        if (modeEl && cfg.mode) modeEl.value = cfg.mode;
        if (presetEl && cfg.preset) presetEl.value = cfg.preset;
        if (bassEl && cfg.bass) bassEl.value = cfg.bass;
        if (trebleEl && cfg.treble) trebleEl.value = cfg.treble;
        if (resEl && cfg.resampleTarget) resEl.value = cfg.resampleTarget;
        if (profEl && cfg.profile) profEl.value = cfg.profile;
        if (stereoEl && cfg.stereoWidth) stereoEl.value = cfg.stereoWidth;
        if (crossEl && cfg.crossfeed) crossEl.value = cfg.crossfeed;
    }
    
    // Sync 10-band equalizer sliders and draw curve
    syncEqualizerSlidersFromEngine();
    
    modal.classList.remove('hidden');
    modal.style.display = 'grid';
}

function syncEqualizerSlidersFromEngine() {
    if (!window.dspEngine) return;
    const bands = window.dspEngine.equalizer?.bands || [];
    bands.forEach((b, i) => {
        const slider = document.getElementById(`eq-band-${i}`);
        const label = document.getElementById(`eq-val-${i}`);
        if (slider) slider.value = b.gain;
        if (label) label.textContent = `${b.gain > 0 ? '+' : ''}${b.gain}dB`;
    });

    const preSlider = document.getElementById('eq-preamp-slider');
    const preVal = document.getElementById('eq-preamp-val');
    const curPre = window.dspEngine.equalizer?.preampGain || 0;
    if (preSlider) preSlider.value = curPre;
    if (preVal) preVal.textContent = `${curPre > 0 ? '+' : ''}${curPre.toFixed(1)} dB`;

    const balSlider = document.getElementById('eq-balance-slider');
    const balVal = document.getElementById('eq-balance-val');
    const curBal = window.dspEngine.stereo?.balance || 0;
    if (balSlider) balSlider.value = curBal;
    if (balVal) {
        if (curBal === 0) balVal.textContent = 'Center';
        else if (curBal < 0) balVal.textContent = `L ${Math.round(Math.abs(curBal) * 100)}%`;
        else balVal.textContent = `R ${Math.round(curBal * 100)}%`;
    }

    const canvas = document.getElementById('eq-curve-canvas');
    if (canvas && window.eqVisualizer) {
        window.eqVisualizer.drawResponseCurve(canvas, window.dspEngine);
    }
}

function onEqualizerSliderChange(bandIndex, gainVal) {
    const val = parseFloat(gainVal);
    const label = document.getElementById(`eq-val-${bandIndex}`);
    if (label) label.textContent = `${val > 0 ? '+' : ''}${val}dB`;
    if (window.dspEngine) {
        window.dspEngine.setBandGain(bandIndex, val);
        const presetEl = document.getElementById('setting-dsp-preset');
        if (presetEl) presetEl.value = 'CUSTOM';
        const canvas = document.getElementById('eq-curve-canvas');
        if (canvas && window.eqVisualizer) {
            window.eqVisualizer.drawResponseCurve(canvas, window.dspEngine);
        }
    }
}

function onPreampChange(preampVal) {
    const val = parseFloat(preampVal);
    const label = document.getElementById('eq-preamp-val');
    if (label) label.textContent = `${val > 0 ? '+' : ''}${val.toFixed(1)} dB`;
    if (window.dspEngine) {
        window.dspEngine.setPreamp(val);
        const canvas = document.getElementById('eq-curve-canvas');
        if (canvas && window.eqVisualizer) {
            window.eqVisualizer.drawResponseCurve(canvas, window.dspEngine);
        }
    }
}

function onBalanceChange(balanceVal) {
    const val = parseFloat(balanceVal);
    const label = document.getElementById('eq-balance-val');
    if (label) {
        if (val === 0) label.textContent = 'Center';
        else if (val < 0) label.textContent = `L ${Math.round(Math.abs(val) * 100)}%`;
        else balVal.textContent = `R ${Math.round(val * 100)}%`;
    }
    if (window.dspEngine && window.dspEngine.stereo) {
        window.dspEngine.stereo.setBalance(val);
    }
}

function resetEqualizerCurve() {
    if (window.dspEngine) {
        window.dspEngine.setPreset('FLAT');
        window.dspEngine.setPreamp(0);
        if (window.dspEngine.stereo) window.dspEngine.stereo.setBalance(0);
    }
    for (let i = 0; i < 10; i++) {
        const slider = document.getElementById(`eq-band-${i}`);
        const label = document.getElementById(`eq-val-${i}`);
        if (slider) slider.value = 0;
        if (label) label.textContent = '0dB';
    }
    const preSlider = document.getElementById('eq-preamp-slider');
    const preVal = document.getElementById('eq-preamp-val');
    if (preSlider) preSlider.value = 0;
    if (preVal) preVal.textContent = '0.0 dB';

    const balSlider = document.getElementById('eq-balance-slider');
    const balVal = document.getElementById('eq-balance-val');
    if (balSlider) balSlider.value = 0;
    if (balVal) balVal.textContent = 'Center';

    const presetEl = document.getElementById('setting-dsp-preset');
    if (presetEl) presetEl.value = 'FLAT';

    const canvas = document.getElementById('eq-curve-canvas');
    if (canvas && window.eqVisualizer && window.dspEngine) {
        window.eqVisualizer.drawResponseCurve(canvas, window.dspEngine);
    }
    showToast('Equalizer reset to Flat (0 dB)', 'info');
}

function closeAudioSettingsModal() {
    const modal = document.getElementById('audio-settings-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
    }
}

function savePlaybackSetting(key, value) {
    if (window.playbackManager) {
        window.playbackManager.updateSettings({ [key]: value });
        showToast(`Updated ${key}: ${value}`, 'info');
    }
}

function updateDspSetting(key, value) {
    if (!window.dspEngine) return;
    switch (key) {
        case 'mode':
            window.dspEngine.setMode(value);
            break;
        case 'preset':
            window.dspEngine.setPreset(value);
            syncEqualizerSlidersFromEngine();
            break;
        case 'bass':
            window.dspEngine.setBass(value);
            break;
        case 'treble':
            window.dspEngine.setTreble(value);
            break;
        case 'resampleTarget':
            window.dspEngine.setResampleTarget(value);
            break;
        case 'profile':
            window.dspEngine.setProfile(value);
            break;
        case 'stereo':
            window.dspEngine.setStereoWidth(value);
            break;
        case 'crossfeed':
            window.dspEngine.setCrossfeed(value);
            break;
    }
    updateABButtonState();
    if (state.currentTrack) {
        updatePlayerUI(state.currentTrack);
    }
    showToast(`DSP ${key} set to ${value}`, 'info');
}

function toggleABMode() {
    if (!window.playbackManager) return;
    const newState = window.playbackManager.toggleAB();
    updateABButtonState();
    if (state.currentTrack) {
        updatePlayerUI(state.currentTrack);
    }
    showToast(newState === 'A' ? 'A/B: State A (DIRECT / DSP BYPASS)' : 'A/B: State B (DSP ENABLED)', 'info');
}

function updateABButtonState() {
    const btn = document.getElementById('ab-mode-btn');
    const playerBtn = document.getElementById('player-ab-btn');
    const modalBtn = document.getElementById('modal-ab-toggle-btn');
    const isDirect = window.dspEngine && (window.dspEngine.abState === 'A' || window.dspEngine.mode === 'DIRECT');
    const label = isDirect ? 'A: BYPASS' : 'B: DSP';
    
    if (btn) {
        btn.textContent = label;
        btn.title = isDirect ? 'A: DIRECT / DSP BYPASS' : 'B: DSP ENABLED';
        btn.classList.toggle('direct-mode', isDirect);
        btn.classList.toggle('dsp-mode', !isDirect);
    }
    if (playerBtn) {
        playerBtn.textContent = label;
        playerBtn.title = isDirect ? 'A: DIRECT / DSP BYPASS' : 'B: DSP ENABLED';
        playerBtn.classList.toggle('direct-mode', isDirect);
        playerBtn.classList.toggle('dsp-mode', !isDirect);
    }
    if (modalBtn) {
        modalBtn.textContent = isDirect ? 'A: DIRECT / DSP BYPASS' : 'B: DSP ENABLED';
    }
}

let pipelineInspectorInterval = null;

function openPipelineInspectorModal() {
    const modal = document.getElementById('pipeline-inspector-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.style.display = 'grid';
    
    updatePipelineInspectorUI();
    if (pipelineInspectorInterval) clearInterval(pipelineInspectorInterval);
    pipelineInspectorInterval = setInterval(updatePipelineInspectorUI, 300);
}

function closePipelineInspectorModal() {
    const modal = document.getElementById('pipeline-inspector-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
    }
    if (pipelineInspectorInterval) {
        clearInterval(pipelineInspectorInterval);
        pipelineInspectorInterval = null;
    }
}

function updatePipelineInspectorUI() {
    if (!window.playbackManager) return;
    const diag = window.playbackManager.getAudioPipelineDiagnostics();
    if (!diag) return;
    const validation = window.playbackManager.validateAudioPipeline();
    updateABButtonState();

    const setTxt = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val !== null && val !== undefined && val !== '' ? String(val) : '—';
    };

    // Stage 1: Source
    const src = diag.source || {};
    const isLossless = Boolean(src.lossless || src.isLossless);
    const truthBadge = document.getElementById('pipeline-truth-badge');
    if (truthBadge) {
        if (isLossless) {
            truthBadge.className = 'source-badge lossless';
            truthBadge.textContent = 'SOURCE: LOSSLESS FLAC';
        } else if (src.provider === 'YOUTUBE' || src.provider === 'youtube') {
            truthBadge.className = 'source-badge standard';
            truthBadge.textContent = 'SOURCE: YOUTUBE OPUS/AAC';
        } else {
            truthBadge.className = 'source-badge high';
            truthBadge.textContent = (diag.dsp && diag.dsp.enabled) ? 'SOURCE: LOSSY AAC · DSP ENHANCED' : 'SOURCE: HIGH / LOSSY (AAC 320)';
        }
    }

    setTxt('diag-source-tier', isLossless ? 'LOSSLESS / STUDIO MASTER' : (src.quality ? `${src.quality} / LOSSY` : 'HIGH / LOSSY'));
    setTxt('diag-source-provider', src.provider ? src.provider.toUpperCase() : 'Unavailable');
    setTxt('diag-source-codec', src.codec ? src.codec.toUpperCase() : 'Unavailable');
    setTxt('diag-source-bitrate', src.bitrate ? `${Math.round(src.bitrate / 1000)} kbps` : 'Unavailable');
    setTxt('diag-source-rate', src.sampleRate ? `${src.sampleRate} Hz` : 'Unavailable');
    setTxt('diag-source-depth', src.bitDepth ? `${src.bitDepth}-bit` : 'UNAVAILABLE / NOT APPLICABLE');
    setTxt('diag-source-channels', src.channels ? (src.channels === 2 ? 'Stereo (2 ch)' : `${src.channels} ch`) : 'Stereo');
    setTxt('diag-source-format', src.format ? src.format.toUpperCase() : (src.codec || 'AUDIO').toUpperCase());
    setTxt('diag-source-lossless', isLossless ? 'Yes (Verified Lossless FLAC)' : 'No (Lossy Compression)');

    // Stage 2: Decoder (Section 4: Browser-managed FLAC decoding)
    const dec = diag.decoder || {};
    setTxt('diag-decoder-status', dec.pcmFormat ? `${dec.pcmFormat} Stream` : 'Float32 PCM');
    setTxt('diag-decoder-name', (isLossless && (src.codec === 'FLAC' || src.format === 'FLAC')) 
        ? 'HTMLMediaElement / Browser-managed FLAC decoding' 
        : (dec.name || 'HTMLMediaElement / Browser-managed decoding'));
    setTxt('diag-decoder-codec', dec.codec ? dec.codec.toUpperCase() : (src.codec || 'Browser Native').toUpperCase());
    setTxt('diag-decoder-pcm', dec.pcmFormat || 'Float32');
    setTxt('diag-decoder-rate', (dec.sampleRate && dec.sampleRate !== 'UNAVAILABLE') ? `${dec.sampleRate} Hz` : 'UNAVAILABLE');

    // Stage 3: Float32 DSP Engine (Section 1: Dynamic actual AudioContext rate)
    const dsp = diag.dsp || {};
    const dspStatusEl = document.getElementById('diag-dsp-status');
    if (dspStatusEl) {
        dspStatusEl.textContent = dsp.enabled ? (dsp.mode || 'ACTIVE') : 'BYPASS / DIRECT';
        dspStatusEl.style.color = dsp.enabled ? '#10b981' : '#f59e0b';
    }
    const nativeRate = dsp.nativeDspRate || diag.audioContext?.actualRate || 48000;
    const rateKhz = nativeRate ? Math.round(nativeRate / 1000) : 48;
    const isModeA = (diag.audioContext?.actualRate || nativeRate) >= 88200;
    const dspRateStr = `${rateKhz} kHz Native DSP`;
    setTxt('diag-dsp-rate', dspRateStr);
    setTxt('diag-dsp-preset', dsp.preset ? dsp.preset.replace(/_/g, ' ') : 'BASA HiFi');
    setTxt('diag-dsp-bass', dsp.bassLevel !== undefined ? (dsp.bassLevel === 0 ? 'OFF' : `${dsp.bassLevel > 0 ? '+' : ''}${dsp.bassLevel.toFixed(1)} dB`) : 'OFF');
    setTxt('diag-dsp-treble', dsp.trebleLevel !== undefined ? (dsp.trebleLevel === 0 ? 'OFF' : `${dsp.trebleLevel > 0 ? '+' : ''}${dsp.trebleLevel.toFixed(1)} dB`) : 'OFF');
    setTxt('diag-dsp-compressor', dsp.compressor?.enabled ? (dsp.compressor.preset || 'LIGHT') : 'OFF');
    setTxt('diag-dsp-limiter', dsp.limiter?.enabled !== false ? `Peak Limiter @ ${rateKhz} kHz (-1.0 dBFS Ceiling)` : 'OFF');
    setTxt('diag-dsp-stereo', dsp.stereo?.enabled ? `${Math.round((dsp.stereo.width || 1) * 100)}%` : 'NORMAL');
    setTxt('diag-dsp-crossfeed', dsp.crossfeed?.enabled ? (dsp.crossfeed.mode || 'ACTIVE') : 'OFF');
    setTxt('diag-dsp-loudness', dsp.loudness?.enabled ? `K-weighted normalization target: ${dsp.loudness.targetLufs || -14} LUFS` : 'OFF');

    // Stage 4: AudioWorklet Resampler / Oversampler
    const res = diag.resampler || {};
    const resStatusEl = document.getElementById('diag-resampler-status');
    if (resStatusEl) {
        const statusText = isModeA 
            ? 'BYPASS (Mode A True 96 kHz Direct)'
            : (res.enabled ? '96 kHz Internal Oversampling' : 'BYPASS');
        resStatusEl.textContent = statusText;
        resStatusEl.style.color = (res.enabled && !isModeA) ? '#10b981' : (statusText === 'UNAVAILABLE' ? '#ef4444' : '#f59e0b');
    }
    const inRate = res.resamplerInputRate || res.inputRate || 48000;
    const osRate = res.internalOversampleRate || res.internalRate || 96000;
    const outRate = res.resamplerOutputRate || res.outputRate || 48000;
    const ioPath = isModeA
        ? 'BYPASS (Mode A Direct 96 kHz Native)'
        : ((osRate > outRate && res.status !== 'BYPASS')
            ? `${inRate} Hz → ${osRate} Hz Internal → ${outRate} Hz`
            : (inRate !== outRate
                ? `${inRate} Hz → ${outRate} Hz`
                : 'BYPASS'));
    setTxt('diag-resampler-io', ioPath);
    setTxt('diag-resampler-algo', res.algorithm || '16-tap polyphase windowed-sinc using Lanczos window');
    setTxt('diag-resampler-quality', res.quality || 'High-Precision Float32 (16-tap Lanczos)');
    setTxt('diag-resampler-latency', res.latencyMs ? `~${res.latencyMs.toFixed(1)} ms (Sync)` : '~2.6 ms (Sync)');

    // Stage 5: AudioContext & Output Device
    const actx = diag.audioContext || {};
    const out = diag.output || {};
    const actualCtxRate = actx.actualRate || out.audioContextSampleRate || 48000;
    setTxt('diag-output-rate-title', `AUDIOCONTEXT: ${Math.round(actualCtxRate / 1000)} kHz`);
    setTxt('diag-output-requested-rate', actx.requestedRate ? `${Math.round(actx.requestedRate / 1000)} kHz` : 'System Default');
    setTxt('diag-output-ctx-rate', `${actualCtxRate} Hz`);
    
    let statusLabel = 'NATIVE';
    if (actx.status === 'REQUEST_NOT_HONORED' || actx.status === 'FALLBACK') {
        statusLabel = 'REQUEST_NOT_HONORED';
    } else if (actx.status === 'MATCH') {
        statusLabel = `MATCH (${Math.round(actualCtxRate / 1000)} kHz achieved)`;
    }
    setTxt('diag-output-status', statusLabel);
    setTxt('diag-output-hw-rate', 'UNAVAILABLE');
    setTxt('diag-output-hw-depth', 'UNAVAILABLE');
    setTxt('diag-output-channels', out.channels ? `${out.channels} (Stereo)` : '2 (Stereo)');
    setTxt('diag-output-device', out.deviceName || 'Default Audio Output');
    setTxt('diag-output-hw-rate', out.hardwareSampleRate || 'UNAVAILABLE / NOT EXPOSED BY BROWSER');
    setTxt('diag-output-hw-depth', out.hardwareBitDepth || 'UNAVAILABLE / NOT EXPOSED BY BROWSER');

    // Internal PCM data rate: sampleRate * bits * channels
    const pcmRate = dsp.internalRate || actualCtxRate;
    if (pcmRate) {
        const pcmBits = pcmRate * 32 * 2;
        setTxt('diag-output-pcm-bitrate', `${(pcmBits / 1000000).toFixed(3)} Mbps (Float32 Internal)`);
    } else {
        setTxt('diag-output-pcm-bitrate', '—');
    }

    // Telemetry meters
    const meters = diag.meters || dsp.analyzer || {};
    const rmsEl = document.getElementById('diag-meter-rms');
    const peakEl = document.getElementById('diag-meter-peak');
    const clipEl = document.getElementById('diag-clip-indicator');
    const rmsVal = meters.rms !== undefined ? meters.rms : meters.rmsDb;
    const peakVal = meters.peak !== undefined ? meters.peak : meters.peakDb;
    if (rmsEl) rmsEl.textContent = rmsVal !== undefined && rmsVal !== -100 ? `${rmsVal.toFixed(1)} dBFS` : '—';
    if (peakEl) peakEl.textContent = peakVal !== undefined && peakVal !== -100 ? `${peakVal.toFixed(1)} dBFS` : '—';
    if (clipEl) {
        if (meters.isClipping) {
            clipEl.textContent = 'CLIPPING DETECTED';
            clipEl.style.background = '#ef4444';
            clipEl.style.color = '#fff';
        } else {
            clipEl.textContent = 'NO CLIPPING';
            clipEl.style.background = 'rgba(255,255,255,0.1)';
            clipEl.style.color = '#888';
        }
    }

    // Validation Status
    const valEl = document.getElementById('pipeline-validation-status');
    if (valEl) {
        const isValid = validation.isValid !== undefined ? validation.isValid : validation.valid;
        const reason = (validation.violations && validation.violations.length > 0) 
            ? validation.violations.join('; ')
            : (validation.reason || (isValid ? 'Pipeline Consistent & Valid' : 'Pipeline Configuration Inconsistent'));
        valEl.textContent = isValid ? `✓ ${reason}` : `⚠ ${reason}`;
        valEl.style.color = isValid ? '#10b981' : '#f59e0b';
    }
}

function openCandidateSourcesModal(encodedTrackData) {
    let track;
    try {
        track = JSON.parse(decodeURIComponent(encodedTrackData));
    } catch (e) {
        console.error('Failed to parse track data for sources modal:', e);
        return;
    }

    const modal = document.getElementById('candidate-sources-modal');
    const titleEl = document.getElementById('sources-modal-title');
    const subtitleEl = document.getElementById('sources-modal-subtitle');
    const listEl = document.getElementById('sources-modal-list');
    if (!modal || !listEl) return;

    // Section 20: Dedicated source modal: AUDIO SOURCES
    if (titleEl) titleEl.textContent = 'AUDIO SOURCES';
    if (subtitleEl) subtitleEl.textContent = `${track.title || 'Track'} · ${track.artist || 'Unknown Artist'}`;

    const candidates = (track.candidates && track.candidates.length > 0) ? track.candidates : [track];

    listEl.innerHTML = candidates.map((cand, idx) => {
        const isCurrent = state.currentTrack && (state.currentTrack.id === cand.id || state.currentTrack.preview === cand.preview || state.currentTrack.sourceId === cand.sourceId);
        const candEncoded = encodeURIComponent(JSON.stringify(cand));

        const isFlac = (cand.format === 'FLAC' || cand.codec === 'FLAC');
        const isVerified = Boolean(cand.verificationStatus === 'VERIFIED' || cand.losslessVerification === 'VERIFIED' || cand.playableLosslessVerified || cand.isCached || cand.cached);

        // Section 20: Standardized format display
        let formatDisplay = '';
        if (isFlac) {
            const bit = cand.bitDepth || (cand.quality === 'HI_RES_LOSSLESS' ? 24 : 16);
            const rate = cand.sampleRate ? `${Math.round(cand.sampleRate / 1000)} kHz` : (cand.quality === 'HI_RES_LOSSLESS' ? '96 kHz' : '44.1 kHz');
            formatDisplay = `FLAC · ${bit}-bit / ${rate}`;
        } else if (cand.source === 'jiosaavn') {
            formatDisplay = 'AAC · 320 kbps';
        } else if (cand.source === 'youtube') {
            formatDisplay = 'YouTube';
        } else {
            formatDisplay = `${(cand.format || cand.codec || 'Audio').toUpperCase()}`;
        }

        let providerDisplayName = 'YouTube Audio';
        if (cand.source === 'lossless') {
            providerDisplayName = 'Lossless Vault';
        } else if (cand.source === 'jiosaavn') {
            providerDisplayName = 'JioSaavn HD Audio';
        } else if (cand.source === 'local') {
            providerDisplayName = 'Local Upload';
        } else if (cand.source === 'internet_archive' || cand.source === 'archive') {
            providerDisplayName = 'Internet Archive FLAC';
        } else if (cand.provider) {
            providerDisplayName = cand.provider;
        }

        const radioMark = isCurrent ? '●' : '○';
        const verifiedBadge = isVerified 
            ? `<span style="font-size: 10px; background: rgba(16, 185, 129, 0.2); color: #10b981; border: 1px solid rgba(16,185,129,0.4); border-radius: 4px; padding: 2px 6px; font-weight: 700; margin-left: 8px;">VERIFIED</span>`
            : '';

        return `
            <div class="track-list-item ${isCurrent ? 'playing' : ''}" style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-radius: 8px; margin-bottom: 8px; background: rgba(255,255,255,0.03); cursor: pointer;" onclick="playSpecificCandidate('${candEncoded}')">
                <div style="display: flex; align-items: center; gap: 14px;">
                    <div style="font-size: 18px; color: ${isCurrent ? '#38bdf8' : 'var(--text-tertiary)'}; width: 20px; text-align: center;">${radioMark}</div>
                    <div>
                        <div style="font-weight: 600; font-size: 14px; display: flex; align-items: center;">
                            <span>${escapeHtml(formatDisplay)}</span>
                            ${verifiedBadge}
                        </div>
                        <div style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">
                            ${escapeHtml(providerDisplayName)} · ${escapeHtml(cand.title || '')}
                            ${cand.cached ? '<span style="color: #71ffba; margin-left: 6px;">⚡ Cached Instant Start</span>' : ''}
                        </div>
                    </div>
                </div>
                <button class="button ${isCurrent ? 'button-secondary' : 'button-primary'}" style="font-size: 12px; padding: 6px 14px;" onclick="event.stopPropagation();playSpecificCandidate('${candEncoded}')">
                    ${isCurrent ? 'Active Source' : 'Select Source'}
                </button>
            </div>
        `;
    }).join('');

    modal.classList.remove('hidden');
    modal.style.display = 'grid';
}

function closeCandidateSourcesModal() {
    const modal = document.getElementById('candidate-sources-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
    }
}

function playSpecificCandidate(encodedCandidateData) {
    try {
        const candidate = JSON.parse(decodeURIComponent(encodedCandidateData));
        closeCandidateSourcesModal();
        showToast(`Switching to ${candidate.source?.toUpperCase() || 'Source'} (${candidate.quality || 'Audio'})...`, 'info');
        
        // Mode B: Explicit Candidate Playback (preserving position, queue, lyrics, recommendations)
        state.currentTrack = {
            ...state.currentTrack,
            ...candidate
        };
        updatePlayerUI(state.currentTrack);
        saveQueueState();
        if (window.playbackManager) {
            window.playbackManager.switchSource(candidate.id, candidate, { explicit: true });
        }
    } catch (e) {
        console.error('Failed to play specific candidate:', e);
    }
}

// ==========================================
// SYNCHRONIZED LYRICS ENGINE & TIMING OFFSET
// ==========================================
// Note: currentLyricsData and related globals hoisted at top of file

function setLyricsOffset(delta) {
    if (delta === 0) {
        lyricsOffsetSeconds = 0;
    } else {
        lyricsOffsetSeconds = Math.max(-10, Math.min(10, Number((lyricsOffsetSeconds + delta).toFixed(1))));
    }
    const valEl = document.getElementById('fs-lyrics-offset-val');
    if (valEl) {
        const sign = lyricsOffsetSeconds > 0 ? '+' : '';
        valEl.textContent = `${sign}${lyricsOffsetSeconds.toFixed(1)}s`;
    }
    if (window.playbackManager) {
        syncLyricsTick(window.playbackManager.getCurrentTime(), true);
    }
}

let lyricsScrollRaf = null;
let currentLyricsScrollY = 0;
let targetLyricsScrollY = 0;
let isProgrammaticLyricsScrolling = false;

function smoothScrollLyricsTo(targetY) {
    const scrollContainer = document.querySelector('.fs-lyrics-content');
    if (!scrollContainer) return;

    targetLyricsScrollY = Math.max(0, targetY);

    if (!isProgrammaticLyricsScrolling) {
        currentLyricsScrollY = scrollContainer.scrollTop;
        isProgrammaticLyricsScrolling = true;

        const animateScroll = () => {
            if (!isProgrammaticLyricsScrolling || isUserInteractingWithLyrics) {
                isProgrammaticLyricsScrolling = false;
                lyricsScrollRaf = null;
                return;
            }

            const diff = targetLyricsScrollY - currentLyricsScrollY;
            if (Math.abs(diff) < 0.6) {
                currentLyricsScrollY = targetLyricsScrollY;
                scrollContainer.scrollTop = currentLyricsScrollY;
                isProgrammaticLyricsScrolling = false;
                lyricsScrollRaf = null;
                return;
            }

            // High-refresh-rate adaptive lerp (12% per frame yields a smooth, liquid momentum curve)
            currentLyricsScrollY += diff * 0.12;
            scrollContainer.scrollTop = currentLyricsScrollY;
            lyricsScrollRaf = requestAnimationFrame(animateScroll);
        };
        lyricsScrollRaf = requestAnimationFrame(animateScroll);
    }
}

function scrollActiveLyricIntoView(activeEl, force = false) {
    if (!activeEl) return;
    if (isUserInteractingWithLyrics && !force) return;

    const container = document.getElementById('fs-lyrics-container');
    const scrollContainer = (container && container.closest('.fs-lyrics-content')) || document.querySelector('.fs-lyrics-content');
    if (!scrollContainer) return;

    const elRect = activeEl.getBoundingClientRect();
    const containerRect = scrollContainer.getBoundingClientRect();
    const currentRelativeTop = elRect.top - containerRect.top;
    const targetScrollTop = scrollContainer.scrollTop + currentRelativeTop - (scrollContainer.clientHeight / 2) + (activeEl.clientHeight / 2);

    smoothScrollLyricsTo(targetScrollTop);
}

function setupLyricsScrollInteractivity() {
    const scrollContainer = document.querySelector('.fs-lyrics-content');
    if (!scrollContainer || scrollContainer._hasScrollListener) return;
    scrollContainer._hasScrollListener = true;

    const onUserScroll = () => {
        isUserInteractingWithLyrics = true;
        isProgrammaticLyricsScrolling = false;
        if (lyricsScrollRaf) {
            cancelAnimationFrame(lyricsScrollRaf);
            lyricsScrollRaf = null;
        }
        if (userLyricsScrollTimeout) clearTimeout(userLyricsScrollTimeout);
        userLyricsScrollTimeout = setTimeout(() => {
            isUserInteractingWithLyrics = false;
            const container = document.getElementById('fs-lyrics-container');
            const activeEl = container ? container.querySelector('.fs-lyrics-line.active-lyric') : null;
            if (activeEl) {
                scrollActiveLyricIntoView(activeEl, true);
            }
        }, 2000);
    };

    scrollContainer.addEventListener('wheel', onUserScroll, { passive: true });
    scrollContainer.addEventListener('touchstart', onUserScroll, { passive: true });
    scrollContainer.addEventListener('touchmove', onUserScroll, { passive: true });
}

function syncLyricsTick(currentTime, forceScroll = false) {
    if (!currentLyricsData || !currentLyricsData.synced || !currentLyricsData.lines || currentLyricsData.lines.length === 0) {
        return;
    }

    // Apply offset only to the display lookup time, NOT to the audio
    const effectiveTime = Math.max(0, currentTime + lyricsOffsetSeconds);
    const lines = currentLyricsData.lines;

    // Binary search for the active lyric line
    let low = 0;
    let high = lines.length - 1;
    let foundIndex = -1;

    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (lines[mid].time <= effectiveTime) {
            foundIndex = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    const container = document.getElementById('fs-lyrics-container');
    if (!container) return;

    if (foundIndex !== activeLyricIndex || forceScroll) {
        activeLyricIndex = foundIndex;
        const lineEls = container.querySelectorAll('.fs-lyrics-line');
        let activeEl = null;

        lineEls.forEach((el, i) => {
            el.classList.remove('active-lyric', 'near-lyric');
            if (i === foundIndex) {
                el.classList.add('active-lyric');
                activeEl = el;
            } else if (i === foundIndex - 1 || i === foundIndex + 1) {
                el.classList.add('near-lyric');
            }
        });

        if (activeEl) {
            scrollActiveLyricIntoView(activeEl, forceScroll);
        }

        // Live lyrics snippet in Spotify Now Playing Sidecar
        const npSnippet = document.getElementById('np-lyrics-snippet');
        if (npSnippet && foundIndex >= 0 && lines[foundIndex]) {
            const currentLine = lines[foundIndex].text || '';
            const nextLine = (lines[foundIndex + 1] && lines[foundIndex + 1].text) ? lines[foundIndex + 1].text : '';
            npSnippet.innerHTML = `
                <p class="np-lyric-line active">${escapeHtml(currentLine)}</p>
                ${nextLine ? `<p class="np-lyric-line upcoming">${escapeHtml(nextLine)}</p>` : ''}
            `;
        }
    }
}

let activeLyricsAbortController = null;
let activeLyricsLoadId = 0;

async function loadLyricsForTrack(track, loadId) {
    if (!track || !track.title) return;

    if (activeLyricsAbortController) {
        try { activeLyricsAbortController.abort(); } catch (e) {}
    }
    activeLyricsAbortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
    activeLyricsLoadId = typeof loadId === 'number' ? loadId : (window.playbackManager ? window.playbackManager.currentLoadId : Date.now());
    const thisLoadId = activeLyricsLoadId;

    currentLyricsTrackId = track.id;
    activeLyricIndex = -1;
    updateFsLyricsButtonState(false, true);

    const container = document.getElementById('fs-lyrics-container');
    const syncBadge = document.getElementById('fs-lyrics-sync-badge');
    if (container) {
        container.classList.add('lyrics-fading-out');
        setTimeout(() => {
            if (activeLyricsLoadId === thisLoadId && currentLyricsTrackId === track.id) {
                container.innerHTML = '<p class="fs-lyrics-placeholder">Looking for lyrics...</p>';
                container.classList.remove('lyrics-fading-out');
            }
        }, 140);
    }

    try {
        const params = new URLSearchParams({
            title: track.title || '',
            artist: track.artist || '',
            album: track.album || '',
            duration: track.duration || 0,
            trackId: track.id || ''
        });

        const res = await fetch(`/api/music/lyrics?${params}`, {
            signal: activeLyricsAbortController ? activeLyricsAbortController.signal : undefined
        });
        if (!res.ok) throw new Error('Lyrics fetch failed');
        const data = await res.json();

        // Check if track or loadId hasn't changed during fetch (Step 2: load tokens kill stale results)
        if (thisLoadId !== activeLyricsLoadId || (state.currentTrack && state.currentTrack.id !== track.id)) return;

        if (data.success && data.lyrics && (data.lyrics.syncedLyrics || data.lyrics.plainLyrics)) {
            currentLyricsData = data.lyrics;
            updateFsLyricsButtonState(true, false);

            if (userWantsLyrics) {
                setFsPlayerMode('lyrics');
            } else {
                setFsPlayerMode('artwork');
            }

            if (data.lyrics.synced && data.lyrics.lines && data.lyrics.lines.length > 0) {
                if (syncBadge) {
                    syncBadge.innerHTML = '<span style="color:var(--accent-primary, #38bdf8); margin-right:4px;">●</span> SYNCED LYRICS';
                    syncBadge.style.cursor = 'pointer';
                    syncBadge.title = 'Click to re-center current lyric';
                    syncBadge.onclick = () => {
                        isUserInteractingWithLyrics = false;
                        if (userLyricsScrollTimeout) clearTimeout(userLyricsScrollTimeout);
                        const ct = window.playbackManager ? window.playbackManager.getCurrentTime() : 0;
                        syncLyricsTick(ct, true);
                    };
                }

                if (container) {
                    container.innerHTML = data.lyrics.lines.map((l, i) => `
                        <div class="fs-lyrics-line" data-index="${i}" data-time="${l.time}">${escapeHtml(l.text)}</div>
                    `).join('');

                    container.classList.remove('lyrics-fading-out');
                    container.classList.remove('lyrics-fading-in');
                    void container.offsetWidth;
                    container.classList.add('lyrics-fading-in');

                    container.querySelectorAll('.fs-lyrics-line').forEach(el => {
                        el.addEventListener('click', () => {
                            const t = parseFloat(el.getAttribute('data-time'));
                            if (!isNaN(t) && window.playbackManager) {
                                isUserInteractingWithLyrics = false;
                                if (userLyricsScrollTimeout) clearTimeout(userLyricsScrollTimeout);
                                window.playbackManager.seek(t);
                                syncLyricsTick(t, true);
                            }
                        });
                    });
                }
                setupLyricsScrollInteractivity();
                setTimeout(() => {
                    syncLyricsTick(window.playbackManager ? window.playbackManager.getCurrentTime() : 0, true);
                }, 80);
            } else {
                if (syncBadge) {
                    syncBadge.textContent = 'PLAIN LYRICS';
                    syncBadge.onclick = null;
                    syncBadge.style.cursor = 'default';
                }
                // Plain lyrics fallback
                const plainLines = (data.lyrics.plainLyrics || '').split(/\r?\n/).filter(Boolean);
                if (container) {
                    container.innerHTML = plainLines.map(line => `
                        <div class="fs-lyrics-line" style="cursor:default; opacity:0.8;">${escapeHtml(line)}</div>
                    `).join('');
                    container.classList.remove('lyrics-fading-out');
                    container.classList.remove('lyrics-fading-in');
                    void container.offsetWidth;
                    container.classList.add('lyrics-fading-in');
                }
            }

            // Update Spotify Now Playing Sidecar lyrics preview
            const npSnippet = document.getElementById('np-lyrics-snippet');
            if (npSnippet) {
                if (data.lyrics.synced && data.lyrics.lines && data.lyrics.lines.length > 0) {
                    const l1 = data.lyrics.lines[0]?.text || '';
                    const l2 = data.lyrics.lines[1]?.text || '';
                    npSnippet.innerHTML = `
                        <p class="np-lyric-line active">${escapeHtml(l1)}</p>
                        ${l2 ? `<p class="np-lyric-line upcoming">${escapeHtml(l2)}</p>` : ''}
                    `;
                } else if (data.lyrics.plainLyrics) {
                    const plain = (data.lyrics.plainLyrics || '').split(/\r?\n/).filter(Boolean);
                    npSnippet.innerHTML = `
                        <p class="np-lyric-line active">${escapeHtml(plain[0] || '')}</p>
                        ${plain[1] ? `<p class="np-lyric-line upcoming">${escapeHtml(plain[1])}</p>` : ''}
                    `;
                }
            }
        } else {
            currentLyricsData = null;
            updateFsLyricsButtonState(false, false);
            setFsPlayerMode('artwork'); // AUTOMATICALLY switch to Centered Apple Music Player!

            const npSnippet = document.getElementById('np-lyrics-snippet');
            if (npSnippet) {
                npSnippet.innerHTML = '<p class="np-lyric-line active" style="opacity:0.7; font-size:14px;">Lyrics not available for this track.</p>';
            }

            if (syncBadge) {
                syncBadge.textContent = 'LYRICS';
                syncBadge.onclick = null;
                syncBadge.style.cursor = 'default';
            }
            if (container) {
                container.innerHTML = '<p class="fs-lyrics-placeholder">Lyrics not available for this track.</p>';
                container.classList.remove('lyrics-fading-out');
            }
        }
    } catch (err) {
        if (thisLoadId !== activeLyricsLoadId || err.name === 'AbortError') return;
        console.warn('[Lyrics] Error:', err.message);
        currentLyricsData = null;
        updateFsLyricsButtonState(false, false);
        setFsPlayerMode('artwork');

        const npSnippet = document.getElementById('np-lyrics-snippet');
        if (npSnippet) {
            npSnippet.innerHTML = '<p class="np-lyric-line active" style="opacity:0.7; font-size:14px;">Lyrics not available for this track.</p>';
        }
    }
}

// ==========================================
// UNIFIED QUALITY-PRESERVING DOWNLOADS
// ==========================================
const activeDownloads = new Set();

async function downloadTrackFromData(encodedCandidateData) {
    let track;
    try {
        track = JSON.parse(decodeURIComponent(encodedCandidateData));
    } catch (e) {
        return showToast('Unable to parse track data', 'error');
    }

    if (!track || !track.id) return;

    if (activeDownloads.has(track.id)) {
        return showToast(`Download already in progress for "${track.title}"`, 'info');
    }

    const source = (track.source || track.provider || '').toLowerCase();
    if (source === 'youtube' || String(track.id).startsWith('yt_') || track.videoId) {
        return showToast('Downloads are unavailable for YouTube streams.', 'warning');
    }

    activeDownloads.add(track.id);
    showToast(`Preparing download: "${track.title}"...`, 'info');

    try {
        const params = new URLSearchParams({
            id: track.id,
            source: track.source || 'local',
            title: track.title || '',
            artist: track.artist || '',
            format: track.format || '',
            audioUrl: track.audioUrl || track.preview || ''
        });

        const downloadUrl = `/api/music/download?${params}`;
        
        const checkRes = await fetch(downloadUrl);
        if (!checkRes.ok && checkRes.status !== 200) {
            const errData = await checkRes.json().catch(() => ({}));
            throw new Error(errData.message || 'Download request failed');
        }

        // Trigger native download
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = '';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        showToast(`✓ Download started for "${track.title}"`, 'success');
    } catch (err) {
        console.error('[Download] Error:', err);
        showToast(`Download failed: ${err.message}`, 'error');
    } finally {
        activeDownloads.delete(track.id);
    }
}

// ==========================================
// 20. MULTI-SOURCE LIBRARY & DISCOVERY (Local, Spotify, YTMusic)
// ==========================================

function switchLibraryTab(tabName) {
    const tabs = ['liked', 'playlists', 'history', 'local', 'spotify', 'ytmusic'];
    tabs.forEach(t => {
        const btn = document.getElementById(`lib-tab-${t}`);
        const pane = document.getElementById(`lib-view-${t}`);
        if (btn) {
            if (t === tabName) {
                btn.className = 'button button-primary active';
            } else {
                btn.className = 'button button-secondary';
            }
        }
        if (pane) {
            pane.classList.toggle('hidden', t !== tabName);
        }
    });

    if (tabName === 'liked') {
        loadLibrary();
    } else if (tabName === 'playlists') {
        loadPlaylistsTab();
    } else if (tabName === 'history') {
        loadHistoryTab();
    } else if (tabName === 'local') {
        renderLocalTracks();
    } else if (tabName === 'spotify') {
        const grid = document.getElementById('spotify-results-grid');
        if (grid && (grid.querySelector('.empty-state') || !grid.children.length)) {
            loadSpotifyCurated("Today's Top Hits");
        }
    } else if (tabName === 'ytmusic') {
        const grid = document.getElementById('ytmusic-results-grid');
        if (grid && (grid.querySelector('.empty-state') || !grid.children.length)) {
            loadYTMusicCurated('Trending Music Global');
        }
        const input = document.getElementById('ytmusic-search-input');
        if (input) input.focus();
    }
}

async function loadPlaylistsTab() {
    const grid = document.getElementById('library-playlists-grid');
    if (!grid) return;
    if (!state.token) {
        grid.innerHTML = '<div class="empty-state">Sign in to create and manage custom playlists</div>';
        return;
    }
    grid.innerHTML = '<div class="loader">Loading playlists...</div>';
    try {
        const data = await api('/playlists');
        const playlists = data.playlists || [];
        if (playlists.length > 0) {
            grid.innerHTML = playlists.map(pl => `
                <div class="track-card glass-subtle" onclick="location.hash='#playlist/${pl.id}'">
                    <div class="track-card-cover" style="display:grid; place-items:center; font-size:36px; background:rgba(255,255,255,0.04);">
                        🎵
                    </div>
                    <div class="track-card-info">
                        <div class="track-card-title">${escapeHtml(pl.name)}</div>
                        <div class="track-card-artist">${pl.track_count || 0} track${(pl.track_count || 0) === 1 ? '' : 's'}</div>
                    </div>
                </div>
            `).join('');
        } else {
            grid.innerHTML = '<div class="empty-state">You have not created any playlists yet.</div>';
        }
    } catch (err) {
        grid.innerHTML = `<div class="empty-state">Failed to load playlists: ${escapeHtml(err.message)}</div>`;
    }
}

async function loadHistoryTab() {
    const container = document.getElementById('history-list');
    if (!container) return;
    if (!state.token) {
        container.innerHTML = '<div class="empty-state">Sign in to view your listening history</div>';
        return;
    }
    container.innerHTML = '<div class="loader">Loading listening history...</div>';
    try {
        const data = await api('/library/history?limit=30');
        const tracks = (data.tracks || []).filter(item => item.track_data && (item.track_data.videoId || item.track_data.id));
        if (tracks.length > 0) {
            container.innerHTML = tracks.map((item, i) =>
                renderTrackListItem(item.track_data, i, item.track_source || 'youtube', { contextType: 'history' })
            ).join('');
        } else {
            container.innerHTML = '<div class="empty-state">Your listening history is empty.</div>';
        }
    } catch (err) {
        container.innerHTML = `<div class="empty-state">Failed to load history: ${escapeHtml(err.message)}</div>`;
    }
}

// Local IndexedDB Library Handlers
async function handleLocalFilesSelected(event) {
    const files = event.target?.files;
    if (!files || files.length === 0) return;

    if (!window.localLibrary) {
        showToast('Local library not initialized', 'error');
        return;
    }

    showToast(`Importing ${files.length} audio file${files.length > 1 ? 's' : ''}...`, 'info');
    try {
        const result = await window.localLibrary.importFiles(files);
        showToast(`Successfully imported ${result.imported.length} track${result.imported.length > 1 ? 's' : ''}!`, 'success');
        renderLocalTracks();
    } catch (err) {
        showToast(`Import error: ${err.message}`, 'error');
    } finally {
        event.target.value = '';
    }
}

async function renderLocalTracks() {
    const container = document.getElementById('local-tracks-list');
    if (!container) return;

    if (!window.localLibrary) {
        container.innerHTML = '<p class="empty-state">Local library not available.</p>';
        return;
    }

    try {
        const tracks = await window.localLibrary.getAllTracks();
        if (tracks.length === 0) {
            container.innerHTML = '<p class="empty-state">No local tracks imported yet. Click "+ Import Audio Files" to import FLAC, WAV, ALAC, or MP3 files from your device.</p>';
            return;
        }

        container.innerHTML = tracks.map((track, i) => {
            const formatBadge = track.isLossless 
                ? '<span class="quality-badge badge-gold" style="font-size:10px; padding:2px 6px;">LOSSLESS • ' + escapeHtml(track.format) + '</span>'
                : '<span class="quality-badge badge-blue" style="font-size:10px; padding:2px 6px;">' + escapeHtml(track.format) + '</span>';

            const durationStr = formatDuration(track.duration || 0);
            const coverImg = track.artworkUrl
                ? `<img src="${track.artworkUrl}" style="width:40px;height:40px;border-radius:6px;object-fit:cover;" alt="Cover">`
                : `<div style="width:40px;height:40px;border-radius:6px;background:rgba(255,255,255,0.06);display:grid;place-items:center;font-size:18px;">🎵</div>`;

            return `
            <div class="track-list-item" style="display:flex; align-items:center; justify-content:space-between; padding:10px 14px; border-bottom:1px solid rgba(255,255,255,0.04); cursor:pointer;" onclick="playLocalTrack('${escapeHtml(track.id)}')">
                <div style="display:flex; align-items:center; gap:12px; flex:1; min-width:0;">
                    <span style="font-size:12px; opacity:0.5; width:20px; text-align:right;">${i + 1}</span>
                    ${coverImg}
                    <div style="min-width:0; flex:1;">
                        <div style="font-weight:600; font-size:13px; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">${escapeHtml(track.title || 'Unknown Title')}</div>
                        <div style="font-size:12px; opacity:0.7; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">${escapeHtml(track.artist || 'Unknown Artist')} • ${escapeHtml(track.album || 'Local Library')}</div>
                    </div>
                </div>
                <div style="display:flex; align-items:center; gap:10px;">
                    ${formatBadge}
                    <span style="font-size:12px; opacity:0.6; font-family:monospace;">${durationStr}</span>
                    <button class="button button-secondary" style="font-size:11px; padding:4px 8px;" onclick="event.stopPropagation(); deleteLocalTrack('${escapeHtml(track.id)}')">✕</button>
                </div>
            </div>`;
        }).join('');
    } catch (err) {
        container.innerHTML = `<p class="empty-state">Failed to load local tracks: ${escapeHtml(err.message)}</p>`;
    }
}

async function playLocalTrack(trackId) {
    if (!window.localLibrary) return;
    const track = await window.localLibrary.getTrack(trackId);
    if (!track) {
        showToast('Local track not found in storage', 'error');
        return;
    }
    const mediaUrl = window.localLibrary.getTrackMediaUrl(track);
    const standardTrack = {
        id: track.id,
        title: track.title || 'Untitled Track',
        artist: track.artist || 'Local Artist',
        album: track.album || 'Local Library',
        cover: track.artworkUrl || '',
        preview: mediaUrl,
        audioUrl: mediaUrl,
        source: 'local',
        format: track.format || 'FLAC',
        codec: track.codec || track.format || 'FLAC',
        sampleRate: track.sampleRate || 44100,
        bitDepth: track.bitDepth || null,
        duration: track.duration || 0,
        isLossless: Boolean(track.isLossless),
        quality: track.isLossless ? 'LOSSLESS' : 'HIGH'
    };
    playTrack(standardTrack);
}

async function deleteLocalTrack(trackId) {
    if (!window.localLibrary) return;
    try {
        await window.localLibrary.deleteTrack(trackId);
        showToast('Track removed from local library', 'info');
        renderLocalTracks();
    } catch (e) {
        showToast('Failed to delete track', 'error');
    }
}

async function clearLocalLibrary() {
    if (!window.localLibrary) return;
    if (confirm('Clear all local tracks from browser storage?')) {
        await window.localLibrary.clear();
        showToast('Local library cleared', 'info');
        renderLocalTracks();
    }
}

// Spotify Discovery Handlers
async function searchSpotifyTracks() {
    const input = document.getElementById('spotify-search-input');
    const q = input ? input.value.trim() : '';
    if (!q) {
        showToast('Please enter a search term for Spotify', 'warning');
        return;
    }
    const grid = document.getElementById('spotify-results-grid');
    if (!grid) return;

    grid.innerHTML = '<div class="loader">Searching Spotify catalog...</div>';
    try {
        const res = await api(`/music/providers/spotify/search?q=${encodeURIComponent(q)}&limit=24`);
        const tracks = res.data || res.tracks || [];
        if (tracks.length === 0) {
            grid.innerHTML = `<p class="empty-state">No Spotify tracks found matching "${escapeHtml(q)}".</p>`;
            return;
        }
        grid.innerHTML = tracks.map((t, idx) => renderTrackCard(t, 'spotify', idx, 'spotify')).join('');
    } catch (err) {
        grid.innerHTML = `<p class="empty-state">Spotify search error: ${escapeHtml(err.message)}</p>`;
    }
}

async function loadSpotifyCurated(themeOrQuery = "Today's Top Hits") {
    const grid = document.getElementById('spotify-results-grid');
    if (!grid) return;
    grid.innerHTML = `<div class="loader">Loading Spotify tracks for "${escapeHtml(themeOrQuery)}"...</div>`;
    try {
        const res = await api(`/music/providers/spotify/search?q=${encodeURIComponent(themeOrQuery)}&limit=18`);
        const tracks = res.data || res.tracks || [];
        if (tracks.length > 0) {
            grid.innerHTML = tracks.map((t, idx) => renderTrackCard(t, 'spotify', idx, 'spotify')).join('');
        } else {
            grid.innerHTML = '<p class="empty-state">No tracks found.</p>';
        }
    } catch (err) {
        grid.innerHTML = `<p class="empty-state">Failed to load Spotify tracks: ${escapeHtml(err.message)}</p>`;
    }
}

// YouTube Music Discovery Handlers
async function searchYTMusicTracks() {
    const input = document.getElementById('ytmusic-search-input');
    const q = input ? input.value.trim() : '';
    if (!q) {
        showToast('Please enter a search term for YouTube Music', 'warning');
        return;
    }
    const grid = document.getElementById('ytmusic-results-grid');
    if (!grid) return;

    grid.innerHTML = '<div class="loader">Searching YouTube Music...</div>';
    try {
        const res = await api(`/music/providers/ytmusic/search?q=${encodeURIComponent(q)}&limit=24`);
        const tracks = res.data || res.tracks || [];
        if (tracks.length === 0) {
            grid.innerHTML = `<p class="empty-state">No YouTube Music tracks found for "${escapeHtml(q)}".</p>`;
            return;
        }
        grid.innerHTML = tracks.map((t, idx) => renderTrackCard(t, 'ytmusic', idx, 'ytmusic')).join('');
    } catch (err) {
        grid.innerHTML = `<p class="empty-state">YouTube Music search error: ${escapeHtml(err.message)}</p>`;
    }
}

async function loadYTMusicCurated(query = 'Trending Music Global') {
    const input = document.getElementById('ytmusic-search-input');
    if (input) input.value = query;
    const grid = document.getElementById('ytmusic-results-grid');
    if (!grid) return;
    grid.innerHTML = `<div class="loader">Loading YouTube Music for "${escapeHtml(query)}"...</div>`;
    try {
        const res = await api(`/music/providers/ytmusic/search?q=${encodeURIComponent(query)}&limit=24`);
        const tracks = res.data || res.tracks || [];
        if (tracks.length === 0) {
            grid.innerHTML = `<p class="empty-state">No YouTube Music tracks found for "${escapeHtml(query)}".</p>`;
            return;
        }
        grid.innerHTML = tracks.map((t, idx) => renderTrackCard(t, 'ytmusic', idx, 'ytmusic')).join('');
    } catch (err) {
        grid.innerHTML = `<p class="empty-state">YouTube Music error: ${escapeHtml(err.message)}</p>`;
    }
}

// Window bindings for Audio Settings, Candidate Sources, Lyrics, Downloads, Library & DSP
window.openAudioSettingsModal = openAudioSettingsModal;
window.closeAudioSettingsModal = closeAudioSettingsModal;
window.savePlaybackSetting = savePlaybackSetting;
window.openCandidateSourcesModal = openCandidateSourcesModal;
window.closeCandidateSourcesModal = closeCandidateSourcesModal;
window.playSpecificCandidate = playSpecificCandidate;
window.downloadTrackFromData = downloadTrackFromData;
window.setLyricsOffset = setLyricsOffset;

// Multi-Source & Library Window Bindings
window.switchLibraryTab = switchLibraryTab;
window.handleLocalFilesSelected = handleLocalFilesSelected;
window.renderLocalTracks = renderLocalTracks;
window.clearLocalLibrary = clearLocalLibrary;
window.deleteLocalTrack = deleteLocalTrack;
window.playLocalTrack = playLocalTrack;
window.searchSpotifyTracks = searchSpotifyTracks;
window.loadSpotifyCurated = loadSpotifyCurated;
window.searchYTMusicTracks = searchYTMusicTracks;
window.loadYTMusicCurated = loadYTMusicCurated;
window.setSearchSourceFilter = setSearchSourceFilter;
window.onEqualizerSliderChange = onEqualizerSliderChange;
window.onPreampChange = onPreampChange;
window.onBalanceChange = onBalanceChange;
window.resetEqualizerCurve = resetEqualizerCurve;
window.clearUserQueue = clearUserQueue;
window.toggleAutoPlay = toggleAutoPlay;
window.playNextInQueueFromData = playNextInQueueFromData;
window.renderPlayerQualityBadge = renderPlayerQualityBadge;
window.handleQueueDragStart = handleQueueDragStart;
window.handleQueueDragOver = handleQueueDragOver;
window.handleQueueDrop = handleQueueDrop;

// ==========================================
// PWA INSTALLATION & SERVICE WORKER ENGINE
// ==========================================
let deferredInstallPrompt = null;

// Register Service Worker for PWA installation
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').then((reg) => {
            console.log('[PWA] Service Worker registered with scope:', reg.scope);
        }).catch((err) => {
            console.warn('[PWA] Service Worker registration notice:', err.message);
        });
    });
}

// Capture native install prompt
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    const btn = document.getElementById('pwa-install-btn');
    if (btn) btn.classList.add('has-prompt');
});

window.addEventListener('appinstalled', () => {
    console.log('[PWA] BASA application installed!');
    showToast('🎉 BASA App installed successfully!', 'success');
    deferredInstallPrompt = null;
    const btn = document.getElementById('pwa-install-btn');
    if (btn) btn.classList.remove('has-prompt');
    closePwaInstallModal();
});

function handlePwaInstallClick() {
    if (deferredInstallPrompt) {
        triggerNativeInstallPrompt();
    } else {
        openPwaInstallModal();
    }
}

async function triggerNativeInstallPrompt() {
    if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        const { outcome } = await deferredInstallPrompt.userChoice;
        if (outcome === 'accepted') {
            showToast('🎉 Installing BASA App...', 'success');
        }
        deferredInstallPrompt = null;
        closePwaInstallModal();
    } else {
        showToast('Tip: Use browser menu or address bar icon to install BASA', 'info');
    }
}

function openPwaInstallModal() {
    const modal = document.getElementById('pwa-install-modal');
    if (modal) modal.classList.remove('hidden');
}

function closePwaInstallModal() {
    const modal = document.getElementById('pwa-install-modal');
    if (modal) modal.classList.add('hidden');
}

window.handlePwaInstallClick = handlePwaInstallClick;
window.triggerNativeInstallPrompt = triggerNativeInstallPrompt;
window.openPwaInstallModal = openPwaInstallModal;
window.closePwaInstallModal = closePwaInstallModal;

// ============================================
// EXPLORE SCREEN SUBSYSTEM (ExploreScreen.kt)
// ============================================

async function exploreMoodStation(moodQuery) {
    showToast(`Starting ${moodQuery} Station...`, 'info');
    try {
        const data = await api(`/search?q=${encodeURIComponent(moodQuery)}`);
        const tracks = data.tracks || [];
        if (tracks.length > 0) {
            playFromList(tracks, 0, `${moodQuery} Station`);
        } else {
            showToast('No tracks found for this station', 'warning');
        }
    } catch (e) {
        showToast('Failed to load station', 'error');
    }
}

async function loadExploreTrending() {
    const grid = document.getElementById('explore-trending-grid');
    if (!grid) return;
    grid.innerHTML = '<div class="grid-skeleton">Loading trending hits...</div>';

    try {
        const data = await api('/search?q=Trending Tamil Hits 2026');
        const tracks = data.tracks || [];
        if (tracks.length > 0) {
            window.currentExploreTracks = tracks;
            grid.innerHTML = tracks.slice(0, 12).map((t, idx) => 
                renderTrackCard(t, t.source || 'youtube', idx, 'explore')
            ).join('');
        } else {
            grid.innerHTML = '<div class="empty-state">No trending tracks available right now.</div>';
        }
    } catch (err) {
        grid.innerHTML = '<div class="empty-state">Failed to load trending tracks</div>';
    }
}

window.exploreMoodStation = exploreMoodStation;
window.loadExploreTrending = loadExploreTrending;

// ============================================
// BASA REPLAY & ANALYTICS (ReplayScreen.kt)
// ============================================

function loadReplayView() {
    let historyItems = [];
    if (window.playerQueueStore && window.playerQueueStore.state && window.playerQueueStore.state.history) {
        historyItems = window.playerQueueStore.state.history.map(it => it.song || it);
    }
    
    // Supplement from localStorage
    try {
        const localRecents = JSON.parse(localStorage.getItem('basa_recent_searches') || '[]');
        if (Array.isArray(localRecents)) {
            historyItems = [...historyItems, ...localRecents.map(r => r.rawTrack || r)];
        }
    } catch (e) {}

    // Deduplicate and count occurrences
    const songCountMap = new Map();
    const artistCountMap = new Map();

    for (const item of historyItems) {
        if (!item) continue;
        const songKey = `${item.title || item.name || 'Unknown'} - ${item.artist || 'Unknown'}`;
        const artistKey = item.artist || 'Unknown Artist';

        songCountMap.set(songKey, (songCountMap.get(songKey) || 0) + 1);
        if (artistKey && artistKey !== 'Unknown Artist') {
            artistCountMap.set(artistKey, (artistCountMap.get(artistKey) || 0) + 1);
        }
    }

    const totalPlays = Math.max(historyItems.length, songCountMap.size, 1);
    const estimatedMinutes = Math.round(totalPlays * 3.4);

    const minutesEl = document.getElementById('replay-stat-minutes');
    const songsEl = document.getElementById('replay-stat-songs');
    const artistEl = document.getElementById('replay-stat-artist');
    const genreEl = document.getElementById('replay-stat-genre');

    if (minutesEl) minutesEl.textContent = String(estimatedMinutes);
    if (songsEl) songsEl.textContent = String(totalPlays);

    // Top artist
    let topArtistName = 'Anirudh Ravichander';
    let topArtistPlays = 0;
    for (const [art, count] of artistCountMap.entries()) {
        if (count > topArtistPlays) {
            topArtistPlays = count;
            topArtistName = art;
        }
    }
    if (artistEl) artistEl.textContent = topArtistName;
    if (genreEl) genreEl.textContent = 'Tamil Melody / EDM';

    // Render Top Tracks
    const topTracksList = document.getElementById('replay-top-tracks-list');
    if (topTracksList) {
        const sortedSongs = Array.from(songCountMap.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);

        if (sortedSongs.length > 0) {
            topTracksList.innerHTML = sortedSongs.map(([titleArt, count], idx) => {
                const parts = titleArt.split(' - ');
                const title = parts[0];
                const artist = parts[1] || 'Unknown';
                return `
                    <div class="track-item" style="display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-radius: 10px; margin-bottom: 6px; background: rgba(255,255,255,0.03);">
                        <div style="display: flex; align-items: center; gap: 14px;">
                            <span style="font-size: 16px; font-weight: 800; color: ${idx === 0 ? '#fbbf24' : idx === 1 ? '#94a3b8' : idx === 2 ? '#b45309' : '#64748b'}; width: 20px;">#${idx + 1}</span>
                            <div>
                                <div style="font-weight: 600; font-size: 14px; color: #fff;">${escapeHtml(title)}</div>
                                <div style="font-size: 12px; color: var(--text-secondary);">${escapeHtml(artist)}</div>
                            </div>
                        </div>
                        <span class="taste-badge" style="font-size: 11px;">${count} play${count > 1 ? 's' : ''}</span>
                    </div>
                `;
            }).join('');
        } else {
            topTracksList.innerHTML = '<div style="color: var(--text-secondary); font-size: 13px; padding: 12px 0;">Play more songs to build your personalized Replay ranking!</div>';
        }
    }

    // Render Top Artists
    const topArtistsList = document.getElementById('replay-top-artists-list');
    if (topArtistsList) {
        const sortedArtists = Array.from(artistCountMap.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4);

        if (sortedArtists.length > 0) {
            topArtistsList.innerHTML = sortedArtists.map(([art, count], idx) => {
                const pct = Math.min(100, Math.round((count / totalPlays) * 100));
                return `
                    <div style="padding: 12px 14px; border-radius: 10px; background: rgba(255,255,255,0.03);">
                        <div style="display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 13px;">
                            <strong style="color: #fff; cursor: pointer;" onclick="openArtistModal('${escapeHtml(art)}')">${escapeHtml(art)}</strong>
                            <span style="color: var(--text-secondary);">${count} stream${count > 1 ? 's' : ''}</span>
                        </div>
                        <div style="width: 100%; height: 6px; background: rgba(255,255,255,0.08); border-radius: 3px; overflow: hidden;">
                            <div style="width: ${Math.max(15, pct)}%; height: 100%; background: linear-gradient(90deg, #ec4899, #8b5cf6); border-radius: 3px;"></div>
                        </div>
                    </div>
                `;
            }).join('');
        } else {
            topArtistsList.innerHTML = '<div style="color: var(--text-secondary); font-size: 13px; padding: 12px 0;">Artists will automatically populate as you listen.</div>';
        }
    }
}

function generateReplayPoster() {
    const container = document.getElementById('replay-poster-container');
    const canvas = document.getElementById('replay-canvas');
    if (!container || !canvas) return;

    container.style.display = 'block';
    container.scrollIntoView({ behavior: 'smooth' });

    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    // Background gradient
    const bgGrad = ctx.createLinearGradient(0, 0, w, h);
    bgGrad.addColorStop(0, '#0a0d1a');
    bgGrad.addColorStop(0.5, '#1e1b4b');
    bgGrad.addColorStop(1, '#09090b');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // Glowing Neon Orbs
    ctx.save();
    const orbGrad1 = ctx.createRadialGradient(150, 180, 20, 150, 180, 250);
    orbGrad1.addColorStop(0, 'rgba(168, 85, 247, 0.4)');
    orbGrad1.addColorStop(1, 'rgba(168, 85, 247, 0)');
    ctx.fillStyle = orbGrad1;
    ctx.beginPath();
    ctx.arc(150, 180, 250, 0, Math.PI * 2);
    ctx.fill();

    const orbGrad2 = ctx.createRadialGradient(450, 650, 20, 450, 650, 280);
    orbGrad2.addColorStop(0, 'rgba(56, 189, 248, 0.35)');
    orbGrad2.addColorStop(1, 'rgba(56, 189, 248, 0)');
    ctx.fillStyle = orbGrad2;
    ctx.beginPath();
    ctx.arc(450, 650, 280, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Card border
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 4;
    ctx.strokeRect(16, 16, w - 32, h - 32);

    // Header branding
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 24px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText('BASA 2.0', 48, 70);

    ctx.fillStyle = '#c084fc';
    ctx.font = '600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText('SOUND REPLAY · 2026 CAPSULE', 48, 92);

    // Title
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 36px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText('Your Year in Music', 48, 160);

    // Listening stats card
    const minVal = document.getElementById('replay-stat-minutes')?.textContent || '1,420';
    const topArtVal = document.getElementById('replay-stat-artist')?.textContent || 'Anirudh Ravichander';

    ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.roundRect ? ctx.roundRect(48, 195, w - 96, 120, 16) : ctx.fillRect(48, 195, w - 96, 120);
    ctx.fill();

    ctx.fillStyle = '#4ade80';
    ctx.font = '800 48px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(minVal, 72, 260);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.font = '600 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText('TOTAL MINUTES STREAMED IN HI-RES', 72, 290);

    // Top Songs List
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 20px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText('🏆 Top Tracks', 48, 365);

    const trackItems = document.querySelectorAll('#replay-top-tracks-list .track-item');
    let startY = 405;
    if (trackItems.length > 0) {
        trackItems.forEach((item, idx) => {
            if (idx >= 5) return;
            const title = item.querySelector('div div:first-child')?.textContent || `Track ${idx + 1}`;
            const artist = item.querySelector('div div:last-child')?.textContent || 'Artist';

            ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
            ctx.roundRect ? ctx.roundRect(48, startY - 24, w - 96, 48, 10) : ctx.fillRect(48, startY - 24, w - 96, 48);
            ctx.fill();

            ctx.fillStyle = idx === 0 ? '#fbbf24' : '#38bdf8';
            ctx.font = '800 16px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.fillText(`#${idx + 1}`, 64, startY + 6);

            ctx.fillStyle = '#ffffff';
            ctx.font = '600 15px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.fillText(title.substring(0, 28), 105, startY + 5);

            ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
            ctx.font = '500 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.fillText(artist.substring(0, 20), 400, startY + 5);

            startY += 58;
        });
    } else {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.font = '500 15px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillText('Streaming active — generating chart...', 48, 410);
        startY = 460;
    }

    // Top Artist Badge
    ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.roundRect ? ctx.roundRect(48, startY + 20, w - 96, 90, 16) : ctx.fillRect(48, startY + 20, w - 96, 90);
    ctx.fill();

    ctx.fillStyle = '#f472b6';
    ctx.font = '700 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText('MOST FREQUENTED ARTIST', 72, startY + 52);

    ctx.fillStyle = '#ffffff';
    ctx.font = '800 24px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(topArtistVal, 72, startY + 84);

    // Footer Watermark
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.font = '500 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText('Verified Bit-Perfect Studio Playback · https://basa.app', 48, h - 45);
}

function downloadReplayPoster() {
    const canvas = document.getElementById('replay-canvas');
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = 'basa-replay-2026.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
    showToast('Downloaded BASA Replay Poster!', 'success');
}

function shareReplayPoster() {
    if (navigator.share) {
        navigator.share({
            title: 'My BASA 2.0 Replay',
            text: 'Check out my 2026 music listening replay on BASA!',
            url: window.location.href
        }).catch(() => {});
    } else {
        downloadReplayPoster();
    }
}

window.loadReplayView = loadReplayView;
window.generateReplayPoster = generateReplayPoster;
window.downloadReplayPoster = downloadReplayPoster;
window.shareReplayPoster = shareReplayPoster;

// ============================================
// EQUALIZER SCREEN SUBSYSTEM (EqualizerScreen.kt)
// ============================================

function initScreenEqualizer() {
    // Sync slider positions with window.dspEngine
    if (window.dspEngine && window.dspEngine.equalizer) {
        const bands = window.dspEngine.equalizer.bands || [];
        bands.forEach((b, idx) => {
            const slider = document.getElementById(`eq-screen-band-${idx}`);
            const readout = document.getElementById(`eq-screen-val-${idx}`);
            if (slider && b.node) {
                slider.value = b.node.gain.value;
                if (readout) readout.textContent = `${b.node.gain.value > 0 ? '+' : ''}${b.node.gain.value.toFixed(1)} dB`;
            }
        });
    }
    syncScreenEqCurve();
}

function syncScreenEqCurve() {
    const canvas = document.getElementById('eq-screen-curve-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    // Draw 0 dB center reference line
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Sample band values
    const points = [];
    const bandsCount = 10;
    for (let i = 0; i < bandsCount; i++) {
        const slider = document.getElementById(`eq-screen-band-${i}`);
        const gain = slider ? parseFloat(slider.value) : 0;
        const x = (i / (bandsCount - 1)) * (w - 60) + 30;
        // Map [-12 dB, +12 dB] to [h - 10, 10]
        const y = h / 2 - (gain / 12) * (h / 2 - 15);
        points.push({ x, y });

        const readout = document.getElementById(`eq-screen-val-${i}`);
        if (readout) readout.textContent = `${gain > 0 ? '+' : ''}${gain.toFixed(1)} dB`;
    }

    // Draw Smooth Frequency Curve
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 0; i < points.length - 1; i++) {
        const xc = (points[i].x + points[i + 1].x) / 2;
        const yc = (points[i].y + points[i + 1].y) / 2;
        ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
    }
    ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
    ctx.stroke();

    // Area Fill
    ctx.lineTo(points[points.length - 1].x, h / 2);
    ctx.lineTo(points[0].x, h / 2);
    ctx.closePath();
    ctx.fillStyle = 'rgba(56, 189, 248, 0.15)';
    ctx.fill();

    // Draw Control Points
    points.forEach(p => {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fill();
    });
}

window.initScreenEqualizer = initScreenEqualizer;
window.syncScreenEqCurve = syncScreenEqCurve;

// ============================================
// ARTIST & ALBUM MODAL SUBSYSTEM (Artist/AlbumScreen.kt)
// ============================================

async function openArtistModal(artistName, artistImg = null) {
    if (!artistName) return;
    const modal = document.getElementById('artist-modal');
    const nameEl = document.getElementById('artist-modal-name');
    const imgEl = document.getElementById('artist-modal-img');
    const tracksContainer = document.getElementById('artist-modal-tracks');
    const playRadioBtn = document.getElementById('artist-modal-play-radio-btn');

    if (!modal) return;
    modal.classList.remove('hidden');
    modal.style.display = 'grid';

    if (nameEl) nameEl.textContent = artistName;
    if (imgEl) imgEl.src = artistImg || '/logo-mark.png';
    if (tracksContainer) tracksContainer.innerHTML = '<div class="loader">Loading artist discography...</div>';

    if (playRadioBtn) {
        playRadioBtn.onclick = () => {
            closeArtistModal();
            exploreMoodStation(`${artistName} Hits`);
        };
    }

    try {
        const data = await api(`/search?q=${encodeURIComponent(artistName)}`);
        const tracks = data.tracks || [];
        if (tracks.length > 0) {
            tracksContainer.innerHTML = tracks.slice(0, 15).map((t, idx) =>
                renderTrackListItem(t, idx, t.source || 'youtube', { contextType: 'artist', contextName: artistName })
            ).join('');
        } else {
            tracksContainer.innerHTML = '<div class="empty-state">No tracks found for this artist.</div>';
        }
    } catch (e) {
        if (tracksContainer) tracksContainer.innerHTML = '<div class="empty-state">Failed to load tracks.</div>';
    }
}

function closeArtistModal() {
    const modal = document.getElementById('artist-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
    }
}

async function openAlbumModal(albumTitle, artistName = '', albumImg = null) {
    if (!albumTitle) return;
    const modal = document.getElementById('album-modal');
    const titleEl = document.getElementById('album-modal-title');
    const artistEl = document.getElementById('album-modal-artist');
    const imgEl = document.getElementById('album-modal-img');
    const tracksContainer = document.getElementById('album-modal-tracks');
    const playAllBtn = document.getElementById('album-modal-play-btn');
    const queueBtn = document.getElementById('album-modal-queue-btn');

    if (!modal) return;
    modal.classList.remove('hidden');
    modal.style.display = 'grid';

    if (titleEl) titleEl.textContent = albumTitle;
    if (artistEl) artistEl.textContent = artistName || 'Original Soundtrack';
    if (imgEl) imgEl.src = albumImg || '/logo-mark.png';
    if (tracksContainer) tracksContainer.innerHTML = '<div class="loader">Loading album tracks...</div>';

    try {
        const query = `${albumTitle} ${artistName || ''}`.trim();
        const data = await api(`/search?q=${encodeURIComponent(query)}`);
        const tracks = data.tracks || [];

        if (playAllBtn) {
            playAllBtn.onclick = () => {
                closeAlbumModal();
                if (tracks.length > 0) playFromList(tracks, 0, albumTitle);
            };
        }

        if (queueBtn) {
            queueBtn.onclick = () => {
                tracks.forEach(t => addToQueue(t));
                showToast(`Added ${tracks.length} tracks to Queue`, 'success');
            };
        }

        if (tracks.length > 0) {
            tracksContainer.innerHTML = tracks.map((t, idx) =>
                renderTrackListItem(t, idx, t.source || 'youtube', { contextType: 'album', contextName: albumTitle })
            ).join('');
        } else {
            tracksContainer.innerHTML = '<div class="empty-state">No album songs found.</div>';
        }
    } catch (e) {
        if (tracksContainer) tracksContainer.innerHTML = '<div class="empty-state">Failed to load album songs.</div>';
    }
}

function closeAlbumModal() {
    const modal = document.getElementById('album-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
    }
}

window.openArtistModal = openArtistModal;
window.closeArtistModal = closeArtistModal;
window.openAlbumModal = openAlbumModal;
window.closeAlbumModal = closeAlbumModal;
