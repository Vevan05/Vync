import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import MonacoEditor from "@monaco-editor/react";
import * as Y from "yjs";
import { io } from "socket.io-client";
import axios from "axios";
import { useAuth } from "../context/AuthContext";

const EXT = {"javascript": "js", "python": "py", "go": "go", "cpp": "cpp", "typescript": "ts", "java": "java"};

const SOCKET_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3001";

// Throttle helper for high-frequency events like cursor moves.
function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  let lastArgs = null;
  return function throttled(...args) {
    const now = Date.now();
    const remaining = ms - (now - last);
    lastArgs = args;
    if (remaining <= 0) {
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        last = Date.now();
        timer = null;
        fn(...lastArgs);
      }, remaining);
    }
  };
}

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
  const isApplyingRemote = useRef(false);
  const saveTimer = useRef(null);
  const outputRef = useRef(null);
  const decorationsRef = useRef({});
  const userColorsRef = useRef({});
  const docSeededRef = useRef(false);

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

  // Memoize the axios instance so it isn't rebuilt on every render.
  const api = useMemo(
    () => axios.create({ headers: { Authorization: `Bearer ${token}` } }),
    [token]
  );

  // Inject base cursor CSS once
  useEffect(() => {
    if (document.getElementById("vync-cursor-styles")) return;
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
    document.head.appendChild(style);
    return () => document.getElementById("vync-cursor-styles")?.remove();
  }, []);

  useEffect(() => {
    if (showHistory) fetchSnapshots();
  }, [showHistory]);

  // Load file metadata from DB.
  useEffect(() => {
    let cancelled = false;
    api.get(`/api/files/${roomId}`)
      .then(({ data }) => {
        if (cancelled) return;
        setLanguage(data.language);
        setFileName(data.name);
        const ytext = ydocRef.current.getText("content");
        ytextRef.current = ytext;
        // Only seed from DB if the server hasn't given us content yet.
        if (!docSeededRef.current && data.content && ytext.toString() === "") {
          ytext.insert(0, data.content);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        if (err.response?.status === 404) {
          setRoomError("This room doesn't exist. Check the ID and try again.");
        } else {
          setRoomError("Something went wrong loading this room.");
        }
      });
    return () => { cancelled = true; };
  }, [roomId, api]);

  // WebSocket connection
  useEffect(() => {
    const socket = io(SOCKET_URL, {
      auth: { token },
      // Reconnection is on by default; the server's disconnect handler will
      // clean up the user's presence entry automatically.
    });
    socketRef.current = socket;

    const ytext = ydocRef.current.getText("content");
    ytextRef.current = ytext;

    socket.on("connect", () => {
      socket.emit("join-room", { roomId, username: user?.username });
    });

    socket.on("connect_error", (err) => {
      setRoomError(err.message || "Failed to connect. Please log in again.");
    });

    socket.on("room-error", (msg) => {
      setRoomError(msg || "You don't have access to this room.");
      socket.disconnect();
    });

    socket.on("doc-state", (update) => {
      // First sync from the server — this is authoritative.
      docSeededRef.current = true;
      isRemoteUpdate.current = true;
      isApplyingRemote.current = true;
      try {
        Y.applyUpdate(ydocRef.current, new Uint8Array(update));
        // Sync Monaco to the merged state if it has drifted.
        const content = ytext.toString();
        if (editorRef.current && content !== editorRef.current.getValue()) {
          editorRef.current.setValue(content);
        }
      } finally {
        isRemoteUpdate.current = false;
        isApplyingRemote.current = false;
      }
    });

    // Incremental updates from other users.
    socket.on("doc-update", (update) => {
      const u8 = update instanceof Uint8Array ? update : new Uint8Array(update);
      isRemoteUpdate.current = true;
      isApplyingRemote.current = true;
      try {
        Y.applyUpdate(ydocRef.current, u8);
        // Push the merged Yjs state back into Monaco using execEdits so the
        // cursor position is preserved and the undo stack stays intact.
        const editor = editorRef.current;
        if (editor) {
          const model = editor.getModel();
          const currentValue = model.getValue();
          const newValue = ytext.toString();
          if (currentValue !== newValue) {
            const fullRange = model.getFullModelRange();
            editor.executeEdits("remote", [
              { range: fullRange, text: newValue, forceMoveMarkers: true },
            ]);
          }
        }
      } finally {
        isRemoteUpdate.current = false;
        isApplyingRemote.current = false;
      }
    });

    socket.on("users-update", (userList) => setUsers(userList));

    socket.on("cursor-update", ({ socketId, user: remoteUser, cursor }) => {
      if (!editorRef.current || !monacoRef.current || !cursor) return;
      const monaco = monacoRef.current;
      const editor = editorRef.current;
      const color = remoteUser?.color || "#ffffff";

      userColorsRef.current[socketId] = color;

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
          content: "${(remoteUser?.name || "user").replace(/"/g, '\\"')}";
          background: ${color};
          color: #000;
          font-size: 11px;
          font-weight: 600;
          padding: 1px 5px;
          border-radius: 3px;
        }
      `;

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

      const oldIds = decorationsRef.current[socketId] || [];
      decorationsRef.current[socketId] = editor.deltaDecorations(oldIds, newDecorations);
    });

    socket.on("user-left", (socketId) => {
      if (editorRef.current && decorationsRef.current[socketId]) {
        editorRef.current.deltaDecorations(decorationsRef.current[socketId], []);
        delete decorationsRef.current[socketId];
      }
      document.getElementById(`cursor-style-${socketId}`)?.remove();
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [roomId, user, token]);

  // Broadcast local Yjs changes — only the *delta* update, not the full state.
  useEffect(() => {
    const ytext = ytextRef.current;
    if (!ytext) return;

    const handler = (event, transaction) => {
      if (isRemoteUpdate.current || transaction.local === false) return;
      // The Yjs update passed to the observer is the incremental diff.
      const update = transaction.update;
      if (update && update.length) {
        socketRef.current?.emit("doc-update", { roomId, update });
      }
    };

    ytext.observe(handler);
    return () => ytext.unobserve(handler);
  }, [roomId]);

  function handleEditorMount(editor, monaco) {
    editorRef.current = editor;
    monacoRef.current = monaco;

    const ytext = ytextRef.current;
    if (ytext && ytext.toString()) editor.setValue(ytext.toString());

    // Throttle cursor emissions — they fire on every selection change.
    const emitCursor = throttle((pos) => {
      socketRef.current?.emit("cursor-update", {
        roomId,
        cursor: { lineNumber: pos.lineNumber, column: pos.column },
      });
    }, 33);

    editor.onDidChangeCursorPosition((e) => emitCursor(e.position));
  }

  function handleEditorChange(value) {
    if (isRemoteUpdate.current) return;
    const ytext = ytextRef.current;
    if (!ytext || value === ytext.toString()) return;

    ydocRef.current.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, value || "");
    });

    // "Unsaved" while the debounce is pending; "Saving..." while the request is in flight.
    setSaveStatus("unsaved");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      // Read the current editor value at fire time, not the value captured
      // when the timer was scheduled.
      const current = editorRef.current?.getValue() ?? "";
      saveFile(current);
    }, 1500);
  }

  async function saveFile(content) {
    setSaveStatus("saving");
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
      fetchSnapshots();
      alert("Snapshot saved!");
    } catch {
      alert("Failed to save snapshot");
    }
  }

  async function fetchSnapshots() {
    try {
      const { data } = await api.get(`/api/files/${roomId}/snapshots`);
      setSnapshots(data);
    } catch (err) {
      console.error("fetchSnapshots failed:", err);
    }
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
    setTimeout(() => outputRef.current?.scrollIntoView({ behavior: "smooth" }), 50);

    try {
      const { data } = await api.post("/api/execute", { code, language });
      setOutput(data);
    } catch (err) {
      setOutput({ output: "", error: err.response?.data?.error || "Server error — is Docker running?" });
    } finally {
      setRunning(false);
    }
  }

  function copyRoomLink() {
    navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 10000);
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

  const saveLabel =
    saveStatus === "saved" ? "✓ Saved" :
    saveStatus === "saving" ? "Saving..." :
    saveStatus === "unsaved" ? "● Unsaved" :
    "Save failed";

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>
      {/* Toolbar */}
      <div style={{
        height: 48, background: "#161b22", borderBottom: "1px solid #30363d",
        display: "flex", alignItems: "center", padding: "0 16px", gap: 12,
      }}>
        <Link to="/">
          <button className="ghost" style={{ fontSize: 11, padding: "2px 8px" }}>
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
          {users.map((u, i) => {
            const initial = (u.name || "?").trim()[0]?.toUpperCase() || "?";
            return (
              <div key={i} title={u.name} style={{
                width: 28, height: 28, borderRadius: "50%",
                background: u.color, display: "flex", alignItems: "center",
                justifyContent: "center", fontSize: 12, fontWeight: 600,
                color: "#000", border: "2px solid #30363d",
              }}>
                {initial}
              </div>
            );
          })}
        </div>

        <span style={{
          fontSize: 12,
          color: saveStatus === "saved" ? "#3fb950"
               : saveStatus === "error" ? "#f85149"
               : "#e3b341",
        }}>
          {saveLabel}
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
