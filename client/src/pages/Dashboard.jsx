import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import { useAuth } from "../context/AuthContext";

const LANGUAGES = ["javascript", "python", "typescript", "cpp", "java", "go"];
const EXTENSIONS = {javascript: "index.js", python: "main.py", 
                    typescript: "index.ts",  cpp: "main.cpp",
                    java: "Main.java",go: "main.go",};

export default function Dashboard() {
  const { user, token, logout } = useAuth();
  const navigate = useNavigate();
  const [files, setFiles] = useState([]);
  const [newFileName, setNewFileName] = useState("");
  const [newFileLang, setNewFileLang] = useState("javascript");
  const [joinRoomId, setJoinRoomId] = useState("");

  const api = axios.create({ headers: { Authorization: `Bearer ${token}` } });

  useEffect(() => { fetchFiles(); }, []);

  async function fetchFiles() {
    const { data } = await api.get("/api/files");
    setFiles(data);
  }

  async function createFile() {
    if (!newFileName.trim()) return;
    const { data } = await api.post("/api/files", { name: newFileName, language: newFileLang });
    navigate(`/room/${data.id}`);
  }

  async function deleteFile(id, e) {
    e.stopPropagation();
    await api.delete(`/api/files/${id}`);
    setFiles(f => f.filter(x => x.id !== id));
  }

  function joinRoom() {
    let id = joinRoomId.trim();

    // If they pasted the full URL, extract just the UUID
    if (id.includes("/room/")) {
      id = id.split("/room/")[1];
    }

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      alert("Please paste the full room ID or the complete room URL");
      return;
    }

    navigate(`/room/${id}`);
  }

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "32px 16px" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 32 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 600 }}>Vync</h1>
          <p style={{ color: "#7d8590" }}>Welcome, {user?.username}</p>
        </div>
        <button className="ghost" onClick={logout}>Sign out</button>
      </div>

      {/* Create new file */}
      <div className="card" style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 16, marginBottom: 16 }}>New file</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            placeholder={EXTENSIONS[newFileLang] || "filename"}
            value={newFileName}
            onChange={e => setNewFileName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && createFile()}
            style={{ flex: 1 }}
          />
          <select value={newFileLang} onChange={e => setNewFileLang(e.target.value)} style={{ width: 140 }}>
            {LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
          <button className="primary" onClick={createFile}>Create</button>
        </div>
      </div>

      {/* Join room by ID */}
      <div className="card" style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 16, marginBottom: 16 }}>Join a room</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            placeholder="Paste a room ID..."
            value={joinRoomId}
            onChange={e => setJoinRoomId(e.target.value)}
            onKeyDown={e => e.key === "Enter" && joinRoom()}
          />
          <button className="ghost" onClick={joinRoom}>Join</button>
        </div>
      </div>

      {/* File list */}
      <h2 style={{ fontSize: 16, marginBottom: 12 }}>Your files</h2>
      {files.length === 0 && (
        <p style={{ color: "#7d8590" }}>No files yet. Create one above.</p>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {files.map(file => (
          <div
            key={file.id}
            onClick={() => navigate(`/room/${file.id}`)}
            style={{
              background: "#161b22", border: "1px solid #30363d", borderRadius: 8,
              padding: "14px 16px", cursor: "pointer", display: "flex",
              justifyContent: "space-between", alignItems: "center",
              transition: "border-color 0.15s",
            }}
            onMouseEnter={e => e.currentTarget.style.borderColor = "#388bfd"}
            onMouseLeave={e => e.currentTarget.style.borderColor = "#30363d"}
          >
            <div>
              <span style={{ fontWeight: 500 }}>{file.name}</span>
              <span style={{
                marginLeft: 8, background: "#21262d", color: "#7d8590",
                fontSize: 12, padding: "2px 8px", borderRadius: 12,
              }}>{file.language}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ color: "#7d8590", fontSize: 12 }}>
                {new Date(file.updated_at).toLocaleDateString()}
              </span>
              <button
                className="danger"
                style={{ padding: "4px 10px", fontSize: 12 }}
                onClick={e => deleteFile(file.id, e)}
              >Delete</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
