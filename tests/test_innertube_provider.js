const assert = require('assert');
const innertubeProvider = require('../services/innertubeProvider');

async function runTests() {
    console.log('--- Testing BASA 2.0 InnerTube Provider ---');

    // Test 1: Duration parser
    assert.strictEqual(innertubeProvider._parseDuration('3:45'), 225, '3:45 should be 225s');
    assert.strictEqual(innertubeProvider._parseDuration('1:02:15'), 3735, '1:02:15 should be 3735s');
    assert.strictEqual(innertubeProvider._parseDuration('0:45'), 45, '0:45 should be 45s');
    console.log('✓ Duration parsing passed');

    // Test 2: Text extractor
    assert.strictEqual(innertubeProvider._getText({ simpleText: 'Hello' }), 'Hello');
    assert.strictEqual(innertubeProvider._getText({ runs: [{ text: 'Hello ' }, { text: 'World' }] }), 'Hello World');
    console.log('✓ Text extraction passed');

    // Test 3: Parse Row item
    const mockRow = {
        playlistItemData: { videoId: 'abc123xyz' },
        flexColumns: [
            {
                musicResponsiveListItemFlexColumnRenderer: {
                    text: { runs: [{ text: 'Nee Kidaithai' }] }
                }
            },
            {
                musicResponsiveListItemFlexColumnRenderer: {
                    text: {
                        runs: [
                            { text: 'Anirudh Ravichander' },
                            { text: ' • ' },
                            { text: 'Vidaamuyarchi', navigationEndpoint: { browseEndpoint: {} } },
                            { text: ' • ' },
                            { text: '3:30' }
                        ]
                    }
                }
            }
        ],
        thumbnail: {
            musicThumbnailRenderer: {
                thumbnail: {
                    thumbnails: [
                        { url: 'https://i.ytimg.com/vi/abc123xyz/default.jpg' },
                        { url: 'https://i.ytimg.com/vi/abc123xyz/hqdefault.jpg' }
                    ]
                }
            }
        }
    };

    const parsedTrack = innertubeProvider._parseRowItem(mockRow);
    assert.ok(parsedTrack, 'Track must be parsed');
    assert.strictEqual(parsedTrack.id, 'abc123xyz');
    assert.strictEqual(parsedTrack.title, 'Nee Kidaithai');
    assert.strictEqual(parsedTrack.artist, 'Anirudh Ravichander');
    assert.strictEqual(parsedTrack.album, 'Vidaamuyarchi');
    assert.strictEqual(parsedTrack.duration, 210);
    assert.strictEqual(parsedTrack.source, 'youtube');
    assert.strictEqual(parsedTrack.playable, true);
    console.log('✓ Mock InnerTube row parsing passed');

    // Test 4: Parse Search Results structure
    const mockSearchResults = {
        contents: {
            tabbedSearchResultsRenderer: {
                tabs: [
                    {
                        tabRenderer: {
                            content: {
                                sectionListRenderer: {
                                    contents: [
                                        {
                                            musicShelfRenderer: {
                                                contents: [
                                                    { musicResponsiveListItemRenderer: mockRow }
                                                ]
                                            }
                                        }
                                    ]
                                }
                            }
                        }
                    }
                ]
            }
        }
    };

    const tracks = innertubeProvider._parseSearchResults(mockSearchResults, 10);
    assert.strictEqual(tracks.length, 1);
    assert.strictEqual(tracks[0].title, 'Nee Kidaithai');
    console.log('✓ Search results mapper passed');

    console.log('\nAll InnerTube Provider tests passed!');
}

runTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});

