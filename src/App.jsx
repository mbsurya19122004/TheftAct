import { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";
import AuthForm from "./AuthForm.jsx";
import Dashboard from "./Dashboard.jsx";

export default function App() {
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setChecking(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  if (checking) return <main className="page"><p className="muted">Loading…</p></main>;

  if (!session) return <main className="page"><AuthForm /></main>;

  return <Dashboard user={session.user} />;
}
