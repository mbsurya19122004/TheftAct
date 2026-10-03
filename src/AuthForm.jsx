import { useState } from "react";
import { supabase } from "./supabaseClient";

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

export default function AuthForm() {
  const [mode, setMode] = useState("login"); // "login" | "signup"
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const isSignup = mode === "signup";

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setNotice("");

    if (isSignup) {
      const name = username.trim();

      if (!USERNAME_RE.test(name)) {
        setError("Username must be 3–20 characters: letters, numbers or underscores.");
        setLoading(false);
        return;
      }

      // Friendly check first; the database also enforces uniqueness
      const { data: free, error: checkError } = await supabase.rpc("is_username_available", {
        p_username: name,
      });
      if (checkError) {
        setError(checkError.message);
        setLoading(false);
        return;
      }
      if (!free) {
        setError("That username is taken. Try another.");
        setLoading(false);
        return;
      }

      // The username travels in the sign-up metadata; a database trigger
      // turns it into the user's profile row.
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { username: name } },
      });
      if (error) setError(error.message);
      else if (!data.session) setNotice("Check your inbox to confirm your email, then log in.");
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setError(error.message);
    }

    setLoading(false);
  }

  function switchMode() {
    setMode(isSignup ? "login" : "signup");
    setError("");
    setNotice("");
  }

  return (
    <form className="card" onSubmit={handleSubmit}>
      <h1>{isSignup ? "Create your account" : "Log in"}</h1>

      {isSignup && (
        <label>
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            maxLength={20}
            required
          />
        </label>
      )}

      <label>
        Email
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
        />
      </label>

      <label>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={isSignup ? "new-password" : "current-password"}
          minLength={6}
          required
        />
      </label>

      {error && <p className="msg error" role="alert">{error}</p>}
      {notice && <p className="msg ok" role="status">{notice}</p>}

      <button type="submit" disabled={loading}>
        {loading ? "Please wait…" : isSignup ? "Sign up" : "Log in"}
      </button>

      <p className="muted">
        {isSignup ? "Already have an account?" : "No account yet?"}{" "}
        <button type="button" className="link" onClick={switchMode}>
          {isSignup ? "Log in" : "Sign up"}
        </button>
      </p>
    </form>
  );
}
