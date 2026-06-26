# Vync — Real-Time Collaborative Code Editor

> Code together, live. Multiple users, one editor, zero conflicts.

Vync is a full-stack collaborative code editor where multiple users can write code simultaneously in the same room, see each other's live cursors, execute code in isolated containers, and restore previous versions — all in real time.

![Tech Stack](https://img.shields.io/badge/React-20232A?style=flat&logo=react) ![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white) ![PostgreSQL](https://img.shields.io/badge/PostgreSQL-316192?style=flat&logo=postgresql&logoColor=white) ![Redis](https://img.shields.io/badge/Redis-DC382D?style=flat&logo=redis&logoColor=white) ![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat&logo=docker&logoColor=white)

---

## Features

- **Real-time collaboration** — multiple users edit the same file simultaneously with no conflicts
- **Live cursors** — see where every collaborator is in the file, with colored labels showing their name
- **Code execution** — run code directly in the browser in an isolated Docker sandbox
- **Multi-language support** — JavaScript, Python, TypeScript, Java, C++, Go
- **Version history** — save named snapshots and restore any previous version
- **Authentication** — secure signup/login with JWT and bcrypt
- **Auto-save** — files save to the database automatically after every edit
- **Room sharing** — share a room URL with anyone to start collaborating instantly

---

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Frontend | React, Monaco Editor | UI and code editing (same editor as VSCode) |
| Real-time | Socket.io (WebSockets) | Bidirectional persistent connection |
| CRDT | Yjs | Conflict-free collaborative editing |
| Backend | Node.js, Express | REST API and WebSocket server |
| Database | PostgreSQL | Users, files, and version snapshots |
| Cache | Redis | Active user sessions and room presence |
| Execution | Docker | Isolated sandboxed code execution |
| Auth | JWT, bcrypt | Secure authentication |

---

## CS Concepts Demonstrated

### Computer Networks
- **WebSockets** — persistent bidirectional TCP connections replace HTTP polling for real-time sync
- **REST API** — standard HTTP endpoints for auth, file management, and code execution
- Socket.io handles connection fallbacks, reconnection, and room-based message routing

### Databases
- **PostgreSQL** — relational schema with users, files, and snapshots tables; foreign key constraints; auto-updating timestamps via triggers
- **Redis** — in-memory key-value store for ephemeral session data (online presence, active rooms); TTL-based auto-expiry

### Operating Systems
- **Process isolation** — each code execution runs in a separate Docker container with no access to the host filesystem or network
- **Resource limits** — containers are capped on memory and CPU to prevent abuse
- **Inter-process communication** — Node.js spawns Docker child processes and captures stdout/stderr

### Data Structures & Algorithms
- **CRDT (Conflict-free Replicated Data Type)** — Yjs implements a mathematical data structure that guarantees all concurrent edits merge correctly regardless of network order, without requiring a central lock
- Specifically uses a variant of the LSEQ algorithm for sequence CRDTs

### Security
- Passwords hashed with bcrypt (cost factor 10)
- JWT tokens for stateless authentication
- Docker containers run with `--network=none` — user code cannot make outbound network requests
- Temp files are created in isolated directories and deleted immediately after execution

---

## Architecture

```
Browsers (React + Monaco + Yjs)
        │
        │  WebSocket (Socket.io)
        │  REST API (axios)
        ▼
Node.js + Express Server
        │
        ├── Yjs Doc (in-memory, per room)
        │
        ├── Redis ──── active users, room presence
        │
        ├── PostgreSQL ── users, files, snapshots
        │
        └── Docker ───── sandboxed code execution
                          (Python, JS, TS, Java, C++, Go)
```

---

## Getting Started

### Prerequisites
- Node.js 18+
- PostgreSQL
- Redis
- Docker

### 1. Clone the repo
```bash
git clone https://github.com/yourusername/vync.git
cd vync
```

### 2. Set up the database
```bash
createdb vync
psql vync < server/db/schema.sql
```

### 3. Build custom Docker images
```bash
# TypeScript image (pre-installs ts-node)
docker build -f server/Dockerfile.ts -t vync-ts ./server

# Go image (pre-warms the stdlib cache)
docker build -f server/Dockerfile.go -t vync-go ./server
```

### 4. Configure environment
```bash
cd server
cp .env.example .env
```

Edit `.env`:
```
PORT=3001
CLIENT_URL=http://localhost:5173
DATABASE_URL=postgresql://postgres@localhost:5432/vync
REDIS_URL=redis://localhost:6379
JWT_SECRET=your_random_secret_here
NODE_ENV=development
```

### 5. Start the server
```bash
cd server
npm install
npm run dev
```

### 6. Start the client
```bash
cd client
npm install
npm run dev
```

Open **http://localhost:5173**

---

## How It Works

### Real-Time Sync (Yjs + WebSockets)

Every keystroke is captured by Monaco Editor and applied to a local Yjs document. The Yjs update (a compact binary diff) is sent to the server via WebSocket, which applies it to the server-side Yjs document and broadcasts it to all other clients in the room. Each client applies the update to their local Yjs document and syncs the editor.

Because Yjs uses a CRDT, two users typing at the same position simultaneously will always produce the same result on all clients — no conflicts, no overwriting.

### Code Execution (Docker)

When a user clicks Run:
1. The code is written to a temporary directory on the server
2. A Docker container is spawned with that directory mounted as a read-write volume
3. The container runs the code with no network access, limited memory, and limited CPU
4. stdout and stderr are captured and returned to the client
5. The temp directory and container are destroyed immediately

### Version History

Snapshots are saved to PostgreSQL with a label and timestamp. Restoring a snapshot applies the content directly to the Yjs document, so all users in the room see the restore in real time.

---

## Project Structure

```
vync/
├── server/
│   ├── index.js              # WebSocket hub + Express server
│   ├── redis.js              # Redis helper functions
│   ├── Dockerfile.ts         # TypeScript execution image
│   ├── Dockerfile.go         # Go execution image (pre-warmed)
│   ├── routes/
│   │   ├── auth.js           # POST /api/auth/signup, /login
│   │   ├── files.js          # CRUD + snapshots
│   │   └── execute.js        # POST /api/execute
│   ├── middleware/
│   │   └── auth.js           # JWT verification
│   └── db/
│       ├── index.js          # PostgreSQL connection pool
│       └── schema.sql        # DB schema
└── client/
    └── src/
        ├── pages/
        │   ├── Login.jsx
        │   ├── Signup.jsx
        │   ├── Dashboard.jsx  # File manager
        │   └── Editor.jsx     # Monaco + Yjs + cursors + execution
        └── context/
            └── AuthContext.jsx
```

---

## Supported Languages

| Language | Runtime | Notes |
|----------|---------|-------|
| JavaScript | Node.js 18 | |
| Python | Python 3.11 | |
| TypeScript | ts-node (custom image) | First run may be slower |
| Java | Eclipse Temurin 17 | Class must be named `Main` |
| C++ | GCC | Compiled with g++ |
| Go | Go 1.21 (custom image) | stdlib cache pre-warmed |

---

## License

MIT