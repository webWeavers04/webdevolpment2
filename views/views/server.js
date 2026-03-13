import express from 'express';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import { Sequelize, DataTypes } from 'sequelize';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== Middleware =====
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(session({
    secret: 'Secret333',
    name: 'sessionId',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        maxAge: 1000 * 60 * 60,
        httpOnly: true,
        sameSite: 'lax'  // ✅ إضافة هذا
    }
}));

// ===== Database (SQLite) =====
const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: './ALULA.db',
    logging: false
});

const db = new sqlite3.Database('./ALULA.db');

// ===== User Model =====
const User = sequelize.define('User', {
    firstName: { type: DataTypes.STRING, allowNull: false },
    lastName: { type: DataTypes.STRING, allowNull: false },
    email: { type: DataTypes.STRING, allowNull: false, unique: true },
    password: { type: DataTypes.STRING, allowNull: false }
});

// Sync DB (Sequelize models)
await sequelize.sync();

// Create tables if not exists (sqlite)
db.serialize(() => {
    // Concert bookings table
    db.run(`
        CREATE TABLE IF NOT EXISTS concert_bookings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_name TEXT,
            seats TEXT,
            full_name TEXT,
            email TEXT,
            phone TEXT,
            total INTEGER,
            booking_date DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // User favorites/likes table
    db.run(`
        CREATE TABLE IF NOT EXISTS user_favorites (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_email TEXT NOT NULL,
            event_name TEXT NOT NULL,
            event_date TEXT,
            event_location TEXT,
            liked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_email, event_name)
        )
    `);

    // User bookings table
    db.run(`
        CREATE TABLE IF NOT EXISTS user_bookings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_email TEXT NOT NULL,
            activity_name TEXT NOT NULL,
            booking_date TEXT NOT NULL,
            num_people INTEGER NOT NULL,
            booking_status TEXT DEFAULT 'Pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // ✅ NEW: Contact messages table
    db.run(`
        CREATE TABLE IF NOT EXISTS contact_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT NOT NULL,
            phone TEXT,
            message TEXT NOT NULL,
            status TEXT DEFAULT 'New',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // ✅ NEW: Hegra feedback table
    db.run(`
        CREATE TABLE IF NOT EXISTS hegra_feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            username TEXT NOT NULL,
            comment TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id)
        )
    `);
});

// ===== Global Middleware =====
app.use((req, res, next) => {
    res.locals.username = req.session.user?.username || null;
    res.locals.loggedIn = req.session.user?.loggedin || false;
    next();
});

// ===== Middleware: Check Login =====
function checkLogin(req, res, next) {
    if (req.session.user && req.session.user.loggedin) next();
    else {
        // If AJAX request, return json; otherwise redirect to login
        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }
        res.redirect('/login');
    }
}

// ===== Routes =====

// Login Page
app.get('/login', (req, res) => res.render('login', { data: {}, err_msg: null }));

// Login POST
app.post('/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password)
        return res.render('login', { data: req.body, err_msg: "Please enter email & password" });

    const user = await User.findOne({ where: { email } });

    if (!user || user.password !== password)
        return res.render('login', { data: req.body, err_msg: "Invalid email or password" });

    req.session.user = {
        loggedin: true,
        username: user.firstName,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName
    };
    
    res.redirect('/login-success');
});

// Login Success Page
app.get('/login-success', (req, res) => {
    const user = req.session.user;
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Redirecting...</title>
        </head>
        <body>
            <script>
                // minimal localStorage token for front-end checks (optional)
                localStorage.setItem('userToken', 'logged-in-${Date.now()}');
                localStorage.setItem('userData', JSON.stringify({
                    username: '${user ? user.username : 'User'}',
                    email: '${user ? user.email : ''}'
                }));
                
                const returnUrl = localStorage.getItem('returnUrl');
                localStorage.removeItem('returnUrl');
                
                if (returnUrl) {
                    window.location.href = returnUrl;
                } else {
                    window.location.href = '/';
                }
            </script>
        </body>
        </html>
    `);
});

// Signup Page
app.get('/signup', (req, res) => res.render('signup', { data: {}, err_msg: null }));

// Signup POST
app.post('/signup', async (req, res) => {
    const { firstName, lastName, email, password } = req.body;

    if (!firstName || !lastName || !email || !password)
        return res.render('signup', { data: req.body, err_msg: "All fields are required" });

    try {
        await User.create({ firstName, lastName, email, password });
        res.redirect('/login');
    } catch (err) {
        res.render('signup', {
            data: req.body,
            err_msg: err.message.includes("UNIQUE") ? "Email already exists" : err.message
        });
    }
});

// ===== FAVORITES/LIKES API =====

// Toggle like (add/remove favorite)
app.post('/api/toggle-like', checkLogin, (req, res) => {
    const { eventName, eventDate, eventLocation, eventId } = req.body;
    const userEmail = req.session.user.email;

    if (!eventName && !eventId) {
        return res.json({ success: false, message: 'Missing event identifier' });
    }

    const effectiveName = eventName || eventId;

    db.get(
        "SELECT * FROM user_favorites WHERE user_email = ? AND event_name = ?",
        [userEmail, effectiveName],
        (err, row) => {
            if (err) {
                console.error('DB error toggle-like:', err);
                return res.json({ success: false, message: 'Database error' });
            }

            if (row) {
                // Unlike - remove from favorites
                db.run(
                    "DELETE FROM user_favorites WHERE user_email = ? AND event_name = ?",
                    [userEmail, effectiveName],
                    function(err) {
                        if (err) {
                            console.error('DB error removing favorite:', err);
                            return res.json({ success: false, message: 'Error removing favorite' });
                        }
                        return res.json({ success: true, liked: false, message: 'Removed from favorites' });
                    }
                );
            } else {
                // Like - add to favorites
                db.run(
                    "INSERT INTO user_favorites (user_email, event_name, event_date, event_location) VALUES (?, ?, ?, ?)",
                    [userEmail, effectiveName, eventDate || null, eventLocation || null],
                    function(err) {
                        if (err) {
                            console.error('DB error adding favorite:', err);
                            return res.json({ success: false, message: 'Error adding favorite' });
                        }
                        return res.json({ success: true, liked: true, message: 'Added to favorites' });
                    }
                );
            }
        }
    );
});

// Get user's liked events
app.get('/api/my-likes', checkLogin, (req, res) => {
    const userEmail = req.session.user.email;

    db.all(
        "SELECT id, event_name, event_date, event_location, liked_at FROM user_favorites WHERE user_email = ? ORDER BY liked_at DESC",
        [userEmail],
        (err, rows) => {
            if (err) {
                console.error('DB error my-likes:', err);
                return res.json({ success: false, favorites: [] });
            }
            const favorites = rows.map(r => ({
                id: r.id,
                event_name: r.event_name,
                event_date: r.event_date,
                event_location: r.event_location,
                liked_at: r.liked_at
            }));
            res.json({ success: true, favorites });
        }
    );
});

// Delete favorite by ID
app.delete('/api/unlike/:id', checkLogin, (req, res) => {
    const favoriteId = req.params.id;
    const userEmail = req.session.user.email;

    db.run(
        "DELETE FROM user_favorites WHERE id = ? AND user_email = ?",
        [favoriteId, userEmail],
        function(err) {
            if (err) {
                console.error('DB error deleting favorite:', err);
                return res.json({ success: false, message: 'Error deleting favorite' });
            }
            
            if (this.changes === 0) {
                return res.json({ success: false, message: 'Favorite not found or unauthorized' });
            }
            
            res.json({ success: true, message: 'Favorite removed successfully' });
        }
    );
});

// ===== BOOKING API =====

// Save booking
app.post('/api/save-booking', checkLogin, (req, res) => {
    const { activityName, bookingDate, numPeople } = req.body;
    const userEmail = req.session.user.email;

    db.run(
        "INSERT INTO user_bookings (user_email, activity_name, booking_date, num_people) VALUES (?, ?, ?, ?)",
        [userEmail, activityName, bookingDate, numPeople],
        function(err) {
            if (err) {
                console.error('DB error save-booking:', err);
                return res.json({ success: false, message: 'Booking failed' });
            }
            res.json({ success: true, bookingId: this.lastID, message: 'Booking saved successfully' });
        }
    );
});

// Get user's bookings
app.get('/api/my-bookings', checkLogin, (req, res) => {
    const userEmail = req.session.user.email;

    db.all(
        "SELECT * FROM user_bookings WHERE user_email = ? ORDER BY created_at DESC",
        [userEmail],
        (err, rows) => {
            if (err) {
                console.error('DB error my-bookings:', err);
                return res.json({ success: false, bookings: [] });
            }
            res.json({ success: true, bookings: rows });
        }
    );
});

// Cancel booking by ID
app.delete('/api/cancel-booking/:id', checkLogin, (req, res) => {
    const bookingId = req.params.id;
    const userEmail = req.session.user.email;

    db.run(
        "DELETE FROM user_bookings WHERE id = ? AND user_email = ?",
        [bookingId, userEmail],
        function(err) {
            if (err) {
                console.error('DB error canceling booking:', err);
                return res.json({ success: false, message: 'Error canceling booking' });
            }
            
            if (this.changes === 0) {
                return res.json({ success: false, message: 'Booking not found or unauthorized' });
            }
            
            res.json({ success: true, message: 'Booking canceled successfully' });
        }
    );
});

// ===== ✅ HEGRA FEEDBACK API (NEW) =====

// Get current user info (for client-side checks)
app.get('/api/current-user', (req, res) => {
    if (req.session.user && req.session.user.loggedin) {
        res.json({
            id: req.session.user.email, // Using email as unique ID
            username: req.session.user.username,
            email: req.session.user.email
        });
    } else {
        res.status(401).json({ error: 'Not authenticated' });
    }
});

// Get all Hegra feedback
app.get('/api/feedback', (req, res) => {
    db.all(
        "SELECT id, user_id, username, comment, created_at FROM hegra_feedback ORDER BY created_at DESC",
        [],
        (err, rows) => {
            if (err) {
                console.error('DB error getting feedback:', err);
                return res.status(500).json([]);
            }
            res.json(rows);
        }
    );
});

// Submit Hegra feedback
app.post('/api/feedback', (req, res) => {
    // Check if user is logged in
    if (!req.session.user || !req.session.user.loggedin) {
        return res.status(401).json({ 
            success: false, 
            message: 'Please login to submit feedback' 
        });
    }

    const { comment } = req.body;
    const userEmail = req.session.user.email;
    const username = req.session.user.username || req.session.user.firstName;

    console.log('📝 Feedback submission attempt:', { userEmail, username, comment: comment?.substring(0, 50) });

    if (!comment || comment.trim().length === 0) {
        return res.status(400).json({ 
            success: false, 
            message: 'Comment is required' 
        });
    }

    // Check if user already submitted feedback
    db.get(
        "SELECT id FROM hegra_feedback WHERE user_id = ?",
        [userEmail],
        (err, row) => {
            if (err) {
                console.error('❌ DB error checking duplicate feedback:', err);
                return res.status(500).json({ 
                    success: false, 
                    message: 'Database error: ' + err.message 
                });
            }

            if (row) {
                console.log('⚠️ Duplicate feedback attempt from:', userEmail);
                return res.status(409).json({ 
                    success: false, 
                    message: 'You have already submitted feedback. Thank you!' 
                });
            }

            // Insert new feedback
            db.run(
                "INSERT INTO hegra_feedback (user_id, username, comment) VALUES (?, ?, ?)",
                [userEmail, username, comment.trim()],
                function(err) {
                    if (err) {
                        console.error('❌ DB error inserting feedback:', err);
                        return res.status(500).json({ 
                            success: false, 
                            message: 'Failed to submit feedback: ' + err.message 
                        });
                    }

                    console.log(`✅ New Hegra feedback from: ${username} (${userEmail})`);

                    res.json({ 
                        success: true, 
                        message: 'Thank you for your feedback!',
                        feedbackId: this.lastID 
                    });
                }
            );
        }
    );
});

// Delete feedback (Admin or user's own - optional)
app.delete('/api/feedback/:id', checkLogin, (req, res) => {
    const feedbackId = req.params.id;
    const userEmail = req.session.user.email;

    // Allow users to delete their own feedback only
    db.run(
        "DELETE FROM hegra_feedback WHERE id = ? AND user_id = ?",
        [feedbackId, userEmail],
        function(err) {
            if (err) {
                console.error('DB error deleting feedback:', err);
                return res.json({ success: false, message: 'Error deleting feedback' });
            }

            if (this.changes === 0) {
                return res.json({ success: false, message: 'Feedback not found or unauthorized' });
            }

            res.json({ success: true, message: 'Feedback deleted successfully' });
        }
    );
});

// ===== ✅ CONTACT FORM API (NEW) =====

// Submit contact form
app.post('/api/contact', (req, res) => {
    const { name, email, phone, message } = req.body;

    if (!name || !email || !message) {
        return res.json({ 
            success: false, 
            message: 'Please fill all required fields' 
        });
    }

    // التحقق من صحة البريد الإلكتروني
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.json({ 
            success: false, 
            message: 'Please enter a valid email address' 
        });
    }

    db.run(
        `INSERT INTO contact_messages (name, email, phone, message) 
         VALUES (?, ?, ?, ?)`,
        [name, email, phone || null, message],
        function(err) {
            if (err) {
                console.error('❌ DB error contact form:', err);
                return res.json({ 
                    success: false, 
                    message: 'Failed to send message. Please try again.' 
                });
            }
            
            console.log(`✉️  New contact message from: ${name} (${email})`);
            console.log(`📝 Message preview: ${message.substring(0, 50)}...`);
            
            res.json({ 
                success: true, 
                message: 'Message sent successfully! We will contact you soon.',
                messageId: this.lastID 
            });
        }
    );
});

// Get all contact messages (Admin only - optional)
app.get('/api/contact-messages', checkLogin, (req, res) => {
    // يمكنك إضافة فحص للأدمن هنا
    // if (req.session.user.email !== 'admin@alula.com') {
    //     return res.status(403).json({ success: false, message: 'Unauthorized' });
    // }

    db.all(
        "SELECT * FROM contact_messages ORDER BY created_at DESC",
        [],
        (err, rows) => {
            if (err) {
                console.error('DB error getting messages:', err);
                return res.json({ success: false, messages: [] });
            }
            res.json({ success: true, messages: rows, total: rows.length });
        }
    );
});

// Mark message as read (Admin - optional)
app.put('/api/contact-message/:id/read', checkLogin, (req, res) => {
    const messageId = req.params.id;
    
    db.run(
        "UPDATE contact_messages SET status = 'Read' WHERE id = ?",
        [messageId],
        function(err) {
            if (err) {
                console.error('DB error updating message:', err);
                return res.json({ success: false, message: 'Error updating message' });
            }
            
            if (this.changes === 0) {
                return res.json({ success: false, message: 'Message not found' });
            }
            
            res.json({ success: true, message: 'Message marked as read' });
        }
    );
});

// Delete contact message (Admin - optional)
app.delete('/api/contact-message/:id', checkLogin, (req, res) => {
    const messageId = req.params.id;
    
    db.run(
        "DELETE FROM contact_messages WHERE id = ?",
        [messageId],
        function(err) {
            if (err) {
                console.error('DB error deleting message:', err);
                return res.json({ success: false, message: 'Error deleting message' });
            }
            
            if (this.changes === 0) {
                return res.json({ success: false, message: 'Message not found' });
            }
            
            res.json({ success: true, message: 'Message deleted successfully' });
        }
    );
});

// ===== DELETE ACCOUNT =====
app.delete('/api/delete-account', checkLogin, async (req, res) => {
    const userEmail = req.session.user.email;

    try {
        // 1. حذف المفضلات
        await new Promise((resolve, reject) => {
            db.run(
                "DELETE FROM user_favorites WHERE user_email = ?",
                [userEmail],
                (err) => {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });

        // 2. حذف الحجوزات
        await new Promise((resolve, reject) => {
            db.run(
                "DELETE FROM user_bookings WHERE user_email = ?",
                [userEmail],
                (err) => {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });

        // 3. حذف حجوزات الحفلات
        await new Promise((resolve, reject) => {
            db.run(
                "DELETE FROM concert_bookings WHERE email = ?",
                [userEmail],
                (err) => {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });

        // 4. حذف المستخدم من جدول Users (Sequelize)
        await User.destroy({ where: { email: userEmail } });

        // 5. تدمير الجلسة
        req.session.destroy((err) => {
            if (err) {
                console.error('Session destroy error:', err);
                return res.json({ success: false, message: 'Error logging out after deletion' });
            }
            
            res.json({ 
                success: true, 
                message: 'Account deleted successfully',
                redirect: '/'
            });
        });

    } catch (err) {
        console.error('Delete account error:', err);
        res.json({ 
            success: false, 
            message: 'Error deleting account: ' + err.message 
        });
    }
});

// ===== CONCERT BOOKING API =====

// Get booked seats
app.get('/api/booked-seats', (req, res) => {
    db.all("SELECT seats FROM concert_bookings", (err, rows) => {
        if (err) {
            console.error('DB error booked-seats:', err);
            return res.json([]);
        }
        const bookedSeats = rows.flatMap(row => {
            try {
                return JSON.parse(row.seats || '[]');
            } catch (e) {
                return [];
            }
        });
        res.json(bookedSeats);
    });
});

// Book seats
app.post('/api/book', (req, res) => {
    const { event, seats, fullName, email, phone, total } = req.body;

    db.all("SELECT seats FROM concert_bookings", (err, rows) => {
        if (err) {
            console.error('DB error book seats:', err);
            return res.json({ success: false, message: 'Database error' });
        }

        const bookedSeats = rows.flatMap(row => {
            try { return JSON.parse(row.seats || '[]'); } catch (e) { return []; }
        });
        const conflictSeats = seats.filter(seat => bookedSeats.includes(seat));

        if (conflictSeats.length > 0) {
            return res.json({
                success: false,
                message: `Seats ${conflictSeats.join(', ')} are already booked!`
            });
        }

        db.run(
            `INSERT INTO concert_bookings (event_name, seats, full_name, email, phone, total)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [event, JSON.stringify(seats), fullName, email, phone, total],
            function(err) {
                if (err) {
                    console.error('DB error insert booking:', err);
                    return res.json({ success: false, message: 'Booking failed' });
                }
                res.json({ success: true, total, bookingId: this.lastID });
            }
        );
    });
});

// ===== PAGES =====

// Homepage (PUBLIC)
app.get('/', (req, res) => {
    res.render('homepage'); 
});

// Tours Page (PUBLIC)
app.get('/tours', (req, res) => {
    res.render('tours');
});

// Contact Page (PUBLIC)
app.get('/contact', (req, res) => {
    res.render('contact');
});

// About Page (PUBLIC)
app.get('/about', (req, res) => {
    res.render('about');
});

// ===== CONCERT PAGES =====

// Elissa Concert Booking Page (PUBLIC)
app.get('/elissaa', (req, res) => {
    res.render('elissa-c');
});

// Generic booking page (PROTECTED)
app.get('/booking', checkLogin, (req, res) => {
    res.render('booking');
});

// ===== PLACE DETAILS ROUTES (PUBLIC) =====

app.get('/place/hegra', (req, res) => {
    res.render('hegra');
});

app.get('/place/maraya', (req, res) => {
    res.render('maraya');
});

app.get('/place/elephant-rock', (req, res) => {
    res.render('elephant-rock');
});

app.get('/place/oasis', (req, res) => {
    res.render('oasis');
});

app.get('/place/aljadidah', (req, res) => {
    res.render('aljadidah');
});

// ===== PROTECTED PAGES =====

// Profile Page (PROTECTED)
app.get('/profile', checkLogin, (req, res) => {
    const userEmail = req.session.user.email;

    db.all(
        "SELECT id, event_name, event_date, event_location, liked_at FROM user_favorites WHERE user_email = ? ORDER BY liked_at DESC",
        [userEmail],
        (errFav, favorites) => {
            if (errFav) {
                console.error('DB error profile favorites:', errFav);
                favorites = [];
            }

            db.all(
                "SELECT id, activity_name, booking_date, num_people, booking_status, created_at FROM user_bookings WHERE user_email = ? ORDER BY created_at DESC",
                [userEmail],
                (errBook, bookings) => {
                    if (errBook) {
                        console.error('DB error profile bookings:', errBook);
                        bookings = [];
                    }

                    res.render('profile', { 
                        user: req.session.user, 
                        favorites: favorites, 
                        bookings: bookings 
                    });
                }
            );
        }
    );
});

// Update Profile (PROTECTED)
app.post('/profile/update', checkLogin, async (req, res) => {
    const { firstName, lastName, currentPassword, newPassword } = req.body;
    
    try {
        const user = await User.findOne({ where: { email: req.session.user.email } });
        
        if (!user) {
            return res.json({ success: false, message: 'User not found' });
        }

        if (firstName && lastName) {
            user.firstName = firstName;
            user.lastName = lastName;
        }

        if (currentPassword && newPassword) {
            if (user.password !== currentPassword) {
                return res.json({ success: false, message: 'Current password is incorrect' });
            }
            user.password = newPassword;
        }

        await user.save();

        req.session.user.username = user.firstName;
        req.session.user.firstName = user.firstName;
        req.session.user.lastName = user.lastName;

        res.json({ success: true, message: 'Profile updated successfully' });
    } catch (err) {
        console.error('Profile update error:', err);
        res.json({ success: false, message: err.message });
    }
});

// Logout
app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

// ===== 404 Handler =====
app.use((req, res) => {
    res.status(404).send(`
        <!DOCTYPE html>
        <html lang="ar">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>404 - Page Not Found</title>
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body {
                    font-family: Arial, sans-serif;
                    background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%);
                    color: #fff;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    height: 100vh;
                    text-align: center;
                }
                .error-container {
                    max-width: 600px;
                    padding: 40px;
                }
                h1 {
                    font-size: 120px;
                    color: #d4af37;
                    margin-bottom: 20px;
                }
                h2 {
                    font-size: 32px;
                    margin-bottom: 20px;
                }
                p {
                    font-size: 18px;
                    color: #ccc;
                    margin-bottom: 30px;
                }
                a {
                    display: inline-block;
                    padding: 12px 30px;
                    background: #d4af37;
                    color: #1a1a1a;
                    text-decoration: none;
                    border-radius: 5px;
                    font-weight: bold;
                    transition: all 0.3s;
                }
                a:hover {
                    background: #b8941f;
                    transform: translateY(-2px);
                }
            </style>
        </head>
        <body>
            <div class="error-container">
                <h1>404</h1>
                <h2>Page Not Found</h2>
                <p>The page you're looking for doesn't exist or has been moved.</p>
                <a href="/">Return to Homepage</a>
            </div>
        </body>
        </html>
    `);
});

// ===== Start Server =====
app.listen(3000, () => {
    console.log('Server running at http://localhost:3000');
});