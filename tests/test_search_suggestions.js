/**
 * Test Suite: Spotify Search Suggestions & Recent Searches Dropdown
 */
const assert = require('assert');

// Lightweight Browser Global Shims for Production script.js in Node
const mockStorage = new Map();
global.localStorage = {
    getItem: (key) => (mockStorage.has(key) ? mockStorage.get(key) : null),
    setItem: (key, val) => mockStorage.set(key, String(val)),
    removeItem: (key) => mockStorage.delete(key),
    clear: () => mockStorage.clear()
};
global.window = global;
global.window.addEventListener = () => {};
global.document = {
    activeElement: { tagName: 'BODY', isContentEditable: false },
    getElementById: (id) => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {}
};
global.navigator = { platform: 'Win32', userAgent: 'Windows' };
global.location = { hash: '' };
global.Audio = class {};

// Import production implementations directly from public/script.js
const {
    getRecentSearches,
    saveRecentSearch,
    removeRecentSearch,
    clearAllRecentSearches,
    formatSuggestions
} = require('../public/script.js');

console.log('======================================================');
console.log('   SPOTIFY SEARCH SUGGESTIONS & RECENTS TEST SUITE    ');
console.log('======================================================\n');

let passCount = 0;
function test(name, fn) {
    try {
        fn();
        console.log(`  ✓ PASS: ${name}`);
        passCount++;
    } catch (e) {
        console.error(`  ✕ FAIL: ${name}`);
        console.error(e);
        process.exit(1);
    }
}

// 1. Storage & Persistence
test('Recent searches persist and retrieve from localStorage', () => {
    clearAllRecentSearches();
    saveRecentSearch({ id: 'song_1', title: 'Around Me', artist: 'Metro Boomin', type: 'song' });
    const recents = getRecentSearches();
    assert.strictEqual(recents.length, 1);
    assert.strictEqual(recents[0].title, 'Around Me');
});

test('Recent searches unshift to top and deduplicate by id or title', () => {
    saveRecentSearch({ id: 'song_2', title: 'Low Life', artist: 'Future', type: 'song' });
    saveRecentSearch({ id: 'song_1', title: 'Around Me', artist: 'Metro Boomin', type: 'song' });
    const recents = getRecentSearches();
    assert.strictEqual(recents.length, 2);
    assert.strictEqual(recents[0].title, 'Around Me'); // most recent at index 0
    assert.strictEqual(recents[1].title, 'Low Life');
});

test('Recent searches are capped at max 12 items', () => {
    for (let i = 0; i < 20; i++) {
        saveRecentSearch({ id: 'song_' + i, title: 'Track ' + i, artist: 'Artist ' + i, type: 'song' });
    }
    const recents = getRecentSearches();
    assert.strictEqual(recents.length, 12);
});

test('removeRecentSearch removes target item by id', () => {
    const initial = getRecentSearches();
    const targetId = initial[0].id;
    removeRecentSearch(targetId);
    const updated = getRecentSearches();
    assert.strictEqual(updated.length, initial.length - 1);
    assert.ok(!updated.some(x => x.id === targetId));
});

test('clearAllRecentSearches empties the entire list', () => {
    clearAllRecentSearches();
    const updated = getRecentSearches();
    assert.strictEqual(updated.length, 0);
});

// 2. Suggestion Classification & Spotify Types
test('formatSuggestions generates Artist card when query matches artist', () => {
    const tracks = [
        { id: '1', title: 'Creepin', artist: 'Metro Boomin', thumbnail: 'thumb.jpg', explicit: true, album: 'HEROES & VILLAINS' },
        { id: '2', title: 'Superhero', artist: 'Metro Boomin', thumbnail: 'thumb2.jpg', explicit: true, album: 'HEROES & VILLAINS' }
    ];
    const suggestions = formatSuggestions(tracks, 'metro boomin');
    assert.strictEqual(suggestions[0].type, 'artist');
    assert.strictEqual(suggestions[0].title, 'Metro Boomin');
    assert.strictEqual(suggestions[0].verified, true);
});

test('formatSuggestions generates Album card alongside Songs', () => {
    const tracks = [
        { id: '1', title: 'Around Me', artist: 'Metro Boomin', thumbnail: 'thumb.jpg', explicit: true, album: 'HEROES & VILLAINS' }
    ];
    const suggestions = formatSuggestions(tracks, 'around me');
    const albumItem = suggestions.find(s => s.type === 'album');
    assert.ok(albumItem, 'Expected album item to be extracted');
    assert.strictEqual(albumItem.title, 'HEROES & VILLAINS');
});

test('formatSuggestions preserves explicit and video flags on songs', () => {
    const tracks = [
        { id: '1', title: 'Low Life', artist: 'Future', thumbnail: 'thumb.jpg', explicit: true, isVideo: true }
    ];
    const suggestions = formatSuggestions(tracks, 'low life');
    const song = suggestions.find(s => s.type === 'song');
    assert.strictEqual(song.explicit, true);
    assert.strictEqual(song.isVideo, true);
});

console.log('\n------------------------------------------------------');
console.log(`Tests Completed: ${passCount}`);
console.log('Passed: ' + passCount);
console.log('ALL SPOTIFY SEARCH SUGGESTIONS TESTS PASSED! ✨');
console.log('------------------------------------------------------');

