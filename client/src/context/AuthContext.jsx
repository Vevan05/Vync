import { createContext, useContext, useState } from "react";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem("vync_user")); } catch { return null; }
  });
  const [token, setToken] = useState(() => localStorage.getItem("vync_token"));

  function login(userData, tokenData) {
    setUser(userData);
    setToken(tokenData);
    localStorage.setItem("vync_user", JSON.stringify(userData));
    localStorage.setItem("vync_token", tokenData);
  }

  function logout() {
    setUser(null);
    setToken(null);
    localStorage.removeItem("vync_user");
    localStorage.removeItem("vync_token");
  }

  return (
    <AuthContext.Provider value={{ user, token, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
