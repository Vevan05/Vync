import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import axios from "axios";
import { useAuth } from "../context/AuthContext";

export default function Login() {
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState("");
  const { login } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    try {
      const { data } = await axios.post("/api/auth/login", form);
      login(data.user, data.token);
      navigate("/");
    } catch (err) {
      setError(err.response?.data?.error || "Login failed");
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh" }}>
      <div className="card" style={{ width: 360 }}>
        <h1 style={{ fontSize: 24, marginBottom: 4 }}>Vync</h1>
        <p style={{ color: "#7d8590", marginBottom: 24 }}>Sign in to your account</p>

        {error && <p style={{ color: "#f85149", marginBottom: 16 }}>{error}</p>}

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <input
            type="email" placeholder="Email" value={form.email}
            onChange={e => setForm(f => ({ ...f, email: e.target.value }))} required
          />
          <input
            type="password" placeholder="Password" value={form.password}
            onChange={e => setForm(f => ({ ...f, password: e.target.value }))} required
          />
          <button type="submit" className="primary" style={{ marginTop: 4 }}>Sign in</button>
        </form>

        <p style={{ marginTop: 16, color: "#7d8590", fontSize: 14 }}>
          No account? <Link to="/signup">Sign up</Link>
        </p>
      </div>
    </div>
  );
}
