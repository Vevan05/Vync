import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import MonacoEditor from "@monaco-editor/react";
import * as Y from "yjs";
import { io } from "socket.io-client";
import axios from "axios";
import { useAuth } from "../context/AuthContext";

const EXT = {"javascript": "js", "python": "py", "go": "go", "cpp": "cpp", "typescript": "ts", "java": "java"};

const SOCKET_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3001";

export default function Editor() {
  const { roomId } = useParams();
  const { user, token } = useAuth();
  const navigate = useNavigate();

  const [users, setUsers] = useState([]);
  const [language, setLanguage] = useState("javascript");
  const [saveStatus, setSaveStatus] = useState("saved");
  const [copied, setCopied] = useState(false);
  const [fileName, setFileName] = useState("");

  const socketRef = useRef(null);
  const ydocRef = useRef(new Y.Doc());
  const ytextRef = useRef(null);
  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  const isRemoteUpdate = useRef(false);
  const saveTimer = useRef(null);
  const outputRef = useRef(null);
  const decorationsRef = useRef({});
  const userColorsRef = useRef({}); 

  const [output, setOutput] = useState(null);   
  const [running, setRunning] = useState(false);
  const [showOutput, setShowOutput] = useState(false);
  const [showWarning, setShowWarning] = useState(() => localStorage.getItem("vync_ts_warning_dismissed") !== "true");
  const [roomError, setRoomError] = useState(null);
  const [outputHeight, setOutputHeight] = useState(200);
  const isResizing = useRef(false);

  const [showHistory, setShowHistory] = useState(false);
  const [snapshots, setSnapshots] = useState([]);
  const [snapshotLabel, setSnapshotLabel] = useState("");

  const api = axios.create({ headers: { Authorization: `Bearer ${token}` } });

  // Inject base cursor CSS once
  useEffect(() => {
    const style = document.createElement("style");
    style.id = "vync-cursor-styles";
    style.textContent = `
      .remote-cursor-label {
        font-size: 11px;
        font-weight: 600;
        padding: 1px 5px;
        border-radius: 3px;
        white-space: nowrap;
        pointer-events: none;
      }
    `;
    if (!document.getElementById("vync-cursor-styles")) {
      document.head.appendChild(style);
    }
    return () => document.getElementById("vync-cursor-styles")?.remove();
  }, []);

  useEffect(() => {
  if (showHistory) fetchSnapshots();
}, [showHistory]);

  // Track whether server has already given us the doc state
const docSeededRef = useRef(false);

// Load file from DB
useEffect(() => {
  api.get(`/api/files/${roomId}`)
    .then(({ data }) => {
      setLanguage(data.language);
      setFileName(data.name);
      const ytext = ydocRef.current.getText("content");
      ytextRef.current = ytext;

      // ✅ Only seed from DB if server hasn't sent us content yet
      if (!docSeededRef.current && data.content && ytext.toString() === "") {
        ytext.insert(0, data.content);
      }
    })
     .catch((err) => {
      // ✅ 404 means room doesn't exist, anything else is a server error
      if (err.response?.status === 404) {
        setRoomError("This room doesn't exist. Check the ID and try again.");
      } else {
        setRoomError("Something went wrong loading this room.");
      }
     })
}, [roomId]);

// WebSocket connection
useEffect(() => {
  const socket = io(SOCKET_URL);
  socketRef.current = socket;

  const ytext = ydocRef.current.getText("content");
  ytextRef.current = ytext;

  socket.on("connect", () => {
    socket.emit("join-room", { roomId, username: user?.username });
  });

  socket.on("doc-state", (update) => {
    // ✅ Mark that the server has given us the authoritative state
    docSeededRef.current = true;

    isRemoteUpdate.current = true;
    Y.applyUpdate(ydocRef.current, new Uint8Array(update));
    isRemoteUpdate.current = false;

    const content = ytextRef.current?.toString();
    if (editorRef.current && content) {
      editorRef.current.setValue(content);
    }
  });

    // Incremental updates from other users
    socket.on("doc-update", (update) => {
      isRemoteUpdate.current = true;
      const prevContent = ytext.toString();
      Y.applyUpdate(ydocRef.current, new Uint8Array(update));
      isRemoteUpdate.current = false;

      const newContent = ytext.toString();
      if (editorRef.current && newContent !== prevContent) {
        const position = editorRef.current.getPosition();
        editorRef.current.getModel().setValue(newContent);
        if (position) editorRef.current.setPosition(position);
      }
    });

    socket.on("users-update", (userList) => setUsers(userList));

    // Receive another user's cursor
    socket.on("cursor-update", ({ socketId, user: remoteUser, cursor }) => {
      if (!editorRef.current || !monacoRef.current || !cursor) return;

      const monaco = monacoRef.current;
      const editor = editorRef.current;
      const color = remoteUser?.color || "#ffffff";

      userColorsRef.current[socketId] = color;

      // Inject a per-user color style
      let perUserStyle = document.getElementById(`cursor-style-${socketId}`);
      if (!perUserStyle) {
        perUserStyle = document.createElement("style");
        perUserStyle.id = `cursor-style-${socketId}`;
        document.head.appendChild(perUserStyle);
      }
      perUserStyle.textContent = `
        .cursor-line-${socketId} {
          border-left: 2px solid ${color};
        }
        .cursor-label-${socketId}::after {
          content: "${remoteUser?.name || "user"}";
          background: ${color};
          color: #000;
          font-size: 11px;
          font-weight: 600;
          padding: 1px 5px;
          border-radius: 3px;
        }
      `;

      // Draw the decoration at their cursor position
      const newDecorations = [
        {
          range: new monaco.Range(
            cursor.lineNumber, cursor.column,
            cursor.lineNumber, cursor.column + 1
          ),
          options: {
            className: `cursor-line-${socketId}`,
            afterContentClassName: `cursor-label-${socketId}`,
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        },
      ];

      // Replace old decorations for this user with new ones
      const oldIds = decorationsRef.current[socketId] || [];
      decorationsRef.current[socketId] = editor.deltaDecorations(oldIds, newDecorations);
    });

    // Clean up when a user leaves
    socket.on("user-left", (socketId) => {
      if (editorRef.current && decorationsRef.current[socketId]) {
        editorRef.current.deltaDecorations(decorationsRef.current[socketId], []);
        delete decorationsRef.current[socketId];
      }
      document.getElementById(`cursor-style-${socketId}`)?.remove();
    });

    return () => socket.disconnect();
  }, [roomId, user]);

  // Broadcast local Yjs changes
  useEffect(() => {
    const ytext = ytextRef.current;
    if (!ytext) return;

    const handler = (event, transaction) => {
      if (isRemoteUpdate.current || transaction.local === false) return;
      const update = Y.encodeStateAsUpdate(ydocRef.current);
      socketRef.current?.emit("doc-update", { roomId, update: Array.from(update) });
    };

    ytext.observe(handler);
    return () => ytext.unobserve(handler);
  }, [roomId]);

  // onMount now takes monaco too, and sets up cursor tracking
  function handleEditorMount(editor, monaco) {
    editorRef.current = editor;
    monacoRef.current = monaco;

    const ytext = ytextRef.current;
    if (ytext && ytext.toString()) editor.setValue(ytext.toString());

    // Emit cursor position on every move
    editor.onDidChangeCursorPosition((e) => {
      socketRef.current?.emit("cursor-update", {
        roomId,
        cursor: {
          lineNumber: e.position.lineNumber,
          column: e.position.column,
        },
      });
    });
  }

  function handleEditorChange(value) {
    if (isRemoteUpdate.current) return;
    const ytext = ytextRef.current;
    if (!ytext || value === ytext.toString()) return;

    ydocRef.current.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, value || "");
    });

    setSaveStatus("unsaved");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveFile(value), 1500);
  }

  async function saveFile(content) {
    try {
      await api.put(`/api/files/${roomId}`, { content });
      setSaveStatus("saved");
    } catch {
      setSaveStatus("error");
    }
  }

  async function saveSnapshot() {
    const content = editorRef.current?.getValue();
    if (!content) return;
    const label = snapshotLabel.trim() || new Date().toLocaleString();
    try {
      await api.post(`/api/files/${roomId}/snapshots`, { content, label });
      setSnapshotLabel("");
      fetchSnapshots(); // refresh the list
      alert("Snapshot saved!");
    } catch {
      alert("Failed to save snapshot");
    }
  }

async function fetchSnapshots() {
  try {
    const { data } = await api.get(`/api/files/${roomId}/snapshots`);
    setSnapshots(data);
  } catch {}
}

  async function restoreSnapshot(snapshotId) {
    if (!confirm("Restore this snapshot? Current content will be replaced.")) return;
    try {
      const { data } = await api.get(`/api/files/${roomId}/snapshots/${snapshotId}`);
      ydocRef.current.transact(() => {
        const ytext = ytextRef.current;
        ytext.delete(0, ytext.length);
        ytext.insert(0, data.content);
      });
      editorRef.current?.setValue(data.content);
    } catch {
      alert("Failed to restore snapshot");
    }
  }

  async function runCode() {
    const code = editorRef.current?.getValue();
    if (!code) return;
    setRunning(true);
    setShowOutput(true);
    setOutput(null);

      setTimeout(() => {outputRef.current?.scrollIntoView({ behavior: "smooth" })}, 50);

    try {
      const { data } = await api.post("/api/execute", { code, language });
      setOutput(data);
    } catch {
      setOutput({ output: "", error: "Server error — is Docker running?" });
    } finally {
      setRunning(false);
    }
  }

  function copyRoomLink() {
    navigator.clipboard.writeText(window.location.href);

    setCopied(true);
    setTimeout(()=> setCopied(false), 10000);
  }

  function dismissTsWarning() {
    localStorage.setItem("vync_ts_warning_dismissed", "true");
    setShowWarning(false);
  }

  function startResize(e) {
    isResizing.current = true;
    const startY = e.clientY;
    const startHeight = outputHeight;

    function onMouseMove(e) {
      if (!isResizing.current) return;
      const delta = startY - e.clientY; // dragging up = bigger
      const newHeight = Math.min(Math.max(startHeight + delta, 80), 600);
      setOutputHeight(newHeight);
    }

    function onMouseUp() {
      isResizing.current = false;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  if (roomError) {
    return (
      <div style={{
        height: "100vh", display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center", gap: 16,
      }}>
        <p style={{ fontSize: 20 }}>😕</p>
        <p style={{ fontSize: 16, fontWeight: 600 }}>{roomError}</p>
        <button className="ghost" onClick={() => navigate("/")}>
          Back to dashboard
        </button>
      </div>
    );
  }

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>
      {/* Toolbar */}
      <div style={{
        height: 48, background: "#161b22", borderBottom: "1px solid #30363d",
        display: "flex", alignItems: "center", padding: "0 16px", gap: 12,
      }}>

        <Link to = "/"> 
        <button className="ghost"
              style={{ fontSize: 11, padding: "2px 8px" }}
        >
        &lt; 
        </button>
        </Link>
        <button
          className="primary"
          style={{ fontSize: 12, padding: "4px 14px" }}
          onClick={runCode}
          disabled={running}
        >
          {running ? "Running..." : "▶ Run"}
        </button>
        <span
          onClick={() => navigate("/")}
          style={{ fontWeight: 700, fontSize: 16, cursor: "pointer", color: "#e6edf3" }}
        >Vync</span>

        {fileName && language && (
          <span style={{
            fontSize: 13, color: "#7d8590",
            borderLeft: "1px solid #30363d",
            paddingLeft: 12,
          }}>
            {fileName}.{EXT[language]}
          </span>
        )}

        <div style={{ flex: 1 }} />

        {/* Colored avatar bubbles */}
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {users.map((u, i) => (
            <div key={i} title={u.name} style={{
              width: 28, height: 28, borderRadius: "50%",
              background: u.color, display: "flex", alignItems: "center",
              justifyContent: "center", fontSize: 12, fontWeight: 600,
              color: "#000", border: "2px solid #30363d",
            }}>
              {u.name[0].toUpperCase()}
            </div>
          ))}
        </div>

        <span style={{ fontSize: 12, color: saveStatus === "saved" ? "#3fb950" : "#f85149" }}>
          {saveStatus === "saved" ? "✓ Saved" : saveStatus === "unsaved" ? "Saving..." : "Save failed"}
        </span>

        <button className="ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={copyRoomLink}>
          {copied ? "Copied!" : "Share Room"}
        </button>

        <button className="ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => setShowHistory(h => !h)}>
          {showHistory ? "Close history" : "History"}
        </button>

        <span style={{ fontSize: 12, color: "#7d8590" }}>
          Room: {roomId.slice(0, 8)}
        </span>
      </div>

      {/* Editor */}
      <div style={{ flex: 1, overflow: "hidden", minHeight: 0 }}>
        <MonacoEditor
          height="100%"
          language={language}
          theme="vs-dark"
          onMount={handleEditorMount}
          onChange={handleEditorChange}
          options={{
            fontSize: 14,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: "on",
            tabSize: 2,
            automaticLayout: true,
          }}
        />
      </div>
        
      {language === "typescript" && showWarning && (
        <div style={{
          background: "#2d2a00", borderTop: "1px solid #6e5c00",
          padding: "6px 16px", fontSize: 12, color: "#e3b341",
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <span>⚠ TypeScript runs via ts-node and may take 15–20s on first run.</span>
          <button
            className="ghost"
            style={{ fontSize: 11, padding: "2px 8px" }}
            onClick={dismissTsWarning}
          >✕</button>
        </div>
      )}

      {/* Output Panel */}
      {showOutput && (
        <div ref={outputRef} style={{
          height: outputHeight,
          background: "#0d1117",
          borderTop: "1px solid #30363d",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
        }}>
          {/* ✅ Drag handle */}
          <div
            onMouseDown={startResize}
            style={{
              height: 4,
              background: "#30363d",
              cursor: "ns-resize",
              flexShrink: 0,
              transition: "background 0.15s",
            }}
            onMouseEnter={e => e.target.style.background = "#388bfd"}
            onMouseLeave={e => e.target.style.background = "#30363d"}
          />

          {/* Toolbar */}
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "6px 16px", borderBottom: "1px solid #30363d",
          }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>Output</span>
            <button
              className="ghost"
              style={{ fontSize: 11, padding: "2px 8px" }}
              onClick={() => setShowOutput(false)}
            >✕</button>
          </div>

          {/* Output content */}
          <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px" }}>
            {running && <p style={{ color: "#7d8590", fontSize: 13 }}>Running...</p>}
            {output && (
              <>
                {output.output && (
                  <pre style={{ color: "#3fb950", fontSize: 13, whiteSpace: "pre-wrap", margin: 0 }}>
                    {output.output}
                  </pre>
                )}
                {output.error && (
                  <pre style={{ color: "#f85149", fontSize: 13, whiteSpace: "pre-wrap", margin: 0 }}>
                    {output.error}
                  </pre>
                )}
                {!output.output && !output.error && (
                  <p style={{ color: "#7d8590", fontSize: 13 }}>No output</p>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* History Panel */}
      {showHistory && (
        <div style={{
          position: "absolute", right: 0, top: 48, width: 300, height: "calc(100vh - 48px)",
          background: "#161b22", borderLeft: "1px solid #30363d",
          display: "flex", flexDirection: "column", zIndex: 50, overflow: "hidden",
        }}>
          <div style={{ padding: 16, borderBottom: "1px solid #30363d" }}>
            <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Save snapshot</p>
            <input
              placeholder="Label (optional)"
              value={snapshotLabel}
              onChange={e => setSnapshotLabel(e.target.value)}
              style={{ marginBottom: 8 }}
            />
            <button className="primary" style={{ width: "100%", fontSize: 13 }} onClick={saveSnapshot}>
              Save current version
            </button>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
            <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Snapshots</p>
            {snapshots.length === 0 && (
              <p style={{ color: "#7d8590", fontSize: 13 }}>No snapshots yet.</p>
            )}
            {snapshots.map(snap => (
              <div key={snap.id} style={{
                background: "#0d1117", border: "1px solid #30363d", borderRadius: 6,
                padding: "10px 12px", marginBottom: 8,
              }}>
                <p style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
                  {snap.label || new Date(snap.created_at).toLocaleString()}
                </p>
                <p style={{ fontSize: 11, color: "#7d8590", marginBottom: 8 }}>
                  {new Date(snap.created_at).toLocaleString()}
                </p>
                <button className="ghost" style={{ fontSize: 12, padding: "3px 10px" }} onClick={() => restoreSnapshot(snap.id)}>
                  Restore
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}