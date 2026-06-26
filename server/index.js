require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const Y = require("yjs");
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

app.use(cors({ origin: process.env.CLIENT_URL || "http://localhost:5173" }));
app.use(express.json());
app.use("/api/auth", authRoutes);
app.use("/api/files", fileRoutes);
app.get("/health", (req, res) => res.json({ status: "ok" }));
app.use("/api/execute", executeRoute);

// Yjs docs still live in memory (fast, no need to persist)
const ydocs = new Map(); // roomId -> Y.Doc

function getOrCreateDoc(roomId) {
  if (!ydocs.has(roomId)) ydocs.set(roomId, new Y.Doc());
  return ydocs.get(roomId);
}

const COLORS = ["#e74c3c","#3498db","#2ecc71","#f39c12","#9b59b6","#1abc9c"];
let colorIndex = 0;
function nextColor() {
  return COLORS[colorIndex++ % COLORS.length];
}

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);
  let currentRoom = null;

  socket.on("join-room", async ({ roomId, username }) => {
    currentRoom = roomId;
    socket.join(roomId);

    // Check if this username is already in the room
    const existingUsers = await redis.getRoomUsers(roomId);
    const duplicate = existingUsers.find(u => u.name === username);
    if (duplicate) {
      await redis.removeUserFromRoom(roomId, duplicate.socketId);
    }

    // Reuse the same color if they were already in the room, else assign new one
    const userData = {
      name: username || "Anonymous",
      color: duplicate?.color || nextColor(),
    };

    await redis.addUserToRoom(roomId, socket.id, userData);

    const doc = getOrCreateDoc(roomId);
    const stateVector = Y.encodeStateAsUpdate(doc);
    socket.emit("doc-state", Array.from(stateVector));

    const users = await redis.getRoomUsers(roomId);
    io.to(roomId).emit("users-update", users.map(u => ({ name: u.name, color: u.color })));

    console.log(`${username} joined room ${roomId}`);
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
    console.log("Client disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Vync server running on http://localhost:${PORT}`);
});