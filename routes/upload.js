const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { requireAuth } = require('../middleware/auth');

// Classification function
function classifyAudioQuality(metadata) {
    if (!metadata || !metadata.format) return 'UNKNOWN';

    const { format, lossless, sampleRate, bitDepth, bitrate } = metadata;
    
    if (lossless === true) {
        if ((sampleRate && sampleRate > 48000) || (bitDepth && bitDepth >= 24)) {
            return 'HI_RES_LOSSLESS';
        }
        return 'LOSSLESS';
    }

    if (bitrate && bitrate >= 256000) {
        return 'HIGH';
    }

    if (format) {
        return 'STANDARD';
    }

    return 'UNKNOWN';
}


const router = express.Router();

function getOne(db, sql, params = []) {
    const stmt = db.prepare(sql); stmt.bind(params);
    let row = null;
    if (stmt.step()) { const c = stmt.getColumnNames(), v = stmt.get(); row = {}; c.forEach((col, i) => row[col] = v[i]); }
    stmt.free(); return row;
}
function getAll(db, sql, params = []) {
    const stmt = db.prepare(sql); stmt.bind(params); const rows = [];
    while (stmt.step()) { const c = stmt.getColumnNames(), v = stmt.get(), row = {}; c.forEach((col, i) => row[col] = v[i]); rows.push(row); }
    stmt.free(); return rows;
}
function runSql(db, sql, params = []) { db.run(sql, params); }

// Configure multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, '..', 'uploads');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, `${uuidv4()}${path.extname(file.originalname)}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 100 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['.mp3', '.m4a', '.wav', '.ogg', '.flac'];
        if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
        else cb(new Error('Only audio files are allowed'));
    }
});

router.use(requireAuth);

// POST /api/upload
router.post('/', upload.single('audio'), async (req, res) => {
    const db = req.app.locals.db;
    if (!req.file) return res.status(400).json({ error: 'No audio file provided' });

    const { title, artist, album } = req.body;
    const id = uuidv4();
    const trackTitle = title || path.basename(req.file.originalname, path.extname(req.file.originalname));

    let audioFormat = 'UNKNOWN';
    let audioCodec = null;
    let audioQuality = 'UNKNOWN';
    let audioLossless = 0;
    let audioSampleRate = null;
    let audioBitDepth = null;
    let audioBitrate = null;
    let audioChannels = null;
    let audioDuration = 0;
    let coverFilename = null;

    const filePath = path.join(__dirname, '..', 'uploads', req.file.filename);
    const coversDir = path.join(__dirname, '..', 'uploads', 'covers');
    if (!fs.existsSync(coversDir)) {
        fs.mkdirSync(coversDir, { recursive: true });
    }

    try {
        const mm = await import('music-metadata');
        const metadata = await mm.parseFile(filePath, { duration: true });
        
        audioFormat = metadata.format.container || metadata.format.formatId || path.extname(req.file.originalname).replace('.', '').toUpperCase();
        audioCodec = metadata.format.codec || null;
        audioLossless = metadata.format.lossless ? 1 : 0;
        audioSampleRate = metadata.format.sampleRate || null;
        audioBitDepth = metadata.format.bitsPerSample || null;
        audioBitrate = metadata.format.bitrate || null;
        audioChannels = metadata.format.numberOfChannels || null;
        audioDuration = metadata.format.duration ? Math.floor(metadata.format.duration) : 0;

        audioQuality = classifyAudioQuality({
            format: audioFormat,
            lossless: metadata.format.lossless,
            sampleRate: audioSampleRate,
            bitDepth: audioBitDepth,
            bitrate: audioBitrate
        });

        if (metadata.common.picture && metadata.common.picture.length > 0) {
            const picture = metadata.common.picture[0];
            let ext = '.jpg';
            if (picture.format === 'image/png') ext = '.png';
            else if (picture.format === 'image/webp') ext = '.webp';
            else if (picture.format === 'image/gif') ext = '.gif';
            
            coverFilename = `${id}${ext}`;
            const coverPath = path.join(coversDir, coverFilename);
            fs.writeFileSync(coverPath, picture.data);
        }

    } catch (err) {
        console.error('Metadata extraction error:', err);
    }

    runSql(db, `INSERT INTO uploaded_tracks 
        (id, user_id, title, artist, album, duration, file_path, cover_url, format, codec, quality, lossless, sampleRate, bitDepth, bitrate, channels) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, req.user.id, trackTitle, artist || 'Unknown Artist', album || 'Unknown Album', audioDuration, req.file.filename, coverFilename,
         audioFormat, audioCodec, audioQuality, audioLossless, audioSampleRate, audioBitDepth, audioBitrate, audioChannels]);
    req.app.locals.saveDb();

    const track = getOne(db, 'SELECT * FROM uploaded_tracks WHERE id = ?', [id]);
    res.status(201).json({ track });
});

// GET /api/upload/tracks
router.get('/tracks', (req, res) => {
    const db = req.app.locals.db;
    const tracks = getAll(db, 'SELECT * FROM uploaded_tracks WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
    res.json({ tracks });
});

// GET /api/upload/stream/:id
router.get('/stream/:id', (req, res) => {
    const db = req.app.locals.db;
    const track = getOne(db, 'SELECT * FROM uploaded_tracks WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!track) return res.status(404).json({ error: 'Track not found' });

    const filePath = path.join(__dirname, '..', 'uploads', track.file_path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

    const stat = fs.statSync(filePath);
    const range = req.headers.range;

    // Resolve MIME Type
    let mimeType = 'audio/mpeg'; // fallback
    const formatStr = (track.format || '').toLowerCase();
    const ext = path.extname(track.file_path).toLowerCase();
    
    if (formatStr === 'flac' || ext === '.flac') mimeType = 'audio/flac';
    else if (formatStr === 'wav' || ext === '.wav') mimeType = 'audio/wav';
    else if (formatStr === 'ogg' || ext === '.ogg') mimeType = 'audio/ogg';
    else if (formatStr === 'm4a' || ext === '.m4a') mimeType = 'audio/mp4';
    else if (formatStr === 'aac' || ext === '.aac') mimeType = 'audio/aac';
    else if (formatStr === 'mp3' || ext === '.mp3') mimeType = 'audio/mpeg';

    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
            'Content-Type': mimeType,
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
        res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': mimeType });
        fs.createReadStream(filePath).pipe(res);
    }
});

// DELETE /api/upload/:id
router.delete('/:id', (req, res) => {
    const db = req.app.locals.db;
    const track = getOne(db, 'SELECT * FROM uploaded_tracks WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!track) return res.status(404).json({ error: 'Track not found' });

    const filePath = path.join(__dirname, '..', 'uploads', track.file_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    runSql(db, 'DELETE FROM uploaded_tracks WHERE id = ?', [req.params.id]);
    req.app.locals.saveDb();
    res.json({ message: 'Track deleted' });
});

// Multer error handler
router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large. Max 20MB.' });
        return res.status(400).json({ error: err.message });
    }
    if (err) return res.status(400).json({ error: err.message });
    next();
});

// GET /api/upload/cover/:id
router.get('/cover/:id', (req, res) => {
    const db = req.app.locals.db;
    const track = getOne(db, 'SELECT * FROM uploaded_tracks WHERE id = ?', [req.params.id]);
    
    if (!track || !track.cover_url) {
        return res.status(404).json({ error: 'Cover not found' });
    }

    const coverPath = path.join(__dirname, '..', 'uploads', 'covers', path.basename(track.cover_url));
    if (!fs.existsSync(coverPath)) {
        return res.status(404).json({ error: 'Cover file not found' });
    }

    const ext = path.extname(coverPath).toLowerCase();
    let mimeType = 'image/jpeg';
    if (ext === '.png') mimeType = 'image/png';
    else if (ext === '.webp') mimeType = 'image/webp';
    else if (ext === '.gif') mimeType = 'image/gif';

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 1 day
    fs.createReadStream(coverPath).pipe(res);
});

module.exports = router;
