require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const Y = require("yjs");
const rateLimit = require("express-rate-limit");
const redis = require("./redis");
const pool = require("./db");
const authRoutes = require("./routes/auth");
const fileRoutes = require("./routes/files");
const executeRoute = require("./routes/execute");

const app = express();
const server = http.createServer(app);

const CLIENT_ORIGIN = process.env.CLIENT_URL || "http://localhost:5173";

const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ["GET", "POST"],
  },
});

app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json({ limit: "50kb" }));

if (process.env.NODE_ENV === "production") {
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: "Too many requests, slow down" },
  });
  app.use(limiter);

  const executeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: { error: "Too many execution requests" },
  });
  app.use("/api/execute", executeLimiter, executeRoute);
} else {
  app.use("/api/execute", executeRoute);
}

app.use("/api/auth", authRoutes);
app.use("/api/files", fileRoutes);
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ---------- Yjs state ----------
// ydocs holds one Y.Doc per room. The doc is the canonical state in memory;
// Postgres is the durable backing store (auto-save on the client side).
// We never delete ydocs on disconnect — the last person to leave may come
// back, and recreating an empty doc would clobber their unsaved edits.
const ydocs = new Map();

function getOrCreateDoc(roomId) {
  if (!ydocs.has(roomId)) ydocs.set(roomId, new Y.Doc());
  return ydocs.get(roomId);
}

// ---------- Color assignment ----------
// Persist assigned colors in Redis so a user that disconnects and rejoins
// gets the same color. Also lets us reuse colors when a duplicate-name
// disconnects but a fresh user takes the slot.
const COLORS = ["#e74c3c", "#3498db", "#2ecc71", "#f39c12", "#9b59b6", "#1abc9c"];

async function pickColor(roomId) {
  const users = await redis.getRoomUsers(roomId);
  const used = new Set(users.map((u) => u.color));
  const free = COLORS.find((c) => !used.has(c));
  return free || COLORS[Math.floor(Math.random() * COLORS.length)];
}

// ---------- Socket auth middleware ----------
// JWT can arrive via handshake auth (preferred) or the Authorization header
// (useful for clients that can't set custom handshake payloads).
io.use((socket, next) => {
  const token =
    socket.handshake.auth?.token ||
    socket.handshake.headers?.authorization?.split(" ")[1];
  if (!token) return next(new Error("No token provided"));
  try {
    socket.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    next(new Error("Invalid token"));
  }
});

// ---------- Per-socket state ----------
// Cache user info per socket so cursor updates don't hit Redis on every move.
const socketUser = new Map(); // socket.id -> { name, color, roomId }

io.on("connection", (socket) => {
  socket.on("join-room", async ({ roomId, username }) => {
    if (!roomId) return;

    // Authorize: this user must own the file they're joining.
    try {
      const { rows } = await pool.query(
        "SELECT id FROM files WHERE id = $1 AND owner_id = $2",
        [roomId, socket.user.id]
      );
      if (!rows[0]) {
        socket.emit("room-error", "You don't have access to this room.");
        return;
      }
    } catch (err) {
      console.error("join-room auth check failed:", err);
      socket.emit("room-error", "Server error. Try again.");
      return;
    }

    // If this socket is already in a room (re-join), clean up the old one first.
    if (socketUser.has(socket.id)) {
      const prev = socketUser.get(socket.id);
      socket.leave(prev.roomId);
      await redis.removeUserFromRoom(prev.roomId, socket.id);
    }

    // Remove any stale entry from a previous tab with the same username
    // in the same room, so they don't show up twice.
    const existingUsers = await redis.getRoomUsers(roomId);
    const duplicate = existingUsers.find((u) => u.name === username);
    if (duplicate) {
      await redis.removeUserFromRoom(roomId, duplicate.socketId);
    }

    const userData = {
      name: username || "Anonymous",
      color: duplicate?.color || (await pickColor(roomId)),
    };

    await redis.addUserToRoom(roomId, socket.id, userData);
    socketUser.set(socket.id, { name: userData.name, color: userData.color, roomId });
    socket.join(roomId);

    // Send current doc state to the new user.
    const doc = getOrCreateDoc(roomId);
    const stateUpdate = Y.encodeStateAsUpdate(doc);
    socket.emit("doc-state", stateUpdate);

    // Broadcast updated user list to everyone in the room.
    const users = await redis.getRoomUsers(roomId);
    io.to(roomId).emit(
      "users-update",
      users.map((u) => ({ name: u.name, color: u.color }))
    );
  });

  socket.on("doc-update", ({ roomId, update }, ack) => {
    if (!roomId || !update) return;
    // update arrives as a Buffer/Uint8Array over the socket.
    const u8 = update instanceof Uint8Array ? update : new Uint8Array(update);
    if (!u8.length) return;

    const doc = getOrCreateDoc(roomId);
    Y.applyUpdate(doc, u8);
    // Forward the *incremental* update to other clients.
    socket.to(roomId).emit("doc-update", u8);
    if (typeof ack === "function") ack();
  });

  // Cursor updates are high-frequency — use the cached user instead of Redis.
  socket.on("cursor-update", ({ roomId, cursor }) => {
    if (!roomId || !cursor) return;
    const me = socketUser.get(socket.id);
    if (!me || me.roomId !== roomId) return;
    socket.to(roomId).emit("cursor-update", {
      socketId: socket.id,
      user: { name: me.name, color: me.color },
      cursor,
    });
  });

  socket.on("disconnect", async () => {
    const me = socketUser.get(socket.id);
    if (!me) return;
    socketUser.delete(socket.id);

    await redis.removeUserFromRoom(me.roomId, socket.id);
    const users = await redis.getRoomUsers(me.roomId);
    io.to(me.roomId).emit(
      "users-update",
      users.map((u) => ({ name: u.name, color: u.color }))
    );
    io.to(me.roomId).emit("user-left", socket.id);
    // Note: we deliberately do NOT delete the Yjs doc when the room empties.
    // Postgres + the in-memory doc both keep their state; if someone rejoins,
    // they get the existing doc, not a fresh empty one.
  });
});

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.stack);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Vync server running on http://localhost:${PORT}`);
});
