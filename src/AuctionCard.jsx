import { useState } from "react";
import { supabase } from "./supabaseClient";

function timeLeft(ms) {
  if (ms <= 0) return "Ended";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

export default function AuctionCard({ auction: a, now, userId, onChanged }) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const remaining = new Date(a.ends_at).getTime() - now;
  const isOpen = a.status === "active" && remaining > 0;
  const isSeller = a.seller_id === userId;
  const isLeader = a.current_bidder_id === userId;
  const minBid = a.current_bid ? a.current_bid + 1 : a.starting_bid;

  async function run(fn) {
    setBusy(true);
    setError("");
    const { error } = await fn();
    setBusy(false);
    if (error) return setError(error.message);
    setAmount("");
    onChanged();
  }

  const placeBid = (e) => {
    e.preventDefault();
    run(() => supabase.rpc("place_bid", { p_auction_id: a.id, p_amount: Number(amount) }));
  };

  const cancel = () => run(() => supabase.rpc("cancel_auction", { p_auction_id: a.id }));

  let result = null;
  if (a.status === "cancelled") result = "Cancelled by seller";
  else if (!isOpen && a.current_bidder_username)
    result = `Sold to ${isLeader ? "you" : a.current_bidder_username} for ${a.current_bid.toLocaleString()} credits`;
  else if (!isOpen) result = a.status === "active" ? "Closing…" : "Ended with no bids";

  return (
    <article className="auction">
      <h3>{a.title}</h3>
      {a.description && <p className="muted">{a.description}</p>}
      <p className="muted">Listed by {isSeller ? "you" : a.seller_username}</p>

      <p className="price">
        {a.current_bid ? a.current_bid.toLocaleString() : a.starting_bid.toLocaleString()} credits
        <span className="muted">
          {" "}
          {a.current_bid
            ? `· ${a.bid_count} ${a.bid_count === 1 ? "bid" : "bids"}, led by ${isLeader ? "you" : a.current_bidder_username}`
            : "· starting bid, no bids yet"}
        </span>
      </p>

      {isOpen && <p className="timer">{timeLeft(remaining)} left</p>}
      {result && <p className="msg ok">{result}</p>}

      {isOpen && !isSeller && (
        <form className="row" onSubmit={placeBid}>
          <input
            type="number"
            min={minBid}
            step={1}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={`${minBid.toLocaleString()} or more`}
            aria-label="Your bid in credits"
            required
          />
          <button type="submit" disabled={busy}>{isLeader ? "Raise bid" : "Bid"}</button>
        </form>
      )}

      {isOpen && isLeader && <p className="msg ok">You're the highest bidder</p>}

      {isOpen && isSeller && a.bid_count === 0 && (
        <button className="secondary" onClick={cancel} disabled={busy}>Cancel auction</button>
      )}

      {error && <p className="msg error" role="alert">{error}</p>}
    </article>
  );
}
