const router = require("express").Router();
const pool = require("../db");
const authMiddleware = require("../middleware/auth");

// All file routes require login
router.use(authMiddleware);

// GET /api/files - list user's files
router.get("/", async (req, res) => {
  const result = await pool.query(
    "SELECT id, name, language, created_at, updated_at FROM files WHERE owner_id = $1 ORDER BY updated_at DESC",
    [req.user.id]
  );
  res.json(result.rows);
});

// POST /api/files - create a new file
router.post("/", async (req, res) => {
  const { name, language = "javascript" } = req.body;
  const result = await pool.query(
    "INSERT INTO files (name, language, owner_id) VALUES ($1, $2, $3) RETURNING *",
    [name, language, req.user.id]
  );
  res.json(result.rows[0]);
});

// POST /api/files/:id/snapshots - save a snapshot
router.post("/:id/snapshots", async (req, res) => {
  const { content, label } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO snapshots (file_id, content, label) VALUES ($1, $2, $3) RETURNING *",
      [req.params.id, content, label || null]
    );
    res.json(result.rows[0]);
  } catch {
    res.status(500).json({ error: "Failed to save snapshot" });
  }
});

// GET /api/files/:id/snapshots - list all snapshots for a file
router.get("/:id/snapshots", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, label, created_at FROM snapshots WHERE file_id = $1 ORDER BY created_at DESC",
      [req.params.id]
    );
    res.json(result.rows);
  } catch {
    res.status(500).json({ error: "Failed to fetch snapshots" });
  }
});

// GET /api/files/:id/snapshots/:snapshotId - get a snapshot's content
router.get("/:id/snapshots/:snapshotId", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM snapshots WHERE id = $1 AND file_id = $2",
      [req.params.snapshotId, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Snapshot not found" });
    res.json(result.rows[0]);
  } catch {
    res.status(500).json({ error: "Failed to fetch snapshot" });
  }
});

// GET /api/files/:id - get file content
router.get("/:id", async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM files WHERE id = $1 AND owner_id = $2",
    [req.params.id, req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "File not found" });
  res.json(result.rows[0]);
});

// PUT /api/files/:id - save file content
router.put("/:id", async (req, res) => {
  const { content } = req.body;
  const result = await pool.query(
    "UPDATE files SET content = $1 WHERE id = $2 AND owner_id = $3 RETURNING *",
    [content, req.params.id, req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "File not found" });
  res.json(result.rows[0]);
});

// DELETE /api/files/:id
router.delete("/:id", async (req, res) => {
  await pool.query("DELETE FROM files WHERE id = $1 AND owner_id = $2", [req.params.id, req.user.id]);
  res.json({ success: true });
});

module.exports = router;
