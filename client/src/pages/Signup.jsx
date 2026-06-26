import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import axios from "axios";
import { useAuth } from "../context/AuthContext";

export default function Signup() {
  const [form, setForm] = useState({ username: "", email: "", password: "" });
  const [error, setError] = useState("");
  const { login } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    try {
      const { data } = await axios.post("/api/auth/signup", form);
      login(data.user, data.token);
      navigate("/");
    } catch (err) {
      setError(err.response?.data?.error || "Signup failed");
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh" }}>
      <div className="card" style={{ width: 360 }}>
        <h1 style={{ fontSize: 24, marginBottom: 4 }}>Vync</h1>
        <p style={{ color: "#7d8590", marginBottom: 24 }}>Create your account</p>

        {error && <p style={{ color: "#f85149", marginBottom: 16 }}>{error}</p>}

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <input
            placeholder="Username" value={form.username}
            onChange={e => setForm(f => ({ ...f, username: e.target.value }))} required
          />
          <input
            type="email" placeholder="Email" value={form.email}
            onChange={e => setForm(f => ({ ...f, email: e.target.value }))} required
          />
          <input
            type="password" placeholder="Password" value={form.password}
            onChange={e => setForm(f => ({ ...f, password: e.target.value }))} required
          />
          <button type="submit" className="primary" style={{ marginTop: 4 }}>Create account</button>
        </form>

        <p style={{ marginTop: 16, color: "#7d8590", fontSize: 14 }}>
          Have an account? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
