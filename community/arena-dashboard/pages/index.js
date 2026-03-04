import { useState, useEffect } from "react";
import Head from "next/head";
import ArenaHeader from "../components/ArenaHeader";
import CardGrid from "../components/CardGrid";
import CardOverlay from "../components/CardOverlay";
import { REFRESH_INTERVAL } from "../lib/constants";

export default function Home() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL);
  const [search, setSearch] = useState("");

  // Fetch leaderboard data
  const fetchData = async () => {
    try {
      const res = await fetch("/api/leaderboard");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setError(null);
      setCountdown(REFRESH_INTERVAL);
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, REFRESH_INTERVAL * 1000);
    return () => clearInterval(interval);
  }, []);

  // Countdown timer
  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown((c) => (c > 0 ? c - 1 : REFRESH_INTERVAL));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <>
      <Head>
        <title>Clawlett Arena</title>
        <meta name="description" content="CreatorBid AI Trading Competition Leaderboard" />
      </Head>

      <div className="min-h-screen">
        <ArenaHeader
          data={data}
          countdown={countdown}
          search={search}
          onSearchChange={setSearch}
        />

        {/* Error */}
        {error && (
          <div className="max-w-7xl mx-auto px-4 py-4">
            <div className="bg-red-900/20 border border-red-800/50 rounded-lg px-4 py-2 text-sm text-red-400">
              Failed to load: {error}
            </div>
          </div>
        )}

        {/* Main content */}
        <main className="max-w-7xl mx-auto px-4 py-6">
          {data ? (
            <CardGrid
              wallets={data.wallets}
              onSelectWallet={setSelected}
              search={search}
            />
          ) : (
            !error && (
              <div className="text-center py-20 text-gray-600">Loading arena...</div>
            )
          )}
        </main>

        {/* Footer */}
        <footer className="border-t border-arena-500/15 py-4 text-center text-xs text-gray-600">
          Clawlett Arena &middot; CreatorBid AI Trading Competition &middot; Base Chain
        </footer>
      </div>

      {/* Detail overlay */}
      <CardOverlay wallet={selected} onClose={() => setSelected(null)} />
    </>
  );
}
