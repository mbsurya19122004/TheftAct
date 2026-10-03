import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "./supabaseClient";
import CreateAuction from "./CreateAuction.jsx";
import AuctionCard from "./AuctionCard.jsx";

export default function Dashboard({ user }) {
  const [profile, setProfile] = useState(null);
  const [auctions, setAuctions] = useState([]);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState("");
  const settling = useRef(false);
  const lastSettleTry = useRef(0);

  const loadProfile = useCallback(async () => {
    const { data, error } = await supabase
      .from("profiles")
      .select("username, credits")
      .eq("id", user.id)
      .single();
    if (error) setError(error.message);
    else setProfile(data);
  }, [user.id]);

  const loadAuctions = useCallback(async () => {
    const { data, error } = await supabase
      .from("auctions")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) setError(error.message);
    else setAuctions(data);
  }, []);

  // Credits change whenever a bid lands (escrow, refunds, payouts), so reload both
  const refresh = useCallback(() => Promise.all([loadProfile(), loadAuctions()]), [loadProfile, loadAuctions]);

  // Close finished auctions and pay sellers
  const settleExpired = useCallback(async () => {
    if (settling.current) return;
    settling.current = true;
    lastSettleTry.current = Date.now();
    const { data, error } = await supabase.rpc("settle_expired_auctions");
    settling.current = false;
    if (error) setError(error.message);
    else if (data > 0) refresh();
  }, [refresh]);

  // First load
  useEffect(() => {
    refresh();
    settleExpired();
  }, [refresh, settleExpired]);

  // Live updates: any change to an auction refreshes the screen
  useEffect(() => {
    const channel = supabase
      .channel("auctions-feed")
      .on("postgres_changes", { event: "*", schema: "public", table: "auctions" }, () => refresh())
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [refresh]);

  // Countdown clock
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // When a countdown hits zero, settle (at most once every 5 seconds)
  useEffect(() => {
    const hasExpired = auctions.some(
      (a) => a.status === "active" && new Date(a.ends_at).getTime() <= now
    );
    if (hasExpired && now - lastSettleTry.current > 5000) settleExpired();
  }, [now, auctions, settleExpired]);

  const live = auctions
    .filter((a) => a.status === "active")
    .sort((a, b) => new Date(a.ends_at) - new Date(b.ends_at));

  const finished = auctions
    .filter((a) => a.status !== "active")
    .sort((a, b) => new Date(b.ends_at) - new Date(a.ends_at))
    .slice(0, 10);

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <strong>{profile?.username ?? "…"}</strong>
          <span className="muted"> · {user.email}</span>
        </div>
        <div className="topbar-right">
          <span className="credits">{profile ? profile.credits.toLocaleString() : "–"} credits</span>
          <button className="secondary" onClick={() => supabase.auth.signOut()}>Log out</button>
        </div>
      </header>

      {error && (
        <p className="msg error" role="alert">
          {error}{" "}
          <button className="link" onClick={() => setError("")}>Dismiss</button>
        </p>
      )}

      <CreateAuction onCreated={refresh} />

      <section>
        <h2>Live auctions</h2>
        {live.length === 0 && <p className="muted">No live auctions. List something above.</p>}
        <div className="grid">
          {live.map((a) => (
            <AuctionCard key={a.id} auction={a} now={now} userId={user.id} onChanged={refresh} />
          ))}
        </div>
      </section>

      {finished.length > 0 && (
        <section>
          <h2>Recently finished</h2>
          <div className="grid">
            {finished.map((a) => (
              <AuctionCard key={a.id} auction={a} now={now} userId={user.id} onChanged={refresh} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
