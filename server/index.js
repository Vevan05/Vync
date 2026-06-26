require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const Y = require("yjs");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const redis = require("./redis");
const authRoutes = require("./routes/auth");
const fileRoutes = require("./routes/files");
const executeRoute = require("./routes/execute");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:5173",
    methods: ["GET", "POST"],
  },
});

// Security middleware first
app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_URL || "http://localhost:5173" }));
app.use(express.json({ limit: "50kb" }));

// General rate limit — 100 requests per 15 minutes per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: "Too many requests, slow down" },
});
app.use(limiter);

// Stricter limit for code execution — 10 runs per minute per IP
const executeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Too many execution requests" },
});

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/files", fileRoutes);
app.use("/api/execute", executeLimiter, executeRoute);
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Yjs docs live in memory
const ydocs = new Map();

function getOrCreateDoc(roomId) {
  if (!ydocs.has(roomId)) ydocs.set(roomId, new Y.Doc());
  return ydocs.get(roomId);
}

const COLORS = ["#e74c3c", "#3498db", "#2ecc71", "#f39c12", "#9b59b6", "#1abc9c"];
let colorIndex = 0;
function nextColor() {
  return COLORS[colorIndex++ % COLORS.length];
}

io.on("connection", (socket) => {
  let currentRoom = null;

  socket.on("join-room", async ({ roomId, username }) => {
    currentRoom = roomId;
    socket.join(roomId);

    // Check if this username is already in the room (duplicate tab)
    const existingUsers = await redis.getRoomUsers(roomId);
    const duplicate = existingUsers.find(u => u.name === username);
    if (duplicate) {
      await redis.removeUserFromRoom(roomId, duplicate.socketId);
    }

    // Reuse color if reconnecting, else assign new one
    const userData = {
      name: username || "Anonymous",
      color: duplicate?.color || nextColor(),
    };

    await redis.addUserToRoom(roomId, socket.id, userData);

    // Send current doc state to the new user
    const doc = getOrCreateDoc(roomId);
    const stateVector = Y.encodeStateAsUpdate(doc);
    socket.emit("doc-state", Array.from(stateVector));

    // Broadcast updated user list to everyone in the room
    const users = await redis.getRoomUsers(roomId);
    io.to(roomId).emit("users-update", users.map(u => ({ name: u.name, color: u.color })));
  });

  socket.on("doc-update", ({ roomId, update }) => {
    const doc = ydocs.get(roomId);
    if (!doc) return;
    Y.applyUpdate(doc, new Uint8Array(update));
    socket.to(roomId).emit("doc-update", update);
  });

  socket.on("cursor-update", async ({ roomId, cursor }) => {
    const users = await redis.getRoomUsers(roomId);
    const currentUser = users.find(u => u.socketId === socket.id);
    if (!currentUser) return;
    socket.to(roomId).emit("cursor-update", {
      socketId: socket.id,
      user: { name: currentUser.name, color: currentUser.color },
      cursor,
    });
  });

  socket.on("disconnect", async () => {
    if (currentRoom) {
      await redis.removeUserFromRoom(currentRoom, socket.id);
      const users = await redis.getRoomUsers(currentRoom);
      io.to(currentRoom).emit("users-update", users.map(u => ({ name: u.name, color: u.color })));
      io.to(currentRoom).emit("user-left", socket.id);

      // Clean up Yjs doc if room is empty
      if (users.length === 0) {
        ydocs.delete(currentRoom);
        await redis.deleteRoom(currentRoom);
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Vync server running on http://localhost:${PORT}`);
});