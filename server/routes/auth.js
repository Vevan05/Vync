const router = require("express").Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db");


// POST /api/auth/signup
router.post("/signup", async (req, res) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const username = req.body.username?.trim();
  const email = req.body.email?.trim().toLowerCase();
  const password = req.body.password;
  
  if (!username || !email || !password)
    return res.status(400).json({ error: "All fields required" });

  if(username.length > 16) 
    return res.status(400).json({error: "Username should be 3-16 characters"});

  if(username.length < 3)
    return res.status(400).json({error: "Username should be 3-16 characters"});

  if (!emailRegex.test(email))
    return res.status(400).json({ error: "Invalid email format" });

  if (password.length < 8)
  return res.status(400).json({
    error: "Password must be at least 8 characters long"
  });

  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email",
      [username, email, hash]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });
    res.json({ token, user });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Username or email already taken" });
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query("SELECT * FROM users WHERE LOWER(email) = LOWER($1)", [email]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });
    res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
  } catch(err) {
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
