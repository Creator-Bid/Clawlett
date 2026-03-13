import fs from "fs";
import path from "path";

export default function handler(req, res) {
  // Try multiple paths: data/ (Vercel), parent dir (local dev), public/ (fallback)
  const paths = [
    path.join(process.cwd(), "data", "leaderboard.json"),
    path.join(process.cwd(), "..", "leaderboard.json"),
    path.join(process.cwd(), "public", "leaderboard.json"),
  ];

  for (const filePath of paths) {
    try {
      const data = fs.readFileSync(filePath, "utf-8");
      const json = JSON.parse(data);
      res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=30");
      return res.status(200).json(json);
    } catch {
      continue;
    }
  }

  res.status(500).json({ error: "leaderboard.json not found" });
}
