const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Helper: get first row from sql.js result
function getOne(db, sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    let row = null;
    if (stmt.step()) {
        const cols = stmt.getColumnNames();
        const vals = stmt.get();
        row = {};
        cols.forEach((col, i) => row[col] = vals[i]);
    }
    stmt.free();
    return row;
}

// Helper: get all rows from sql.js result
function getAll(db, sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
        const cols = stmt.getColumnNames();
        const vals = stmt.get();
        const row = {};
        cols.forEach((col, i) => row[col] = vals[i]);
        rows.push(row);
    }
    stmt.free();
    return rows;
}

// Helper: run a statement (INSERT/UPDATE/DELETE)
function runSql(db, sql, params = []) {
    db.run(sql, params);
}

// POST /api/auth/signup
router.post('/signup', (req, res) => {
    const db = req.app.locals.db;
    const saveDb = req.app.locals.saveDb;
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
        return res.status(400).json({ error: 'Username, email, and password are required' });
    }
    if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = getOne(db, 'SELECT id FROM users WHERE email = ? OR username = ?', [email, username]);
    if (existing) {
        return res.status(409).json({ error: 'Email or username already taken' });
    }

    const id = uuidv4();
    const password_hash = bcrypt.hashSync(password, 10);

    runSql(db, 'INSERT INTO users (id, username, email, password_hash) VALUES (?, ?, ?, ?)',
        [id, username, email, password_hash]);
    saveDb();

    const token = jwt.sign({ id, username, email }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ token, user: { id, username, email, avatar_url: null } });
});

// POST /api/auth/login
router.post('/login', (req, res) => {
    const db = req.app.locals.db;
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = getOne(db, 'SELECT * FROM users WHERE email = ?', [email]);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
        { id: user.id, username: user.username, email: user.email },
        process.env.JWT_SECRET,
        { expiresIn: '30d' }
    );
    res.json({ token, user: { id: user.id, username: user.username, email: user.email, avatar_url: user.avatar_url } });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
    const db = req.app.locals.db;
    const user = getOne(db, 'SELECT id, username, email, avatar_url, created_at FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
});

module.exports = router;
