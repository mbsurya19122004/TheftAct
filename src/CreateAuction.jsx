import { useState } from "react";
import { supabase } from "./supabaseClient";

const DURATIONS = [
  { label: "5 minutes", minutes: 5 },
  { label: "30 minutes", minutes: 30 },
  { label: "1 hour", minutes: 60 },
  { label: "24 hours", minutes: 1440 },
  { label: "7 days", minutes: 10080 },
];

export default function CreateAuction({ onCreated }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [startingBid, setStartingBid] = useState("");
  const [minutes, setMinutes] = useState(60);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const { error } = await supabase.rpc("create_auction", {
      p_title: title,
      p_description: description,
      p_starting_bid: Number(startingBid),
      p_duration_minutes: Number(minutes),
    });

    setLoading(false);
    if (error) return setError(error.message);

    setTitle("");
    setDescription("");
    setStartingBid("");
    onCreated();
  }

  return (
    <form className="panel" onSubmit={handleSubmit}>
      <h2>List an item</h2>

      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} required />
      </label>

      <label>
        Description
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={500}
          rows={2}
        />
      </label>

      <div className="row">
        <label>
          Starting bid (credits)
          <input
            type="number"
            min={1}
            step={1}
            value={startingBid}
            onChange={(e) => setStartingBid(e.target.value)}
            required
          />
        </label>

        <label>
          Runs for
          <select value={minutes} onChange={(e) => setMinutes(e.target.value)}>
            {DURATIONS.map((d) => (
              <option key={d.minutes} value={d.minutes}>{d.label}</option>
            ))}
          </select>
        </label>
      </div>

      {error && <p className="msg error" role="alert">{error}</p>}

      <button type="submit" disabled={loading}>{loading ? "Listing…" : "Start auction"}</button>
    </form>
  );
}
